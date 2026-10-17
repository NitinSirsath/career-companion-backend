/**
 * Each model pauses on its own, end to end: the real queue and workers, pipeline, ledger, pauses,
 * the resume job and "Read waiting mails now", with only the provider client faked. Also the
 * migration that moves today's single pause onto the Detailed model.
 */
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import type { JobWithMetadata } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { startAiResumeWorker } from '../jobs/aiResumeJob';
import { processEmailJob, startEmailProcessingWorker } from '../jobs/emailProcessingJob';
import { JobExtractionSchema } from '../services/ai/contracts';
import { ProviderFailure } from '../services/ai/errors';
import { reofferPendingEmails, resumeWaitingEmails } from '../services/ai/offer';
import { createProviderClient } from '../services/ai/providers';
import {
  AI_RESUME_JOB,
  EMAIL_PROCESSING_JOB,
  EmailProcessingJobData,
  enqueueEmailProcessingJob,
} from '../services/enqueue';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { getQueue, stopQueue } from '../services/queue';
import { configureAI, pauseOf, setPause } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
// The real enqueue, watched.
vi.mock('../services/enqueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/enqueue')>();
  return {
    ...actual,
    enqueueEmailProcessingJob: vi.fn(actual.enqueueEmailProcessingJob),
    enqueueNotificationJob: vi.fn(),
  };
});

const EMAIL = 'owner@model-pause.test';
/** Fast screening: Gemini 3.5 Flash-Lite. Detailed analysis: Gemini 3.8 Flash. */
const FAST = 'gemini-3.5-flash-lite';
const DETAILED = 'gemini-3.8-flash';
let userId: string;

const relevant = { decision: 'RELEVANT', category: 'INTERVIEW', confidence: 0.95, reasoning: 'r' };
const notJobMail = { decision: 'IRRELEVANT', confidence: 0.99, reasoning: 'r' };
const extraction = JobExtractionSchema.parse({
  ...Object.fromEntries(Object.keys(JobExtractionSchema.shape).map((key) => [key, null])),
  companyName: 'Northwind Robotics',
});
const busy = () => {
  throw new ProviderFailure('PROVIDER_BUSY', { status: 503, providerCode: 'UNAVAILABLE' });
};
/** What Gemini 3.8 Flash answers when it reads a mail's details. */
let detail: () => unknown;
const client = fakeProviderClient({
  classification: (input: string) => (input.includes('Newsletter') ? notJobMail : relevant),
  extraction: () => detail(),
});

const newEmail = async (day: number, subject = 'Interview') =>
  (
    await prisma.email.create({
      data: {
        userId,
        gmailMessageId: `pause-${day}-${Math.random()}`,
        subject,
        receivedAt: new Date(Date.UTC(2026, 9, day)),
      },
    })
  ).id;
const mail = (id: string) => prisma.email.findUniqueOrThrow({ where: { id } });
const job = (emailId: string) =>
  ({
    id: `job-${emailId}`,
    data: { userId, emailId },
    retryCount: 0,
    retryLimit: 3,
  }) as JobWithMetadata<EmailProcessingJobData>;
const offered = () => vi.mocked(enqueueEmailProcessingJob).mock.calls.map(([, emailId]) => emailId);
const readNow = () =>
  request(app).post('/api/ai/waiting/read').set('X-Development-User', EMAIL).send({});
const secondsFromNow = (date: Date | null | undefined) =>
  Math.round(((date?.getTime() ?? 0) - Date.now()) / 1000);

/** Polls until the condition holds, as the queue's workers run on their own. */
async function until(condition: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('condition not met in 30 seconds');
}

/**
 * Mails sorted by Flash-Lite that now wait for Gemini 3.8 Flash, which is paused. Flash-Lite is
 * busy too when it would take the details instead; its short pause is cleared after each mail.
 */
async function waitingForDetails(days: number[]) {
  const answer = detail;
  detail = busy;
  const ids: string[] = [];
  for (const day of days) {
    const emailId = await newEmail(day);
    await processEmailJob(job(emailId));
    await prisma.aIModelPause.deleteMany({ where: { userId, model: FAST } });
    ids.push(emailId);
  }
  detail = answer;
  return ids;
}

