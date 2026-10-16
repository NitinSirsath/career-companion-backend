/**
 * Fake AI errors for testing the AI error screens by hand (`npm run fake-ai-errors -- <fault>`,
 * README "Testing AI error screens"). Each fault is what an AI library itself gives the app for a
 * real provider problem: built with the library's own classes and the provider's own error body,
 * so it goes through the app's real error handling. Nothing here sends a request.
 *
 * Used by the fake-error command (scripts/fake-ai-errors*.cjs, dev mode only) and its tests. The
 * app never imports it.
 */
import { ApiError, FinishReason, GenerateContentResponse } from '@google/genai';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIError as OpenAIError,
} from 'openai';
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
  APIError as AnthropicError,
} from '@anthropic-ai/sdk';
import { AI_CATALOG, AIProviderId } from '../../contracts/aiCatalog';

export const FAKE_AI_ERRORS = {
  busy: 'The provider is busy: Google 503 UNAVAILABLE, OpenAI 503, Anthropic 529 overloaded.',
  'no-answer': 'No answer in time: the AI library stops waiting (here after 5 seconds).',
  deadline: "The provider's own deadline passed: Google 504 DEADLINE_EXCEEDED, 504 for the others.",
  'rate-minute': 'Per-minute limit: 429, and the provider asks to wait 10 seconds.',
  'rate-day': "Daily limit: 429, for Google the free tier's limit per day.",
  key: 'The API key is rejected: Google 400 API_KEY_INVALID, OpenAI and Anthropic 401.',
  billing: 'Billing or account: Google 403 SERVICE_DISABLED, OpenAI no quota, Anthropic no credit.',
  'model-gone': 'The model is not available to this key: 404.',
  unusable: 'An answer the app cannot use: cut off at the token limit (MAX_TOKENS).',
  'no-connection': 'No connection: the request never left (ENOTFOUND).',
  'line-dropped': 'The connection dropped after the request was sent (ECONNRESET).',
  'server-error': 'Server error 500.',
} as const;

export type FakeAiError = keyof typeof FAKE_AI_ERRORS;

export const isFakeAiError = (name: unknown): name is FakeAiError =>
  typeof name === 'string' && Object.hasOwn(FAKE_AI_ERRORS, name);

/** How long a fake "no answer in time" waits. The real wait is the model's own 30 or 60 seconds. */
export const FAKE_TIMEOUT_MS = 5_000;

/** The faults a provider answers with an HTTP error. */
type HttpFault = Exclude<FakeAiError, 'no-answer' | 'unusable' | 'no-connection' | 'line-dropped'>;
type ConnectionFault = 'no-connection' | 'line-dropped';

interface HttpAnswer {
  status: number;
  body: object;
  headers?: Record<string, string>;
}

const HOSTS = Object.fromEntries(
  AI_CATALOG.map((provider) => [provider.id, new URL(provider.baseUrl).hostname]),
) as Record<AIProviderId, string>;
const PROVIDER_HOSTS = new Set(Object.values(HOSTS));

// ─── Google: ApiError, with Google's JSON error body as its message ─────────

const googleError = (code: number, status: string, message: string, details?: object[]) => ({
  status: code,
  body: { error: { code, message, status, ...(details ? { details } : {}) } },
});

const quotaFailure = (quotaId: string, model: string) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [
    {
      quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
      quotaId,
      quotaDimensions: { location: 'global', model },
      quotaValue: '20',
    },
  ],
});

const RETRY_IN_10_SECONDS = {
  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
  retryDelay: '10s',
};

const errorInfo = (reason: string) => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason,
  domain: 'googleapis.com',
  metadata: { service: 'generativelanguage.googleapis.com' },
});

const QUOTA_MESSAGE =
  'You exceeded your current quota, please check your plan and billing details.';

