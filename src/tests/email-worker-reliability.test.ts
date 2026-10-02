import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { JobWithMetadata } from 'pg-boss';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { EmailAIPipeline } from '../services/ai/pipeline';
import { AIAccessError, AIOutcomeUnknownError, AIProviderError, RetryableAIError, TerminalAIError } from '../services/ai/errors';
import { createProviderClient } from '../services/ai/providers';
import { configureAI } from './helpers/aiAccess';
import { getQueue, stopQueue } from '../services/queue';
import {
  EMAIL_PROCESSING_JOB,
  EmailJobFailure,
  EmailProcessingJobData,
  emailJobOptions,
  enqueueEmailProcessingJob,
  handleEmailJobs,
  processEmailJob,
  startEmailProcessingWorker,
} from '../jobs/emailProcessingJob';

vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../jobs/emailProcessingJob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jobs/emailProcessingJob')>()),
  enqueueEmailProcessingJob: vi.fn(),
}));

const OWNER = 'worker-owner@reliability.test';
let userId: string;
let otherId: string;
let emailId: string;

const job = (retryCount = 0, retryLimit = 3) =>
  ({
    id: `job-${retryCount}`,
    data: { userId, emailId },
    retryCount,
    retryLimit,
  }) as JobWithMetadata<EmailProcessingJobData>;
const email = () => prisma.email.findUniqueOrThrow({ where: { id: emailId } });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@reliability.test' } } });
  userId = (await prisma.user.create({ data: { email: OWNER } })).id;
  otherId = (await prisma.user.create({ data: { email: 'other@reliability.test' } })).id;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(enqueueEmailProcessingJob).mockReset();
  await prisma.email.deleteMany({ where: { userId: { in: [userId, otherId] } } });
  emailId = (await prisma.email.create({ data: { userId, gmailMessageId: 'worker-msg' } })).id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@reliability.test' } } });
  await stopQueue();
});

