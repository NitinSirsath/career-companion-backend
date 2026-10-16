import { inspect } from 'util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import { z } from 'zod';
import { getCatalogProvider } from '../contracts/aiCatalog';
import { bindCapabilities } from '../services/ai/capabilities';
import {
  CLASSIFICATION_CONTRACT,
  EXTRACTION_CONTRACT,
  JobExtractionSchema,
} from '../services/ai/contracts';
import { ProviderFailure } from '../services/ai/errors';
import { strictJsonSchema } from '../services/ai/providers/jsonSchema';
import { retryAfterMs } from '../services/ai/providers/headers';
import { classifyOpenAIError, createOpenAIClient } from '../services/ai/providers/openai';

const create = vi.fn();
const retrieve = vi.fn();
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  const OpenAIMock = vi.fn().mockImplementation(function () {
    return { chat: { completions: { create } }, models: { retrieve } };
  });
  return { ...actual, default: OpenAIMock, OpenAI: OpenAIMock };
});

const SENTINEL = 'sk-test-SENTINEL-openai private email body';
const apiError = (
  status: number,
  code?: string | null,
  headers: Record<string, string> = {},
  type = 'invalid_request_error',
) =>
  APIError.generate(
    status,
    { error: { message: `Incorrect API key provided: ${SENTINEL}`, type, code } },
    undefined,
    new Headers(headers),
  );
/** What Node's fetch throws when a connection fails: the system or undici error is its cause. */
const fetchFailed = (code: string) =>
  new TypeError(`fetch failed ${SENTINEL}`, {
    cause: Object.assign(new Error(`connect ${code} ${SENTINEL}`), { code }),
  });
const connectionError = (code: string) =>
  new APIConnectionError({ message: 'Connection error.', cause: fetchFailed(code) });
const failure = (pending: Promise<unknown>) =>
  pending.then(
    () => {
      throw new Error('expected a failure');
    },
    (err: ProviderFailure) => err,
  );

const openai = getCatalogProvider('openai')!;
const [nano, mini] = openai.models;
const client = () => createOpenAIClient(openai, 'sk-test-key');
const capabilities = () => bindCapabilities(client(), { fast: nano, detailed: mini });
const completion = (content: string | null, extra: object = {}) => ({
  choices: [{ finish_reason: 'stop', message: { content, refusal: null }, ...extra }],
  usage: { prompt_tokens: 21, completion_tokens: 8 },
});

beforeEach(() => vi.clearAllMocks());

