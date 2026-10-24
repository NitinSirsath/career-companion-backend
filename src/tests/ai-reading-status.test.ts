/**
 * "AI is reading your mails" (owner, 24 Oct 2026): `GET /api/ai/reading` counts the user's batch,
 * the mail jobs ahead in the reader's line and the reader's speed, says what the batch waits for,
 * and lists the newest steps and job mails. The real database, pg-boss queue and settings rules.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { AIReadingStatusResponseSchema } from '../contracts/ai';
import { getCatalogProvider, recommendedModel } from '../contracts/aiCatalog';
import { EMAIL_PROCESSING_JOB } from '../services/enqueue';
import { getQueue, stopQueue } from '../services/queue';
import {
  FALLBACK_SECONDS_PER_MAIL,
  resetReadingSpeed,
  secondsPerMail,
} from '../services/ai/readingStatus';
import { configureAI, setPause } from './helpers/aiAccess';

const ANNA = 'anna@reading-status.test';
const BEN = 'ben@reading-status.test';
const CARA = 'cara@reading-status.test';
const ids: Record<string, string> = {};
const gemini = getCatalogProvider('gemini')!;
const FAST = recommendedModel(gemini, 'fast').id;
const DETAILED = recommendedModel(gemini, 'detailed').id;
const LUNA = 'openai/gpt-6-luna';
const FREE = 'career-companion';

/** The status as the screens get it; no field beyond the contract. */
const status = async (email: string) => {
  const res = await request(app).get('/api/ai/reading').set({ 'X-Development-User': email });
  expect(res.status).toBe(200);
  return AIReadingStatusResponseSchema.strict().parse(res.body);
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

let mailNumber = 0;
/** One of the user's mails, saved `minutes` ago. */
const mail = async (
  email: string,
  minutes: number,
  data: Partial<Prisma.EmailUncheckedCreateInput> = {},
) =>
  (
    await prisma.email.create({
      data: {
        userId: ids[email],
        gmailMessageId: `reading-${++mailNumber}`,
        subject: `Mail ${mailNumber}`,
        createdAt: minutesAgo(minutes),
        ...data,
      },
    })
  ).id;

/** An AI step of a mail, as the ledger keeps it. */
const step = (emailId: string, data: Partial<Prisma.AIOperationUncheckedCreateInput>) =>
  prisma.aIOperation.create({
    data: {
      emailId,
      operation: 'classification',
      version: 'relevance/v4',
      status: 'COMPLETED',
      provider: 'gemini',
      model: FAST,
      startedAt: minutesAgo(1),
      completedAt: minutesAgo(1),
      ...data,
    },
  });

/** Mail jobs in the reader's line for this user, in this order. */
async function queueJobs(email: string, count: number) {
  const queue = await getQueue();
  for (let i = 0; i < count; i++)
    await queue.send(EMAIL_PROCESSING_JOB, { userId: ids[email], emailId: `job-${email}-${i}` });
}

const clearJobs = () =>
  prisma.$executeRaw`DELETE FROM pgboss.job WHERE name = ${EMAIL_PROCESSING_JOB} AND data->>'userId' = ANY(${Object.values(ids)}::text[])`;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@reading-status.test' } } });
  for (const email of [ANNA, BEN, CARA])
    ids[email] = (await prisma.user.create({ data: { email } })).id;
});
beforeEach(async () => {
  vi.stubEnv('AI_USER_DAILY_CALL_LIMIT', '');
  vi.stubEnv('FREE_AI_OPENROUTER_KEY', 'reading-status-fixture-key');
  vi.stubEnv('FREE_AI_ENABLED', '');
  resetReadingSpeed();
  const userId = { in: Object.values(ids) };
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
  await prisma.aIModelPause.deleteMany({ where: { userId } });
  await prisma.aIConfiguration.deleteMany({ where: { userId } });
  await prisma.freeAIPause.deleteMany({});
  await prisma.aIOperation.deleteMany({ where: { completedAt: { gt: minutesAgo(10) } } });
  await getQueue();
  await clearJobs();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await clearJobs();
  await prisma.freeAIPause.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { endsWith: '@reading-status.test' } } });
  await stopQueue();
});

