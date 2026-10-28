/**
 * The user's synced emails: the Gmail page list, the checks before a manual retry, and the
 * processing state the worker records.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { logEvent } from '../utils/log';
import { blockingPause, getAccessState, withPause } from './ai/access';
import { readFailure } from './ai/failures';
import { HoldReason, heldOperations } from './ai/heldOperations';
import { STATUS_STEP_SELECT, aiStatusOf } from './ai/mailStatus';
import { enqueueEmailProcessingJob } from './enqueue';

// 300s expiry + ~120s detection + 60 * 2^3 backoff; also clears the
// uncertain AI claim thresholds (15 minutes for a batch) by five minutes.
export const EMAIL_PROCESSING_STUCK_MS = 20 * 60_000;

/**
 * One page of job mails and mails not read yet, newest first, plus one extra row so the caller
 * can tell if more exist. Mails that are not about a job are never listed: the app keeps only
 * their ids (`mailRetention.ts`). A waiting or stopped email says why and what happens next
 * (`aiStatus`).
 */
export async function listEmails(userId: string, limit: number, offset: number) {
  const where: Prisma.EmailWhereInput = {
    userId,
    relevanceState: { in: ['RELEVANT', 'UNPROCESSED'] },
  };

  const [messages, access] = await Promise.all([
    prisma.email.findMany({
      where,
      take: limit + 1,
      skip: offset,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        gmailMessageId: true,
        threadId: true,
        subject: true,
        sender: true,
        receivedAt: true,
        relevanceState: true,
        matchState: true,
        applicationId: true,
        matchConfirmedBy: true,
        application: { select: { id: true, companyName: true, jobTitle: true } },
        processingState: true,
        updatedAt: true,
        processingErrorCategory: true,
        processingErrorDetails: true,
        processingErrorStage: true,
        processingRetryable: true,
        processingFailedAt: true,
        aiProcessingResult: {
          select: { provider: true, model: true, processingStatus: true, category: true },
        },
        aiOperations: { select: STATUS_STEP_SELECT },
      },
    }),
    getAccessState(userId),
  ]);

  const now = new Date();
  const cutoff = now.getTime() - EMAIL_PROCESSING_STUCK_MS;
  return messages.map(({ updatedAt, aiOperations, aiProcessingResult, ...message }) => ({
    ...message,
    aiProcessingResult: aiProcessingResult && {
      provider: aiProcessingResult.provider,
      model: aiProcessingResult.model,
    },
    category: aiProcessingResult?.category ?? null,
    processingStuck: message.processingState === 'PROCESSING' && updatedAt.getTime() < cutoff,
    aiStatus: aiStatusOf({ ...message, aiProcessingResult, aiOperations }, access, now),
  }));
}

const RETRY_STATE = {
  processingState: true,
  aiProcessingResult: { select: { processingStatus: true } },
  aiOperations: {
    select: {
      id: true,
      operation: true,
      version: true,
      status: true,
      attempts: true,
      approvedRetries: true,
      errorCode: true,
      startedAt: true,
      provider: true,
      model: true,
      lastFailure: true,
      triedAt: true,
    },
  },
} satisfies Prisma.EmailSelect;

type RetryOperation = Prisma.EmailGetPayload<{
  select: typeof RETRY_STATE;
}>['aiOperations'][number];
/** An operation that is not tried again by itself, and why the user may approve one more call. */
type HeldOperation = { op: RetryOperation; approvable: HoldReason };

/**
 * Offers a failed or stuck email to the worker again. It writes no processing state: the worker
 * alone moves the email into PROCESSING and to its final outcome.
 */
export async function retryEmail(
  userId: string,
  emailId: string,
  acceptPossibleDuplicateCharge: boolean | undefined,
): Promise<void> {
  const approval = await prepareRetry(userId, emailId, acceptPossibleDuplicateCharge);
  const jobId = await enqueueEmailProcessingJob(userId, emailId, approval);
  if (!jobId)
    throw new AppError(
      409,
      'RETRY_RECENTLY_QUEUED',
      'A processing attempt was queued recently. Try again in a few minutes.',
    );
}

/**
 * Checks that the email may be retried. Held operations are not tried again by themselves: when
 * the outcome was uncertain or unusable, the user may approve exactly one more call with
 * `acceptPossibleDuplicateCharge`. Engineering failures and legacy partial results stay with the
 * operator.
 *
 * Returns the approval number to queue the job with; undefined when nothing was held.
 */
