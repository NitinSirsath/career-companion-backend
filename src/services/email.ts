/** The user's synced emails: the Gmail page list and the checks before a manual retry. */
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { logEvent } from '../utils/log';
import { getAccessState } from './ai/access';
import { HoldReason, holdOf } from './ai/heldOperations';
import { enqueueEmailProcessingJob } from './enqueue';

// 300s expiry + ~120s detection + 60 * 2^3 backoff; also clears the
// 15-minute uncertain AI claim threshold by five minutes.
export const EMAIL_PROCESSING_STUCK_MS = 20 * 60_000;

/** One page of emails, newest first, plus one extra row so the caller can tell if more exist. */
export async function listEmails(
  userId: string,
  relevance: string | undefined,
  limit: number,
  offset: number,
) {
  const where: Prisma.EmailWhereInput = { userId };
  if (relevance === 'job_related') {
    where.relevanceState = { in: ['RELEVANT', 'UNPROCESSED'] };
  } else if (relevance === 'irrelevant') {
    where.relevanceState = 'IRRELEVANT';
  }

  const messages = await prisma.email.findMany({
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
      aiProcessingResult: { select: { provider: true, model: true } },
    },
  });

  const cutoff = Date.now() - EMAIL_PROCESSING_STUCK_MS;
  return messages.map(({ updatedAt, ...message }) => ({
    ...message,
    processingStuck: message.processingState === 'PROCESSING' && updatedAt.getTime() < cutoff,
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
    },
  },
} satisfies Prisma.EmailSelect;

type RetryOperation = Prisma.EmailGetPayload<{
  select: typeof RETRY_STATE;
}>['aiOperations'][number];
/** An operation that is never replayed automatically, and why the user may approve one more call. */
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
 * Checks that the email may be retried. Held operations are never replayed automatically: when
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

  const now = new Date();
  const holds = email.aiOperations.flatMap((op) => {
    const hold = holdOf(op, now);
    return hold ? [{ op, approvable: hold.approvable }] : [];
  });
  const held = holds.filter((hold): hold is HeldOperation => hold.approvable !== null);
  const legacyPartial =
    !!email.aiProcessingResult &&
    email.aiProcessingResult.processingStatus !== 'COMPLETED' &&
    email.aiOperations.length === 0;
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
        })),
        currentProvider: config?.provider ?? null,
      },
    );

  const access = await getAccessState(userId);
  if (access.state !== 'READY')
    throw new AppError(409, 'AI_ACCESS_UNAVAILABLE', 'Fix AI access before approving a retry.', {
      state: access.state,
      reason: access.reason,
      resumesAt: access.resumesAt ? access.resumesAt.toISOString() : null,
    });

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
