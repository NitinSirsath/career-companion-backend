import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@google/genai';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { STALE_PROCESSING_MS, runOperation } from '../services/ai/operations';
import {
  AIAccessError,
  AIOutcomeUnknownError,
  FailureKind,
  ProviderFailure,
  SchemaValidationFailure,
  TerminalAIError,
} from '../services/ai/errors';
import { holdOf } from '../services/ai/heldOperations';
import { classifyGeminiError } from '../services/ai/providers/gemini';
import { nextUtcMidnight, utcDay } from '../services/ai/usage';
import { enqueueAiResume } from '../services/enqueue';
import { configureAI, fakeAccess, pauseOf, setPause } from './helpers/aiAccess';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueAiResume: vi.fn(async () => 'job-id'),
}));

const schema = z.object({ decision: z.string() });
const FAST_MODEL = 'gemini-3.5-flash-lite';
const DETAILED_MODEL = 'gemini-3.8-flash';

let a: string;
let b: string;

const newEmail = async (userId: string) =>
  (await prisma.email.create({ data: { userId, gmailMessageId: `limits-${Math.random()}` } })).id;

function run(
  userId: string,
  emailId: string,
  call: () => Promise<unknown>,
  options: {
    revision?: number;
    access?: () => Promise<ReturnType<typeof fakeAccess>>;
    /** The detailed model's step instead of the fast model's. */
    detailed?: boolean;
  } = {},
) {
  const role = options.detailed ? ('detailed' as const) : ('fast' as const);
  return runOperation({
    userId,
    emailId,
    operation: options.detailed ? 'extraction' : 'classification',
    contract: { version: 'v1', schema, role },
    access: options.access ?? (async () => fakeAccess(userId, options.revision ?? 0)),
    call: async () => ({
      version: 'v1',
      data: (await call()) as { decision: string },
      model: options.detailed ? DETAILED_MODEL : FAST_MODEL,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  });
}

const ok = () => vi.fn().mockResolvedValue({ decision: 'yes' });
const refuse = (kind: FailureKind, details = {}) =>
  vi.fn().mockRejectedValue(new ProviderFailure(kind, details));
const config = (userId: string) => prisma.aIConfiguration.findUniqueOrThrow({ where: { userId } });
const op = (emailId: string) => prisma.aIOperation.findFirstOrThrow({ where: { emailId } });
const usage = (userId: string) =>
  prisma.aIUsageDay.findUnique({ where: { userId_day: { userId, day: utcDay(new Date()) } } });
const failure = (pending: Promise<unknown>) =>
  pending.then(
    () => {
      throw new Error('expected failure');
    },
    (e) => e,
  );
const secondsFromNow = (date: Date | null | undefined) =>
  Math.round(((date?.getTime() ?? 0) - Date.now()) / 1000);
const fastPause = (userId: string) => pauseOf(userId, FAST_MODEL);
/** The fast model's pause has ended; its failures in a row still count. */
const endFastPause = (userId: string) =>
  setPause(userId, FAST_MODEL, { resumesAt: new Date(Date.now() - 1000) });
/** Google's 429 for one quota, read by the real Gemini error mapping. */
const googleQuota = (quotaId: string) =>
  vi.fn().mockRejectedValue(
    classifyGeminiError(
      new ApiError({
        status: 429,
        message: JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            details: [
              { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
              { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '10s' },
            ],
          },
        }),
      }),
    ),
  );

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@limits.test' } } });
  a = (await prisma.user.create({ data: { email: 'a@limits.test' } })).id;
  b = (await prisma.user.create({ data: { email: 'b@limits.test' } })).id;
});
beforeEach(async () => {
  vi.mocked(enqueueAiResume).mockClear();
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  await prisma.email.deleteMany({ where: { userId: { in: [a, b] } } });
  await prisma.aIUsageDay.deleteMany({ where: { userId: { in: [a, b] } } });
  await prisma.aIModelPause.deleteMany({ where: { userId: { in: [a, b] } } });
  for (const user of [a, b])
    await configureAI(user, { accessIssue: null, accessIssueModel: null, revision: 0 });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@limits.test' } } });
});

