import { GoogleGenAI, Schema, ThinkingLevel, Type } from '@google/genai';
import { z } from 'zod';
import type { CatalogProvider } from '../../../contracts/aiCatalog';
import { ACCESS_FAILURE_KINDS, ProviderFailure } from '../errors';
import { ProviderClient, VERIFY_TIMEOUT_MS, VerifyResult } from './types';

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

/**
 * Reads the Google API error body (`{ error: { status, details } }`, carried as the SDK error's
 * message) in memory. Only allowlisted tokens leave this function; the text is never kept.
 */
function googleErrorBody(err: unknown): {
  status?: string;
  reason?: string;
  retryAfterMs?: number;
} {
  try {
    const message = err instanceof Error ? err.message : '';
    const body = JSON.parse(message) as {
      error?: {
        status?: unknown;
        details?: { '@type'?: unknown; reason?: unknown; retryDelay?: unknown }[];
      };
    };
    const details = Array.isArray(body.error?.details) ? body.error.details : [];
    const reason = details.find((d) => typeof d.reason === 'string')?.reason as string | undefined;
    const delay = details.find((d) => typeof d.retryDelay === 'string')?.retryDelay as
      string | undefined;
    const seconds = delay ? Number(delay.replace(/s$/, '')) : NaN;
    return {
      status: typeof body.error?.status === 'string' ? body.error.status : undefined,
      reason,
      retryAfterMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Gemini API error mapping (plan §3.6). Starting table; each row must be confirmed with a real key
 * before Gemini is offered in production. Anything unrecognized is an unknown outcome: the
 * conservative choice, held and never replayed.
 */
export function classifyGeminiError(err: unknown): ProviderFailure {
  if (err instanceof ProviderFailure) return err;
  const status =
    typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
      ? err.status
      : undefined;
  if (status === undefined) return new ProviderFailure('OUTCOME_UNKNOWN');
  const body = googleErrorBody(err);
  const details = {
    status,
    providerCode: body.reason ?? body.status,
    retryAfterMs: body.retryAfterMs,
  };
  if (body.reason === 'API_KEY_INVALID' || status === 401)
    return new ProviderFailure('KEY_REJECTED', details);
  if (status === 403 || body.status === 'FAILED_PRECONDITION')
    return new ProviderFailure('ACCOUNT_OR_BILLING', details);
  if (status === 404) return new ProviderFailure('MODEL_UNAVAILABLE', details);
  if (status === 429 || status === 503) return new ProviderFailure('RATE_LIMITED', details);
  if (status === 408 || status >= 500) return new ProviderFailure('OUTCOME_UNKNOWN', details);
  return new ProviderFailure('INVALID_REQUEST', details);
}

export function createGeminiClient(provider: CatalogProvider, apiKey: string): ProviderClient {
  // One SDK attempt: a hidden retry could repeat a call whose outcome is already charged.
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { baseUrl: provider.baseUrl, retryOptions: { attempts: 1 } },
  });
  return {
    async generateStructured({ contract, model, input }) {
      let response;
      try {
        response = await client.models.generateContent({
          model: model.id,
          contents: input,
          config: {
            systemInstruction: contract.instructions,
            responseMimeType: 'application/json',
            responseSchema: geminiSchema(contract.schema),
            ...(model.temperature === null ? {} : { temperature: model.temperature }),
            maxOutputTokens: contract.maxOutputTokens,
            ...(model.reasoning && 'thinkingBudget' in model.reasoning
              ? { thinkingConfig: { thinkingBudget: model.reasoning.thinkingBudget } }
              : {}),
            ...(model.reasoning && 'thinkingLevel' in model.reasoning
              ? {
                  thinkingConfig: { thinkingLevel: THINKING_LEVELS[model.reasoning.thinkingLevel] },
                }
              : {}),
            httpOptions: { timeout: model.timeoutMs },
          },
        });
      } catch (err) {
        throw classifyGeminiError(err);
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
        });
      try {
        return { data: JSON.parse(text), usage };
      } catch {
        throw new ProviderFailure('INVALID_OUTPUT', {
          message: 'AI provider returned invalid JSON',
          usage,
        });
      }
    },

    async verifyModels(modelIds): Promise<VerifyResult> {
      for (const modelId of new Set(modelIds)) {
        try {
          await client.models.get({
            model: modelId,
            config: { httpOptions: { timeout: VERIFY_TIMEOUT_MS } },
          });
        } catch (err) {
          const { kind } = classifyGeminiError(err);
          return (ACCESS_FAILURE_KINDS as readonly string[]).includes(kind)
            ? { result: 'REJECTED', kind: kind as (typeof ACCESS_FAILURE_KINDS)[number], modelId }
            : { result: 'INCONCLUSIVE' };
        }
      }
      return { result: 'VERIFIED' };
    },
  };
}
