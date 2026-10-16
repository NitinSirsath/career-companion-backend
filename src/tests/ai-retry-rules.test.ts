/**
 * The retry rules for one mail, end to end: the real pg-boss queue and workers, the real pipeline,
 * ledger, pause and retry API, and the real Gemini adapter with only the AI library's call faked.
 * No answer in time uses 1 of 3 tries and is tried again by itself after a pause; after the 3rd
 * the mail waits for the user's OK, which allows exactly one more try.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { startAiResumeWorker } from '../jobs/aiResumeJob';
import { startEmailProcessingWorker } from '../jobs/emailProcessingJob';
import { AI_CONTRACT_VERSIONS } from '../services/ai/contracts';
import { resumeWaitingEmails } from '../services/ai/offer';
import { utcDay } from '../services/ai/usage';
import {
  AI_RESUME_JOB,
  EMAIL_PROCESSING_JOB,
  enqueueEmailProcessingJob,
} from '../services/enqueue';
import { fetchMessageMetadata } from '../services/gmailFetcher';
import { getQueue, stopQueue } from '../services/queue';
import { configureAI, pauseOf, setPause } from './helpers/aiAccess';

const generateContent = vi.fn();
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent } };
  }),
}));
vi.mock('../services/gmailFetcher');
// The real enqueue, watched.
vi.mock('../services/enqueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/enqueue')>();
  return { ...actual, enqueueEmailProcessingJob: vi.fn(actual.enqueueEmailProcessingJob) };
});

const EMAIL = 'owner@retry-rules.test';
/** Sorting runs on the recommended fast model. */
const FAST = 'gemini-3.5-flash-lite';
let userId: string;

const notJobMail = {
  text: JSON.stringify({ decision: 'IRRELEVANT', confidence: 0.99, reasoning: 'Not a job.' }),
};
const deadlineExpired = () =>
  new ApiError({
    status: 504,
    message: JSON.stringify({
      error: { code: 504, status: 'DEADLINE_EXCEEDED', message: 'Deadline expired.' },
    }),
  });

const newEmail = async () =>
  (await prisma.email.create({ data: { userId, gmailMessageId: `retry-${Math.random()}` } })).id;
const mail = (id: string) => prisma.email.findUniqueOrThrow({ where: { id } });
const ledger = (emailId: string) => prisma.aIOperation.findFirstOrThrow({ where: { emailId } });
const attempts = async (emailId: string) =>
  (await prisma.aIOperation.findFirst({ where: { emailId } }))?.attempts;
const pause = () => pauseOf(userId, FAST);
const callsToday = async () =>
  (
    await prisma.aIUsageDay.findUnique({
      where: { userId_day: { userId, day: utcDay(new Date()) } },
    })
  )?.calls;
const retry = (emailId: string, body: object) =>
  request(app).post(`/api/emails/${emailId}/retry`).set('X-Development-User', EMAIL).send(body);

/** Polls until the condition holds, as the queue's workers run on their own. */
async function until(condition: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('condition not met in 30 seconds');
}

/** The pause ends and the automatic read runs, as the resume job does then. */
async function pauseEnds() {
  await setPause(userId, FAST, { resumesAt: new Date(Date.now() - 1000) });
  await resumeWaitingEmails(userId);
}

const clearJobs = () =>
  prisma.$executeRaw`DELETE FROM pgboss.job WHERE name IN (${EMAIL_PROCESSING_JOB}, ${AI_RESUME_JOB})`;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  userId = (await prisma.user.create({ data: { email: EMAIL } })).id;
});
beforeEach(async () => {
  generateContent.mockReset();
  vi.mocked(enqueueEmailProcessingJob).mockClear();
  vi.mocked(fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: 'Hello' });
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
  await configureAI(userId, { accessIssue: null });
  await prisma.aIModelPause.deleteMany({ where: { userId } });
  await clearJobs();
});
afterAll(async () => {
  await clearJobs();
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await stopQueue();
});

