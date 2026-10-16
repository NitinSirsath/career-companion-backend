/**
 * End-to-end redaction (BYO AI plan §8): a recognizable key and recognizable email text are pushed
 * through save, verify, check, sample test, processing and every failure kind, with the real
 * Gemini adapter whose SDK errors and responses echo both. Neither may appear in any log line,
 * HTTP response, or stored row (the sealed key never contains the plaintext).
 */
import type { JobWithMetadata } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
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
  await prisma.aIConfiguration.updateMany({
    where: { userId },
    data: { cooldownUntil: null, accessIssue: null },
  });
  return email.id;
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

    const everything = [logs.join('\n'), responses.join('\n'), await storedText()];
    for (const text of everything) {
      expect(text).not.toContain('KEYSENTINEL');
      expect(text).not.toContain('CONTENTSENTINEL');
    }
    // The key was used (sealed and opened), so the scan above is meaningful.
    expect(await prisma.aIConfiguration.count({ where: { userId } })).toBe(1);
    expect(generateContent).toHaveBeenCalled();
  });
});