describe('per-user safety limit and counts', () => {
  it("counts each call against that user only, with Career Companion's own token counts", async () => {
    await run(a, await newEmail(a), ok());
    expect(await usage(a)).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5 });
    expect(await usage(b)).toBeNull();
  });

  it('stops one user at the safety limit without affecting another user', async () => {
    process.env.AI_USER_DAILY_CALL_LIMIT = '2';
    await prisma.aIUsageDay.create({ data: { userId: a, day: utcDay(new Date()), calls: 2 } });
    const call = ok();
    const emailId = await newEmail(a);
    const error = await failure(run(a, emailId, call));
    expect(error).toBeInstanceOf(AIAccessError);
    expect(error).toMatchObject({ reason: 'SAFETY_LIMIT', resumesAt: nextUtcMidnight(new Date()) });
    expect(call).not.toHaveBeenCalled();
    expect(await op(emailId)).toMatchObject({ status: 'PENDING', attempts: 0 });
    await run(b, await newEmail(b), ok());
    expect((await usage(b))!.calls).toBe(1);
  });

  it('does not claim or count anything when access is unavailable', async () => {
    const emailId = await newEmail(a);
    const call = ok();
    const error = await failure(
      run(a, emailId, call, {
        access: async () => {
          throw new AIAccessError('NOT_SET_UP');
        },
      }),
    );
    expect(error).toMatchObject({ reason: 'NOT_SET_UP' });
    expect(call).not.toHaveBeenCalled();
    expect(await op(emailId)).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(await usage(a)).toBeNull();
  });

  it('resolves access only when a provider call is about to be claimed', async () => {
    const emailId = await newEmail(a);
    await run(a, emailId, ok());
    const access = vi.fn(async () => fakeAccess(a));
    await run(a, emailId, ok(), { access }); // completed result reused
    expect(access).not.toHaveBeenCalled();
  });
});

