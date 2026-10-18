import type OpenAI from 'openai';
import type { CatalogModel, CatalogProvider } from '../../../contracts/aiCatalog';
import { FailureKind, ProviderFailure } from '../errors';
import {
  errorMessageOf,
  httpAnswerOf,
  openaiLibraryClient,
  replyUsage,
  usableReply,
} from './chatCompletions';
import { retryAfterMs } from './headers';
import { strictJsonSchema } from './jsonSchema';
import { ProviderClient, VERIFY_TIMEOUT_MS } from './types';
import { checkModels } from './verify';

/**
 * OpenRouter, the one provider with its own adapter on another's protocol (ADR-0001 decision 3,
 * owner amendment of 17 Oct 2026). It speaks OpenAI's chat completions, but its model lists are
 * public, its errors mean other things, and every request must ask for private servers. No model
 * names here: whatever differs per model comes from the catalog.
 */

/** Every request: only servers that keep nothing (zero data retention) and take every parameter. */
const ROUTING = { zdr: true, require_parameters: true } as const;

type Thinking = { enabled: false } | { effort: 'low' };

/** Exactly what a request sends: under require_parameters, anything more can leave no server. */
interface OpenRouterRequest {
  model: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  response_format: OpenAI.ResponseFormatJSONSchema;
  max_tokens?: number;
  temperature?: number;
  reasoning?: Thinking;
  provider: typeof ROUTING;
}

const isThinking = (reasoning: CatalogModel['reasoning']): reasoning is Thinking =>
  reasoning !== null && ('enabled' in reasoning || 'effort' in reasoning);

/** The settings a model has in the catalog: a temperature, and its thinking control. */
function modelSettings(model: CatalogModel): Pick<OpenRouterRequest, 'temperature' | 'reasoning'> {
  return {
    ...(model.temperature === null ? {} : { temperature: model.temperature }),
    ...(isThinking(model.reasoning) ? { reasoning: model.reasoning } : {}),
  };
}

/**
 * Every parameter a request sends besides the model and the messages. A server must list them all,
 * or OpenRouter skips it; the key check and the model-check script use this same list.
 */
export function requiredParameters(model: CatalogModel): string[] {
  return [
    ...(model.noOutputLimit ? [] : ['max_tokens']),
    'response_format',
    'structured_outputs',
    ...Object.keys(modelSettings(model)),
  ];
}

