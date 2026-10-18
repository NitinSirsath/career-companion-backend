import { inspect } from 'util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import { z } from 'zod';
import { CatalogModel, getCatalogProvider, recommendedModel } from '../contracts/aiCatalog';
import { bindCapabilities } from '../services/ai/capabilities';
import {
  AIContract,
  CLASSIFICATION_CONTRACT,
  RELEVANCE_BATCH_CONTRACT,
} from '../services/ai/contracts';
import { ProviderFailure } from '../services/ai/errors';
import {
  classifyOpenRouterError,
  createOpenRouterClient,
  requiredParameters,
} from '../services/ai/providers/openrouter';

const create = vi.fn();
const get = vi.fn();
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  const OpenAIMock = vi.fn().mockImplementation(function () {
    return { chat: { completions: { create } }, get };
  });
  return { ...actual, default: OpenAIMock, OpenAI: OpenAIMock };
});

const SENTINEL = 'sk-or-SENTINEL private email body';
/** OpenRouter's error body: a numeric code, its text, and metadata that can echo the mail. */
const routerError = (status: number, metadata?: object, headers: Record<string, string> = {}) =>
  APIError.generate(
    status,
    {
      error: {
        code: status,
        message: `Provider returned error: ${SENTINEL}`,
        ...(metadata ? { metadata: { raw: SENTINEL, provider_name: SENTINEL, ...metadata } } : {}),
      },
    },
    undefined,
    new Headers(headers),
  );
/** What Node's fetch throws when a connection fails: the system or undici error is its cause. */
const fetchFailed = (code: string) =>
  new TypeError(`fetch failed ${SENTINEL}`, {
    cause: Object.assign(new Error(`connect ${code} ${SENTINEL}`), { code }),
  });
const leaks = (value: unknown) =>
  `${JSON.stringify(value)} ${inspect(value)} ${value instanceof Error ? value.stack : ''}`.includes(
    'SENTINEL',
  );
const failure = (pending: Promise<unknown>) =>
  pending.then(
    () => {
      throw new Error('expected a failure');
    },
    (err: ProviderFailure) => err,
  );

const openrouter = getCatalogProvider('openrouter')!;
const fast = recommendedModel(openrouter, 'fast');
const detailed = recommendedModel(openrouter, 'detailed');
const client = () => createOpenRouterClient(openrouter, 'sk-or-test-key');
const completion = (content: string | null, extra: object = {}) => ({
  choices: [{ finish_reason: 'stop', message: { content, refusal: null }, ...extra }],
  usage: { prompt_tokens: 21, completion_tokens: 8 },
});
const RELEVANT = JSON.stringify({
  decision: 'RELEVANT',
  confidence: 0.9,
  reasoning: 'r',
  category: 'RECRUITER',
});
/** One call of a model, and the body and options it sent. */
async function sent(model: CatalogModel, contract: AIContract<unknown> = CLASSIFICATION_CONTRACT) {
  create.mockResolvedValue(completion(RELEVANT));
  await client().generateStructured({ contract, model, input: 'Synthetic mail' });
  const [body, options] = create.mock.calls[create.mock.calls.length - 1];
  return { body, options };
}

beforeEach(() => vi.clearAllMocks());

