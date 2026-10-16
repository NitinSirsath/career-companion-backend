/**
 * Per-user AI safety limit and counts, and each model's own pause (ADR-0001 decision 7; plan §3.9).
 *
 * The safety limit is Career Companion's own safeguard: it bounds how many AI calls Career
 * Companion makes for one user per UTC day so a defect or loop cannot run unbounded. It does not
 * represent, mirror or predict any provider quota, billing or rate limit. Counts are records of
 * what Career Companion sent, not provider billing data.
 */
import { AIModelPause, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { enqueueAiResume } from '../enqueue';
import type { AIUsage } from './contracts';
import { AIAccessError, FailureKind, QuotaScope, aiSetting } from './errors';
import * as config from '../../utils/config';
import { logEvent, logWarn } from '../../utils/log';

export const MAX_DAILY_VERIFICATIONS = 20;

const RATE_LIMIT_BASE_MS = 60_000;
const MAX_COOLDOWN_MS = 30 * 60_000;
const RETRY_AFTER_MIN_MS = 10_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;

/** AI calls per user per UTC day. 0 pauses all AI calls. */
export const userDailyCallLimit = () => aiSetting(config.userDailyCallLimit);

export const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/**
 * True while the test mail of "Read waiting mails now" waits for the paused model's answer: until
 * then only that mail may use the model.
 */
const isRunningTest = (
  pause: Pick<AIModelPause, 'testEmailId' | 'testResult'>,
  emailId: string | undefined,
) => emailId !== undefined && pause.testEmailId === emailId && pause.testResult === null;

export function nextUtcMidnight(now: Date): Date {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

/** Google resets a daily quota at midnight Pacific time. */
const GOOGLE_QUOTA_ZONE = 'America/Los_Angeles';

/** How far the time zone's clock is ahead of UTC at that moment (negative west of UTC). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const clock = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return clock - Math.floor(at.getTime() / 1000) * 1000;
}

/** The next midnight in Los Angeles, when Google's daily quotas reset. */
export function nextPacificMidnight(now: Date): Date {
  const today = new Date(now.getTime() + zoneOffsetMs(now, GOOGLE_QUOTA_ZONE));
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
  // The clocks may change before that midnight, so the offset is read again at it.
  const guess = midnight - zoneOffsetMs(new Date(midnight), GOOGLE_QUOTA_ZONE);
  return new Date(midnight - zoneOffsetMs(new Date(guess), GOOGLE_QUOTA_ZONE));
}

/**
 * Reserves one call on a model for the user inside the claim transaction. Throws AIAccessError
 * (rolling back the claim) when Career Companion is paused, the model's pause is running, or the
 * user's safety limit for today is reached. A pause stops only the calls on its own model; while
 * "Read waiting mails now" tests it, its test mail (`emailId`) may still use it.
 */
export async function reserveUserCall(
  tx: Prisma.TransactionClient,
  call: { userId: string; model: string; emailId?: string },
  now: Date,
) {
  const { userId } = call;
  const limit = userDailyCallLimit();
  if (limit === 0) throw new AIAccessError('PAUSED');
  const pause = await tx.aIModelPause.findUnique({
    where: { userId_model: { userId, model: call.model } },
  });
  if (pause?.resumesAt && pause.resumesAt > now && !isRunningTest(pause, call.emailId))
    throw new AIAccessError(pause.reason, pause.resumesAt);
  const day = utcDay(now);
  await tx.aIUsageDay.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day },
    update: {},
  });
  const reserved = await tx.aIUsageDay.updateMany({
    where: { userId, day, calls: { lt: limit } },
    data: { calls: { increment: 1 } },
  });
  if (!reserved.count) throw new AIAccessError('SAFETY_LIMIT', nextUtcMidnight(now));
}

/** Records the tokens Career Companion observed for one call. Best effort: diagnostics only. */
export async function recordTokens(userId: string, now: Date, usage: AIUsage | undefined) {
  if (!usage || (usage.inputTokens === null && usage.outputTokens === null)) return;
  try {
    await prisma.aIUsageDay.updateMany({
      where: { userId, day: utcDay(now) },
      data: {
        inputTokens: { increment: usage.inputTokens ?? 0 },
        outputTokens: { increment: usage.outputTokens ?? 0 },
      },
    });
  } catch {
    logWarn('ai_usage_record_failed', { userId });
  }
}

/** The configuration a job resolved; state writes apply only while it is still the saved one. */
export interface AccessIdentity {
  userId: string;
  revision: number;
}

/**
 * The wait the provider asked for (bounded to 10 s–1 h), else 1 minute; doubled for each failure
 * in a row, up to 30 minutes, but never shorter than the provider asked.
 */
