import { inspect } from 'util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { getCatalogProvider } from '../contracts/aiCatalog';
import { bindCapabilities } from '../services/ai/capabilities';
import { AI_CONTRACT_VERSIONS, CLASSIFICATION_CONTRACT } from '../services/ai/contracts';
import { ProviderFailure } from '../services/ai/errors';
import { classifyGeminiError, createGeminiClient } from '../services/ai/providers/gemini';

const mockGenerateContent = vi.fn();
const mockGet = vi.fn();

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    GoogleGenAI: vi.fn().mockImplementation(function () {
      return { models: { generateContent: mockGenerateContent, get: mockGet } };
    }),
  };
});

const SENTINEL = 'sk-test-SENTINEL-7f3a private email body';
/** The SDK puts the Google error body (JSON) in the message, as ApiError does. */
const googleError = (status: number, body: object = {}) =>
  new ApiError({ status, message: JSON.stringify({ error: { message: SENTINEL, ...body } }) });
/** What Node's fetch throws when a connection fails: the system or undici error is its cause. */
const fetchFailed = (code: string) =>
  new TypeError(`fetch failed ${SENTINEL}`, {
    cause: Object.assign(new Error(`connect ${code} ${SENTINEL}`), { code }),
  });

const failure = (pending: Promise<unknown>) =>
  pending.then(
    () => {
      throw new Error('expected a failure');
    },
    (err: ProviderFailure) => err,
  );

const gemini = getCatalogProvider('gemini')!;
const [flashLite, flash] = gemini.models;
const client = () => createGeminiClient(gemini, 'test_key');
const capabilities = () => bindCapabilities(client(), { fast: flashLite, detailed: flash });