describe('email worker attributable outcomes', () => {
  it('completes and clears earlier error fields (real pipeline, completed AI result reused)', async () => {
    await prisma.email.update({
      where: { id: emailId },
      data: {
        processingState: 'FAILED', processingErrorCategory: 'RetryableAIError', processingErrorDetails: 'old',
        processingErrorStage: 'classification', processingRetryable: true, processingFailedAt: new Date(),
      },
    });
    await prisma.aIProcessingResult.create({
      data: { emailId, provider: 't', model: 't', contractVersion: 'classification/v2', processingStatus: 'COMPLETED', relevanceDecision: 'IRRELEVANT' },
    });
    const gemini = vi.mocked(createProviderClient);
    gemini.mockClear();
    await processEmailJob(job());
    expect(await email()).toMatchObject({
      processingState: 'COMPLETED', processingErrorCategory: null, processingErrorDetails: null,
      processingErrorStage: null, processingRetryable: null, processingFailedAt: null,
    });
    expect(gemini).not.toHaveBeenCalled();
  });

  it('passes the delivery cancellation signal into the email pipeline', async () => {
    const controller = new AbortController();
    const run = vi.spyOn(EmailAIPipeline, 'processEmail').mockResolvedValue(undefined);
    const delivery = { ...job(), signal: controller.signal };
    await processEmailJob(delivery);
    expect(run).toHaveBeenCalledWith(userId, emailId, { signal: controller.signal });
  });

  it('schedules a retry for a retryable failure before the final attempt', async () => {
    vi.spyOn(EmailAIPipeline, 'processEmail').mockRejectedValue(new RetryableAIError('AI operation not ready'));
    await expect(processEmailJob(job(1))).rejects.toThrow();
    const row = await email();
    expect(row.processingState).toBe('PROCESSING');
    expect(row.processingRetryable).toBe(true);
    expect(row.processingErrorCategory).toBe('RetryableAIError');
  });

  it('marks the email FAILED when the final permitted delivery fails', async () => {
    vi.spyOn(EmailAIPipeline, 'processEmail').mockRejectedValue(new RetryableAIError('AI operation not ready'));
    await expect(processEmailJob(job(3, 3))).rejects.toThrow();
    const row = await email();
    expect(row.processingState).toBe('FAILED');
    expect(row.processingRetryable).toBe(false);
  });

  it('acknowledges terminal failures as FAILED without rethrowing', async () => {
    vi.spyOn(EmailAIPipeline, 'processEmail').mockRejectedValue(new TerminalAIError('AI provider rejected request'));
    await expect(processEmailJob(job())).resolves.toBeUndefined();
    expect((await email()).processingState).toBe('FAILED');
  });

  it('hands pg-boss only the sanitized category, never the original error (S6-R06)', async () => {
    const raw = Object.assign(new Error('Dear candidate, private body'), { meta: { body: 'private' } });
    vi.spyOn(EmailAIPipeline, 'processEmail').mockRejectedValue(raw);
    const thrown = await processEmailJob(job()).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(EmailJobFailure);
    expect(thrown).toMatchObject({ name: 'EmailJobFailure', message: 'ProcessingError' });
    expect(JSON.stringify({ ...(thrown as object), stack: (thrown as Error).stack })).not.toContain('private');
  });

  it('stores an outcome-unknown provider error as not retryable; retry semantics unchanged (S6-R06)', async () => {
    vi.spyOn(EmailAIPipeline, 'processEmail').mockRejectedValue(
      new AIProviderError('AI provider outcome unknown; reconciliation required', false),
    );
    await expect(processEmailJob(job(1))).rejects.toThrow('AIProviderError');
    const row = await email();
    expect(row.processingState).toBe('PROCESSING');
    expect(row.processingRetryable).toBe(false);
    await expect(processEmailJob(job(3, 3))).rejects.toThrow();
    expect((await email()).processingState).toBe('FAILED');
  });

  it.each(['NOT_SET_UP', 'KEY_REJECTED', 'RATE_LIMITED', 'SAFETY_LIMIT'] as const)(
    'waits as PENDING when AI access is unavailable (%s): acknowledged, no retry used, no error stored',
    async (reason) => {
      await prisma.email.update({
        where: { id: emailId },
        data: { processingState: 'FAILED', processingErrorCategory: 'TerminalAIError', processingErrorDetails: 'old', processingRetryable: false, processingFailedAt: new Date() },
      });
      vi.spyOn(EmailAIPipeline, 'processEmail').mockRejectedValue(new AIAccessError(reason));
      await expect(processEmailJob(job(1))).resolves.toBeUndefined();
      expect(await email()).toMatchObject({
        processingState: 'PENDING', processingErrorCategory: null, processingErrorDetails: null,
        processingErrorStage: null, processingRetryable: null, processingFailedAt: null,
      });
    },
  );

  it('fails an unknown outcome at once, held for review, without a queue retry', async () => {
    vi.spyOn(EmailAIPipeline, 'processEmail').mockRejectedValue(new AIOutcomeUnknownError());
    await expect(processEmailJob(job(0))).resolves.toBeUndefined();
    expect(await email()).toMatchObject({ processingState: 'FAILED', processingRetryable: false, processingErrorCategory: 'OutcomeUnknown' });
  });

  it('never persists unexpected raw error text', async () => {
    vi.spyOn(EmailAIPipeline, 'processEmail').mockRejectedValue(new Error('Dear candidate, private body'));
    await expect(processEmailJob(job())).rejects.toThrow();
    const row = await email();
    expect(row.processingErrorDetails).toBe('Processing failed unexpectedly');
    expect(row.processingErrorCategory).toBe('ProcessingError');
  });

  it('never downgrades a completed email', async () => {
    await prisma.email.update({ where: { id: emailId }, data: { processingState: 'COMPLETED' } });
    vi.spyOn(EmailAIPipeline, 'processEmail').mockRejectedValue(new TerminalAIError('Email unavailable'));
    await processEmailJob(job());
    expect((await email()).processingState).toBe('COMPLETED');
  });
});