const clearJobs = () =>
  prisma.$executeRaw`DELETE FROM pgboss.job WHERE name IN (${EMAIL_PROCESSING_JOB}, ${AI_RESUME_JOB})`;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  userId = (await prisma.user.create({ data: { email: EMAIL } })).id;
});
beforeEach(async () => {
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  detail = () => extraction;
  client.generateStructured.mockClear();
  vi.mocked(createProviderClient).mockReturnValue(client);
  vi.mocked(fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: 'Hello' });
  vi.mocked(fetchMessageBody).mockResolvedValue('Synthetic interview invitation body');
  vi.mocked(enqueueEmailProcessingJob).mockClear();
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
  await configureAI(userId, { accessIssue: null, fastModel: null });
  await prisma.aIModelPause.deleteMany({ where: { userId } });
  await clearJobs();
});
afterAll(async () => {
  await clearJobs();
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await stopQueue();
});

describe('each model pauses on its own', () => {
  it('with Gemini 3.8 Flash paused, Flash-Lite reads the details too and leaves that pause', async () => {
    const paused = await setPause(userId, DETAILED, {
      resumesAt: new Date(Date.now() + 10 * 60_000),
      consecutiveFailures: 2,
    });
    const newsletter = await newEmail(1, 'Newsletter');
    await processEmailJob(job(newsletter));
    const interview = await newEmail(2);
    await processEmailJob(job(interview));

    // Flash-Lite read both: the newsletter is sorted out, the interview is read in full.
    expect(await mail(newsletter)).toMatchObject({
      processingState: 'COMPLETED',
      relevanceState: 'IRRELEVANT',
    });
    expect(await mail(interview)).toMatchObject({ processingState: 'COMPLETED' });
    expect(
      await prisma.aIOperation.findMany({
        where: { emailId: interview },
        orderBy: { operation: 'asc' },
        select: { operation: true, status: true, attempts: true, model: true },
      }),
    ).toEqual([
      { operation: 'classification', status: 'COMPLETED', attempts: 1, model: FAST },
      { operation: 'extraction', status: 'COMPLETED', attempts: 1, model: FAST },
    ]);
    expect(
      await prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId: interview } }),
    ).toMatchObject({ model: FAST, companyName: 'Northwind Robotics' });
    expect(client.calls('email_relevance')).toHaveLength(2);
    expect(client.calls('job_extraction')).toHaveLength(1);
    // Flash-Lite's successes leave the 3.8 Flash pause and its count as they were.
    expect(await pauseOf(userId, DETAILED)).toEqual(paused);
    expect(await pauseOf(userId, FAST)).toBeNull();
  });

  it('when 3.8 Flash turns busy on a mail, Flash-Lite reads that mail at once', async () => {
    let first = true;
    detail = () => {
      if (!first) return extraction;
      first = false;
      return busy();
    };
    const interview = await newEmail(2);
    await processEmailJob(job(interview));

    expect(await mail(interview)).toMatchObject({ processingState: 'COMPLETED' });
    expect(client.calls('job_extraction').map(([call]) => call.model.id)).toEqual([DETAILED, FAST]);
    // The busy answer used no try; 3.8 Flash pauses as usual.
    expect(
      await prisma.aIOperation.findFirstOrThrow({
        where: { emailId: interview, operation: 'extraction' },
        select: { status: true, attempts: true, model: true },
      }),
    ).toEqual({ status: 'COMPLETED', attempts: 1, model: FAST });
    expect(await pauseOf(userId, DETAILED)).toMatchObject({ reason: 'PROVIDER_BUSY' });
  });

  it('a call that works confirms a key the key check could not confirm', async () => {
    await configureAI(userId, { verifiedAt: null });
    await processEmailJob(job(await newEmail(1, 'Newsletter')));
    expect(
      (await prisma.aIConfiguration.findUniqueOrThrow({ where: { userId } })).verifiedAt,
    ).toBeInstanceOf(Date);
  });

  it('with one model for both steps, a mail waits for it', async () => {
    await configureAI(userId, { fastModel: DETAILED });
    await setPause(userId, DETAILED, { resumesAt: new Date(Date.now() + 10 * 60_000) });
    const interview = await newEmail(2);
    await processEmailJob(job(interview));

    expect(await mail(interview)).toMatchObject({ processingState: 'PENDING' });
    expect(client.generateStructured).not.toHaveBeenCalled();
  });
});

