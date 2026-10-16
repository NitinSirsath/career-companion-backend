/**
 * End-to-end redaction (BYO AI plan §8): a recognizable key and recognizable email text are pushed
 * through save, verify, check, sample test, processing and every failure kind, with the real
 * Gemini, OpenAI and Anthropic adapters whose SDK errors and responses echo both. Neither may
 * appear in any log line, HTTP response (the exact error included: the mail list, the AI settings,
 * the retry dialog), or stored row (the sealed key never contains the plaintext).
 */
import type { JobWithMetadata } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeout,
  APIError as OpenAIError,
} from 'openai';
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicTimeout,
  APIError as AnthropicError,
} from '@anthropic-ai/sdk';
import { getCatalogProvider } from '../contracts/aiCatalog';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { processEmailJob } from '../jobs/emailProcessingJob';
import { EmailProcessingJobData } from '../services/enqueue';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';

const generateContent = vi.fn();
const get = vi.fn();
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent, get } };
  }),
}));
const create = vi.fn();
const retrieve = vi.fn();
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  const OpenAIMock = vi.fn().mockImplementation(function () {
    return { chat: { completions: { create } }, models: { retrieve } };
  });
  return { ...actual, default: OpenAIMock, OpenAI: OpenAIMock };
});
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  const AnthropicMock = vi.fn().mockImplementation(function () {
    return { messages: { create }, models: { retrieve } };
  });
  return { ...actual, default: AnthropicMock, Anthropic: AnthropicMock };
});
vi.mock('../services/gmailFetcher');
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));
vi.mock('../services/queue', () => ({
  getQueue: vi.fn(async () => ({ send: vi.fn(async () => 'job') })),
  stopQueue: vi.fn(),
}));

const KEY = 'AIza-KEYSENTINEL-4f9c2b7d1e';
const CONTENT = 'CONTENTSENTINEL private salary details';
const EMAIL = 'owner@redaction.test';
let userId: string;
const logs: string[] = [];
const responses: string[] = [];

/** An SDK error whose message (the Google error body) echoes the key and the email text. */
const leakyError = (status: number, extra: object = {}) =>
  new ApiError({
    status,
    message: JSON.stringify({
      error: { message: `API key ${KEY} invalid for: ${CONTENT}`, ...extra },
    }),
  });

const as = () => ({ 'X-Development-User': EMAIL });
async function call(method: 'get' | 'put' | 'post' | 'delete', path: string, body?: object) {
  const res = await request(app)
    [method](path)
    .set(as())
    .send(body ?? {});
  responses.push(JSON.stringify(res.body));
  return res;
}
const job = (emailId: string) =>
  ({
    id: `job-${emailId}`,
    data: { userId, emailId },
    retryCount: 0,
    retryLimit: 3,
  }) as JobWithMetadata<EmailProcessingJobData>;
async function processOne(subject: string) {
  const email = await prisma.email.create({
    data: { userId, gmailMessageId: `redaction-${Math.random()}`, subject },
  });
  await processEmailJob(job(email.id)).catch(() => undefined);
  // The exact error of this mail, as the list and the retry dialog show it.
  await call('get', '/api/gmail/messages');
  await call('post', `/api/emails/${email.id}/retry`);
  await call('get', '/api/ai/settings');
  await prisma.aIConfiguration.updateMany({ where: { userId }, data: { accessIssue: null } });
  await prisma.aIModelPause.deleteMany({ where: { userId } });
  return email.id;
}

/** Every log line, response and stored row so far holds neither the key nor the mail text. */
async function expectNothingLeaked() {
  const everything = [logs.join('\n'), responses.join('\n'), await storedText()];
  for (const text of everything) {
    expect(text).not.toContain('KEYSENTINEL');
    expect(text).not.toContain('CONTENTSENTINEL');
  }
}

/** Every stored row in every application table, as text. */
async function storedText(): Promise<string> {
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const dumps = [];
  for (const { name } of tables)
    dumps.push(
      await prisma.$queryRawUnsafe<{ row: string }[]>(
        `SELECT row_to_json(t)::text AS row FROM "${name}" t`,
      ),
    );
  return JSON.stringify(dumps);
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  userId = (await prisma.user.create({ data: { email: EMAIL } })).id;
  for (const method of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
});
beforeEach(() => {
  process.env.AI_USER_DAILY_CALL_LIMIT = '1000';
  vi.mocked(fetchMessageMetadata).mockResolvedValue({
    labelIds: ['INBOX'],
    snippet: CONTENT,
  });
  vi.mocked(fetchMessageBody).mockResolvedValue(`Dear candidate, ${CONTENT}`);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.user.deleteMany({ where: { email: EMAIL } });
});

