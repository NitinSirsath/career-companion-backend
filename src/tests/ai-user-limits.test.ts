import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { runOperation } from '../services/ai/operations';
import {
  AIAccessError,
  AIOutcomeUnknownError,
  FailureKind,
  ProviderFailure,
  SchemaValidationFailure,
} from '../services/ai/errors';
import { nextUtcMidnight, utcDay } from '../services/ai/usage';
import { enqueueAiResume } from '../services/enqueue';
import { configureAI, fakeAccess } from './helpers/aiAccess';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueAiResume: vi.fn(async () => 'job-id'),
}));

const schema = z.object({ decision: z.string() });
const contract = { version: 'v1', schema, role: 'fast' as const };
const FAST_MODEL = 'gemini-3.5-flash-lite';

let a: string;
let b: string;

const newEmail = async (userId: string) =>
  (await prisma.email.create({ data: { userId, gmailMessageId: `limits-${Math.random()}` } })).id;

function run(
  userId: string,
  emailId: string,
  call: () => Promise<unknown>,
  options: { revision?: number; access?: () => Promise<ReturnType<typeof fakeAccess>> } = {},
) {
  return runOperation({
    userId,
    emailId,
    operation: 'classification',
    contract,
    access: options.access ?? (async () => fakeAccess(userId, options.revision ?? 0)),
    call: async () => ({
      version: 'v1',
      data: (await call()) as { decision: string },
      model: FAST_MODEL,
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
const secondsFromNow = (date: Date | null) =>
  Math.round(((date?.getTime() ?? 0) - Date.now()) / 1000);

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
  for (const user of [a, b])
    await configureAI(user, {
      cooldownUntil: null,
      accessIssue: null,
      accessIssueModel: null,
      consecutiveFailures: 0,
      revision: 0,
    });
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

describe('per-user provider cooldown', () => {
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
    expect(await config(a)).toMatchObject({ accessIssue: 'RATE_LIMITED', consecutiveFailures: 1 });

    const next = ok();
    expect(await failure(run(a, await newEmail(a), next))).toMatchObject({
      reason: 'RATE_LIMITED',
    });
    expect(next).not.toHaveBeenCalled();
    await run(b, await newEmail(b), ok());
    expect(await config(b)).toMatchObject({ cooldownUntil: null, consecutiveFailures: 0 });
  });

  it('treats a busy provider as a refusal: the mail waits, no attempt is used, nothing is held', async () => {
    const emailId = await newEmail(a);
    const error = await failure(run(a, emailId, refuse('PROVIDER_BUSY', { status: 504 })));
    expect(error).toMatchObject({ name: 'AIAccessError', reason: 'PROVIDER_BUSY' });
    expect(secondsFromNow(error.resumesAt)).toBe(60);
    expect(await op(emailId)).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      errorCode: 'PROVIDER_BUSY',
    });
    expect(await config(a)).toMatchObject({ accessIssue: 'PROVIDER_BUSY', consecutiveFailures: 1 });
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
    await configureAI(a, { cooldownUntil: new Date(Date.now() - 1000) });
    await run(a, emailId, ok());
    expect(await op(emailId)).toMatchObject({ status: 'COMPLETED', attempts: 1 });
    expect(await config(a)).toMatchObject({
      accessIssue: null,
      cooldownUntil: null,
      consecutiveFailures: 0,
    });
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
    await configureAI(a, { consecutiveFailures: 3 });
    expect(
      secondsFromNow((await failure(run(a, await newEmail(a), refuse('PROVIDER_BUSY')))).resumesAt),
    ).toBe(480);
  });

  it('bounds a long retry-after to one hour', async () => {
    const error = await failure(
      run(a, await newEmail(a), refuse('RATE_LIMITED', { retryAfterMs: 7_200_000 })),
    );
    expect(secondsFromNow(error.resumesAt)).toBe(3600);
  });

  it('grows with consecutive refusals up to 30 minutes and resets after a success', async () => {
    await configureAI(a, { consecutiveFailures: 2 });
    expect(
      secondsFromNow((await failure(run(a, await newEmail(a), refuse('RATE_LIMITED')))).resumesAt),
    ).toBe(240);
    await configureAI(a, { consecutiveFailures: 10, cooldownUntil: null });
    expect(
      secondsFromNow((await failure(run(a, await newEmail(a), refuse('RATE_LIMITED')))).resumesAt),
    ).toBe(1800);
    await configureAI(a, { cooldownUntil: new Date(Date.now() - 1000) });
    await run(a, await newEmail(a), ok());
    expect(await config(a)).toMatchObject({
      accessIssue: null,
      cooldownUntil: null,
      consecutiveFailures: 0,
    });
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
      expect(await config(a)).toMatchObject({ accessIssue: kind, cooldownUntil: null });
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

  it('holds an unknown outcome and pauses that user briefly so an outage holds one call, not many', async () => {
    const emailId = await newEmail(a);
    const error = await failure(run(a, emailId, refuse('OUTCOME_UNKNOWN')));
    expect(error).toBeInstanceOf(AIOutcomeUnknownError);
    expect(await op(emailId)).toMatchObject({
      status: 'UNKNOWN',
      attempts: 1,
      errorCode: 'OUTCOME_UNKNOWN',
    });
    const saved = await config(a);
    expect(saved).toMatchObject({ accessIssue: 'PROVIDER_UNAVAILABLE', consecutiveFailures: 1 });
    expect(secondsFromNow(saved.cooldownUntil)).toBe(120);
    // The held mail stays held; the other waiting mail is offered again when the pause ends.
    expect(vi.mocked(enqueueAiResume).mock.calls).toEqual([[a, saved.cooldownUntil]]);

    const next = ok();
    expect(await failure(run(a, await newEmail(a), next))).toMatchObject({
      reason: 'PROVIDER_UNAVAILABLE',
    });
    expect(next).not.toHaveBeenCalled();
    await run(b, await newEmail(b), ok());
  });

  it('fails unusable output for review and records its tokens', async () => {
    const emailId = await newEmail(a);
    const call = refuse('INVALID_OUTPUT', { usage: { inputTokens: 7, outputTokens: 3 } });
    expect(await failure(run(a, emailId, call))).toBeInstanceOf(SchemaValidationFailure);
    expect(await op(emailId)).toMatchObject({ status: 'FAILED', errorCode: 'INVALID_OUTPUT' });
    expect(await usage(a)).toMatchObject({ calls: 1, inputTokens: 7, outputTokens: 3 });
    expect(await config(a)).toMatchObject({ accessIssue: null, cooldownUntil: null });
  });

  it('never lets a job holding an older configuration change the saved state', async () => {
    await configureAI(a, { revision: 1 });
    await failure(run(a, await newEmail(a), refuse('KEY_REJECTED'), { revision: 0 }));
    await failure(run(a, await newEmail(a), refuse('RATE_LIMITED'), { revision: 0 }));
    expect(await config(a)).toMatchObject({
      accessIssue: null,
      cooldownUntil: null,
      consecutiveFailures: 0,
    });
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
    await configureAI(a, { cooldownUntil: null });
    await expect(run(a, emailId, call)).rejects.toThrow('requires review');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