const GOOGLE: Record<HttpFault, (model: string) => HttpAnswer> = {
  busy: () => googleError(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'),
  deadline: () =>
    googleError(504, 'DEADLINE_EXCEEDED', 'Deadline expired before operation could complete.'),
  'rate-minute': (model) =>
    googleError(429, 'RESOURCE_EXHAUSTED', QUOTA_MESSAGE, [
      quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', model),
      RETRY_IN_10_SECONDS,
    ]),
  // Google's daily-limit answer also carries a short retry delay.
  'rate-day': (model) =>
    googleError(429, 'RESOURCE_EXHAUSTED', QUOTA_MESSAGE, [
      quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier', model),
      RETRY_IN_10_SECONDS,
    ]),
  key: () =>
    googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [
      errorInfo('API_KEY_INVALID'),
    ]),
  billing: () =>
    googleError(
      403,
      'PERMISSION_DENIED',
      'Generative Language API has not been used in this project before or it is disabled.',
      [errorInfo('SERVICE_DISABLED')],
    ),
  'model-gone': (model) =>
    googleError(404, 'NOT_FOUND', `models/${model} is not found for API version v1beta.`),
  'server-error': () => googleError(500, 'INTERNAL', 'An internal error has occurred.'),
};

// ─── OpenAI: `{ error: { message, type, param, code } }` ────────────────────

const openaiError = (
  status: number,
  error: { type: string; code: string | null; message: string },
  headers?: Record<string, string>,
) => ({ status, body: { error: { ...error, param: null } }, headers });

const OPENAI: Record<HttpFault, HttpAnswer> = {
  busy: openaiError(503, {
    type: 'server_error',
    code: null,
    message: 'The server is overloaded or not ready yet.',
  }),
  deadline: openaiError(504, { type: 'server_error', code: null, message: 'Gateway timeout.' }),
  'rate-minute': openaiError(
    429,
    {
      type: 'requests',
      code: 'rate_limit_exceeded',
      message: 'Rate limit reached for requests per min (RPM).',
    },
    { 'retry-after': '10' },
  ),
  'rate-day': openaiError(429, {
    type: 'requests',
    code: 'rate_limit_exceeded',
    message: 'Rate limit reached for requests per day (RPD).',
  }),
  key: openaiError(401, {
    type: 'invalid_request_error',
    code: 'invalid_api_key',
    message: 'Incorrect API key provided.',
  }),
  billing: openaiError(429, {
    type: 'insufficient_quota',
    code: 'insufficient_quota',
    message: QUOTA_MESSAGE,
  }),
  'model-gone': openaiError(404, {
    type: 'invalid_request_error',
    code: 'model_not_found',
    message: 'The model does not exist or you do not have access to it.',
  }),
  'server-error': openaiError(500, {
    type: 'server_error',
    code: null,
    message: 'The server had an error while processing your request.',
  }),
};

// ─── Anthropic: `{ type: 'error', error: { type, message } }` ───────────────

const anthropicError = (
  status: number,
  type: string,
  message: string,
  headers?: Record<string, string>,
) => ({ status, body: { type: 'error', error: { type, message } }, headers });

const ANTHROPIC: Record<HttpFault, HttpAnswer> = {
  busy: anthropicError(529, 'overloaded_error', 'Overloaded'),
  deadline: anthropicError(504, 'timeout_error', 'Request timed out'),
  'rate-minute': anthropicError(
    429,
    'rate_limit_error',
    'Number of requests has exceeded your per-minute rate limit.',
    { 'retry-after': '10' },
  ),
  'rate-day': anthropicError(
    429,
    'rate_limit_error',
    'Number of requests has exceeded your daily rate limit.',
  ),
  key: anthropicError(401, 'authentication_error', 'invalid x-api-key'),
  billing: anthropicError(
    400,
    'invalid_request_error',
    'Your credit balance is too low to access the Anthropic API.',
  ),
  'model-gone': anthropicError(404, 'not_found_error', 'model: not found'),
  'server-error': anthropicError(500, 'api_error', 'Internal server error'),
};

// ─── Shared shapes ──────────────────────────────────────────────────────────

/** A JSON answer cut off at the token limit. */
const CUT_OFF_JSON = '{"decision": "RELEVANT", "confidence": 0.9, "reasoning": "The mail';
const CUT_OFF_USAGE = { input: 800, output: 2048 };

const waitForTimeout = () => new Promise((resolve) => setTimeout(resolve, FAKE_TIMEOUT_MS));

/** What Node's fetch rejects with when the library's own timer stops the request. */
const aborted = () => new DOMException('This operation was aborted', 'AbortError');

/** What Node's fetch throws when a connection fails: the system error is its cause. */
function fetchFailed(fault: ConnectionFault, host: string) {
  const cause =
    fault === 'no-connection'
      ? Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
          code: 'ENOTFOUND',
          syscall: 'getaddrinfo',
          hostname: host,
        })
      : Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' });
  return new TypeError('fetch failed', { cause });
}