async function prepareRetry(
  userId: string,
  emailId: string,
  acceptPossibleDuplicateCharge: boolean | undefined,
): Promise<number | undefined> {
  const email = await prisma.email.findFirst({
    where: { id: emailId, userId },
    select: RETRY_STATE,
  });
  if (!email) throw new AppError(404, 'NOT_FOUND', 'Email not found.');
  if (email.processingState === 'COMPLETED')
    throw new AppError(400, 'BAD_REQUEST', 'Email is already completed.');

  const { holds, legacyPartial } = heldOperations(email, new Date());
  const held = holds.filter((hold): hold is HeldOperation => hold.approvable !== null);
  if (legacyPartial || held.length < holds.length)
    throw new AppError(
      409,
      'AI_OPERATION_REQUIRES_REVIEW',
      'This email has an AI operation that needs review before it can be retried.',
    );

  if (!held.length) return undefined;
  return approveHeldOperations(userId, emailId, held, acceptPossibleDuplicateCharge);
}

/** Records the user's approval of one more call for each held operation. */
async function approveHeldOperations(
  userId: string,
  emailId: string,
  held: HeldOperation[],
  acceptPossibleDuplicateCharge: boolean | undefined,
): Promise<number> {
  const config = await prisma.aIConfiguration.findUnique({
    where: { userId },
    select: { provider: true },
  });
  if (!acceptPossibleDuplicateCharge)
    throw new AppError(
      409,
      'AI_RETRY_NEEDS_APPROVAL',
      'The earlier AI attempt may already have been charged. Approve one more attempt to retry.',
      {
        operations: held.map(({ op, approvable }) => ({
          operation: op.operation,
          reason: approvable,
          provider: op.provider,
          model: op.model,
          attemptedAt: op.startedAt ? op.startedAt.toISOString() : null,
          triedAt: op.triedAt.map((at) => at.toISOString()),
          failure: readFailure(op.lastFailure),
        })),
        currentProvider: config?.provider ?? null,
      },
    );

  // The model a held step uses must not be paused either.
  const user = await getAccessState(userId);
  const roles = held.map(({ op }) => (op.operation === 'extraction' ? 'detailed' : 'fast'));
  const access = withPause(user, blockingPause(user.pauses, roles));
  if (access.state !== 'READY') {
    const failure = access.pause?.failure ?? null;
    throw new AppError(409, 'AI_ACCESS_UNAVAILABLE', 'Fix AI access before approving a retry.', {
      state: access.state,
      reason: access.reason,
      resumesAt: access.resumesAt ? access.resumesAt.toISOString() : null,
      modelId: access.pause?.model ?? null,
      failure,
    });
  }

  // Compare-and-set on what the user saw: a concurrent approval or claim changes the row.
  await prisma.$transaction(async (tx) => {
    for (const { op } of held) {
      const changed = await tx.aIOperation.updateMany({
        where: {
          id: op.id,
          status: op.status,
          attempts: op.attempts,
          approvedRetries: op.approvedRetries,
        },
        data: { status: 'RETRYABLE', retryAfter: null, approvedRetries: { increment: 1 } },
      });
      if (changed.count !== 1)
        throw new AppError(
          409,
          'AI_OPERATION_CHANGED',
          'This email changed. Refresh and try again.',
        );
    }
  });

  for (const { op } of held)
    logEvent('ai_retry_approved', {
      userId,
      emailId,
      operation: op.operation,
      version: op.version,
      previousStatus: op.status,
      previousProvider: op.provider,
      currentProvider: config?.provider ?? null,
    });
  return Math.max(...held.map(({ op }) => op.approvedRetries)) + 1;
}

// Completed emails are never downgraded, so every worker update skips them.
const notCompleted = (userId: string, emailId: string) => ({
  id: emailId,
  userId,
  processingState: { not: 'COMPLETED' as const },
});

export async function markEmailProcessing(userId: string, emailId: string): Promise<void> {
  await prisma.email.updateMany({
    where: notCompleted(userId, emailId),
    data: { processingState: 'PROCESSING' },
  });
}

/** Puts an email that only waited for AI access back in line, with no failure recorded. */
export async function returnEmailToPending(userId: string, emailId: string): Promise<void> {
  await prisma.email.updateMany({
    where: notCompleted(userId, emailId),
    data: {
      processingState: 'PENDING',
      processingErrorCategory: null,
      processingErrorDetails: null,
      processingErrorStage: null,
      processingRetryable: null,
      processingFailedAt: null,
    },
  });
}

/** Records a failed attempt. `final` means no delivery is left, so the email becomes FAILED. */
export async function recordEmailFailure(
  userId: string,
  emailId: string,
  failure: { category: string; details: string; stage: string | null; retryable: boolean },
  final: boolean,
): Promise<void> {
  await prisma.email.updateMany({
    where: notCompleted(userId, emailId),
    data: {
      processingState: final ? 'FAILED' : 'PROCESSING',
      processingErrorCategory: failure.category,
      processingErrorDetails: failure.details,
      processingErrorStage: failure.stage,
      processingRetryable: final ? false : failure.retryable,
      processingFailedAt: new Date(),
    },
  });
}