describe('OpenAI error mapping (plan §3.6)', () => {
  it.each([
    ['401 invalid key', apiError(401, 'invalid_api_key'), 'KEY_REJECTED'],
    [
      '403 region or permission',
      apiError(403, 'unsupported_country_region_territory'),
      'ACCOUNT_OR_BILLING',
    ],
    [
      '429 insufficient_quota (no credit)',
      apiError(429, 'insufficient_quota'),
      'ACCOUNT_OR_BILLING',
    ],
    [
      '429 billing_not_active (no active billing)',
      apiError(429, null, {}, 'billing_not_active'),
      'ACCOUNT_OR_BILLING',
    ],
    [
      '400 billing_hard_limit_reached (spend limit)',
      apiError(400, 'billing_hard_limit_reached'),
      'ACCOUNT_OR_BILLING',
    ],
    ['404 model', apiError(404, 'model_not_found'), 'MODEL_UNAVAILABLE'],
    ['400 model_not_found', apiError(400, 'model_not_found'), 'MODEL_UNAVAILABLE'],
    ['429 rate limit', apiError(429, 'rate_limit_exceeded'), 'RATE_LIMITED'],
    ['500 server error', apiError(500, null, {}, 'server_error'), 'PROVIDER_BUSY'],
    ['502 bad gateway', apiError(502), 'PROVIDER_BUSY'],
    ['503 overloaded', apiError(503, null, {}, 'server_error'), 'PROVIDER_BUSY'],
    ['504 gateway timeout', apiError(504), 'PROVIDER_BUSY'],
    ['409 conflict', apiError(409), 'PROVIDER_BUSY'],
    ['408 (not in the busy list)', apiError(408), 'OUTCOME_UNKNOWN'],
    ['501 (not in the busy list)', apiError(501), 'OUTCOME_UNKNOWN'],
    ['other 400', apiError(400, 'invalid_value'), 'INVALID_REQUEST'],
    ['timeout', new APIConnectionTimeoutError({ message: SENTINEL }), 'OUTCOME_UNKNOWN'],
    ['unknown error', new Error(SENTINEL), 'OUTCOME_UNKNOWN'],
  ])('%s → %s, carrying no provider text', (_label, err, kind) => {
    const mapped = classifyOpenAIError(err);
    expect(mapped.kind).toBe(kind);
    expect(`${JSON.stringify(mapped)} ${inspect(mapped)} ${mapped.stack}`).not.toContain(
      'SENTINEL',
    );
  });

  it.each([
    [
      "the library's own timer",
      Object.assign(new APIConnectionTimeoutError(), {
        cause: new DOMException('This operation was aborted', 'AbortError'),
      }),
      'TIMEOUT',
    ],
    ['a timeout with no cause', new APIConnectionTimeoutError({ message: SENTINEL }), 'TIMEOUT'],
    [
      'undici connect timeout',
      Object.assign(new APIConnectionTimeoutError(), {
        cause: fetchFailed('UND_ERR_CONNECT_TIMEOUT'),
      }),
      'NETWORK',
      'UND_ERR_CONNECT_TIMEOUT',
    ],
    ['no DNS answer', connectionError('ENOTFOUND'), 'NETWORK', 'ENOTFOUND'],
    ['connection refused', connectionError('ECONNREFUSED'), 'NETWORK', 'ECONNREFUSED'],
    ['dropped after sending', connectionError('ECONNRESET'), 'NETWORK_AFTER_SEND', 'ECONNRESET'],
    [
      'closed while reading the answer',
      new TypeError('terminated', {
        cause: Object.assign(new Error(SENTINEL), { code: 'UND_ERR_SOCKET' }),
      }),
      'NETWORK_AFTER_SEND',
      'UND_ERR_SOCKET',
    ],
    [
      'a connection error with no code',
      new APIConnectionError({ message: SENTINEL }),
      'NETWORK_AFTER_SEND',
    ],
    ['an abort we never ask for', new APIUserAbortError({ message: SENTINEL }), 'UNCLASSIFIED'],
    ['unknown error', new Error(SENTINEL), 'UNCLASSIFIED'],
  ])('%s with no answer: cause %s', (_label, err, failureCause, networkCode?: string) => {
    const mapped = classifyOpenAIError(err);
    // A request that never left is busy (no try used); anything else is no answer in time.
    const kind = failureCause === 'NETWORK' ? 'PROVIDER_BUSY' : 'OUTCOME_UNKNOWN';
    expect(mapped).toMatchObject({ kind, failureCause, networkCode });
    expect(`${JSON.stringify(mapped)} ${inspect(mapped)} ${mapped.stack}`).not.toContain(
      'SENTINEL',
    );
  });

  it.each([409, 500, 502, 503, 504])(
    '%i is an answer, not a deadline: cause PROVIDER_ANSWER',
    (status) => {
      expect(classifyOpenAIError(apiError(status))).toMatchObject({
        failureCause: 'PROVIDER_ANSWER',
      });
    },
  );

  it("keeps OpenAI's request ID, so a failure can be found with OpenAI, and only an ID", () => {
    expect(
      classifyOpenAIError(apiError(503, null, { 'x-request-id': 'req_7f3a9c2e41b8d6' })),
    ).toMatchObject({ kind: 'PROVIDER_BUSY', providerRequestId: 'req_7f3a9c2e41b8d6' });
    expect(classifyOpenAIError(apiError(503)).providerRequestId).toBeUndefined();
    const odd = classifyOpenAIError(apiError(503, null, { 'x-request-id': `req ${SENTINEL}` }));
    expect(odd.providerRequestId).toBeUndefined();
    expect(`${JSON.stringify(odd)} ${inspect(odd)}`).not.toContain('SENTINEL');
  });

  it('reads retry-after-ms, retry-after seconds and HTTP dates', () => {
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '1500' }))).toBe(1500);
    expect(retryAfterMs(new Headers({ 'retry-after': '20' }))).toBe(20_000);
    expect(
      retryAfterMs(new Headers({ 'retry-after': new Date(Date.now() + 60_000).toUTCString() })),
    ).toBeGreaterThan(50_000);
    expect(
      classifyOpenAIError(apiError(429, 'rate_limit_exceeded', { 'retry-after': '7' })),
    ).toMatchObject({ retryAfterMs: 7000, providerCode: 'rate_limit_exceeded' });
  });
});