const isConnectionFault = (fault: FakeAiError): fault is ConnectionFault =>
  fault === 'no-connection' || fault === 'line-dropped';

async function geminiAnswer(fault: FakeAiError, model: string) {
  if (fault === 'no-answer') {
    await waitForTimeout();
    throw aborted();
  }
  if (isConnectionFault(fault)) throw fetchFailed(fault, HOSTS.gemini);
  if (fault === 'unusable')
    return Object.assign(new GenerateContentResponse(), {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: CUT_OFF_JSON }] },
          finishReason: FinishReason.MAX_TOKENS,
        },
      ],
      usageMetadata: {
        promptTokenCount: CUT_OFF_USAGE.input,
        candidatesTokenCount: CUT_OFF_USAGE.output,
        totalTokenCount: CUT_OFF_USAGE.input + CUT_OFF_USAGE.output,
      },
      modelVersion: model,
    });
  const { status, body } = GOOGLE[fault](model);
  throw new ApiError({ status, message: JSON.stringify(body) });
}

async function openaiAnswer(fault: FakeAiError, unusable: () => object) {
  if (fault === 'no-answer') {
    await waitForTimeout();
    throw Object.assign(new OpenAITimeoutError(), { cause: aborted() });
  }
  if (isConnectionFault(fault))
    throw new OpenAIConnectionError({
      message: 'Connection error.',
      cause: fetchFailed(fault, HOSTS.openai),
    });
  if (fault === 'unusable') return unusable();
  const { status, body, headers } = OPENAI[fault];
  throw OpenAIError.generate(
    status,
    body,
    undefined,
    new Headers({ 'x-request-id': 'req_fake', ...headers }),
  );
}

async function anthropicAnswer(fault: FakeAiError, unusable: () => object) {
  if (fault === 'no-answer') {
    await waitForTimeout();
    throw Object.assign(new AnthropicTimeoutError(), { cause: aborted() });
  }
  if (isConnectionFault(fault))
    throw new AnthropicConnectionError({
      message: 'Connection error.',
      cause: fetchFailed(fault, HOSTS.anthropic),
    });
  if (fault === 'unusable') return unusable();
  const { status, body, headers } = ANTHROPIC[fault];
  throw AnthropicError.generate(
    status,
    body,
    undefined,
    new Headers({ 'request-id': 'req_fake', ...headers }),
  );
}

/**
 * The fake library calls for one fault: Gemini `models.generateContent`, OpenAI
 * `chat.completions.create` and `models.retrieve`, Anthropic `messages.create` and
 * `models.retrieve`. The key checks use the same calls, so they answer with the fault too.
 */
export function fakeAiAnswers(fault: FakeAiError) {
  return {
    gemini: {
      generateContent: (params: { model: string }) => geminiAnswer(fault, params.model),
    },
    openai: {
      create: (body: { model: string }) =>
        openaiAnswer(fault, () => ({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: CUT_OFF_JSON, refusal: null },
              finish_reason: 'length',
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: CUT_OFF_USAGE.input,
            completion_tokens: CUT_OFF_USAGE.output,
            total_tokens: CUT_OFF_USAGE.input + CUT_OFF_USAGE.output,
          },
        })),
      retrieve: (id: string) =>
        openaiAnswer(fault, () => ({ id, object: 'model', created: 0, owned_by: 'openai' })),
    },
    anthropic: {
      create: (body: { model: string }) =>
        anthropicAnswer(fault, () => ({
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: CUT_OFF_JSON }],
          stop_reason: 'max_tokens',
          stop_sequence: null,
          usage: { input_tokens: CUT_OFF_USAGE.input, output_tokens: CUT_OFF_USAGE.output },
        })),
      retrieve: (id: string) =>
        anthropicAnswer(fault, () => ({
          id,
          type: 'model',
          display_name: id,
          created_at: '2026-01-01T00:00:00Z',
        })),
    },
  };
}

/** Wraps fetch so that no request reaches an AI provider, whichever code sends it. */
export function blockProviderRequests(send: typeof fetch): typeof fetch {
  return (input, init) => {
    const { hostname } = new URL(input instanceof Request ? input.url : input);
    if (PROVIDER_HOSTS.has(hostname))
      return Promise.reject(new Error(`Fake AI errors: a request to ${hostname} was blocked`));
    return send(input, init);
  };
}
