import {
  type GenerateContentResponse,
  GoogleGenAI,
  Schema,
  ThinkingLevel,
  Type,
} from '@google/genai';
import { z } from 'zod';
import type { CatalogModel, CatalogProvider } from '../../../contracts/aiCatalog';
import { ProviderFailure, ProviderFailureDetails, QuotaScope } from '../errors';
import { droppedConnection, unansweredFailure } from './network';
import { ProviderClient, VERIFY_TIMEOUT_MS } from './types';
import { checkModels } from './verify';

const THINKING_LEVELS = { minimal: ThinkingLevel.MINIMAL, low: ThinkingLevel.LOW } as const;

const TYPES: Record<string, Type> = {
  object: Type.OBJECT,
  array: Type.ARRAY,
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
};

// Accepted Gemini response-schema keywords. Anything else Zod emits (for example minimum/maximum)
// is dropped here and still enforced by the contract's Zod validation.
const KEPT = new Set(['description', 'enum', 'nullable', 'required']);

type JsonNode = { [key: string]: unknown };

function toGemini(node: JsonNode): Schema {
  const out: JsonNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') out.type = TYPES[value as string];
    else if (key === 'properties')
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, JsonNode>).map(([name, child]) => [
          name,
          toGemini(child),
        ]),
      );
    else if (key === 'items') out.items = toGemini(value as JsonNode);
    else if (KEPT.has(key)) out[key] = value;
  }
  return out as Schema;
}

const schemas = new WeakMap<z.ZodType, Schema>();

/** Gemini's dialect of a contract schema, derived from the contract's Zod schema. */
export function geminiSchema(schema: z.ZodType): Schema {
  let derived = schemas.get(schema);
  if (!derived) {
    derived = toGemini(z.toJSONSchema(schema, { target: 'openapi-3.0' }) as JsonNode);
    schemas.set(schema, derived);
  }
  return derived;
}

/** Which of Google's quotas a 429 hit, from its quota IDs (for example `…PerDay…-FreeTier`). */
function quotaScope(quotaIds: string[]): QuotaScope | undefined {
  if (quotaIds.some((id) => id.includes('PerDay'))) return 'PER_DAY';
  if (quotaIds.some((id) => id.includes('PerMinute'))) return 'PER_MINUTE';
  return undefined;
}

type GoogleErrorDetail = {
  '@type'?: unknown;
  reason?: unknown;
  retryDelay?: unknown;
  violations?: { quotaId?: unknown }[];
};

/**
 * Reads the Google API error body (`{ error: { status, details } }`, carried as the SDK error's
 * message) in memory. Only allowlisted tokens leave this function; the text is never kept.
 */
function googleErrorBody(err: unknown): {
  status?: string;
  reason?: string;
  retryAfterMs?: number;
  quotaScope?: QuotaScope;
  freeTier?: boolean;
} {
  try {
    const message = err instanceof Error ? err.message : '';
    const body = JSON.parse(message) as {
      error?: { status?: unknown; details?: GoogleErrorDetail[] };
    };
    const details = Array.isArray(body.error?.details) ? body.error.details : [];
    const reason = details.find((d) => typeof d.reason === 'string')?.reason as string | undefined;
    const delay = details.find((d) => typeof d.retryDelay === 'string')?.retryDelay as
      string | undefined;
    const seconds = delay ? Number(delay.replace(/s$/, '')) : NaN;
    const quotaIds = details
      .flatMap((d) => (Array.isArray(d.violations) ? d.violations : []))
      .map((violation) => violation?.quotaId)
      .filter((id): id is string => typeof id === 'string');
    return {
      status: typeof body.error?.status === 'string' ? body.error.status : undefined,
      reason,
      retryAfterMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
      quotaScope: quotaScope(quotaIds),
      freeTier: quotaIds.some((id) => id.includes('FreeTier')),
    };
  } catch {
    return {};
  }
}

/**
 * Where a Gemini call that got no answer failed: our own timer, the connection, or anything else,
 * which is our bug.
 */
function unansweredCall(err: unknown): ProviderFailureDetails {
  if (err instanceof Error && err.name === 'AbortError') return { failureCause: 'TIMEOUT' };
  return droppedConnection(err) ?? { failureCause: 'UNCLASSIFIED' };
}

/** Google's short server errors: it did not do the work, so the mail waits and uses no try. */
const BUSY_STATUSES = [500, 502, 503];

/**
 * Gemini API error mapping (plan §3.6). Starting table; each row must be confirmed with a real key
 * before Gemini is offered in production.
 *
 * 503 ("high demand"), 500 and 502 are Google's own answers that it did not do the work, and Google
 * does not charge a request that fails with a 400 or 500 error: a busy provider. 504 ("deadline
 * expired") is Google's own deadline, the model's time limit we send with each call, passing: no
 * answer in time, like our own timer. A 408 or another 5xx is treated as no answer in time too.
 */