describe('the batch', () => {
  it('shows nothing while no mail waits', async () => {
    await configureAI(ids[ANNA]);
    await mail(ANNA, 30, { processingState: 'COMPLETED' });
    expect(await status(ANNA)).toMatchObject({
      state: 'NONE',
      notDone: 0,
      total: 0,
      steps: [],
      jobMails: { count: 0, newest: [] },
    });
  });

  it('names the job mails of the last batch once nothing waits, for "done"', async () => {
    await configureAI(ids[ANNA]);
    await mail(ANNA, 70, { processingState: 'COMPLETED', relevanceState: 'RELEVANT' }); // an hour before
    const job = await mail(ANNA, 3, { processingState: 'COMPLETED', relevanceState: 'RELEVANT' });
    await mail(ANNA, 2.5, { processingState: 'COMPLETED', relevanceState: 'IRRELEVANT' });
    expect(await status(ANNA)).toMatchObject({
      state: 'NONE',
      total: 0,
      jobMails: { count: 1, newest: [{ emailId: job }] },
    });
  });

  it('starts at the oldest mail not done, and counts a stopped mail as done', async () => {
    await configureAI(ids[ANNA]);
    await mail(ANNA, 120, { processingState: 'COMPLETED' }); // an earlier sync, not in the batch
    await mail(ANNA, 20, { processingState: 'PENDING' });
    await mail(ANNA, 19, { processingState: 'COMPLETED' });
    await mail(ANNA, 18, { processingState: 'FAILED' });
    await mail(ANNA, 17, { processingState: 'PROCESSING' });
    await mail(ANNA, 2, { processingState: 'PENDING' }); // a new sync joins the batch
    await mail(BEN, 10, { processingState: 'PENDING' }); // another user's
    expect(await status(ANNA)).toMatchObject({
      state: 'READING',
      provider: 'gemini',
      total: 5,
      done: 2,
      notDone: 3,
    });
  });
});

describe('the batch of one sync', () => {
  it('counts the mails of the sync that are read already, since the oldest is read first', async () => {
    await configureAI(ids[ANNA]);
    await mail(ANNA, 70, { processingState: 'COMPLETED' }); // the sync an hour before
    for (const minutes of [12, 11.5, 11, 10.5, 10])
      await mail(ANNA, minutes, { processingState: 'COMPLETED' });
    for (const minutes of [9.5, 9]) await mail(ANNA, minutes);
    expect(await status(ANNA)).toMatchObject({ total: 7, done: 5, notDone: 2 });
  });
});

describe('a new sync a few minutes later', () => {
  it('starts a new batch', async () => {
    await configureAI(ids[ANNA]);
    for (const minutes of [8, 7.9, 7.8])
      await mail(ANNA, minutes, { processingState: 'COMPLETED' });
    for (const minutes of [4, 3.9]) await mail(ANNA, minutes);
    expect(await status(ANNA)).toMatchObject({ total: 2, done: 0, notDone: 2 });
  });
});