describe('Gemini error mapping (plan §3.6)', () => {
  it.each([
    [
      '400 API_KEY_INVALID',
      googleError(400, { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }),
      'KEY_REJECTED',
    ],
    ['401', googleError(401), 'KEY_REJECTED'],
    [
      '403 PERMISSION_DENIED',
      googleError(403, { status: 'PERMISSION_DENIED' }),
      'ACCOUNT_OR_BILLING',
    ],
    [
      '400 FAILED_PRECONDITION',
      googleError(400, { status: 'FAILED_PRECONDITION' }),
      'ACCOUNT_OR_BILLING',
    ],
    ['404 model', googleError(404, { status: 'NOT_FOUND' }), 'MODEL_UNAVAILABLE'],
    ['429', googleError(429, { status: 'RESOURCE_EXHAUSTED' }), 'RATE_LIMITED'],
    ['503 high demand', googleError(503, { status: 'UNAVAILABLE' }), 'PROVIDER_BUSY'],
    ['504 deadline expired', googleError(504, { status: 'DEADLINE_EXCEEDED' }), 'PROVIDER_BUSY'],
    ['500', googleError(500, { status: 'INTERNAL' }), 'OUTCOME_UNKNOWN'],
    ['502', googleError(502), 'OUTCOME_UNKNOWN'],
    ['408', googleError(408), 'OUTCOME_UNKNOWN'],
    ['other 400', googleError(400, { status: 'INVALID_ARGUMENT' }), 'INVALID_REQUEST'],
    [
      'timeout (no status)',
      Object.assign(new Error(SENTINEL), { name: 'AbortError' }),
      'OUTCOME_UNKNOWN',
    ],
    ['network (no status)', new TypeError(`fetch failed ${SENTINEL}`), 'OUTCOME_UNKNOWN'],
    ['non-JSON body', new ApiError({ status: 429, message: SENTINEL }), 'RATE_LIMITED'],
  ])('%s → %s', (_label, err, kind) => {
    const mapped = classifyGeminiError(err);
    expect(mapped.kind).toBe(kind);
    expect(mapped.isRetryable).toBe(kind === 'RATE_LIMITED' || kind === 'PROVIDER_BUSY');
    // Nothing from the provider's text, and no original error, travels with the failure.
    expect(`${JSON.stringify(mapped)} ${inspect(mapped)} ${mapped.stack}`).not.toContain(
      'SENTINEL',
    );
    expect(mapped.cause).toBeUndefined();
  });

  it.each([
    [
      'our timer (AbortError)',
      new DOMException('This operation was aborted', 'AbortError'),
      'TIMEOUT',
    ],
    ['no DNS answer', fetchFailed('ENOTFOUND'), 'NETWORK', 'ENOTFOUND'],
    ['connection refused', fetchFailed('ECONNREFUSED'), 'NETWORK', 'ECONNREFUSED'],
    [
      'connect timeout',
      fetchFailed('UND_ERR_CONNECT_TIMEOUT'),
      'NETWORK',
      'UND_ERR_CONNECT_TIMEOUT',
    ],
    ['dropped after sending', fetchFailed('ECONNRESET'), 'NETWORK_AFTER_SEND', 'ECONNRESET'],
    [
      'closed while reading the answer',
      new TypeError('terminated', {
        cause: Object.assign(new Error(SENTINEL), { code: 'UND_ERR_SOCKET' }),
      }),
      'NETWORK_AFTER_SEND',
      'UND_ERR_SOCKET',
    ],
    ['a code not on the list', fetchFailed('EHOSTUNREACH'), 'NETWORK_AFTER_SEND'],
    ['a code with text', fetchFailed(`ECONNRESET ${SENTINEL}`), 'NETWORK_AFTER_SEND'],
    ['our own bug', new RangeError(SENTINEL), 'UNCLASSIFIED'],
    ['fetch failed with no cause', new TypeError(`fetch failed ${SENTINEL}`), 'UNCLASSIFIED'],
  ])(
    '%s with no answer → OUTCOME_UNKNOWN, cause %s',
    (_label, err, failureCause, networkCode?: string) => {
      const mapped = classifyGeminiError(err);
      expect(mapped).toMatchObject({ kind: 'OUTCOME_UNKNOWN', failureCause, networkCode });
      expect(mapped.status).toBeUndefined();
      expect(`${JSON.stringify(mapped)} ${inspect(mapped)} ${mapped.stack}`).not.toContain(
        'SENTINEL',
      );
    },
  );

  it.each([
    [
      '504 deadline expired',
      googleError(504, { status: 'DEADLINE_EXCEEDED' }),
      'PROVIDER_DEADLINE',
    ],
    ['503 high demand', googleError(503, { status: 'UNAVAILABLE' }), 'PROVIDER_ANSWER'],
    ['500', googleError(500, { status: 'INTERNAL' }), 'PROVIDER_ANSWER'],
    ['429', googleError(429, { status: 'RESOURCE_EXHAUSTED' }), 'PROVIDER_ANSWER'],
    ['400', googleError(400, { status: 'INVALID_ARGUMENT' }), 'PROVIDER_ANSWER'],
  ])('%s is an answer from Google: cause %s', (_label, err, failureCause) => {
    expect(classifyGeminiError(err)).toMatchObject({ failureCause, networkCode: undefined });
  });

  it('keeps only allowlisted provider tokens and the retry delay', () => {
    const mapped = classifyGeminiError(
      googleError(429, {
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17.5s' }],
      }),
    );
    expect(mapped).toMatchObject({
      status: 429,
      providerCode: 'RESOURCE_EXHAUSTED',
      retryAfterMs: 17_500,
    });
    const unsafe = classifyGeminiError(googleError(400, { status: 'not a token: <script>' }));
    expect(unsafe.providerCode).toBeUndefined();
  });
});