export function classifyGeminiError(err: unknown): ProviderFailure {
  if (err instanceof ProviderFailure) return err;
  const status =
    typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
      ? err.status
      : undefined;
  if (status === undefined) return unansweredFailure(unansweredCall(err));
  const body = googleErrorBody(err);
  const details: ProviderFailureDetails = {
    status,
    providerCode: body.reason ?? body.status,
    retryAfterMs: body.retryAfterMs,
    quotaScope: body.quotaScope,
    freeTier: body.freeTier,
    failureCause: status === 504 ? 'PROVIDER_DEADLINE' : 'PROVIDER_ANSWER',
  };
  if (body.reason === 'API_KEY_INVALID' || status === 401)
    return new ProviderFailure('KEY_REJECTED', details);
  if (status === 403 || body.status === 'FAILED_PRECONDITION')
    return new ProviderFailure('ACCOUNT_OR_BILLING', details);
  if (status === 404) return new ProviderFailure('MODEL_UNAVAILABLE', details);
  if (status === 429) return new ProviderFailure('RATE_LIMITED', details);
  if (BUSY_STATUSES.includes(status)) return new ProviderFailure('PROVIDER_BUSY', details);
  if (status === 408 || status >= 500) return new ProviderFailure('OUTCOME_UNKNOWN', details);
  return new ProviderFailure('INVALID_REQUEST', details);
}

/** The model's thinking setting, kept at the minimum the model allows. */
function thinkingConfig(model: CatalogModel | undefined) {
  const reasoning = model?.reasoning;
  if (reasoning && 'thinkingBudget' in reasoning)
    return { thinkingConfig: { thinkingBudget: reasoning.thinkingBudget } };
  if (reasoning && 'thinkingLevel' in reasoning)
    return { thinkingConfig: { thinkingLevel: THINKING_LEVELS[reasoning.thinkingLevel] } };
  return {};
}

/**
 * Why Google stopped or blocked an answer that cannot be used (for example MAX_TOKENS or SAFETY).
 * A normal stop says nothing about the problem, so it is left out.
 */
function stoppedEarly(response: GenerateContentResponse): string | undefined {
  const finish = response.candidates?.[0]?.finishReason;
  return response.promptFeedback?.blockReason ?? (finish === 'STOP' ? undefined : finish);
}

/**
 * Google is told the model's own time limit (in seconds) and answers 504 DEADLINE_EXCEEDED when it
 * passes. We stop waiting this much later, so Google's answer normally comes first.
 */
const SERVER_TIMEOUT_HEADER = 'X-Server-Timeout';
const ANSWER_GRACE_MS = 15_000;

/** The fixed text of a key check. It holds nothing of the user's. */
const VERIFY_INPUT = 'Reply with OK.';
const VERIFY_MAX_OUTPUT_TOKENS = 16;

export function createGeminiClient(provider: CatalogProvider, apiKey: string): ProviderClient {
  // One SDK attempt: a hidden retry could repeat a call whose outcome is already charged.
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { baseUrl: provider.baseUrl, retryOptions: { attempts: 1 } },
  });
  return {
    async generateStructured({ contract, model, input }) {
      // Built before the call: an error in our own code is never taken for the provider's answer.
      const responseSchema = geminiSchema(contract.schema);
      // Not the SDK's `timeout`: it sends Google the same deadline it stops waiting at, so which
      // one ends the call first is luck. Our own timer stops the call 15 seconds after Google's.
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), model.timeoutMs + ANSWER_GRACE_MS);
      let response;
      try {
        response = await client.models.generateContent({
          model: model.id,
          contents: input,
          config: {
            systemInstruction: contract.instructions,
            responseMimeType: 'application/json',
            responseSchema,
            ...(model.temperature === null ? {} : { temperature: model.temperature }),
            maxOutputTokens: contract.maxOutputTokens,
            ...thinkingConfig(model),
            httpOptions: {
              headers: { [SERVER_TIMEOUT_HEADER]: String(Math.ceil(model.timeoutMs / 1000)) },
            },
            abortSignal: stop.signal,
          },
        });
      } catch (err) {
        throw classifyGeminiError(err);
      } finally {
        clearTimeout(timer);
      }
      const usage = {
        inputTokens: response.usageMetadata?.promptTokenCount ?? null,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      };
      const text = response.text;
      if (!text)
        throw new ProviderFailure('INVALID_OUTPUT', {
          message: 'AI provider returned empty response',
          usage,
          stopReason: stoppedEarly(response),
        });
      try {
        return { data: JSON.parse(text), usage };
      } catch {
        throw new ProviderFailure('INVALID_OUTPUT', {
          message: 'AI provider returned invalid JSON',
          usage,
          stopReason: stoppedEarly(response),
        });
      }
    },

    /**
     * Sends one very small real request to each model. Looking the model up is not enough: Google
     * describes a model to every key, also to a key it refuses every real request from. The
     * answer is not read, kept or logged.
     */
    verifyModels: (modelIds) =>
      checkModels(
        provider.id,
        modelIds,
        (modelId) =>
          client.models.generateContent({
            model: modelId,
            contents: VERIFY_INPUT,
            config: {
              maxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
              ...thinkingConfig(provider.models.find((model) => model.id === modelId)),
              httpOptions: { timeout: VERIFY_TIMEOUT_MS },
            },
          }),
        classifyGeminiError,
      ),
  };
}