describe('the time left', () => {
  it("counts other users' mail jobs queued before the user's newest one, at the load test's speed", async () => {
    await configureAI(ids[ANNA]);
    for (let i = 0; i < 3; i++) await mail(ANNA, 5);
    await queueJobs(BEN, 2); // synced first: read before Anna's
    await queueJobs(ANNA, 3);
    await queueJobs(CARA, 4); // synced after: read after Anna's
    const result = await status(ANNA);
    expect(result).toMatchObject({ state: 'READING', inLine: true, done: 0, notDone: 3 });
    expect(result.secondsLeft).toBe(Math.round((2 + 3) * FALLBACK_SECONDS_PER_MAIL));
  });

  it('is not "in line" once one of the mails is done', async () => {
    await configureAI(ids[ANNA]);
    await mail(ANNA, 6);
    await mail(ANNA, 5, { processingState: 'COMPLETED' });
    await queueJobs(BEN, 2);
    await queueJobs(ANNA, 1);
    expect(await status(ANNA)).toMatchObject({ inLine: false, done: 1, notDone: 1 });
  });

  it("takes the speed from the AI's time per mail in the last 5 minutes, shared by 3 at once", async () => {
    const now = new Date();
    expect(await secondsPerMail(now)).toBe(FALLBACK_SECONDS_PER_MAIL);
    resetReadingSpeed();
    // Six mails sorted in 6 seconds each, one of them a job mail read in 6 more, and an hour of
    // idle time before them that must not count.
    await step(await mail(BEN, 90, { processingState: 'COMPLETED' }), {
      startedAt: new Date(now.getTime() - 3_600_000),
      completedAt: new Date(now.getTime() - 3_590_000),
    });
    for (let i = 0; i < 6; i++) {
      const id = await mail(BEN, 30, { processingState: 'COMPLETED' });
      const completedAt = new Date(now.getTime() - (60 - i * 10) * 1000);
      await step(id, { startedAt: new Date(completedAt.getTime() - 6_000), completedAt });
      if (!i)
        await step(id, {
          operation: 'extraction',
          version: 'extraction/v5',
          startedAt: completedAt,
          completedAt: new Date(completedAt.getTime() + 6_000),
        });
    }
    // (6 × 6 + 6) seconds for 6 mails, 3 at once.
    expect(await secondsPerMail(now)).toBeCloseTo(42 / 6 / 3);
  });

  it('has no time when no mail job of the user is in the line', async () => {
    await configureAI(ids[ANNA]);
    await mail(ANNA, 5);
    expect(await status(ANNA)).toMatchObject({ state: 'READING', secondsLeft: null });
  });

  it('has no time while a pause holds back the mails that need one of the models', async () => {
    await configureAI(ids[ANNA]);
    await mail(ANNA, 5); // needs the fast model
    const sorted = await mail(ANNA, 5); // sorted already: needs the detailed model
    await step(sorted, {});
    await queueJobs(ANNA, 2);
    await setPause(ids[ANNA], DETAILED, { resumesAt: new Date(Date.now() + 600_000) });
    expect(await status(ANNA)).toMatchObject({ state: 'READING', secondsLeft: null });
  });
});

describe('what the batch waits for', () => {
  it('shows the pause and when reading goes on, when it holds back every waiting mail', async () => {
    await configureAI(ids[ANNA]);
    await mail(ANNA, 5);
    const resumesAt = new Date(Date.now() + 600_000);
    await setPause(ids[ANNA], FAST, { resumesAt, reason: 'RATE_LIMITED' });
    expect(await status(ANNA)).toMatchObject({
      state: 'PAUSED',
      reason: 'RATE_LIMITED',
      model: FAST,
      resumesAt: resumesAt.toISOString(),
      secondsLeft: null,
      inLine: false,
    });
  });

  it('waits for midnight UTC at the daily limit', async () => {
    await configureAI(ids[ANNA]);
    await mail(ANNA, 5);
    const day = new Date().toISOString().slice(0, 10);
    await prisma.aIUsageDay.create({ data: { userId: ids[ANNA], day, calls: 500 } });
    const result = await status(ANNA);
    expect(result).toMatchObject({ state: 'PAUSED', reason: 'SAFETY_LIMIT' });
    expect(result.resumesAt).toMatch(/T00:00:00\.000Z$/);
  });

  it('needs the user with no AI set up, or a refused key', async () => {
    await mail(ANNA, 5);
    expect(await status(ANNA)).toMatchObject({
      state: 'NEEDS_YOU',
      reason: 'NOT_SET_UP',
      provider: null,
    });
    await configureAI(ids[ANNA], { accessIssue: 'KEY_REJECTED' });
    expect(await status(ANNA)).toMatchObject({ state: 'NEEDS_YOU', reason: 'KEY_REJECTED' });
  });

  it("pauses or stops with the free AI's shared pause, and stops when it is off", async () => {
    await prisma.aIConfiguration.create({
      data: {
        userId: ids[ANNA],
        provider: FREE,
        encryptedApiKey: null,
        consentDisclosure: getCatalogProvider(FREE)!.disclosure.version,
        consentedAt: new Date(),
      },
    });
    await mail(ANNA, 5);
    const resumesAt = new Date(Date.now() + 300_000);
    await prisma.freeAIPause.create({ data: { model: LUNA, reason: 'RATE_LIMITED', resumesAt } });
    expect(await status(ANNA)).toMatchObject({
      state: 'PAUSED',
      reason: 'FREE_AI_BUSY',
      model: LUNA,
      resumesAt: resumesAt.toISOString(),
    });
    await prisma.freeAIPause.update({
      where: { model: LUNA },
      data: { reason: 'ACCOUNT_OR_BILLING' },
    });
    expect(await status(ANNA)).toMatchObject({
      state: 'STOPPED',
      reason: 'FREE_AI_BUDGET',
      resumesAt: null,
    });
    vi.stubEnv('FREE_AI_OPENROUTER_KEY', '');
    expect(await status(ANNA)).toMatchObject({ state: 'STOPPED', reason: 'FREE_AI_OFF' });
  });
});