describe('OpenRouter request', () => {
  it('uses the catalog endpoint, no hidden retries, and no organization or project from the environment', async () => {
    await sent(fast);
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-or-test-key',
      baseURL: openrouter.baseUrl,
      maxRetries: 0,
      organization: null,
      project: null,
    });
  });

  it.each(openrouter.models.map((model) => [model.id, model] as const))(
    '%s: sends only what every private server must take',
    async (_id, model) => {
      const { body, options } = await sent(model);
      expect(Object.keys(body).sort()).toEqual(
        [
          ...(model.noOutputLimit ? [] : ['max_tokens']),
          'messages',
          'model',
          'provider',
          'response_format',
          ...(model.temperature === null ? [] : ['temperature']),
          ...(model.reasoning === null ? [] : ['reasoning']),
        ].sort(),
      );
      expect(body).toMatchObject({
        model: model.id,
        messages: [
          { role: 'system', content: CLASSIFICATION_CONTRACT.instructions },
          { role: 'user', content: 'Synthetic mail' },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: CLASSIFICATION_CONTRACT.schemaName, strict: true },
        },
        // Private servers only: they keep nothing and take every parameter sent.
        provider: { zdr: true, require_parameters: true },
      });
      // A model whose private servers take no output limit gets none; every other gets the
      // contract's.
      expect(body.max_tokens).toBe(
        model.noOutputLimit ? undefined : CLASSIFICATION_CONTRACT.maxOutputTokens,
      );
      expect(body.provider).toEqual({ zdr: true, require_parameters: true });
      if (model.temperature !== null) expect(body.temperature).toBe(model.temperature);
      if (model.reasoning !== null) expect(body.reasoning).toEqual(model.reasoning);
      expect(options).toEqual({ timeout: model.timeoutMs });
      // The key check asks for servers that take exactly what was sent.
      const sentParameters = Object.keys(body).filter(
        (key) => !['model', 'messages', 'provider'].includes(key),
      );
      expect(requiredParameters(model).sort()).toEqual(
        [...sentParameters, 'structured_outputs'].sort(),
      );
    },
  );

  it.each([
    ['no thinking control and no temperature', { reasoning: null, temperature: null }],
    ['thinking turned off', { reasoning: { enabled: false } }],
    ['the lowest effort for a model that always thinks', { reasoning: { effort: 'low' } }],
  ] as const)('sends %s as the catalog says', async (_label, settings) => {
    const model: CatalogModel = { ...fast, ...settings };
    const { body } = await sent(model);
    if (model.reasoning === null) expect(body).not.toHaveProperty('reasoning');
    else expect(body.reasoning).toEqual(model.reasoning);
    if (model.temperature === null) expect(body).not.toHaveProperty('temperature');
    expect(requiredParameters(model)).toContain('structured_outputs');
    expect(requiredParameters(model).includes('reasoning')).toBe(model.reasoning !== null);
  });

  it('sends no output limit for a model whose private servers take none', async () => {
    const model: CatalogModel = { ...fast, noOutputLimit: true };
    const { body } = await sent(model, RELEVANCE_BATCH_CONTRACT);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.provider).toEqual({ zdr: true, require_parameters: true });
    expect(requiredParameters(model)).not.toContain('max_tokens');
    expect(requiredParameters(fast)).toContain('max_tokens');
  });

  it('gives the batch contract its own token budget', async () => {
    const { body } = await sent(fast, RELEVANCE_BATCH_CONTRACT);
    expect(body).toMatchObject({
      max_tokens: RELEVANCE_BATCH_CONTRACT.maxOutputTokens,
      response_format: { json_schema: { name: RELEVANCE_BATCH_CONTRACT.schemaName } },
    });
  });

  it('builds the answer format before calling OpenRouter, so its error is never taken for an answer', async () => {
    const unbuildable = { ...CLASSIFICATION_CONTRACT, schema: z.object({ at: z.date() }) };
    const error = await failure(
      client().generateStructured({ contract: unbuildable, model: fast, input: 'x' }),
    );
    expect(error).not.toBeInstanceOf(ProviderFailure);
    expect(create).not.toHaveBeenCalled();
  });

  it('turns a null optional field back into an absent one, on the model of each role', async () => {
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
    const result = await bindCapabilities(client(), {
      fast,
      detailed,
    }).classifier.classifyRelevance({ subject: 's' });
    expect(result.data).toEqual({ decision: 'IRRELEVANT', confidence: 0.95, reasoning: 'r' });
    expect(result).toMatchObject({ model: fast.id, usage: { inputTokens: 21, outputTokens: 8 } });
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
    ['a body with no choices', { usage: { prompt_tokens: 1, completion_tokens: 1 } }, undefined],
  ])(
    'reports %s as INVALID_OUTPUT with usage and no provider text',
    async (_label, response, stopReason) => {
      create.mockResolvedValue(response);
      const error = await failure(
        client().generateStructured({ contract: CLASSIFICATION_CONTRACT, model: fast, input: 's' }),
      );
      expect(error).toMatchObject({
        kind: 'INVALID_OUTPUT',
        stopReason,
        usage: {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
        },
      });
      expect(leaks(error)).toBe(false);
    },
  );

  const withError = (metadata?: object) => ({
    code: 502,
    message: `Upstream failed: ${SENTINEL}`,
    ...(metadata ? { metadata: { raw: SENTINEL, ...metadata } } : {}),
  });
  it.each([
    ['provider_overloaded', 'PROVIDER_BUSY'],
    ['provider_unavailable', 'PROVIDER_BUSY'],
    ['rate_limit_exceeded', 'RATE_LIMITED'],
    ['server', 'OUTCOME_UNKNOWN'],
    [undefined, 'OUTCOME_UNKNOWN'],
  ] as const)(
    'reads a 200 answer that carries the error %s as %s, in the body or in its choice',
    async (errorType, kind) => {
      const error = withError(errorType ? { error_type: errorType } : undefined);
      const usage = { prompt_tokens: 40, completion_tokens: 3 };
      for (const response of [
        { choices: [], error, usage },
        { choices: [{ finish_reason: 'error', message: { content: '' }, error }], usage },
      ]) {
        create.mockResolvedValueOnce(response);
        const failed = await failure(
          client().generateStructured({
            contract: CLASSIFICATION_CONTRACT,
            model: fast,
            input: 's',
          }),
        );
        expect(failed).toMatchObject({
          kind,
          providerCode: errorType,
          usage: { inputTokens: 40, outputTokens: 3 },
        });
        expect(failed.status).toBeUndefined();
        expect(leaks(failed)).toBe(false);
      }
    },
  );

  it('sanitizes library errors thrown by a call', async () => {
    create.mockRejectedValue(routerError(402));
    const error = await failure(
      client().generateStructured({ contract: CLASSIFICATION_CONTRACT, model: fast, input: 's' }),
    );
    expect(error).toMatchObject({ kind: 'ACCOUNT_OR_BILLING', status: 402 });
    expect(leaks(error)).toBe(false);
  });
});