describe('Gemini adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables hidden SDK retries, uses the fixed endpoint and bounds a request', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ decision: 'IRRELEVANT', confidence: 1, reasoning: 'other' }),
    });
    await capabilities().classifier.classifyRelevance({ subject: 'bounded' });
    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test_key',
      httpOptions: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        retryOptions: { attempts: 1 },
      },
    });
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
          // Google's deadline is the model's time limit; our own timer is the abort signal.
          httpOptions: { headers: { 'X-Server-Timeout': '30' } },
          abortSignal: expect.any(AbortSignal),
        }),
      }),
    );
  });

  it('sends a thinking level and no temperature for Gemini 3 models', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ decision: 'IRRELEVANT', confidence: 1, reasoning: 'other' }),
    });
    const lite3 = gemini.models.find((m) => m.id === 'gemini-3.5-flash-lite')!;
    const flash3 = gemini.models.find((m) => m.id === 'gemini-3.8-flash')!;
    await bindCapabilities(client(), {
      fast: lite3,
      detailed: flash3,
    }).classifier.classifyRelevance({ subject: 'a' });
    await bindCapabilities(client(), {
      fast: flash3,
      detailed: flash3,
    }).classifier.classifyRelevance({ subject: 'b' });
    const [first, second] = mockGenerateContent.mock.calls.map(([request]) => request);
    expect(first.model).toBe('gemini-3.5-flash-lite');
    expect(first.config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(first.config).not.toHaveProperty('temperature');
    expect(second.model).toBe('gemini-3.8-flash');
    expect(second.config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(second.config.httpOptions).toEqual({ headers: { 'X-Server-Timeout': '60' } });
  });

  it('turns SDK errors into sanitized provider failures', async () => {
    mockGenerateContent.mockRejectedValue(googleError(429, { status: 'RESOURCE_EXHAUSTED' }));
    const error = await failure(
      capabilities().classifier.classifyRelevance({ subject: 'private' }),
    );
    expect(error).toBeInstanceOf(ProviderFailure);
    expect(error.kind).toBe('RATE_LIMITED');
    expect(error.message).not.toContain('SENTINEL');
  });

  it('builds the answer format before calling Google, so its error is never taken for an answer', async () => {
    const unbuildable = { ...CLASSIFICATION_CONTRACT, schema: z.object({ at: z.date() }) };
    const error = await failure(
      client().generateStructured({ contract: unbuildable, model: flashLite, input: 'x' }),
    );
    expect(error).not.toBeInstanceOf(ProviderFailure);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('runs each contract on the model bound to its role and reports usage', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ decision: 'RELEVANT', confidence: 0.9, reasoning: 'test' }),
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
    });
    const result = await capabilities().classifier.classifyRelevance({
      sender: 'a@b.com',
      subject: 'test',
    });
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash-lite',
        contents: JSON.stringify({ sender: 'a@b.com', subject: 'test' }),
      }),
    );
    expect(result).toMatchObject({
      version: AI_CONTRACT_VERSIONS.CLASSIFICATION,
      model: 'gemini-2.5-flash-lite',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it('accepts a valid structured response', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        decision: 'RELEVANT',
        confidence: 0.8,
        reasoning: 'r',
        category: 'RECRUITER',
      }),
    });
    const result = await capabilities().classifier.classifyRelevance({ sender: 'a' });
    expect(result.data).toMatchObject({ decision: 'RELEVANT', category: 'RECRUITER' });
  });

  it.each([
    [
      JSON.stringify({ decision: 'NOT_A_DECISION', reasoning: SENTINEL }),
      'AI provider returned malformed structured data',
    ],
    ['', 'AI provider returned empty response'],
    [`not json ${SENTINEL}`, 'AI provider returned invalid JSON'],
  ])(
    'reports unusable output %#  as INVALID_OUTPUT with usage and no provider text',
    async (text, message) => {
      mockGenerateContent.mockResolvedValue({
        text,
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
      });
      const error = await failure(capabilities().classifier.classifyRelevance({ sender: 'test' }));
      expect(error).toMatchObject({
        kind: 'INVALID_OUTPUT',
        message,
        usage: { inputTokens: 7, outputTokens: 2 },
      });
      expect(`${JSON.stringify(error)} ${inspect(error)}`).not.toContain('SENTINEL');
    },
  );

  it('extracts missing fields as null on the detailed model', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        companyName: 'TestCo',
        jobTitle: null,
        recruiterName: null,
        recruiterEmail: null,
        interviewStage: null,
        interviewType: null,
        interviewDate: null,
        interviewTime: null,
        assessmentInfo: null,
        assessmentDeadline: null,
        offerInfo: null,
        rejectionInfo: null,
        actionRequired: null,
        requestedAction: null,
        actionDeadline: null,
        followUpRequired: null,
        followUpDate: null,
        extractionConfidence: 0.9,
        provenance: 'body',
      }),
    });
    const result = await capabilities().analyzer.extractJobData('test body');
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-2.5-flash', contents: 'test body' }),
    );
    expect(result.data.companyName).toBe('TestCo');
    expect(result.data.jobTitle).toBeNull();
  });
});

