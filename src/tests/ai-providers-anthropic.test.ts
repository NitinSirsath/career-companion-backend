import { inspect } from 'util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Anthropic, { APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk';
import { getCatalogProvider } from '../contracts/aiCatalog';
import { bindCapabilities } from '../services/ai/capabilities';
import { CLASSIFICATION_CONTRACT, JobExtractionSchema } from '../services/ai/contracts';
import { ProviderFailure } from '../services/ai/errors';
import { classifyAnthropicError, createAnthropicClient } from '../services/ai/providers/anthropic';
import { strictJsonSchema } from '../services/ai/providers/jsonSchema';

const create = vi.fn();
const retrieve = vi.fn();
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  const AnthropicMock = vi.fn().mockImplementation(function () {
    return { messages: { create }, models: { retrieve } };
  });
  return { ...actual, default: AnthropicMock, Anthropic: AnthropicMock };
});

const SENTINEL = 'sk-ant-test-SENTINEL private email body';
const apiError = (status: number, type?: string, message = SENTINEL, headers: Record<string, string> = {}) =>
  APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers(headers));
const failure = (pending: Promise<unknown>) =>
  pending.then(() => { throw new Error('expected a failure'); }, (err: ProviderFailure) => err);

const claude = getCatalogProvider('anthropic')!;
const [haiku, sonnet] = claude.models;
const client = () => createAnthropicClient(claude, 'sk-ant-test-key');
const usage = { input_tokens: 30, output_tokens: 12 };
const toolReply = (input: unknown, extra: object = {}) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 't', name: 'email_relevance', input }],
  usage,
  ...extra,
});
const textReply = (text: string, extra: object = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage, ...extra });
const extraction = Object.fromEntries(Object.keys(JobExtractionSchema.shape).map((k) => [k, null]));

beforeEach(() => vi.clearAllMocks());