describe('"Read waiting mails now" sends one test mail first', () => {
  it('a still-busy test keeps the pause as long as it was; after a test that works, the others follow', async () => {
    const boss = await getQueue();
    await setPause(userId, DETAILED, {
      resumesAt: new Date(Date.now() + 3 * 60_000),
      consecutiveFailures: 2,
    });
    const [oldest, older, newest] = await waitingForDetails([1, 2, 3]);
    vi.mocked(enqueueEmailProcessingJob).mockClear();
    client.generateStructured.mockClear();
    await startEmailProcessingWorker();
    try {
      // 3.8 Flash is still busy.
      detail = busy;
      expect((await readNow()).status).toBe(200);
      expect(offered()).toEqual([newest]);
      await until(async () => (await pauseOf(userId, DETAILED))?.testResult === 'PROVIDER_BUSY');
      const stillBusy = (await pauseOf(userId, DETAILED))!;
      // The pause starts again from the answer, 2 minutes as before (2 failures in a row), not 4.
      expect(stillBusy).toMatchObject({ consecutiveFailures: 2, testEmailId: newest });
      expect(secondsFromNow(stillBusy.resumesAt)).toBeGreaterThan(110);
      expect(secondsFromNow(stillBusy.resumesAt)).toBeLessThanOrEqual(120);
      await until(async () => (await mail(newest)).processingState === 'PENDING');
      // Only the test mail was sent; the others were not offered.
      expect(client.calls('job_extraction')).toHaveLength(1);
      expect(offered()).toEqual([newest]);
      // The settings show the pause again, with the test's result kept on it.
      const settings = await request(app).get('/api/ai/settings').set('X-Development-User', EMAIL);
      expect(settings.body.access).toMatchObject({
        state: 'LIMITED',
        reason: 'PROVIDER_BUSY',
        resumesAt: stillBusy.resumesAt!.toISOString(),
      });

      // 3.8 Flash answers again: the test works, the pause ends and the others follow by itself.
      detail = () => extraction;
      vi.mocked(enqueueEmailProcessingJob).mockClear();
      expect((await readNow()).status).toBe(200);
      expect(offered()).toEqual([newest]);
      await until(async () => (await mail(newest)).processingState === 'COMPLETED');
      expect(await pauseOf(userId, DETAILED)).toBeNull();
      await startAiResumeWorker();
      await until(
        async () =>
          (await mail(oldest)).processingState === 'COMPLETED' &&
          (await mail(older)).processingState === 'COMPLETED',
      );
      expect(offered().sort()).toEqual([newest, older, oldest].sort());
      expect(client.calls('job_extraction')).toHaveLength(4);
    } finally {
      await boss.offWork(AI_RESUME_JOB, { wait: true });
      await boss.offWork(EMAIL_PROCESSING_JOB, { wait: true });
    }
  }, 90_000);

  it('a second click while the test mail is read sends no other mail; still busy, the pause is not longer', async () => {
    await setPause(userId, DETAILED, {
      resumesAt: new Date(Date.now() + 3 * 60_000),
      consecutiveFailures: 2,
    });
    const [older, newest] = await waitingForDetails([1, 2]);
    vi.mocked(enqueueEmailProcessingJob).mockClear();
    client.generateStructured.mockClear();
    expect((await readNow()).status).toBe(200);
    // The worker has started on the test mail when the user clicks again.
    await prisma.email.update({ where: { id: newest }, data: { processingState: 'PROCESSING' } });
    expect((await readNow()).status).toBe(200);
    expect(offered()).toEqual([newest]);
    expect(await pauseOf(userId, DETAILED)).toMatchObject({ testEmailId: newest });

    detail = busy;
    await processEmailJob(job(newest));
    expect(await pauseOf(userId, DETAILED)).toMatchObject({
      consecutiveFailures: 2,
      testEmailId: newest,
      testResult: 'PROVIDER_BUSY',
    });
    expect(client.calls('job_extraction')).toHaveLength(1);
    expect(await mail(older)).toMatchObject({ processingState: 'PENDING' });
  });

  /** The settings show the 3.8 Flash pause, with no test running. */
  async function showsDetailedPause(resumesAt: Date, consecutiveFailures: number) {
    expect(await pauseOf(userId, DETAILED)).toMatchObject({
      resumesAt,
      consecutiveFailures,
      testEmailId: null,
      testStartedAt: null,
      testResult: null,
    });
    const settings = await request(app).get('/api/ai/settings').set('X-Development-User', EMAIL);
    expect(settings.body.access).toMatchObject({
      state: 'LIMITED',
      reason: 'PROVIDER_BUSY',
      resumesAt: resumesAt.toISOString(),
    });
  }

  it('a test mail Flash-Lite sorts as not job mail ends the 3.8 Flash test, so that pause shows again', async () => {
    const resumesAt = new Date(Date.now() + 10 * 60_000);
    await setPause(userId, FAST, { resumesAt: new Date(Date.now() + 5 * 60_000) });
    await setPause(userId, DETAILED, { resumesAt, consecutiveFailures: 3 });
    const newsletter = await newEmail(1, 'Newsletter');
    expect((await readNow()).status).toBe(200);
    expect(offered()).toEqual([newsletter]);
    // Not sorted yet, the test mail may need both models.
    expect(await pauseOf(userId, DETAILED)).toMatchObject({ testEmailId: newsletter });

    await processEmailJob(job(newsletter));
    expect(await mail(newsletter)).toMatchObject({
      processingState: 'COMPLETED',
      relevanceState: 'IRRELEVANT',
    });
    expect(client.calls('job_extraction')).toHaveLength(0);
    expect(await pauseOf(userId, FAST)).toBeNull();
    await showsDetailedPause(resumesAt, 3);
  });

  it('a test mail whose step is held ends the test, so the pause shows again', async () => {
    const resumesAt = new Date(Date.now() + 10 * 60_000);
    await setPause(userId, DETAILED, { resumesAt, consecutiveFailures: 2 });
    const [test] = await waitingForDetails([1]);
    expect((await readNow()).status).toBe(200);
    expect(await pauseOf(userId, DETAILED)).toMatchObject({ testEmailId: test });

    detail = () => {
      throw new ProviderFailure('INVALID_OUTPUT');
    };
    await processEmailJob(job(test));
    expect(await mail(test)).toMatchObject({ processingState: 'FAILED' });
    await showsDetailedPause(resumesAt, 2);
  });
});