/** A field of a JSON value OpenRouter sent; undefined when it is not an object or lacks it. */
function field(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null || !(name in value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, name)?.value;
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** What OpenRouter's error metadata says, as tokens from its own lists. */
interface ErrorFacts {
  errorType?: string;
  limitSource?: string;
  /** A moderation flag carries the reasons and the flagged text: only that they exist is read. */
  moderated: boolean;
}

function errorFacts(error: unknown): ErrorFacts {
  const metadata = field(error, 'metadata');
  return {
    errorType: text(field(metadata, 'error_type')),
    limitSource: text(field(metadata, 'limit_source')),
    moderated:
      field(metadata, 'reasons') !== undefined || field(metadata, 'flagged_input') !== undefined,
  };
}

/** Too much spend still in flight: a limit that passes by itself. */
const IN_FLIGHT_BUDGET = 'openrouter_in_flight_budget';
const BLOCKED_CONTENT = ['content_policy_violation', 'refusal'];
const BUSY_TYPES = ['provider_overloaded', 'provider_unavailable'];

/** Answers whose kind follows from the status alone. */
const KIND_BY_STATUS: Partial<Record<number, FailureKind>> = {
  401: 'KEY_REJECTED',
  404: 'MODEL_UNAVAILABLE',
  408: 'OUTCOME_UNKNOWN',
  429: 'RATE_LIMITED',
  500: 'PROVIDER_BUSY',
  502: 'PROVIDER_BUSY',
};

/**
 * Only blocked content fails the mails of this call. A spend limit or any other refusal needs the
 * user, because a refused batch would fail every mail in it.
 */
const blockedContent = (facts: ErrorFacts) =>
  facts.limitSource === undefined &&
  (facts.moderated || BLOCKED_CONTENT.includes(facts.errorType ?? ''));

function answerKind(status: number, facts: ErrorFacts): FailureKind {
  const fixed = KIND_BY_STATUS[status];
  if (fixed) return fixed;
  if (status === 402)
    return facts.limitSource === IN_FLIGHT_BUDGET ? 'RATE_LIMITED' : 'ACCOUNT_OR_BILLING';
  if (status === 403) return blockedContent(facts) ? 'INVALID_REQUEST' : 'ACCOUNT_OR_BILLING';
  // A 503 that is not "overloaded" means no server meets our rules (zero retention, every parameter).
  if (status === 503)
    return facts.errorType === 'provider_overloaded' ? 'PROVIDER_BUSY' : 'MODEL_UNAVAILABLE';
  return status >= 500 ? 'OUTCOME_UNKNOWN' : 'INVALID_REQUEST';
}

/**
 * OpenRouter's error table. A starting table: each row must be confirmed with a real key before
 * the provider is offered in production. The provider code is a token from OpenRouter's own lists,
 * never its numeric code or its text.
 */
export function classifyOpenRouterError(err: unknown): ProviderFailure {
  const answer = httpAnswerOf(err);
  if (answer instanceof ProviderFailure) return answer;
  const facts = errorFacts(answer.error);
  return new ProviderFailure(answerKind(answer.status, facts), {
    status: answer.status,
    providerCode: facts.limitSource ?? facts.errorType,
    retryAfterMs: retryAfterMs(answer.headers),
    providerRequestId: answer.requestID ?? undefined,
    providerMessage: errorMessageOf(answer.error),
  });
}

function failedAnswerKind(errorType: string | undefined): FailureKind {
  if (errorType !== undefined && BUSY_TYPES.includes(errorType)) return 'PROVIDER_BUSY';
  return errorType === 'rate_limit_exceeded' ? 'RATE_LIMITED' : 'OUTCOME_UNKNOWN';
}

/**
 * A server that failed after OpenRouter answered 200 leaves an error in the body instead of an
 * answer. A body with no choices at all cannot be used either.
 */
function unusableAnswer(completion: OpenAI.ChatCompletion): ProviderFailure | undefined {
  const choices: unknown = completion.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const error = field(completion, 'error') ?? field(firstChoice, 'error');
  const usage = replyUsage(completion);
  if (typeof error === 'object' && error !== null) {
    const { errorType } = errorFacts(error);
    return new ProviderFailure(failedAnswerKind(errorType), {
      providerCode: errorType,
      usage,
      providerMessage: errorMessageOf(error),
    });
  }
  return Array.isArray(choices) ? undefined : new ProviderFailure('INVALID_OUTPUT', { usage });
}

/** The key's own record: the public model lists prove nothing about a key. */
async function checkKey(client: OpenAI): Promise<void> {
  const record = await client.get<unknown>('/key', { timeout: VERIFY_TIMEOUT_MS });
  // null: the key has no spend limit.
  const remaining = field(field(record, 'data'), 'limit_remaining');
  if (typeof remaining === 'number' && remaining <= 0)
    throw new ProviderFailure('ACCOUNT_OR_BILLING', { providerCode: 'openrouter_key_limit' });
}

interface Server {
  model: string;
  parameters: unknown[];
}

/** OpenRouter's public list of servers that keep nothing, with the parameters each one takes. */
async function zeroRetentionServers(client: OpenAI): Promise<Server[]> {
  const list = field(
    await client.get<unknown>('/endpoints/zdr', { timeout: VERIFY_TIMEOUT_MS }),
    'data',
  );
  // An empty or unknown list decides nothing about the key or the models.
  if (!Array.isArray(list) || list.length === 0) throw new ProviderFailure('INVALID_OUTPUT');
  return list.flatMap((entry: unknown) => {
    const model = field(entry, 'model_id');
    const parameters = field(entry, 'supported_parameters');
    return typeof model === 'string' && Array.isArray(parameters) ? [{ model, parameters }] : [];
  });
}

/** A private server takes our request when it lists every parameter we send. */
function takesRequest(servers: Server[], model: CatalogModel): boolean {
  const required = requiredParameters(model);
  return servers.some(
    (server) =>
      server.model === model.id && required.every((name) => server.parameters.includes(name)),
  );
}

export function createOpenRouterClient(provider: CatalogProvider, apiKey: string): ProviderClient {
  const client = openaiLibraryClient(provider, apiKey);
  return {
    async generateStructured({ contract, model, input }) {
      // Built before the call: an error in our own code is never taken for the provider's answer.
      const body: OpenRouterRequest = {
        model: model.id,
        messages: [
          { role: 'system', content: contract.instructions },
          { role: 'user', content: input },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: contract.schemaName,
            schema: strictJsonSchema(contract.schema),
            strict: true,
          },
        },
        ...(model.noOutputLimit ? {} : { max_tokens: contract.maxOutputTokens }),
        ...modelSettings(model),
        provider: ROUTING,
      };
      let completion: OpenAI.ChatCompletion;
      try {
        completion = await client.chat.completions.create(body, { timeout: model.timeoutMs });
      } catch (err) {
        throw classifyOpenRouterError(err);
      }
      const unusable = unusableAnswer(completion);
      if (unusable) throw unusable;
      return usableReply(completion, contract.schema);
    },

    verifyModels: (modelIds) => {
      // The key first, then one list of private servers for every model; each is read once.
      let key: Promise<void> | undefined;
      let servers: Promise<Server[]> | undefined;
      return checkModels(
        provider.id,
        modelIds,
        async (modelId) => {
          key ??= checkKey(client);
          await key;
          servers ??= zeroRetentionServers(client);
          const model = provider.models.find((m) => m.id === modelId);
          if (!model || !takesRequest(await servers, model))
            throw new ProviderFailure('MODEL_UNAVAILABLE');
        },
        classifyOpenRouterError,
      );
    },
  };
}