describe('manual email retry preserves paid claims and user decisions', () => {
  const retry = (id = emailId, as = OWNER) =>
    request(app).post(`/api/emails/${id}/retry`).set('X-Development-User', as);

  async function failedWithOperation(
    status: 'RETRYABLE' | 'UNKNOWN' | 'PROCESSING' | 'COMPLETED' | 'FAILED',
    extra: { errorCode?: string; startedAt?: Date; provider?: string; model?: string; attempts?: number } = {},
  ) {
    await prisma.email.update({
      where: { id: emailId },
      data: {
        processingState: 'FAILED',
        relevanceState: 'RELEVANT',
        matchState: 'IGNORED',
        matchConfirmedBy: 'USER_CONFIRMED',
        processingErrorCategory: 'RetryableAIError',
      },
    });
    await prisma.aIOperation.create({
      data: { emailId, operation: 'classification', version: 'v1', status, attempts: 1, ...extra },
    });
  }

  it('re-enqueues resumable work without resetting operations, state or decisions', async () => {
    await failedWithOperation('RETRYABLE');
    vi.mocked(enqueueEmailProcessingJob).mockResolvedValue('job-id');
    const res = await retry();
    expect(res.status).toBe(200);
    expect(enqueueEmailProcessingJob).toHaveBeenCalledWith(userId, emailId, undefined);
    const row = await email();
    expect(row).toMatchObject({
      processingState: 'FAILED',
      relevanceState: 'RELEVANT',
      matchState: 'IGNORED',
      matchConfirmedBy: 'USER_CONFIRMED',
    });
    expect(await prisma.aIOperation.count({ where: { emailId } })).toBe(1);
  });

  it('keeps a worker outcome that finishes before queue acknowledgment', async () => {
    await failedWithOperation('COMPLETED');
    vi.mocked(enqueueEmailProcessingJob).mockImplementation(async () => {
      await prisma.email.update({
        where: { id: emailId },
        data: { processingState: 'FAILED', processingErrorCategory: 'TerminalAIError' },
      });
      return 'job-id';
    });
    expect((await retry()).status).toBe(200);
    const row = await email();
    expect(row.processingState).toBe('FAILED');
    expect(row.processingErrorCategory).toBe('TerminalAIError');
  });

  it.each([
    ['UNKNOWN', {}, 'AI_RETRY_NEEDS_APPROVAL'],
    ['PROCESSING', { startedAt: new Date() }, 'AI_OPERATION_REQUIRES_REVIEW'],
    ['FAILED', { errorCode: 'INVALID_REQUEST' }, 'AI_OPERATION_REQUIRES_REVIEW'],
    ['FAILED', { errorCode: 'TerminalAIError' }, 'AI_OPERATION_REQUIRES_REVIEW'],
  ] as const)('never replays a held %s operation automatically (%o → %s)', async (status, extra, code) => {
    await failedWithOperation(status, extra);
    const res = await retry();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(code);
    expect(enqueueEmailProcessingJob).not.toHaveBeenCalled();
    expect(await prisma.aIOperation.findFirstOrThrow({ where: { emailId } })).toMatchObject({ status, approvedRetries: 0 });
  });

  describe('user-approved retry (ADR-0001 decision 10)', () => {
    const approve = (body: object = { acceptPossibleDuplicateCharge: true }) =>
      request(app).post(`/api/emails/${emailId}/retry`).set('X-Development-User', OWNER).send(body);
    const op = () => prisma.aIOperation.findFirstOrThrow({ where: { emailId } });
    beforeEach(async () => {
      await configureAI(userId, { provider: 'gemini', accessIssue: null, cooldownUntil: null });
    });

    it('explains where the uncertain attempt went and which provider a retry would use', async () => {
      const attemptedAt = new Date('2026-10-01T10:00:00Z');
      await failedWithOperation('UNKNOWN', { provider: 'gemini', model: 'gemini-2.5-flash', startedAt: attemptedAt });
      const res = await retry();
      expect(res.status).toBe(409);
      expect(res.body.error.details).toEqual({
        operations: [{ operation: 'classification', reason: 'OUTCOME_UNKNOWN', provider: 'gemini', model: 'gemini-2.5-flash', attemptedAt: attemptedAt.toISOString() }],
        currentProvider: 'gemini',
      });
    });

    it.each([
      ['an unknown outcome', 'UNKNOWN', {}],
      ['unusable output', 'FAILED', { errorCode: 'INVALID_OUTPUT' }],
      ['a stale claim after a crash', 'PROCESSING', { startedAt: new Date(Date.now() - 20 * 60_000) }],
      ['exhausted attempts', 'RETRYABLE', { attempts: 3 }],
    ] as const)('approves exactly one more attempt after %s', async (_label, status, extra) => {
      await failedWithOperation(status, extra);
      vi.mocked(enqueueEmailProcessingJob).mockResolvedValue('job-id');
      const res = await approve();
      expect(res.status).toBe(200);
      expect(await op()).toMatchObject({ status: 'RETRYABLE', approvedRetries: 1 });
      // Its own delivery identity: the failed delivery still holds the email's singleton slot.
      expect(enqueueEmailProcessingJob).toHaveBeenCalledWith(userId, emailId, 1);
    });

    it('records one approval even when the user clicks twice at once', async () => {
      await failedWithOperation('UNKNOWN');
      vi.mocked(enqueueEmailProcessingJob).mockResolvedValue('job-id');
      const results = await Promise.all([approve(), approve()]);
      expect(results.map((r) => r.status).sort()).toContain(200);
      expect((await op()).approvedRetries).toBe(1);
    });

    it('asks the user to fix AI access before approving a charge that would only wait', async () => {
      await failedWithOperation('UNKNOWN');
      await configureAI(userId, { accessIssue: 'KEY_REJECTED' });
      const res = await approve();
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'AI_ACCESS_UNAVAILABLE', details: { state: 'NEEDS_ATTENTION', reason: 'KEY_REJECTED' } });
      expect(await op()).toMatchObject({ status: 'UNKNOWN', approvedRetries: 0 });
    });

    it('rejects unexpected fields in the approval', async () => {
      await failedWithOperation('UNKNOWN');
      expect((await approve({ acceptPossibleDuplicateCharge: true, force: true })).status).toBe(400);
      expect((await approve({ acceptPossibleDuplicateCharge: false })).status).toBe(400);
    });
  });

  it('reports a singleton-suppressed retry instead of claiming success', async () => {
    await failedWithOperation('RETRYABLE');
    vi.mocked(enqueueEmailProcessingJob).mockResolvedValue(null);
    const res = await retry();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RETRY_RECENTLY_QUEUED');
  });

  it('returns 404 for another owner and never enqueues', async () => {
    const res = await retry(emailId, 'other@reliability.test');
    expect(res.status).toBe(404);
    expect(enqueueEmailProcessingJob).not.toHaveBeenCalled();
  });
});

