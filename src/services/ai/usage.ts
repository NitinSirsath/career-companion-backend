/**
 * Per-user AI safety limit, counts and cooldown (ADR-0001 decision 7; plan §3.9).
 *
 * The safety limit is Career Companion's own safeguard: it bounds how many AI calls Career
 * Companion makes for one user per UTC day so a defect or loop cannot run unbounded. It does not
 * represent, mirror or predict any provider quota, billing or rate limit. Counts are records of
 * what Career Companion sent, not provider billing data.
 */
import { AIAccessIssue, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { enqueueAiResume } from '../enqueue';
import type { AIUsage } from './contracts';
import { AIAccessError, FailureKind, PAUSE_FAILURE_KINDS, aiSetting } from './errors';
import * as config from '../../utils/config';
import { logWarn } from '../../utils/log';

export const MAX_DAILY_VERIFICATIONS = 20;

const RATE_LIMIT_BASE_MS = 60_000;
const UNKNOWN_OUTCOME_BASE_MS = 120_000;
const MAX_COOLDOWN_MS = 30 * 60_000;
const RETRY_AFTER_MIN_MS = 10_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;

/** AI calls per user per UTC day. 0 pauses all AI calls. */
export const userDailyCallLimit = () => aiSetting(config.userDailyCallLimit);

export const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** Stored problems that pass by themselves: each comes with a cooldown, and a success clears it. */
export const PAUSE_ISSUES: AIAccessIssue[] = [
  'RATE_LIMITED',
  'PROVIDER_BUSY',
  'PROVIDER_UNAVAILABLE',
];

/** Why an active cooldown is running, from the stored problem. */
export const pauseReason = (issue: AIAccessIssue | null | undefined) =>
  issue === 'PROVIDER_BUSY' || issue === 'PROVIDER_UNAVAILABLE' ? issue : 'RATE_LIMITED';

export function nextUtcMidnight(now: Date): Date {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

/**
 * Reserves one call for the user inside the claim transaction. Throws AIAccessError (rolling back
 * the claim) when Career Companion is paused, the user's provider cooldown is active, or the user's
 * safety limit for today is reached.
 */
export async function reserveUserCall(tx: Prisma.TransactionClient, userId: string, now: Date) {
  const limit = userDailyCallLimit();
  if (limit === 0) throw new AIAccessError('PAUSED');
  const config = await tx.aIConfiguration.findUnique({
    where: { userId },
    select: { cooldownUntil: true, accessIssue: true },
  });
  if (config?.cooldownUntil && config.cooldownUntil > now)
    throw new AIAccessError(pauseReason(config.accessIssue), config.cooldownUntil);
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

type PauseKind = (typeof PAUSE_FAILURE_KINDS)[number] | 'OUTCOME_UNKNOWN';

function cooldownMs(kind: PauseKind, failures: number, retryAfterMs?: number) {
  if (kind !== 'OUTCOME_UNKNOWN' && retryAfterMs !== undefined)
    return Math.min(Math.max(retryAfterMs, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
  const base = kind === 'OUTCOME_UNKNOWN' ? UNKNOWN_OUTCOME_BASE_MS : RATE_LIMIT_BASE_MS;
  return Math.min(base * 2 ** failures, MAX_COOLDOWN_MS);
}

/**
 * Records a provider refusal or an unknown outcome on the user's configuration and returns when
 * a cooldown ends (null when the problem needs the user's attention instead).
 *
 * - Key, account/billing and model problems need the user's attention.
 * - A rate limit or a busy provider pauses this user only, with growth on consecutive failures,
 *   capped at 30 minutes.
 * - An unknown outcome pauses this user briefly too, so an outage holds at most one uncertain
 *   operation per window instead of one per email.
 */
export async function noteProviderFailure(
  tx: Prisma.TransactionClient,
  access: AccessIdentity,
  kind: Exclude<FailureKind, 'INVALID_OUTPUT' | 'INVALID_REQUEST'>,
  now: Date,
  details: { modelId?: string; retryAfterMs?: number } = {},
): Promise<Date | null> {
  const where = { userId: access.userId, revision: access.revision };
  if (kind === 'KEY_REJECTED' || kind === 'ACCOUNT_OR_BILLING' || kind === 'MODEL_UNAVAILABLE') {
    await tx.aIConfiguration.updateMany({
      where,
      data: {
        accessIssue: kind,
        accessIssueModel: kind === 'MODEL_UNAVAILABLE' ? (details.modelId ?? null) : null,
      },
    });
    return null;
  }
  const current = await tx.aIConfiguration.findFirst({
    where,
    select: { consecutiveFailures: true },
  });
  const resumesAt = new Date(
    now.getTime() + cooldownMs(kind, current?.consecutiveFailures ?? 0, details.retryAfterMs),
  );
  await tx.aIConfiguration.updateMany({
    where,
    data: {
      accessIssue: kind === 'OUTCOME_UNKNOWN' ? 'PROVIDER_UNAVAILABLE' : kind,
      accessIssueModel: null,
      cooldownUntil: resumesAt,
      consecutiveFailures: { increment: 1 },
    },
  });
  return resumesAt;
}

/**
 * Queues the automatic read for the moment a pause ends, so waiting mail does not wait for the
 * next sync. Called after the transaction that recorded the pause. Best effort: if the job cannot
 * be queued, the next sync offers the waiting mail again.
 */
export async function resumeAfterPause(userId: string, resumesAt: Date | null): Promise<void> {
  if (!resumesAt) return;
  try {
    await enqueueAiResume(userId, resumesAt);
  } catch {
    logWarn('ai_resume_not_queued', { userId });
  }
}

/** A successful call clears a passed limitation and resets cooldown growth. Best effort. */
export async function noteProviderSuccess(access: AccessIdentity) {
  try {
    await prisma.aIConfiguration.updateMany({
      where: {
        userId: access.userId,
        revision: access.revision,
        // Only limitations are cleared; a needs-attention issue recorded concurrently stays.
        AND: [
          { OR: [{ accessIssue: null }, { accessIssue: { in: PAUSE_ISSUES } }] },
          {
            OR: [
              { consecutiveFailures: { gt: 0 } },
              { cooldownUntil: { not: null } },
              { accessIssue: { not: null } },
            ],
          },
        ],
      },
      data: { consecutiveFailures: 0, cooldownUntil: null, accessIssue: null },
    });
  } catch {
    logWarn('ai_access_state_record_failed', { userId: access.userId });
  }
}