describe('OpenRouter error table', () => {
  it.each([
    ['401 key', routerError(401), 'KEY_REJECTED'],
    ['402 no credit', routerError(402), 'ACCOUNT_OR_BILLING'],
    [
      '402 too much spend in flight',
      routerError(402, { limit_source: 'openrouter_in_flight_budget' }, { 'retry-after': '7' }),
      'RATE_LIMITED',
    ],
    [
      '403 key limit',
      routerError(403, { limit_source: 'openrouter_key_limit' }),
      'ACCOUNT_OR_BILLING',
    ],
    [
      '403 guardrail budget',
      routerError(403, { limit_source: 'openrouter_guardrail_budget' }),
      'ACCOUNT_OR_BILLING',
    ],
    [
      '403 workspace budget',
      routerError(403, { limit_source: 'openrouter_workspace_budget' }),
      'ACCOUNT_OR_BILLING',
    ],
    [
      '403 content filter',
      routerError(403, { error_type: 'content_policy_violation' }),
      'INVALID_REQUEST',
    ],
    ['403 refusal', routerError(403, { error_type: 'refusal' }), 'INVALID_REQUEST'],
    [
      '403 moderation flag',
      routerError(403, { reasons: [SENTINEL], flagged_input: SENTINEL }),
      'INVALID_REQUEST',
    ],
    ['403 any other refusal', routerError(403), 'ACCOUNT_OR_BILLING'],
    ['404 no such model or server', routerError(404), 'MODEL_UNAVAILABLE'],
    ['408 timed out', routerError(408), 'OUTCOME_UNKNOWN'],
    ['429 rate limit', routerError(429, { error_type: 'rate_limit_exceeded' }), 'RATE_LIMITED'],
    ['500 server error', routerError(500), 'PROVIDER_BUSY'],
    ['502 model down', routerError(502), 'PROVIDER_BUSY'],
    ['503 overloaded', routerError(503, { error_type: 'provider_overloaded' }), 'PROVIDER_BUSY'],
    ['503 no server meets our rules', routerError(503), 'MODEL_UNAVAILABLE'],
    ['504 (not in the table)', routerError(504), 'OUTCOME_UNKNOWN'],
    ['400 bad request', routerError(400), 'INVALID_REQUEST'],
    ['413 too large', routerError(413), 'INVALID_REQUEST'],
  ])('%s → %s, carrying no provider text', (_label, err, kind) => {
    const mapped = classifyOpenRouterError(err);
    expect(mapped).toMatchObject({ kind, status: err.status, failureCause: 'PROVIDER_ANSWER' });
    expect(leaks(mapped)).toBe(false);
  });

  it("takes the provider code and the wait only from OpenRouter's own fields", () => {
    expect(
      classifyOpenRouterError(
        routerError(402, { limit_source: 'openrouter_in_flight_budget' }, { 'retry-after': '7' }),
      ),
    ).toMatchObject({ providerCode: 'openrouter_in_flight_budget', retryAfterMs: 7000 });
    // The spend limit names the case better than the error type.
    expect(
      classifyOpenRouterError(
        routerError(403, { limit_source: 'openrouter_key_limit', error_type: 'permission_denied' }),
      ).providerCode,
    ).toBe('openrouter_key_limit');
    // The numeric code is never a provider code, and free text is never kept.
    expect(classifyOpenRouterError(routerError(402)).providerCode).toBeUndefined();
    const odd = classifyOpenRouterError(routerError(503, { error_type: `odd ${SENTINEL}` }));
    expect(odd).toMatchObject({ kind: 'MODEL_UNAVAILABLE', providerCode: undefined });
  });

  it.each([
    ['a timeout', new APIConnectionTimeoutError({ message: SENTINEL }), 'TIMEOUT'],
    [
      'no DNS answer',
      new APIConnectionError({ message: 'Connection error.', cause: fetchFailed('ENOTFOUND') }),
      'NETWORK',
    ],
    [
      'dropped after sending',
      new APIConnectionError({ message: 'Connection error.', cause: fetchFailed('ECONNRESET') }),
      'NETWORK_AFTER_SEND',
    ],
    ['an abort we never ask for', new APIUserAbortError({ message: SENTINEL }), 'UNCLASSIFIED'],
    ['unknown error', new Error(SENTINEL), 'UNCLASSIFIED'],
  ])('%s with no answer: cause %s', (_label, err, failureCause) => {
    const mapped = classifyOpenRouterError(err);
    const kind = failureCause === 'NETWORK' ? 'PROVIDER_BUSY' : 'OUTCOME_UNKNOWN';
    expect(mapped).toMatchObject({ kind, failureCause });
    expect(leaks(mapped)).toBe(false);
  });
});

