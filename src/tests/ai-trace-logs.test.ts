/**
 * One mail's AI tries in the log: searching for its ID shows every try with its duration, cause
 * and next step. Real Gemini adapter (SDK mocked), real pipeline, ledger and pause rules. A
 * provider failure is a warning without a stack; only our own bugs are errors.
 */
import type { JobWithMetadata } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { getCatalogProvider, recommendedModel } from '../contracts/aiCatalog';
import { processEmailJob } from '../jobs/emailProcessingJob';
import * as aiPipeline from '../services/ai/pipeline';
import { runOperation } from '../services/ai/operations';
import { EmailProcessingJobData } from '../services/enqueue';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { configureAI, fakeAccess } from './helpers/aiAccess';

const generateContent = vi.fn();
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent } };
  }),
}));
vi.mock('../services/gmailFetcher');
vi.mock('../services/queue', () => ({
  getQueue: vi.fn(async () => ({ send: vi.fn(async () => 'job'), cancel: vi.fn() })),
  stopQueue: vi.fn(),
}));

const EMAIL = 'owner@trace-logs.test';
const SENTINEL = 'TRACESENTINEL';
const FAST = recommendedModel(getCatalogProvider('gemini')!, 'fast');
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
let userId: string;
let lines: Record<string, unknown>[] = [];

/** Google's error, as the SDK throws it; its message text echoes our sentinel. */
const googleError = (status: number, code?: string) =>
  new ApiError({
    status,
    message: JSON.stringify({ error: { message: `${SENTINEL} ${status}`, status: code } }),
  });
const notJobMail = {
  text: JSON.stringify({ decision: 'IRRELEVANT', confidence: 0.99, reasoning: 'Not a job.' }),
};

const job = (emailId: string) =>
  ({
    id: `job-${emailId}`,
    data: { userId, emailId },
    retryCount: 0,
    retryLimit: 3,
  }) as JobWithMetadata<EmailProcessingJobData>;
const newEmail = async () =>
  (
    await prisma.email.create({
      data: { userId, gmailMessageId: `trace-${Math.random()}`, subject: `${SENTINEL} subject` },
    })
  ).id;
const endPause = () =>
  prisma.aIConfiguration.updateMany({
    where: { userId },
    data: { cooldownUntil: null, accessIssue: null },
  });
const linesFor = (id: string) => lines.filter((line) => Object.values(line).includes(id));
const only = (event: string) => {
  const found = lines.filter((line) => line.event === event);
  expect(found).toHaveLength(1);
  return found[0];
};

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  userId = (await prisma.user.create({ data: { email: EMAIL } })).id;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  generateContent.mockReset();
  lines = [];
  for (const method of ['log', 'warn', 'error'] as const)
    vi.spyOn(console, method).mockImplementation((text: unknown) => {
      lines.push(JSON.parse(String(text)) as Record<string, unknown>);
    });
  vi.mocked(fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: SENTINEL });
  vi.mocked(fetchMessageBody).mockResolvedValue(`Dear candidate, ${SENTINEL}`);
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
  await configureAI(userId, { cooldownUntil: null, accessIssue: null, consecutiveFailures: 0 });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.user.deleteMany({ where: { email: EMAIL } });
});