describe('delivery invariant (S6-03)', () => {
  it('fails an unexpected multi-job delivery without attempting or acknowledging any job', async () => {
    const pipeline = vi.spyOn(EmailAIPipeline, 'processEmail');
    await expect(handleEmailJobs([job(), { ...job(), id: 'job-extra' }])).rejects.toThrow('UNEXPECTED_EMAIL_JOB_BATCH');
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('withdraws a delivery that waited for AI so the email can be re-offered at once', async () => {
    const boss = await getQueue();
    await prisma.$executeRaw`DELETE FROM pgboss.job WHERE name = ${EMAIL_PROCESSING_JOB}`;
    vi.spyOn(EmailAIPipeline, 'processEmail').mockRejectedValue(new AIAccessError('NOT_SET_UP'));
    const first = await boss.send(EMAIL_PROCESSING_JOB, { userId, emailId }, emailJobOptions(userId, emailId));
    expect(first).toBeTruthy();
    // Same email, same 5-minute singleton slot: suppressed while the first delivery is live.
    expect(await boss.send(EMAIL_PROCESSING_JOB, { userId, emailId }, emailJobOptions(userId, emailId))).toBeNull();
    await startEmailProcessingWorker();
    let state: string | undefined;
    for (let i = 0; i < 150 && state !== 'cancelled'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      state = (await boss.getJobById(EMAIL_PROCESSING_JOB, first!))?.state;
    }
    await boss.offWork(EMAIL_PROCESSING_JOB, { wait: true });
    expect(state).toBe('cancelled');
    expect((await email()).processingState).toBe('PENDING');
    // The waiting delivery no longer holds the slot: a re-offer after access is fixed is accepted.
    expect(await boss.send(EMAIL_PROCESSING_JOB, { userId, emailId }, emailJobOptions(userId, emailId))).toBeTruthy();
    await prisma.$executeRaw`DELETE FROM pgboss.job WHERE name = ${EMAIL_PROCESSING_JOB}`;
  }, 60_000);

  it('accounts for every distinct queued email through installed pg-boss delivery', async () => {
    const boss = await getQueue();
    await prisma.$executeRaw`DELETE FROM pgboss.job WHERE name = ${EMAIL_PROCESSING_JOB}`;
    const ids = await Promise.all(['ok-1', 'terminal', 'exhausted', 'ok-2', 'raw'].map(async (key) =>
      (await prisma.email.create({ data: { userId, gmailMessageId: `queue-${key}` } })).id));
    const [ok1, terminal, exhausted, ok2, raw] = ids;
    vi.spyOn(EmailAIPipeline, 'processEmail').mockImplementation(async (_user, id) => {
      if (id === terminal) throw new TerminalAIError('AI provider rejected request');
      if (id === exhausted) throw new RetryableAIError('AI operation not ready');
      if (id === raw)
        throw Object.assign(new Error('Dear candidate, private body'), { meta: { body: 'private' } });
      await prisma.email.update({ where: { id }, data: { processingState: 'COMPLETED' } });
    });
    const jobIds = await Promise.all(ids.map((id) =>
      boss.send(EMAIL_PROCESSING_JOB, { userId, emailId: id }, { ...emailJobOptions(userId, id), retryLimit: 1, retryDelay: 1, retryBackoff: false })));
    expect(jobIds.every(Boolean)).toBe(true);

    await startEmailProcessingWorker();
    const registration = boss.getWipData().find((w) => w.name === EMAIL_PROCESSING_JOB);
    expect(registration?.options).toMatchObject({ batchSize: 1, includeMetadata: true });
    const settled = async () => {
      const jobs = await Promise.all(jobIds.map((id) => boss.getJobById(EMAIL_PROCESSING_JOB, id!)));
      return jobs.every((j) => j && ['completed', 'failed'].includes(j.state)) ? jobs : null;
    };
    let jobs = await settled();
    for (let i = 0; !jobs && i < 150; i++) {
      await new Promise((r) => setTimeout(r, 200));
      jobs = await settled();
    }
    await boss.offWork(EMAIL_PROCESSING_JOB, { wait: true });
    expect(jobs).not.toBeNull();
    const byEmail = new Map(ids.map((id, i) => [id, jobs![i]!]));
    const state = async (id: string) => (await prisma.email.findUniqueOrThrow({ where: { id } }));
    expect(byEmail.get(ok1)!.state).toBe('completed');
    expect(byEmail.get(ok2)!.state).toBe('completed');
    expect((await state(ok1)).processingState).toBe('COMPLETED');
    expect((await state(ok2)).processingState).toBe('COMPLETED');
    // Terminal work is acknowledged with a recorded FAILED outcome.
    expect(byEmail.get(terminal)!.state).toBe('completed');
    expect((await state(terminal)).processingState).toBe('FAILED');
    // Retryable work is retried, then recorded as exhausted at the final permitted delivery.
    expect(byEmail.get(exhausted)!).toMatchObject({ state: 'failed', retryCount: 1 });
    expect(await state(exhausted)).toMatchObject({ processingState: 'FAILED', processingRetryable: false });
    expect(vi.mocked(EmailAIPipeline.processEmail).mock.calls.filter(([, id]) => id === exhausted)).toHaveLength(2);
    // S6-R06: pgboss.job.output holds only the sanitized category.
    expect(byEmail.get(exhausted)!.output).toEqual({
      name: 'EmailJobFailure', message: 'RetryableAIError', stack: 'EmailJobFailure: RetryableAIError',
    });
    expect(byEmail.get(raw)!.state).toBe('failed');
    expect(byEmail.get(raw)!.output).toEqual({
      name: 'EmailJobFailure', message: 'ProcessingError', stack: 'EmailJobFailure: ProcessingError',
    });
    const stored = await prisma.$queryRaw<{ output: unknown }[]>`SELECT output FROM pgboss.job WHERE name = ${EMAIL_PROCESSING_JOB}`;
    expect(JSON.stringify(stored)).not.toContain('private');
  }, 60_000);
});