function cooldownMs(failures: number, retryAfterMs?: number) {
  const base =
    retryAfterMs === undefined
      ? RATE_LIMIT_BASE_MS
      : Math.min(Math.max(retryAfterMs, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
  return Math.max(base, Math.min(base * 2 ** failures, MAX_COOLDOWN_MS));
}

interface PauseDetails {
  modelId: string;
  /** The email the failed call was for, when it was for one. */
  emailId?: string;
  retryAfterMs?: number;
  quotaScope?: QuotaScope;
}

type PauseKind = Extract<FailureKind, 'RATE_LIMITED' | 'PROVIDER_BUSY' | 'OUTCOME_UNKNOWN'>;

/**
 * Records a provider refusal or a call with no answer in time and returns when the model's pause
 * ends (null when the problem needs the user's attention instead). `failedAt` is the moment of
 * the failure: the pause is counted from it, not from the start of the call.
 *
 * - Key, account/billing and model problems need the user's attention, on the configuration.
 * - A rate limit, a busy provider or no answer in time pauses that model only, for this user: for
 *   the wait the provider asked for or 1 minute, growing on the model's failures in a row up to
 *   30 minutes. Another model of the same user is not affected.
 * - A daily quota waits until the provider resets it: midnight Pacific time for Google.
 * - The test mail of "Read waiting mails now" that fails this way keeps the failure count: the
 *   pause starts again from the failure, as long as it was, and the result is kept.
 */
export async function noteProviderFailure(
  tx: Prisma.TransactionClient,
  access: AccessIdentity,
  kind: Exclude<FailureKind, 'INVALID_OUTPUT' | 'INVALID_REQUEST'>,
  failedAt: Date,
  details: PauseDetails,
): Promise<Date | null> {
  if (kind === 'KEY_REJECTED' || kind === 'ACCOUNT_OR_BILLING' || kind === 'MODEL_UNAVAILABLE') {
    await tx.aIConfiguration.updateMany({
      where: { userId: access.userId, revision: access.revision },
      data: {
        accessIssue: kind,
        accessIssueModel: kind === 'MODEL_UNAVAILABLE' ? details.modelId : null,
      },
    });
    return null;
  }
  return pauseModel(tx, access, { ...details, kind, failedAt });
}

/** When a pause from a failure ends: the provider's daily reset, or the cooldown from the failure. */
function pauseEnd(failedAt: Date, failures: number, details: PauseDetails): Date {
  if (details.quotaScope === 'PER_DAY') return nextPacificMidnight(failedAt);
  return new Date(failedAt.getTime() + cooldownMs(failures, details.retryAfterMs));
}

const NO_TEST = { testEmailId: null, testStartedAt: null, testResult: null };

async function pauseModel(
  tx: Prisma.TransactionClient,
  access: AccessIdentity,
  failure: PauseDetails & { kind: PauseKind; failedAt: Date },
): Promise<Date> {
  const { kind, failedAt } = failure;
  const key = { userId_model: { userId: access.userId, model: failure.modelId } };
  const before = await tx.aIModelPause.findUnique({ where: key });
  const failures = before?.consecutiveFailures ?? 0;
  const test = !!before && isRunningTest(before, failure.emailId);
  const resumesAt = pauseEnd(failedAt, test ? Math.max(failures - 1, 0) : failures, failure);
  // A job holding an older configuration never changes the saved state.
  const saved = { userId: access.userId, revision: access.revision };
  if (!(await tx.aIConfiguration.count({ where: saved }))) return resumesAt;
  // No answer in time pauses as for a busy provider.
  const pause = { reason: kind === 'OUTCOME_UNKNOWN' ? 'PROVIDER_BUSY' : kind, resumesAt } as const;
  await tx.aIModelPause.upsert({
    where: key,
    create: { userId: access.userId, model: failure.modelId, ...pause, consecutiveFailures: 1 },
    update: test
      ? { ...pause, testResult: kind }
      : { ...pause, consecutiveFailures: { increment: 1 }, ...NO_TEST },
  });
  // A failure while the model's pause still runs (a call already under way) makes it longer.
  const extended = !test && !!before?.resumesAt && before.resumesAt > failedAt;
  logEvent(extended ? 'ai_pause_extended' : 'ai_paused', {
    userId: access.userId,
    model: failure.modelId,
    reason: pause.reason,
    pauseMs: resumesAt.getTime() - failedAt.getTime(),
    resumesAt,
    consecutiveFailures: test ? failures : failures + 1,
    testEmailId: test ? failure.emailId : undefined,
  });
  return resumesAt;
}

/**
 * Queues the automatic read for the moment a pause or Career Companion's daily limit ends, so
 * waiting mail does not wait for the next sync. Called after the transaction that recorded the
 * pause. Best effort: if the job cannot be queued, the next sync offers the waiting mail again.
 */
export async function resumeAfterPause(userId: string, resumesAt: Date | null): Promise<void> {
  if (!resumesAt) return;
  try {
    await enqueueAiResume(userId, resumesAt);
  } catch {
    logWarn('ai_resume_not_queued', { userId });
  }
}

/**
 * A successful call on a model ends that model's pause and resets its growth; other models keep
 * theirs. When the success answers the test of "Read waiting mails now", the other waiting mail
 * follows now. Best effort.
 */
export async function noteProviderSuccess(access: AccessIdentity, modelId: string) {
  try {
    const where = { userId: access.userId, model: modelId };
    const pause = await prisma.aIModelPause.findUnique({ where: { userId_model: where } });
    if (!pause) return;
    const ended = await prisma.aIModelPause.deleteMany({
      where: { ...where, configuration: { is: { revision: access.revision } } },
    });
    if (ended.count && pause.testEmailId && pause.testResult === null)
      await resumeAfterPause(access.userId, new Date());
  } catch {
    logWarn('ai_access_state_record_failed', { userId: access.userId });
  }
}

/**
 * The test mail of "Read waiting mails now" is done with the AI for now. A test it left open got
 * no busy answer from that model (the mail did not need it, or its step was held), so the test
 * ends and the model's pause shows again. A test with a busy answer keeps it. Best effort.
 */
export async function endTest(userId: string, emailId: string) {
  try {
    await prisma.aIModelPause.updateMany({
      where: { userId, testEmailId: emailId, testResult: null },
      data: { testEmailId: null, testStartedAt: null },
    });
  } catch {
    logWarn('ai_access_state_record_failed', { userId });
  }
}