describe('Anthropic error mapping (plan §3.6)', () => {
  it.each([
    ['401 authentication_error', apiError(401, 'authentication_error'), 'KEY_REJECTED'],
    ['billing_error', apiError(400, 'billing_error'), 'ACCOUNT_OR_BILLING'],
    ['400 low credit balance', apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the API.'), 'ACCOUNT_OR_BILLING'],
    ['403 permission_error', apiError(403, 'permission_error'), 'ACCOUNT_OR_BILLING'],
    ['404 not_found_error', apiError(404, 'not_found_error'), 'MODEL_UNAVAILABLE'],
    ['429 rate_limit_error', apiError(429, 'rate_limit_error'), 'RATE_LIMITED'],
    ['529 overloaded_error', apiError(529, 'overloaded_error'), 'RATE_LIMITED'],
    ['500 api_error', apiError(500, 'api_error'), 'OUTCOME_UNKNOWN'],
    ['504 timeout_error', apiError(504, 'timeout_error'), 'OUTCOME_UNKNOWN'],
    ['other 400', apiError(400, 'invalid_request_error'), 'INVALID_REQUEST'],
    ['413', apiError(413, 'request_too_large'), 'INVALID_REQUEST'],
    ['timeout', new APIConnectionTimeoutError({ message: SENTINEL }), 'OUTCOME_UNKNOWN'],
    ['unknown error', new Error(SENTINEL), 'OUTCOME_UNKNOWN'],
  ])('%s → %s, carrying no provider text', (_label, err, kind) => {
    const mapped = classifyAnthropicError(err);
    expect(mapped.kind).toBe(kind);
    expect(`${JSON.stringify(mapped)} ${inspect(mapped)} ${mapped.stack}`).not.toContain('SENTINEL');
    expect(`${JSON.stringify(mapped)}`).not.toContain('credit balance');
  });

  it('keeps the error type token and the retry-after delay', () => {
    expect(classifyAnthropicError(apiError(429, 'rate_limit_error', 'x', { 'retry-after': '12' }))).toMatchObject({
      providerCode: 'rate_limit_error',
      retryAfterMs: 12_000,
    });
  });
});

describe('Anthropic adapter', () => {
  it('uses the catalog endpoint, no hidden retries, and no token from the environment', async () => {
    create.mockResolvedValue(toolReply({ decision: 'IRRELEVANT', confidence: 1, reasoning: 'r', category: null }));
    await bindCapabilities(client(), { fast: haiku, detailed: haiku }).classifier.classifyRelevance({ subject: 's' });
    expect(Anthropic).toHaveBeenCalledWith({ apiKey: 'sk-ant-test-key', authToken: null, baseURL: 'https://api.anthropic.com', maxRetries: 0 });
  });

  it('forces a tool call with the strict schema when the model uses tool mode', async () => {
    create.mockResolvedValue(toolReply({ decision: 'RELEVANT', confidence: 0.9, reasoning: 'r', category: 'INTERVIEW' }));
    const result = await bindCapabilities(client(), { fast: haiku, detailed: haiku }).classifier.classifyRelevance({ subject: 'Interview' });
    const [body, options] = create.mock.calls[0];
    expect(body).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: CLASSIFICATION_CONTRACT.instructions,
      messages: [{ role: 'user', content: JSON.stringify({ subject: 'Interview' }) }],
      temperature: 0.1,
      tools: [{ name: 'email_relevance', input_schema: strictJsonSchema(CLASSIFICATION_CONTRACT.schema) }],
      tool_choice: { type: 'tool', name: 'email_relevance' },
    });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('output_config');
    expect(options).toEqual({ timeout: 30_000 });
    expect(result).toMatchObject({ data: { category: 'INTERVIEW' }, usage: { inputTokens: 30, outputTokens: 12 } });
  });

  it('uses native JSON-schema output when the model supports it', async () => {
    create.mockResolvedValue(textReply(JSON.stringify(extraction)));
    const result = await bindCapabilities(client(), { fast: haiku, detailed: sonnet }).analyzer.extractJobData('body');
    const [body, options] = create.mock.calls[0];
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { format: { type: 'json_schema' } } });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('temperature');
    expect(options).toEqual({ timeout: 60_000 });
    expect(result.data.companyName).toBeNull();
  });

  it('turns a null optional field back into an absent one', async () => {
    create.mockResolvedValue(toolReply({ decision: 'IRRELEVANT', confidence: 0.9, reasoning: 'r', category: null }));
    const result = await bindCapabilities(client(), { fast: haiku, detailed: haiku }).classifier.classifyRelevance({ subject: 's' });
    expect(result.data).toEqual({ decision: 'IRRELEVANT', confidence: 0.9, reasoning: 'r' });
  });

  it.each([
    ['truncated output', toolReply({ decision: 'RELEVANT' }, { stop_reason: 'max_tokens' })],
    ['a refusal', textReply(SENTINEL, { stop_reason: 'refusal' })],
    ['no tool call', textReply(`no tool ${SENTINEL}`)],
    ['schema-invalid input', toolReply({ decision: 'MAYBE', reasoning: SENTINEL })],
  ])('reports %s as INVALID_OUTPUT with usage and no provider text', async (_label, reply) => {
    create.mockResolvedValue(reply);
    const error = await failure(bindCapabilities(client(), { fast: haiku, detailed: haiku }).classifier.classifyRelevance({ subject: 's' }));
    expect(error).toMatchObject({ kind: 'INVALID_OUTPUT', usage: { inputTokens: 30, outputTokens: 12 } });
    expect(`${JSON.stringify(error)} ${inspect(error)}`).not.toContain('SENTINEL');
  });

  it('reports non-JSON native output as INVALID_OUTPUT', async () => {
    create.mockResolvedValue(textReply(`not json ${SENTINEL}`));
    const error = await failure(bindCapabilities(client(), { fast: haiku, detailed: sonnet }).analyzer.extractJobData('b'));
    expect(error).toMatchObject({ kind: 'INVALID_OUTPUT', message: 'AI provider returned invalid JSON' });
  });

  it('sanitizes SDK errors thrown by a call', async () => {
    create.mockRejectedValue(apiError(529, 'overloaded_error'));
    const error = await failure(bindCapabilities(client(), { fast: haiku, detailed: haiku }).classifier.classifyRelevance({ subject: 's' }));
    expect(error).toMatchObject({ kind: 'RATE_LIMITED', status: 529 });
    expect(error.message).not.toContain('SENTINEL');
  });
});

describe('Anthropic content-free verification', () => {
  it('looks up each model once with a short timeout and sends no content', async () => {
    retrieve.mockResolvedValue({ id: 'claude-haiku-4-5-20251001' });
    expect(await client().verifyModels(['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'])).toEqual({ result: 'VERIFIED' });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith('claude-haiku-4-5-20251001', {}, { timeout: 10_000 });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [apiError(401, 'authentication_error'), { result: 'REJECTED', kind: 'KEY_REJECTED', modelId: 'claude-sonnet-5-5' }],
    [apiError(404, 'not_found_error'), { result: 'REJECTED', kind: 'MODEL_UNAVAILABLE', modelId: 'claude-sonnet-5-5' }],
    [apiError(529, 'overloaded_error'), { result: 'INCONCLUSIVE' }],
    [new APIConnectionTimeoutError(), { result: 'INCONCLUSIVE' }],
  ])('maps a lookup failure (%#) without throwing', async (err, expected) => {
    retrieve.mockRejectedValue(err);
    expect(await client().verifyModels(['claude-sonnet-5-5'])).toEqual(expected);
  });
});