describe('OpenRouter key check', () => {
  const keyRecord = (limitRemaining?: number | null) => ({
    data: {
      label: 'sk-or-v1-abc...xyz',
      ...(limitRemaining === undefined ? {} : { limit_remaining: limitRemaining }),
    },
  });
  const takesAll = (model: CatalogModel) => ({
    model_id: model.id,
    supported_parameters: requiredParameters(model),
  });
  const ALL_SERVERS = { data: openrouter.models.map(takesAll) };
  const answers = (key: object, servers: object) =>
    get.mockImplementation(async (path: string) => (path === '/key' ? key : servers));
  const check = () => client().verifyModels([fast.id, detailed.id, detailed.id]);

  it("reads the key's record and one list of private servers, and sends nothing of the user's", async () => {
    answers(keyRecord(null), ALL_SERVERS);
    expect(await check()).toEqual({ result: 'VERIFIED' });
    // Model IDs keep their "/": the list is matched as it is, never looked up by URL.
    expect(get.mock.calls).toEqual([
      ['/key', { timeout: 10_000 }],
      ['/endpoints/zdr', { timeout: 10_000 }],
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a fake key before it looks at any model', async () => {
    get.mockRejectedValue(routerError(401));
    const result = await check();
    expect(result).toMatchObject({
      result: 'REJECTED',
      kind: 'KEY_REJECTED',
      modelId: fast.id,
      failure: { provider: 'openrouter', model: fast.id, httpStatus: 401, timeoutMs: 10_000 },
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(leaks(result)).toBe(false);
  });

  it.each([0, -0.5])('rejects a key with %d of its credit limit left', async (remaining) => {
    answers(keyRecord(remaining), ALL_SERVERS);
    expect(await check()).toMatchObject({
      result: 'REJECTED',
      kind: 'ACCOUNT_OR_BILLING',
      failure: { providerCode: 'openrouter_key_limit' },
    });
  });

  it.each([null, 2, undefined])('accepts a key with limit %s', async (remaining) => {
    answers(keyRecord(remaining), ALL_SERVERS);
    expect(await check()).toEqual({ result: 'VERIFIED' });
  });

  it.each([
    ['no server for the model', { data: [takesAll(fast)] }, detailed],
    [
      'servers that skip one parameter we send',
      {
        data: openrouter.models.map((model) => ({
          ...takesAll(model),
          supported_parameters: requiredParameters(model).filter((p) => p !== 'structured_outputs'),
        })),
      },
      fast,
    ],
  ])('rejects a model with %s', async (_label, servers, model) => {
    answers(keyRecord(null), servers);
    expect(await check()).toMatchObject({
      result: 'REJECTED',
      kind: 'MODEL_UNAVAILABLE',
      modelId: model.id,
    });
  });

  it('accepts a model when one of its servers takes the whole request', async () => {
    answers(keyRecord(null), {
      data: [
        { model_id: fast.id, supported_parameters: ['max_tokens'] },
        ...openrouter.models.map(takesAll),
        { model_id: detailed.id, supported_parameters: [] },
      ],
    });
    expect(await check()).toEqual({ result: 'VERIFIED' });
  });

  it.each([
    ['an empty list', { data: [] }],
    ['an unknown answer', { endpoints: SENTINEL }],
  ])('cannot decide on %s of servers', async (_label, servers) => {
    answers(keyRecord(null), servers);
    const result = await check();
    expect(result).toMatchObject({ result: 'INCONCLUSIVE' });
    expect(leaks(result)).toBe(false);
  });

  it.each([
    [
      routerError(429, { error_type: 'rate_limit_exceeded' }),
      { kind: 'RATE_LIMITED', httpStatus: 429 },
    ],
    [
      routerError(503, { error_type: 'provider_overloaded' }),
      { kind: 'PROVIDER_BUSY', httpStatus: 503 },
    ],
    [new APIConnectionTimeoutError(), { kind: 'NO_ANSWER_IN_TIME', cause: 'TIMEOUT' }],
  ])('cannot decide when the key record is not answered (%#)', async (err, failureFields) => {
    get.mockRejectedValue(err);
    const result = await check();
    expect(result).toMatchObject({
      result: 'INCONCLUSIVE',
      failure: { provider: 'openrouter', timeoutMs: 10_000, ...failureFields },
    });
    expect(leaks(result)).toBe(false);
  });
});