describe("one mail's AI tries in the log", () => {
  it('shows every try of a mail with its duration and result, and the pause it started', async () => {
    const emailId = await newEmail();
    generateContent.mockRejectedValueOnce(googleError(503, 'UNAVAILABLE'));
    await processEmailJob(job(emailId));
    await endPause();
    generateContent.mockResolvedValueOnce(notJobMail);
    await processEmailJob(job(emailId));

    const trace = linesFor(emailId);
    expect(trace.map((line) => line.event)).toEqual([
      'ai_call_started',
      'ai_call_failed',
      'job_waiting_for_ai',
      'ai_call_started',
      'ai_call_completed',
    ]);
    const failed = only('ai_call_failed');
    expect(failed).toMatchObject({
      level: 'warn',
      emailId,
      operation: 'classification',
      attempt: 1,
      model: FAST.id,
      kind: 'PROVIDER_BUSY',
      failureCause: 'PROVIDER_ANSWER',
      status: 503,
      providerCode: 'UNAVAILABLE',
      durationMs: expect.any(Number),
      timeoutMs: FAST.timeoutMs,
      result: 'paused',
      resumesAt: expect.stringMatching(ISO_UTC),
    });
    expect(trace[4]).toMatchObject({ durationMs: expect.any(Number) });
    expect(only('ai_paused')).toMatchObject({
      userId,
      model: FAST.id,
      reason: 'PROVIDER_BUSY',
      pauseMs: 60_000,
      consecutiveFailures: 1,
      resumesAt: failed.resumesAt,
    });
    for (const line of lines) expect(line.time).toMatch(ISO_UTC);
    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
  });

  const answered = (kind: string, failureCause: string, result: string) => ({
    kind,
    failureCause,
    result,
  });
  it.each([
    {
      label: '504 deadline expired',
      answer: googleError(504, 'DEADLINE_EXCEEDED'),
      logged: answered('PROVIDER_BUSY', 'PROVIDER_DEADLINE', 'paused'),
    },
    {
      label: '401 key rejected',
      answer: googleError(401, 'UNAUTHENTICATED'),
      logged: answered('KEY_REJECTED', 'PROVIDER_ANSWER', 'waiting_for_user'),
    },
    {
      label: '500 server error',
      answer: googleError(500, 'INTERNAL'),
      logged: answered('OUTCOME_UNKNOWN', 'PROVIDER_ANSWER', 'held'),
    },
    {
      label: '400 refused request',
      answer: googleError(400, 'INVALID_ARGUMENT'),
      logged: answered('INVALID_REQUEST', 'PROVIDER_ANSWER', 'held'),
    },
    {
      label: 'an unusable answer',
      answer: { text: `not json ${SENTINEL}` },
      logged: answered('INVALID_OUTPUT', 'PROVIDER_ANSWER', 'held'),
    },
  ])(
    'logs $label with its cause and next step, as a warning without a stack',
    async ({ answer, logged }) => {
      if (answer instanceof Error) generateContent.mockRejectedValueOnce(answer);
      else generateContent.mockResolvedValueOnce(answer);
      const emailId = await newEmail();
      await processEmailJob(job(emailId)).catch(() => undefined);

      expect(only('ai_call_failed')).toMatchObject({ level: 'warn', emailId, ...logged });
      const outcome = linesFor(emailId).find((line) => String(line.event).startsWith('job_'));
      expect(outcome).toMatchObject(
        logged.result === 'held'
          ? { event: 'job_failed', level: 'warn', errorCategory: expect.any(String) }
          : { event: 'job_waiting_for_ai' },
      );
      for (const line of linesFor(emailId)) {
        expect(line).not.toHaveProperty('category');
        expect(line).not.toHaveProperty('where');
      }
      expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    },
  );

  /** What Node's fetch throws when a connection fails: the system error is its cause. */
  const fetchFailed = (code: string) =>
    new TypeError(`fetch failed ${SENTINEL}`, {
      cause: Object.assign(new Error(`${code} ${SENTINEL}`), { code }),
    });
  it.each([
    {
      label: 'our timer stopped',
      error: new DOMException(`aborted ${SENTINEL}`, 'AbortError'),
      logged: { failureCause: 'TIMEOUT' },
    },
    {
      label: 'never reached Google',
      error: fetchFailed('ECONNREFUSED'),
      logged: { failureCause: 'NETWORK', networkCode: 'ECONNREFUSED' },
    },
    {
      label: 'lost the line after sending',
      error: fetchFailed('ECONNRESET'),
      logged: { failureCause: 'NETWORK_AFTER_SEND', networkCode: 'ECONNRESET' },
    },
  ])('logs the cause of a call that $label, still held as today', async ({ error, logged }) => {
    generateContent.mockRejectedValueOnce(error);
    const emailId = await newEmail();
    await processEmailJob(job(emailId));
    const failed = only('ai_call_failed');
    expect(failed).toMatchObject({
      level: 'warn',
      emailId,
      kind: 'OUTCOME_UNKNOWN',
      result: 'held',
      timeoutMs: FAST.timeoutMs,
      ...logged,
    });
    expect(failed).not.toHaveProperty('status');
    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
  });

  it('logs an error we cannot sort as our own bug: an error with where it broke, never its text', async () => {
    const emailId = await newEmail();
    const bug = runOperation({
      userId,
      emailId,
      operation: 'classification',
      contract: { version: 'v1', schema: z.object({}), role: 'fast' },
      access: async () => fakeAccess(userId),
      call: async () => {
        throw new TypeError(`cannot read ${SENTINEL}`);
      },
    });
    await expect(bug).rejects.toThrow(TypeError);
    expect(only('ai_call_failed')).toMatchObject({
      level: 'error',
      emailId,
      attempt: 1,
      kind: 'UNCLASSIFIED',
      failureCause: 'UNCLASSIFIED',
      result: 'held',
      category: 'TypeError',
      where: expect.stringMatching(/^src\/tests\/ai-trace-logs\.test\.ts:\d+$/),
    });
    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
  });

  it('logs a job that failed on our own bug as an error, with one category', async () => {
    const emailId = await newEmail();
    vi.spyOn(aiPipeline, 'processEmail').mockRejectedValue(new RangeError(`bad ${SENTINEL}`));
    await expect(processEmailJob(job(emailId))).rejects.toThrow();
    const failed = only('job_failed');
    expect(failed).toMatchObject({
      level: 'error',
      emailId,
      outcome: 'retry_scheduled',
      category: 'RangeError',
      where: expect.stringMatching(/^src\/tests\/ai-trace-logs\.test\.ts:\d+$/),
    });
    expect(failed).not.toHaveProperty('errorCategory');
    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
  });
});
