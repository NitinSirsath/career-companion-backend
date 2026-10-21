/**
 * Jobs the user's automation looked at but did not apply to (ADR-0002 amendment, 21 Oct 2026).
 *
 * Domain only: no MCP code. Kept apart from applications: an entry never creates, links or changes
 * an application. Keyed by `sourceRecordRef` like submissions; a repeat fills only empty fields.
 */
import { NotSubmittedJob, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { LOCK_NAMESPACE, lockUser } from '../utils/advisoryLock';
import { submissionDailyLimit } from '../utils/config';
import { SUBMISSION_PLATFORMS, SubmissionIntakeError, canonicalJobUrl } from './externalSubmission';

const FUTURE_TOLERANCE_MS = 5 * 60_000;
export const REASON_LIMIT = 1000;

/** The not-submitted tool contract. Strict: unknown keys are rejected. */
export const RecordNotSubmittedJobInputSchema = z.strictObject({
  sourceRecordRef: z.string().regex(/^\d{4}-\d{2}-\d{2}\/\d{2}:\d{2}:\d{2}$/),
  outcome: z.enum(['skipped', 'needs_user']),
  platform: z.enum(SUBMISSION_PLATFORMS),
  company: z.string().trim().min(1).max(200),
  jobTitle: z.string().trim().min(1).max(200),
  loggedAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(REASON_LIMIT),
  jobUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .nullish(),
});

const KNOWN_FIELDS = new Set(Object.keys(RecordNotSubmittedJobInputSchema.shape));

/** Field names safe to log: known schema fields, with unknown keys counted rather than named. */
export function loggableNotSubmittedFields(fields: string[]) {
  return {
    invalidFields: fields.filter((f) => KNOWN_FIELDS.has(f) || f === '(input)'),
    unknownKeyCount: fields.filter((f) => !KNOWN_FIELDS.has(f) && f !== '(input)').length,
  };
}

export interface CanonicalNotSubmittedJob {
  sourceRecordRef: string;
  outcome: 'SKIPPED' | 'NEEDS_USER';
  platform: (typeof SUBMISSION_PLATFORMS)[number];
  company: string;
  jobTitle: string;
  loggedAt: Date;
  reason: string;
  jobUrl: string | null;
}

export function parseNotSubmittedInput(raw: unknown, now = new Date()): CanonicalNotSubmittedJob {
  const parsed = RecordNotSubmittedJobInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = new Set<string>();
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys') issue.keys.forEach((k) => fields.add(k));
      else fields.add(issue.path.length ? String(issue.path[0]) : '(input)');
    }
    throw new SubmissionIntakeError(
      'invalid_input',
      'The entry does not match the tool contract.',
      [...fields],
    );
  }
  const input = parsed.data;
  const loggedAt = new Date(input.loggedAt);
  if (loggedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS)
    throw new SubmissionIntakeError('invalid_input', 'loggedAt is in the future.', ['loggedAt']);
  return {
    sourceRecordRef: input.sourceRecordRef,
    outcome: input.outcome === 'skipped' ? 'SKIPPED' : 'NEEDS_USER',
    platform: input.platform,
    company: input.company,
    jobTitle: input.jobTitle,
    loggedAt,
    reason: input.reason,
    jobUrl: input.jobUrl ? canonicalJobUrl(input.jobUrl) : null,
  };
}

const startOfUtcDay = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export type NotSubmittedResult = 'recorded' | 'already_recorded';
const TX_OPTIONS = { maxWait: 5000, timeout: 10000 };

/** Fills only the optional job link, and only while it is empty. */
const fillOf = (stored: NotSubmittedJob, incoming: CanonicalNotSubmittedJob) =>
  stored.jobUrl === null && incoming.jobUrl !== null ? { jobUrl: incoming.jobUrl } : null;

/**
 * Records one not-submitted entry for the token's user. Idempotent on
 * (user, AUTOMATION, sourceRecordRef). Counts against its own daily limit, apart from submissions.
 */
export async function recordNotSubmittedJob(
  userId: string,
  tokenId: string | null,
  raw: unknown,
  now = new Date(),
): Promise<{ result: NotSubmittedResult; recordId: string }> {
  const job = parseNotSubmittedInput(raw, now);
  const ref = { userId, source: 'AUTOMATION' as const, sourceRecordRef: job.sourceRecordRef };
  const repeat = async (db: Prisma.TransactionClient | typeof prisma) => {
    const stored = await db.notSubmittedJob.findUnique({
      where: { userId_source_sourceRecordRef: ref },
    });
    if (!stored) return null;
    const fill = fillOf(stored, job);
    if (fill) await db.notSubmittedJob.update({ where: { id: stored.id }, data: fill });
    return { result: 'already_recorded' as const, recordId: stored.id };
  };
  try {
    return await prisma.$transaction(async (tx) => {
      await lockUser(tx, LOCK_NAMESPACE.externalSubmissions, userId);
      const existing = await repeat(tx);
      if (existing) return existing;
      const today = await tx.notSubmittedJob.count({
        where: { userId, receivedAt: { gte: startOfUtcDay(now) } },
      });
      if (today >= submissionDailyLimit())
        throw new SubmissionIntakeError(
          'rate_limited',
          'The daily limit is reached. Retry the next UTC day.',
        );
      const record = await tx.notSubmittedJob.create({
        data: { ...ref, ...job, receivedAt: now, tokenId },
        select: { id: true },
      });
      return { result: 'recorded' as const, recordId: record.id };
    }, TX_OPTIONS);
  } catch (err) {
    // Defensive: the lock makes this unreachable, but a duplicate ref is always a replay.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await repeat(prisma);
      if (existing) return existing;
    }
    throw err;
  }
}

/** The owner's not-submitted jobs, newest entry first. */
export async function listNotSubmittedJobs(userId: string, limit: number, offset: number) {
  return prisma.notSubmittedJob.findMany({
    where: { userId },
    orderBy: [{ loggedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    skip: offset,
    select: {
      id: true,
      sourceRecordRef: true,
      outcome: true,
      platform: true,
      company: true,
      jobTitle: true,
      jobUrl: true,
      reason: true,
      loggedAt: true,
      receivedAt: true,
    },
  });
}