describe('Gemini key check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends one tiny fixed request to each model, with a short timeout, and looks nothing up', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'OK' });
    expect(
      await client().verifyModels([
        'gemini-3.5-flash-lite',
        'gemini-2.5-flash',
        'gemini-2.5-flash',
      ]),
    ).toEqual({
      result: 'VERIFIED',
    });
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(mockGenerateContent).toHaveBeenNthCalledWith(1, {
      model: 'gemini-3.5-flash-lite',
      contents: 'Reply with OK.',
      config: {
        maxOutputTokens: 16,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        httpOptions: { timeout: 10_000 },
      },
    });
    expect(mockGenerateContent).toHaveBeenNthCalledWith(2, {
      model: 'gemini-2.5-flash',
      contents: 'Reply with OK.',
      config: {
        maxOutputTokens: 16,
        thinkingConfig: { thinkingBudget: 0 },
        httpOptions: { timeout: 10_000 },
      },
    });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('refuses a model that Google describes but does not serve to this key', async () => {
    mockGet.mockResolvedValue({ name: 'models/gemini-2.5-flash' });
    mockGenerateContent
      .mockResolvedValueOnce({ text: 'OK' })
      .mockRejectedValueOnce(googleError(404, { status: 'NOT_FOUND' }));
    expect(await client().verifyModels(['gemini-3.5-flash-lite', 'gemini-2.5-flash'])).toEqual({
      result: 'REJECTED',
      kind: 'MODEL_UNAVAILABLE',
      modelId: 'gemini-2.5-flash',
    });
  });

  it.each([
    [
      googleError(400, { details: [{ reason: 'API_KEY_INVALID' }] }),
      { result: 'REJECTED', kind: 'KEY_REJECTED', modelId: 'gemini-2.5-flash-lite' },
    ],
    [
      googleError(403, { status: 'PERMISSION_DENIED' }),
      { result: 'REJECTED', kind: 'ACCOUNT_OR_BILLING', modelId: 'gemini-2.5-flash-lite' },
    ],
    [
      googleError(404),
      { result: 'REJECTED', kind: 'MODEL_UNAVAILABLE', modelId: 'gemini-2.5-flash-lite' },
    ],
    [googleError(429), { result: 'INCONCLUSIVE' }],
    [googleError(503, { status: 'UNAVAILABLE' }), { result: 'INCONCLUSIVE' }],
    [googleError(504, { status: 'DEADLINE_EXCEEDED' }), { result: 'INCONCLUSIVE' }],
    [googleError(500), { result: 'INCONCLUSIVE' }],
    [new TypeError('fetch failed'), { result: 'INCONCLUSIVE' }],
  ])('maps a failed check (%#) without throwing', async (err, expected) => {
    mockGenerateContent.mockRejectedValue(err);
    expect(await client().verifyModels(['gemini-2.5-flash-lite'])).toEqual(expected);
  });
});

describe('Gemini batch relevance contract', () => {
  it('supports a nullable category inside array items and uses the batch contract', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        results: [{ key: 'e1', decision: 'RELEVANT', confidence: 0.9, category: 'INTERVIEW' }],
      }),
    });
    const result = await capabilities().classifier.classifyRelevanceBatch({
      items: [{ key: 'e1', sender: 'a', subject: 'Interview', labels: [], snippet: null }],
    });
    expect(result.data.results).toHaveLength(1);
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash-lite',
        config: expect.objectContaining({ maxOutputTokens: 4096 }),
      }),
    );
  });

  it('treats truncated batch JSON as INVALID_OUTPUT', async () => {
    mockGenerateContent.mockResolvedValue({ text: '{"results":[' });
    const error = await failure(capabilities().classifier.classifyRelevanceBatch({ items: [] }));
    expect(error.kind).toBe('INVALID_OUTPUT');
  });
});