describe("moving today's single pause onto the Detailed model", () => {
  const MIGRATION = path.resolve(
    __dirname,
    '../../prisma/migrations/20261014100000_ai_model_pauses/migration.sql',
  );
  const statements = fs
    .readFileSync(MIGRATION, 'utf8')
    .split(/;\s*$/m)
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);

  class RolledBack extends Error {
    constructor(readonly result: unknown) {
      super('rolled back');
    }
  }

  /**
   * Runs the migration on a copy of `ai_configurations` as it was before it, in a schema of its
   * own inside a transaction that is rolled back. Returns what the migration left.
   */
  async function migrate(rows: string[]) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('CREATE SCHEMA migration_check');
        await tx.$executeRawUnsafe('SET LOCAL search_path TO migration_check, public');
        await tx.$executeRawUnsafe(
          'CREATE TABLE ai_configurations (LIKE public.ai_configurations INCLUDING ALL)',
        );
        await tx.$executeRawUnsafe(`ALTER TABLE ai_configurations
          ADD COLUMN "cooldownUntil" TIMESTAMP(3),
          ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
          DROP CONSTRAINT ai_configurations_counters_check,
          ADD CONSTRAINT ai_configurations_counters_check
            CHECK ("consecutiveFailures" >= 0 AND "revision" >= 0)`);
        for (const row of rows)
          await tx.$executeRawUnsafe(`INSERT INTO ai_configurations
            ("userId", provider, "encryptedApiKey", "fastModel", "detailedModel", "accessIssue",
             "cooldownUntil", "consecutiveFailures", "consentDisclosure", "consentedAt", "updatedAt")
            VALUES ${row}`);
        for (const statement of statements) await tx.$executeRawUnsafe(statement);
        const pauses = await tx.$queryRawUnsafe(
          'SELECT "userId", model, reason::text, "resumesAt", "consecutiveFailures" FROM ai_model_pauses ORDER BY model',
        );
        const configs = await tx.$queryRawUnsafe(
          'SELECT "userId", "accessIssue"::text FROM ai_configurations ORDER BY "accessIssue"',
        );
        const columns = await tx.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'migration_check' AND table_name = 'ai_configurations'
            AND column_name IN ('cooldownUntil', 'consecutiveFailures')`);
        throw new RolledBack({ pauses, configs, columns });
      });
    } catch (err) {
      if (err instanceof RolledBack)
        return err.result as {
          pauses: {
            userId: string;
            model: string;
            reason: string;
            resumesAt: Date | null;
            consecutiveFailures: number;
          }[];
          configs: { userId: string; accessIssue: string | null }[];
          columns: unknown[];
        };
      throw err;
    }
    throw new Error('the migration check was not rolled back');
  }

  it('moves a failure count of 6 onto the recommended Detailed model; the waiting mail is read when that pause ends', async () => {
    const resumesAt = new Date(Date.now() + 25 * 60_000);
    const [rateLimited, keyRejected, openai] = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    /** One configuration: fast and detailed model, access issue, cooldown, failures in a row. */
    const row = (id: string, provider: string, state: string) =>
      `('${id}', '${provider}', 'v1:k', ${state}, 'd', now(), now())`;
    const moved = await migrate([
      // Today's shape on 14 Oct: both roles on 3.8 Flash (Detailed by recommendation), paused.
      row(
        userId,
        'gemini',
        `'${DETAILED}', NULL, 'PROVIDER_BUSY', '${resumesAt.toISOString()}', 6`,
      ),
      row(rateLimited, 'gemini', `NULL, 'gemini-2.5-flash', 'RATE_LIMITED', NULL, 1`),
      row(keyRejected, 'gemini', `NULL, NULL, 'KEY_REJECTED', NULL, 0`),
      row(openai, 'openai', 'NULL, NULL, NULL, NULL, 2'),
    ]);
    expect(moved.pauses).toEqual([
      {
        userId: rateLimited,
        model: 'gemini-2.5-flash',
        reason: 'RATE_LIMITED',
        resumesAt: null,
        consecutiveFailures: 1,
      },
      { userId, model: DETAILED, reason: 'PROVIDER_BUSY', resumesAt, consecutiveFailures: 6 },
      {
        userId: openai,
        model: 'gpt-5-mini',
        reason: 'RATE_LIMITED',
        resumesAt: null,
        consecutiveFailures: 2,
      },
    ]);
    // Pause kinds leave the configuration; a key problem stays there.
    expect(moved.configs).toEqual([
      { userId: keyRejected, accessIssue: 'KEY_REJECTED' },
      { userId: expect.any(String), accessIssue: null },
      { userId: expect.any(String), accessIssue: null },
      { userId: expect.any(String), accessIssue: null },
    ]);
    expect(moved.columns).toEqual([]);

    // The owner's moved pause, with one mail Flash-Lite sorted that waits for 3.8 Flash after one
    // try with no answer. Then both roles use 3.8 Flash, as on 14 Oct.
    await prisma.aIModelPause.create({ data: moved.pauses[1] as never });
    const [waiting] = await waitingForDetails([1]);
    await configureAI(userId, { fastModel: DETAILED });
    await prisma.aIOperation.updateMany({
      where: { emailId: waiting, operation: 'extraction' },
      data: { status: 'RETRYABLE', attempts: 1, errorCode: 'OUTCOME_UNKNOWN' },
    });
    vi.mocked(enqueueEmailProcessingJob).mockClear();
    expect(await reofferPendingEmails(userId)).toBe(0);

    // The pause ends: the mail is offered again. 3.8 Flash is still busy: 6 failures in a row
    // make the next pause the longest, 30 minutes, and the try is not used.
    await setPause(userId, DETAILED, { resumesAt: new Date(Date.now() - 1000) });
    await resumeWaitingEmails(userId);
    expect(offered()).toEqual([waiting]);
    detail = busy;
    await processEmailJob(job(waiting));
    const longest = (await pauseOf(userId, DETAILED))!;
    expect(longest.consecutiveFailures).toBe(7);
    expect(secondsFromNow(longest.resumesAt)).toBe(1800);

    // After that pause it is read, with its second try.
    await setPause(userId, DETAILED, { resumesAt: new Date(Date.now() - 1000) });
    detail = () => extraction;
    await processEmailJob(job(waiting));
    expect(await mail(waiting)).toMatchObject({ processingState: 'COMPLETED' });
    expect(
      await prisma.aIOperation.findFirstOrThrow({
        where: { emailId: waiting, operation: 'extraction' },
      }),
    ).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    expect(await pauseOf(userId, DETAILED)).toBeNull();
  });
});