describe('no answer in time on a per-mail read', () => {
  it('leads to a pause, then a real new try, by itself', async () => {
    const boss = await getQueue();
    generateContent
      .mockRejectedValueOnce(new DOMException('This operation was aborted', 'AbortError'))
      .mockResolvedValueOnce(notJobMail);
    const emailId = await newEmail();
    await startEmailProcessingWorker();
    try {
      const first = await enqueueEmailProcessingJob(userId, emailId);
      // The delivery is withdrawn, so it does not hold the mail's slot for the next try.
      await until(
        async () => (await boss.getJobById(EMAIL_PROCESSING_JOB, first!))?.state === 'cancelled',
      );
      expect(await mail(emailId)).toMatchObject({ processingState: 'PENDING' });
      expect(await ledger(emailId)).toMatchObject({
        status: 'RETRYABLE',
        attempts: 1,
        errorCode: 'OUTCOME_UNKNOWN',
      });
      const { resumesAt, reason } = (await pause())!;
      expect(reason).toBe('PROVIDER_BUSY');

      // The automatic read is queued for the end of the pause. Here the pause ends at once.
      const resumeKey = `resume:${userId}:${resumesAt!.toISOString()}`;
      const [resume] = await prisma.$queryRaw<{ start_after: Date }[]>`
        SELECT start_after FROM pgboss.job
        WHERE name = ${AI_RESUME_JOB} AND singleton_key = ${resumeKey}`;
      expect(resume.start_after.getTime()).toBe(resumesAt!.getTime() + 2_000);
      await setPause(userId, FAST, { resumesAt: new Date(Date.now() - 1000) });
      await prisma.$executeRaw`
        UPDATE pgboss.job SET start_after = now()
        WHERE name = ${AI_RESUME_JOB} AND singleton_key = ${resumeKey}`;
      await startAiResumeWorker();

      await until(async () => (await mail(emailId)).processingState === 'COMPLETED');
      expect(await ledger(emailId)).toMatchObject({ status: 'COMPLETED', attempts: 2 });
      expect(generateContent).toHaveBeenCalledTimes(2);
    } finally {
      await boss.offWork(AI_RESUME_JOB, { wait: true });
      await boss.offWork(EMAIL_PROCESSING_JOB, { wait: true });
    }
  }, 60_000);

  it("after the 3rd try waits for the user's OK; the OK makes exactly one more try", async () => {
    const boss = await getQueue();
    generateContent.mockRejectedValue(deadlineExpired());
    const emailId = await newEmail();
    await startEmailProcessingWorker();
    try {
      await enqueueEmailProcessingJob(userId, emailId);
      for (const attempt of [1, 2]) {
        await until(
          async () =>
            (await attempts(emailId)) === attempt &&
            (await mail(emailId)).processingState === 'PENDING',
        );
        await pauseEnds();
      }
      // The 3rd try gets no answer either: no try is left, so the mail waits for the user's OK.
      await until(async () => (await mail(emailId)).processingState === 'FAILED');
      expect(await ledger(emailId)).toMatchObject({
        status: 'RETRYABLE',
        attempts: 3,
        errorCode: 'OUTCOME_UNKNOWN',
      });
      expect(generateContent).toHaveBeenCalledTimes(3);
      // Each try counts toward the daily safety limit.
      expect(await callsToday()).toBe(3);

      // Not sent a 4th time by itself: when the pause ends there is nothing to offer.
      vi.mocked(enqueueEmailProcessingJob).mockClear();
      await pauseEnds();
      expect(enqueueEmailProcessingJob).not.toHaveBeenCalled();

      // Manual Retry asks for the OK first and says why.
      const asked = await retry(emailId, {});
      expect(asked.status).toBe(409);
      expect(asked.body.error).toMatchObject({
        code: 'AI_RETRY_NEEDS_APPROVAL',
        details: { operations: [{ operation: 'classification', reason: 'ATTEMPTS_EXHAUSTED' }] },
      });
      // The OK makes exactly one more try.
      expect((await retry(emailId, { acceptPossibleDuplicateCharge: true })).status).toBe(200);
      await until(async () => (await attempts(emailId)) === 4);
      await until(async () => (await mail(emailId)).processingState === 'FAILED');
      expect(await ledger(emailId)).toMatchObject({ status: 'RETRYABLE', approvedRetries: 1 });
      vi.mocked(enqueueEmailProcessingJob).mockClear();
      await pauseEnds();
      expect(enqueueEmailProcessingJob).not.toHaveBeenCalled();
      expect(generateContent).toHaveBeenCalledTimes(4);
      expect(await callsToday()).toBe(4);
    } finally {
      await boss.offWork(EMAIL_PROCESSING_JOB, { wait: true });
    }
  }, 90_000);
});

describe('a try still in progress when the worker starts', () => {
  it('goes back to waiting with its try counted; a batch claim keeps its own rules', async () => {
    const boss = await getQueue();
    const perEmail = await newEmail();
    const batch = await newEmail();
    const startedAt = new Date();
    await prisma.aIOperation.createMany({
      data: [
        {
          emailId: perEmail,
          operation: 'extraction',
          version: 'extraction/v3',
          status: 'PROCESSING',
          attempts: 2,
          startedAt,
        },
        {
          emailId: batch,
          operation: 'classification',
          version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
          status: 'PROCESSING',
          attempts: 1,
          startedAt,
        },
      ],
    });
    await startEmailProcessingWorker();
    await boss.offWork(EMAIL_PROCESSING_JOB, { wait: true });
    expect(await ledger(perEmail)).toMatchObject({ status: 'RETRYABLE', attempts: 2 });
    expect(await ledger(batch)).toMatchObject({ status: 'PROCESSING', attempts: 1 });
  });
});