describe('the live feed', () => {
  it("lists where the user's newest mails are and the job mails found, never another user's", async () => {
    await configureAI(ids[ANNA]);
    const notJob = await mail(ANNA, 10, {
      processingState: 'COMPLETED',
      relevanceState: 'IRRELEVANT',
      subject: 'Your weekly digest',
    });
    await step(notJob, { completedAt: minutesAgo(4) });
    const job = await mail(ANNA, 10, {
      processingState: 'COMPLETED',
      relevanceState: 'RELEVANT',
      subject: 'Interview invitation',
    });
    await step(job, { completedAt: minutesAgo(3) });
    await step(job, {
      operation: 'extraction',
      version: 'extraction/v5',
      model: DETAILED,
      completedAt: minutesAgo(2),
    });
    await prisma.aIProcessingResult.create({
      data: {
        emailId: job,
        provider: 'gemini',
        model: DETAILED,
        contractVersion: 'extraction/v5',
        processingStatus: 'COMPLETED',
        relevanceDecision: 'RELEVANT',
        category: 'INTERVIEW',
        companyName: 'Northwind',
        jobTitle: 'Frontend Engineer',
      },
    });
    const sorting = await mail(ANNA, 10, { processingState: 'PROCESSING', subject: 'Hello' });
    await step(sorting, { status: 'PROCESSING', completedAt: null, startedAt: minutesAgo(0.1) });
    await mail(ANNA, 10); // only waits: no step yet
    const others = await mail(BEN, 10, { processingState: 'PROCESSING', subject: "Ben's" });
    await step(others, { status: 'PROCESSING', completedAt: null });

    const result = await status(ANNA);
    expect(result.steps.map(({ subject, step: s }) => [subject, s])).toEqual([
      ['Your weekly digest', 'NOT_JOB'],
      ['Interview invitation', 'JOB'],
      ['Hello', 'SORTING'],
    ]);
    expect(result.steps[1]).toMatchObject({
      provider: 'gemini',
      model: DETAILED,
      category: 'INTERVIEW',
      companyName: 'Northwind',
      jobTitle: 'Frontend Engineer',
    });
    expect(result.steps[2]).toMatchObject({ provider: 'gemini', model: FAST });
    expect(result.jobMails).toEqual({
      count: 1,
      newest: [
        {
          emailId: job,
          category: 'INTERVIEW',
          companyName: 'Northwind',
          jobTitle: 'Frontend Engineer',
        },
      ],
    });
  });

  it('shows a stopped mail and the detailed step of a job mail', async () => {
    await configureAI(ids[ANNA]);
    const stopped = await mail(ANNA, 10, { processingState: 'FAILED', subject: 'Stopped' });
    await step(stopped, { status: 'RETRYABLE', completedAt: null });
    const details = await mail(ANNA, 10, { processingState: 'PROCESSING', subject: 'Offer' });
    await step(details, {});
    await step(details, {
      operation: 'extraction',
      version: 'extraction/v5',
      status: 'PROCESSING',
      model: DETAILED,
      completedAt: null,
    });
    const steps = (await status(ANNA)).steps;
    expect(steps.find((s) => s.subject === 'Stopped')?.step).toBe('STOPPED');
    expect(steps.find((s) => s.subject === 'Offer')).toMatchObject({
      step: 'READING_DETAILS',
      model: DETAILED,
    });
  });
});