describe("each model's own pause", () => {
  it('pauses only the rate-limited user, honoring a bounded retry-after', async () => {
    const emailId = await newEmail(a);
    const error = await failure(run(a, emailId, refuse('RATE_LIMITED', { retryAfterMs: 5_000 })));
    expect(error).toMatchObject({ name: 'AIAccessError', reason: 'RATE_LIMITED' });
    expect(secondsFromNow(error.resumesAt)).toBe(10); // 5 s raised to the 10 s minimum
    expect(await op(emailId)).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      errorCode: 'RATE_LIMITED',
    });
    expect(await fastPause(a)).toMatchObject({ reason: 'RATE_LIMITED', consecutiveFailures: 1 });
    expect((await config(a)).accessIssue).toBeNull();

    const next = ok();
    expect(await failure(run(a, await newEmail(a), next))).toMatchObject({
      reason: 'RATE_LIMITED',
    });
    expect(next).not.toHaveBeenCalled();
    await run(b, await newEmail(b), ok());
    expect(await fastPause(b)).toBeNull();
  });

  it('treats a busy provider as a refusal: the mail waits, no attempt is used, nothing is held', async () => {
    const emailId = await newEmail(a);
    const error = await failure(run(a, emailId, refuse('PROVIDER_BUSY', { status: 503 })));
    expect(error).toMatchObject({ name: 'AIAccessError', reason: 'PROVIDER_BUSY' });
    expect(secondsFromNow(error.resumesAt)).toBe(60);
    expect(await op(emailId)).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      errorCode: 'PROVIDER_BUSY',
    });
    expect(await fastPause(a)).toMatchObject({ reason: 'PROVIDER_BUSY', consecutiveFailures: 1 });
    // The waiting mail is read by itself when the pause ends: one job, for this user only.
    expect(vi.mocked(enqueueAiResume).mock.calls).toEqual([[a, error.resumesAt]]);

    // During the pause nothing is sent for this user; another user is not affected.
    const next = ok();
    expect(await failure(run(a, await newEmail(a), next))).toMatchObject({
      reason: 'PROVIDER_BUSY',
    });
    expect(next).not.toHaveBeenCalled();
    await run(b, await newEmail(b), ok());

    // The same mail is read at the first try after the pause, and the busy state is cleared.
    await endFastPause(a);
    await run(a, emailId, ok());
    expect(await op(emailId)).toMatchObject({ status: 'COMPLETED', attempts: 1 });
    expect(await fastPause(a)).toBeNull();
  });

  it('still pauses and reports busy when the resume job cannot be queued', async () => {
    vi.mocked(enqueueAiResume).mockRejectedValueOnce(new Error('queue down'));
    const emailId = await newEmail(a);
    expect(await failure(run(a, emailId, refuse('PROVIDER_BUSY')))).toMatchObject({
      name: 'AIAccessError',
      reason: 'PROVIDER_BUSY',
    });
    expect(await op(emailId)).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('lets a busy pause grow like a rate limit while the provider stays busy', async () => {
    await setPause(a, FAST_MODEL, { consecutiveFailures: 3 });
    expect(
      secondsFromNow((await failure(run(a, await newEmail(a), refuse('PROVIDER_BUSY')))).resumesAt),
    ).toBe(480);
  });

  it('waits as long as Google asks for a per-minute limit, and longer when it repeats', async () => {
    const perMinute = googleQuota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier');
    for (const seconds of [10, 20, 40]) {
      const error = await failure(run(a, await newEmail(a), perMinute));
      expect(error).toMatchObject({ name: 'AIAccessError', reason: 'RATE_LIMITED' });
      expect(secondsFromNow(error.resumesAt)).toBe(seconds);
      await endFastPause(a);
    }
  });

  it.each([
    // US summer time ends that morning: 1:30 PM in India.
    ['2026-11-01T10:00:00Z', '2026-11-02T08:00:00Z'],
    // Summer time: 12:30 PM in India.
    ['2026-10-14T10:00:00Z', '2026-10-15T07:00:00Z'],
  ])(
    "waits for Google's reset at midnight Pacific time: a daily 429 at %s resumes at %s",
    async (at, resumes) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(at));
      try {
        await setPause(a, FAST_MODEL, { consecutiveFailures: 2 });
        const perDay = googleQuota('GenerateRequestsPerDayPerProjectPerModel-FreeTier');
        const error = await failure(run(a, await newEmail(a), perDay));
        expect(error).toMatchObject({ reason: 'RATE_LIMITED', resumesAt: new Date(resumes) });
        expect(await fastPause(a)).toMatchObject({
          reason: 'RATE_LIMITED',
          resumesAt: new Date(resumes),
        });
        // The waiting mail is read by itself after the reset.
        expect(vi.mocked(enqueueAiResume).mock.calls).toEqual([[a, new Date(resumes)]]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('bounds a long retry-after to one hour', async () => {
    const error = await failure(
      run(a, await newEmail(a), refuse('RATE_LIMITED', { retryAfterMs: 7_200_000 })),
    );
    expect(secondsFromNow(error.resumesAt)).toBe(3600);
  });

  it('grows with consecutive refusals up to 30 minutes and resets after a success', async () => {
    await setPause(a, FAST_MODEL, { consecutiveFailures: 2 });
    expect(
      secondsFromNow((await failure(run(a, await newEmail(a), refuse('RATE_LIMITED')))).resumesAt),
    ).toBe(240);
    await setPause(a, FAST_MODEL, { consecutiveFailures: 10, resumesAt: null });
    expect(
      secondsFromNow((await failure(run(a, await newEmail(a), refuse('RATE_LIMITED')))).resumesAt),
    ).toBe(1800);
    await endFastPause(a);
    await run(a, await newEmail(a), ok());
    expect(await fastPause(a)).toBeNull();
  });

  it('pauses only the model that failed; a success on another model does not reset it', async () => {
    // Gemini 3.8 Flash (detailed) is busy.
    const error = await failure(
      run(a, await newEmail(a), refuse('PROVIDER_BUSY'), { detailed: true }),
    );
    expect(error).toMatchObject({ name: 'AIAccessError', reason: 'PROVIDER_BUSY' });
    const paused = await pauseOf(a, DETAILED_MODEL);
    expect(paused).toMatchObject({ reason: 'PROVIDER_BUSY', consecutiveFailures: 1 });

    // Gemini 3.5 Flash-Lite (fast) keeps reading mail.
    const sorting = ok();
    await run(a, await newEmail(a), sorting);
    expect(sorting).toHaveBeenCalledTimes(1);
    expect(await fastPause(a)).toBeNull();
    // Its success leaves the 3.8 Flash pause and its count as they were.
    expect(await pauseOf(a, DETAILED_MODEL)).toEqual(paused);

    // 3.8 Flash itself is not called during its pause.
    const detail = ok();
    expect(await failure(run(a, await newEmail(a), detail, { detailed: true }))).toMatchObject({
      reason: 'PROVIDER_BUSY',
      resumesAt: paused!.resumesAt,
    });
    expect(detail).not.toHaveBeenCalled();
  });

  it.each([
    ['busy', 'PROVIDER_BUSY', 60_000, 60],
    ['no answer in time', 'OUTCOME_UNKNOWN', 75_000, 60],
  ] as const)(
    'counts the pause from the failure: after a long wait (%s) it is the full pause',
    async (_label, kind, waitedMs, pauseSeconds) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const started = new Date('2026-10-14T06:06:55Z');
      vi.setSystemTime(started);
      try {
        const emailId = await newEmail(a);
        const slow = vi.fn(async () => {
          vi.setSystemTime(started.getTime() + waitedMs);
          throw new ProviderFailure(kind, { failureCause: 'PROVIDER_ANSWER' });
        });
        const error = await failure(run(a, emailId, slow));
        const failedAt = started.getTime() + waitedMs;
        expect(error.resumesAt).toEqual(new Date(failedAt + pauseSeconds * 1000));
        expect((await fastPause(a))!.resumesAt).toEqual(error.resumesAt);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('the test mail of "Read waiting mails now"', () => {
  const testing = (emailId: string, consecutiveFailures = 2) =>
    setPause(a, FAST_MODEL, {
      consecutiveFailures,
      resumesAt: new Date(Date.now() + 4 * 60_000),
      testEmailId: emailId,
      testStartedAt: new Date(),
    });

  it('alone may use the paused model; still busy, the pause starts again but is not longer', async () => {
    const test = await newEmail(a);
    const other = await newEmail(a);
    await testing(test);

    const notSent = ok();
    expect(await failure(run(a, other, notSent))).toMatchObject({ reason: 'PROVIDER_BUSY' });
    expect(notSent).not.toHaveBeenCalled();

    const stillBusy = refuse('PROVIDER_BUSY', { status: 503 });
    const error = await failure(run(a, test, stillBusy));
    expect(stillBusy).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ name: 'AIAccessError', reason: 'PROVIDER_BUSY' });
    // The pause was 2 minutes (2 failures in a row): it starts again at 2 minutes, not 4.
    expect(secondsFromNow(error.resumesAt)).toBe(120);
    expect(await fastPause(a)).toMatchObject({
      consecutiveFailures: 2,
      resumesAt: error.resumesAt,
      testEmailId: test,
      testResult: 'PROVIDER_BUSY',
    });
    // The test has its answer: now it waits like the other mail.
    const again = ok();
    expect(await failure(run(a, test, again))).toMatchObject({ reason: 'PROVIDER_BUSY' });
    expect(again).not.toHaveBeenCalled();
  });

  it('that works ends the pause, and the other waiting mail follows by itself', async () => {
    const test = await newEmail(a);
    await testing(test);
    await run(a, test, ok());
    expect(await fastPause(a)).toBeNull();
    expect(vi.mocked(enqueueAiResume)).toHaveBeenCalledTimes(1);
    expect(secondsFromNow(vi.mocked(enqueueAiResume).mock.calls[0][1])).toBeCloseTo(0, 0);
  });
});

describe('refusals and unusable outcomes', () => {
  it.each(['KEY_REJECTED', 'ACCOUNT_OR_BILLING'] as const)(
    'records %s as needing attention and releases the claim',
    async (kind) => {
      const emailId = await newEmail(a);
      expect(await failure(run(a, emailId, refuse(kind)))).toMatchObject({
        name: 'AIAccessError',
        reason: kind,
      });
      expect(await op(emailId)).toMatchObject({ status: 'PENDING', attempts: 0, errorCode: kind });
      expect(await config(a)).toMatchObject({ accessIssue: kind });
      expect(await fastPause(a)).toBeNull();
      // Only the user can fix this, so no automatic try is queued.
      expect(enqueueAiResume).not.toHaveBeenCalled();
      // The call was sent, so it counts toward the safety limit.
      expect((await usage(a))!.calls).toBe(1);
    },
  );

  it('names the model a MODEL_UNAVAILABLE refusal refers to', async () => {
    await failure(run(a, await newEmail(a), refuse('MODEL_UNAVAILABLE')));
    expect(await config(a)).toMatchObject({
      accessIssue: 'MODEL_UNAVAILABLE',
      accessIssueModel: FAST_MODEL,
    });
  });

  it('uses one try for no answer in time: the mail waits, AI pauses as for busy, then tries again', async () => {
    const emailId = await newEmail(a);
    const timeout = refuse('OUTCOME_UNKNOWN', { failureCause: 'TIMEOUT' });
    const error = await failure(run(a, emailId, timeout));
    expect(error).toMatchObject({ name: 'AIAccessError', reason: 'PROVIDER_BUSY' });
    expect(secondsFromNow(error.resumesAt)).toBe(60);
    expect(await op(emailId)).toMatchObject({
      status: 'RETRYABLE',
      attempts: 1,
      errorCode: 'OUTCOME_UNKNOWN',
    });
    expect(await fastPause(a)).toMatchObject({
      reason: 'PROVIDER_BUSY',
      consecutiveFailures: 1,
      resumesAt: error.resumesAt,
    });
    // The waiting mail is read by itself when the pause ends.
    expect(vi.mocked(enqueueAiResume).mock.calls).toEqual([[a, error.resumesAt]]);

    // During the pause nothing is sent for this user; another user is not affected.
    const next = ok();
    expect(await failure(run(a, await newEmail(a), next))).toMatchObject({
      reason: 'PROVIDER_BUSY',
    });
    expect(next).not.toHaveBeenCalled();
    await run(b, await newEmail(b), ok());

    // After the pause the same mail gets a real second try.
    await endFastPause(a);
    await run(a, emailId, ok());
    expect(await op(emailId)).toMatchObject({ status: 'COMPLETED', attempts: 2 });
  });

  it("waits for the user's OK after the 3rd try with no answer; each try counts toward the safety limit", async () => {
    const emailId = await newEmail(a);
    const deadline = refuse('OUTCOME_UNKNOWN', { status: 504, failureCause: 'PROVIDER_DEADLINE' });
    for (let i = 0; i < 2; i++) {
      expect(await failure(run(a, emailId, deadline))).toBeInstanceOf(AIAccessError);
      await endFastPause(a);
    }
    expect(await failure(run(a, emailId, deadline))).toBeInstanceOf(AIOutcomeUnknownError);
    const held = await op(emailId);
    expect(held).toMatchObject({ status: 'RETRYABLE', attempts: 3, errorCode: 'OUTCOME_UNKNOWN' });
    expect(holdOf(held, new Date())).toEqual({ approvable: 'ATTEMPTS_EXHAUSTED' });
    expect((await usage(a))!.calls).toBe(3);

    // Not a 4th time by itself, even when a job runs after the pause.
    await endFastPause(a);
    await expect(run(a, emailId, deadline)).rejects.toThrow('requires review');
    expect(deadline).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['an error in our own code', () => vi.fn().mockRejectedValue(new RangeError('bug'))],
    [
      'an error the adapter could not sort',
      () => refuse('OUTCOME_UNKNOWN', { failureCause: 'UNCLASSIFIED' }),
    ],
  ])('fails %s for us to check: never an unknown outcome, and no pause', async (_label, call) => {
    const emailId = await newEmail(a);
    expect(await failure(run(a, emailId, call()))).toBeInstanceOf(TerminalAIError);
    const failed = await op(emailId);
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1, errorCode: 'UNCLASSIFIED' });
    // Only Career Companion can fix it: the user is not asked to approve a new try.
    expect(holdOf(failed, new Date())).toEqual({ approvable: null });
    expect(await config(a)).toMatchObject({ accessIssue: null });
    expect(await fastPause(a)).toBeNull();
    expect(enqueueAiResume).not.toHaveBeenCalled();
  });

  it('fails unusable output for review and records its tokens', async () => {
    const emailId = await newEmail(a);
    const call = refuse('INVALID_OUTPUT', { usage: { inputTokens: 7, outputTokens: 3 } });
    expect(await failure(run(a, emailId, call))).toBeInstanceOf(SchemaValidationFailure);
    expect(await op(emailId)).toMatchObject({ status: 'FAILED', errorCode: 'INVALID_OUTPUT' });
    expect(await usage(a)).toMatchObject({ calls: 1, inputTokens: 7, outputTokens: 3 });
    expect(await config(a)).toMatchObject({ accessIssue: null });
    expect(await fastPause(a)).toBeNull();
  });

  it('never lets a job holding an older configuration change the saved state', async () => {
    await configureAI(a, { revision: 1 });
    await failure(run(a, await newEmail(a), refuse('KEY_REJECTED'), { revision: 0 }));
    await failure(run(a, await newEmail(a), refuse('RATE_LIMITED'), { revision: 0 }));
    expect(await config(a)).toMatchObject({ accessIssue: null });
    expect(await fastPause(a)).toBeNull();
  });
});

describe('a claim no live job can hold', () => {
  const claimed = async (emailId: string, msAgo: number, attempts = 1) =>
    prisma.aIOperation.create({
      data: {
        emailId,
        operation: 'classification',
        version: 'v1',
        status: 'PROCESSING',
        attempts,
        startedAt: new Date(Date.now() - msAgo),
      },
    });

  it('goes back to waiting with its try counted, and the next job tries again', async () => {
    const emailId = await newEmail(a);
    await claimed(emailId, STALE_PROCESSING_MS + 1000);
    const call = ok();
    await run(a, emailId, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(await op(emailId)).toMatchObject({ status: 'COMPLETED', attempts: 2 });
  });

  it("after the 3rd try waits for the user's OK instead", async () => {
    const emailId = await newEmail(a);
    await claimed(emailId, STALE_PROCESSING_MS + 1000, 3);
    const call = ok();
    await expect(run(a, emailId, call)).rejects.toThrow('requires review');
    expect(call).not.toHaveBeenCalled();
    const held = await op(emailId);
    expect(held).toMatchObject({ status: 'RETRYABLE', attempts: 3 });
    expect(holdOf(held, new Date())).toEqual({ approvable: 'ATTEMPTS_EXHAUSTED' });
  });

  it('is left alone while a live job may still be waiting for its answer', async () => {
    const emailId = await newEmail(a);
    await claimed(emailId, 60_000);
    const call = ok();
    await expect(run(a, emailId, call)).rejects.toThrow('requires review');
    expect(call).not.toHaveBeenCalled();
    expect(await op(emailId)).toMatchObject({ status: 'PROCESSING', attempts: 1 });
  });
});

describe('provenance and user-approved attempts', () => {
  it('records the provider and model at claim time and returns them on reuse', async () => {
    const emailId = await newEmail(a);
    expect(await run(a, emailId, ok())).toEqual({
      data: { decision: 'yes' },
      provider: 'gemini',
      model: FAST_MODEL,
    });
    expect(await op(emailId)).toMatchObject({
      provider: 'gemini',
      model: FAST_MODEL,
      status: 'COMPLETED',
    });
    expect(await run(a, emailId, ok())).toEqual({
      data: { decision: 'yes' },
      provider: 'gemini',
      model: FAST_MODEL,
    });
  });

  it('allows exactly one call beyond the attempt limit per approval', async () => {
    const emailId = await newEmail(a);
    await prisma.aIOperation.create({
      data: {
        emailId,
        operation: 'classification',
        version: 'v1',
        status: 'RETRYABLE',
        attempts: 3,
      },
    });
    const call = refuse('OUTCOME_UNKNOWN');
    await expect(run(a, emailId, call)).rejects.toThrow('requires review');
    await prisma.aIOperation.updateMany({ where: { emailId }, data: { approvedRetries: 1 } });
    await expect(run(a, emailId, call)).rejects.toBeInstanceOf(AIOutcomeUnknownError);
    // Re-opening the operation without a new approval does not permit another call.
    await prisma.aIOperation.updateMany({ where: { emailId }, data: { status: 'RETRYABLE' } });
    await endFastPause(a);
    await expect(run(a, emailId, call)).rejects.toThrow('requires review');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