describe('OpenAI adapter', () => {
  it('uses the catalog endpoint, no hidden retries, and no organization or project from the environment', async () => {
    create.mockResolvedValue(
      completion(
        JSON.stringify({ decision: 'IRRELEVANT', confidence: 1, reasoning: 'r', category: null }),
      ),
    );
    await capabilities().classifier.classifyRelevance({ subject: 's' });
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-test-key',
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      organization: null,
      project: null,
    });
  });

  it('sends the contract as strict JSON schema with the right token parameter and reasoning control', async () => {
    create.mockResolvedValue(
      completion(
        JSON.stringify({
          decision: 'RELEVANT',
          confidence: 0.9,
          reasoning: 'r',
          category: 'RECRUITER',
        }),
      ),
    );
    await capabilities().classifier.classifyRelevance({ subject: 'Interview' });
    const [body, options] = create.mock.calls[0];
    expect(body).toMatchObject({
      model: 'gpt-5-nano',
      messages: [
        { role: 'system', content: CLASSIFICATION_CONTRACT.instructions },
        { role: 'user', content: JSON.stringify({ subject: 'Interview' }) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'email_relevance', strict: true },
      },
      max_completion_tokens: 2048,
      reasoning_effort: 'minimal',
      store: false,
    });
    expect(body).not.toHaveProperty('temperature'); // the model does not accept one
    expect(options).toEqual({ timeout: 30_000 });
  });

  it('builds the answer format before calling OpenAI, so its error is never taken for an answer', async () => {
    const unbuildable = { ...CLASSIFICATION_CONTRACT, schema: z.object({ at: z.date() }) };
    const error = await failure(
      client().generateStructured({ contract: unbuildable, model: nano, input: 'x' }),
    );
    expect(error).not.toBeInstanceOf(ProviderFailure);
    expect(create).not.toHaveBeenCalled();
  });

  it('derives a strict schema: every key required, optional keys nullable, nothing extra', () => {
    const schema = strictJsonSchema(CLASSIFICATION_CONTRACT.schema) as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type: unknown; enum?: unknown[] }>;
    };
    expect(schema.required.sort()).toEqual(['category', 'confidence', 'decision', 'reasoning']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.category.type).toEqual(['string', 'null']);
    expect(schema.properties.category.enum).toContain(null);
    expect(schema.properties.confidence).not.toHaveProperty('minimum');
    const extraction = strictJsonSchema(EXTRACTION_CONTRACT.schema) as { required: string[] };
    expect(extraction.required).toHaveLength(19);
  });

  it('turns a null optional field back into an absent one so the unchanged contract validates', async () => {
    create.mockResolvedValue(
      completion(
        JSON.stringify({
          decision: 'IRRELEVANT',
          confidence: 0.95,
          reasoning: 'r',
          category: null,
        }),
      ),
    );
    const result = await capabilities().classifier.classifyRelevance({ subject: 's' });
    expect(result.data).toEqual({ decision: 'IRRELEVANT', confidence: 0.95, reasoning: 'r' });
    expect(result).toMatchObject({
      model: 'gpt-5-nano',
      usage: { inputTokens: 21, outputTokens: 8 },
    });
  });

  it('runs extraction on the detailed model with its own timeout', async () => {
    create.mockResolvedValue(
      completion(
        JSON.stringify(
          Object.fromEntries(Object.keys(JobExtractionSchema.shape).map((k) => [k, null])),
        ),
      ),
    );
    await capabilities().analyzer.extractJobData('body');
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'gpt-5-mini',
      response_format: { json_schema: { name: 'job_extraction' } },
    });
    expect(create.mock.calls[0][1]).toEqual({ timeout: 45_000 });
  });

  it.each([
    ['truncated output', completion('{"decision":', { finish_reason: 'length' }), 'length'],
    [
      'a refusal',
      {
        choices: [{ finish_reason: 'stop', message: { content: null, refusal: SENTINEL } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      'refusal',
    ],
    ['empty content', completion(null), undefined],
    ['non-JSON', completion(`not json ${SENTINEL}`), undefined],
    [
      'schema-invalid JSON',
      completion(JSON.stringify({ decision: 'MAYBE', reasoning: SENTINEL })),
      undefined,
    ],
  ])(
    'reports %s as INVALID_OUTPUT with usage and no provider text',
    async (_label, response, stopReason) => {
      create.mockResolvedValue(response);
      const error = await failure(capabilities().classifier.classifyRelevance({ subject: 's' }));
      expect(error).toBeInstanceOf(ProviderFailure);
      expect(error.kind).toBe('INVALID_OUTPUT');
      // Why it stopped early, or that the model refused: a token, never its text.
      expect(error.stopReason).toBe(stopReason);
      expect(error.usage).toEqual({
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      });
      expect(`${JSON.stringify(error)} ${inspect(error)}`).not.toContain('SENTINEL');
    },
  );

  it('sanitizes SDK errors thrown by a call', async () => {
    create.mockRejectedValue(apiError(429, 'insufficient_quota'));
    const error = await failure(capabilities().classifier.classifyRelevance({ subject: 's' }));
    expect(error).toMatchObject({ kind: 'ACCOUNT_OR_BILLING', status: 429 });
    expect(error.message).not.toContain('SENTINEL');
  });
});

describe('OpenAI content-free verification', () => {
  it('looks up each model once with a short timeout and sends no content', async () => {
    retrieve.mockResolvedValue({ id: 'gpt-5-mini' });
    expect(await client().verifyModels(['gpt-5-nano', 'gpt-5-mini', 'gpt-5-mini'])).toEqual({
      result: 'VERIFIED',
    });
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenCalledWith('gpt-5-nano', { timeout: 10_000 });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [
      apiError(401, 'invalid_api_key'),
      { result: 'REJECTED', kind: 'KEY_REJECTED', modelId: 'gpt-5-nano' },
    ],
    [
      apiError(404, 'model_not_found'),
      { result: 'REJECTED', kind: 'MODEL_UNAVAILABLE', modelId: 'gpt-5-nano' },
    ],
    [
      apiError(429, 'rate_limit_exceeded'),
      {
        result: 'INCONCLUSIVE',
        failure: { kind: 'RATE_LIMITED', httpStatus: 429, providerCode: 'rate_limit_exceeded' },
      },
    ],
    [
      new APIConnectionTimeoutError(),
      { result: 'INCONCLUSIVE', failure: { kind: 'NO_ANSWER_IN_TIME', cause: 'TIMEOUT' } },
    ],
  ])('maps a lookup failure (%#) without throwing, and says why', async (err, expected) => {
    retrieve.mockRejectedValue(err);
    const result = await client().verifyModels(['gpt-5-nano']);
    expect(result).toMatchObject(expected);
    expect(result).toMatchObject({
      failure: { provider: 'openai', model: 'gpt-5-nano', timeoutMs: 10_000 },
    });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });
});

describe('OpenAI batch relevance contract', () => {
  it('uses the batch schema and validates a nullable category', async () => {
    create.mockResolvedValue(
      completion(
        JSON.stringify({
          results: [{ key: 'e1', decision: 'IRRELEVANT', confidence: 0.9, category: null }],
        }),
      ),
    );
    const result = await capabilities().classifier.classifyRelevanceBatch({
      items: [{ key: 'e1', sender: null, subject: 's', labels: [], snippet: null }],
    });
    expect(result.data.results).toHaveLength(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      response_format: { json_schema: { name: 'email_relevance_batch', strict: true } },
      max_completion_tokens: 4096,
    });
  });

  it('treats non-stop batch output as INVALID_OUTPUT', async () => {
    create.mockResolvedValue(completion('{"results":[]}', { finish_reason: 'length' }));
    const error = await failure(capabilities().classifier.classifyRelevanceBatch({ items: [] }));
    expect(error.kind).toBe('INVALID_OUTPUT');
  });
});