describe('no key or email content leaks anywhere', () => {
  it('stays out of logs, responses and storage on every path', async () => {
    // Save: rejected (leaky SDK error), malformed key, then verified. The key check is a tiny
    // real request, so its errors and answers come from the same call as real work.
    generateContent.mockRejectedValueOnce(
      leakyError(400, { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }),
    );
    expect(
      (
        await call('put', '/api/ai/settings', {
          provider: 'gemini',
          apiKey: KEY,
          consentDisclosure: 'gemini-draft-2026-10',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call('put', '/api/ai/settings', {
          provider: 'gemini',
          apiKey: `${KEY} with spaces`,
          consentDisclosure: 'gemini-draft-2026-10',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('put', '/api/ai/settings', {
          provider: 'gemini',
          apiKey: `${KEY}${'x'.repeat(600)}`,
        })
      ).status,
    ).toBe(400);
    // The answer of a key check is never read, so an answer that echoes both leaks nothing.
    generateContent
      .mockResolvedValueOnce({ text: `OK ${KEY} ${CONTENT}` })
      .mockResolvedValueOnce({ text: `OK ${KEY} ${CONTENT}` });
    expect(
      (
        await call('put', '/api/ai/settings', {
          provider: 'gemini',
          apiKey: KEY,
          consentDisclosure: 'gemini-draft-2026-10',
        })
      ).status,
    ).toBe(200);

    // Check again: inconclusive and rejected, both with leaky errors.
    generateContent.mockRejectedValueOnce(leakyError(503));
    await call('post', '/api/ai/settings/check');
    generateContent.mockRejectedValueOnce(leakyError(403, { status: 'PERMISSION_DENIED' }));
    await call('post', '/api/ai/settings/check');
    generateContent
      .mockResolvedValueOnce({ text: `OK ${KEY} ${CONTENT}` })
      .mockResolvedValueOnce({ text: `OK ${KEY} ${CONTENT}` });
    await call('post', '/api/ai/settings/check');
    // Google is never asked to describe a model: a description proves nothing about the key.
    expect(get).not.toHaveBeenCalled();

    // Sample test: provider error, then output that echoes the email text but is not usable.
    generateContent.mockRejectedValueOnce(leakyError(500));
    await call('post', '/api/ai/settings/sample-test');
    // Google's 500 is busy: its pause ends here, so the next sample test calls again.
    await prisma.aIModelPause.deleteMany({ where: { userId } });
    generateContent.mockResolvedValueOnce({ text: `not json ${CONTENT} ${KEY}` });
    await call('post', '/api/ai/settings/sample-test');

    // Processing: every failure kind, each with leaky SDK errors or echoing output.
    for (const [status, extra] of [
      [401, {}],
      [403, { status: 'PERMISSION_DENIED' }],
      [404, {}],
      [429, { status: 'RESOURCE_EXHAUSTED' }],
      [503, { status: 'UNAVAILABLE' }],
      [504, { status: 'DEADLINE_EXCEEDED' }],
      [500, {}],
      [400, { status: 'INVALID_ARGUMENT' }],
    ] as const) {
      generateContent.mockRejectedValueOnce(leakyError(status, extra));
      await processOne(`failure ${status}`);
    }
    generateContent.mockRejectedValueOnce(
      Object.assign(new Error(`timeout ${KEY} ${CONTENT}`), { name: 'AbortError' }),
    );
    await processOne('timeout');
    // A lost connection: only a code from the fixed list is kept, never the error's text.
    generateContent.mockRejectedValueOnce(
      new TypeError(`fetch failed ${KEY} ${CONTENT}`, {
        cause: Object.assign(new Error(`${KEY} ${CONTENT}`), { code: `ECONNRESET ${KEY}` }),
      }),
    );
    await processOne('network');
    generateContent.mockResolvedValueOnce({ text: `{"decision": "${CONTENT}", "key": "${KEY}"}` });
    await processOne('schema-invalid');
    generateContent.mockResolvedValueOnce({ text: `${CONTENT} ${KEY}` });
    await processOne('non-JSON');
    // A successful run stores only validated output.
    generateContent.mockResolvedValueOnce({
      text: JSON.stringify({
        decision: 'IRRELEVANT',
        confidence: 0.99,
        reasoning: 'Not about a job.',
      }),
    });
    const done = await processOne('success');
    expect((await prisma.email.findUniqueOrThrow({ where: { id: done } })).processingState).toBe(
      'COMPLETED',
    );

    // Read paths.
    await call('get', '/api/ai/settings');
    await call('get', '/api/gmail/messages');

    // The failure lines were written, so the scan below covers them.
    for (const event of ['ai_call_failed', 'ai_paused', 'job_failed', 'job_waiting_for_ai'])
      expect(logs.join('\n')).toContain(`"event":"${event}"`);
    // The exact error was answered, so the scan below covers it too.
    expect(responses.join('\n')).toContain('"providerCode":"UNAVAILABLE"');
    expect(responses.join('\n')).toContain('"verificationFailure":{');
    await expectNothingLeaked();
    // The key was used (sealed and opened), so the scan above is meaningful.
    expect(await prisma.aIConfiguration.count({ where: { userId } })).toBe(1);
    expect(generateContent).toHaveBeenCalled();
  });
});

/** OpenAI's error body echoes the key and the email text, also in its code. */
const openAIError = (status: number, code?: string) =>
  OpenAIError.generate(
    status,
    { error: { message: `Incorrect API key ${KEY}: ${CONTENT}`, type: `${CONTENT}`, code } },
    undefined,
    new Headers(),
  );
const anthropicError = (status: number, type?: string) =>
  AnthropicError.generate(
    status,
    { type: 'error', error: { type, message: `API key ${KEY} for: ${CONTENT}` } },
    undefined,
    new Headers(),
  );
/** What Node's fetch throws when a connection fails, its text and code echoing both. */
const leakyFetch = () =>
  new TypeError(`fetch failed ${KEY} ${CONTENT}`, {
    cause: Object.assign(new Error(`${KEY} ${CONTENT}`), { code: `ECONNRESET ${KEY}` }),
  });

describe.each([
  {
    provider: 'openai',
    failures: [
      openAIError(401, 'invalid_api_key'),
      openAIError(403),
      openAIError(404, 'model_not_found'),
      openAIError(429, 'insufficient_quota'),
      openAIError(429, `rate ${KEY}`),
      openAIError(503),
      openAIError(500),
      openAIError(400, 'invalid_request'),
      new OpenAITimeout({ message: `${KEY} ${CONTENT}` }),
      new OpenAIConnectionError({ message: `${KEY} ${CONTENT}`, cause: leakyFetch() }),
    ],
    // Answers that echo both and cannot be used: cut off, refused, not JSON.
    unusable: [
      {
        choices: [
          {
            finish_reason: 'length',
            message: { content: `{"a": "${CONTENT} ${KEY}`, refusal: null },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      {
        choices: [
          { finish_reason: 'stop', message: { content: null, refusal: `${KEY} ${CONTENT}` } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      {
        choices: [
          { finish_reason: 'stop', message: { content: `${CONTENT} ${KEY}`, refusal: null } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ],
  },
  {
    provider: 'anthropic',
    failures: [
      anthropicError(401, 'authentication_error'),
      anthropicError(400, 'invalid_request_error'),
      anthropicError(403, 'permission_error'),
      anthropicError(404, 'not_found_error'),
      anthropicError(429, 'rate_limit_error'),
      anthropicError(529, 'overloaded_error'),
      anthropicError(500, 'api_error'),
      anthropicError(504, `${CONTENT}`),
      new AnthropicTimeout({ message: `${KEY} ${CONTENT}` }),
      new AnthropicConnectionError({ message: `${KEY} ${CONTENT}`, cause: leakyFetch() }),
    ],
    unusable: [
      {
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: `${CONTENT} ${KEY}` }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: `no tool ${CONTENT} ${KEY}` }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
  },
])('no key or email content leaks with $provider', ({ provider, failures, unusable }) => {
  const consentDisclosure = getCatalogProvider(provider)!.disclosure.version;

  it('stays out of logs, responses and storage on every path', async () => {
    // Save: the key is refused with an error that echoes it, then accepted.
    retrieve.mockRejectedValueOnce(failures[0]);
    expect(
      (await call('put', '/api/ai/settings', { provider, apiKey: KEY, consentDisclosure })).status,
    ).toBe(422);
    retrieve.mockResolvedValue({ id: 'model' });
    expect(
      (await call('put', '/api/ai/settings', { provider, apiKey: KEY, consentDisclosure })).status,
    ).toBe(200);
    // Check again: the provider cannot confirm (the failure is answered), then refuses.
    retrieve.mockRejectedValueOnce(failures[failures.length - 2]);
    expect((await call('post', '/api/ai/settings/check')).body.verificationFailure).toBeTruthy();
    retrieve.mockRejectedValueOnce(failures[0]);
    await call('post', '/api/ai/settings/check');
    await prisma.aIConfiguration.updateMany({ where: { userId }, data: { accessIssue: null } });
    // Sample test: a failure, then an answer that cannot be used.
    create.mockRejectedValueOnce(failures[failures.length - 2]);
    await call('post', '/api/ai/settings/sample-test');
    create.mockResolvedValueOnce(unusable[0]);
    await call('post', '/api/ai/settings/sample-test');
    await prisma.aIModelPause.deleteMany({ where: { userId } });

    // Processing: every failure kind and every unusable answer.
    for (const failure of failures) {
      create.mockRejectedValueOnce(failure);
      await processOne(`failure ${provider}`);
    }
    for (const answer of unusable) {
      create.mockResolvedValueOnce(answer);
      await processOne(`unusable ${provider}`);
    }

    // The exact error was answered, so the scan below covers it.
    expect(responses.join('\n')).toContain(`"provider":"${provider}"`);
    expect(responses.join('\n')).toContain('"httpStatus":');
    await expectNothingLeaked();
    expect(create).toHaveBeenCalled();
  });
});
