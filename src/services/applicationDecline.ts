/**
 * The user declined by mail (owner, 17 Nov 2026): the reply is noted on the conversation's
 * application, the user answers "Close the application?", and the ones nobody answered close by
 * themselves after three days. How it reads: `declineQuestion.ts`.
 */
import type { ApplicationStatus, Prisma } from '@prisma/client';
import { AppError } from '../errors';
import { prisma } from '../db/prisma';
import type { ApplicationResponse, DeclineAnswerRequest } from '../contracts';
import { logEvent } from '../utils/log';
import { getApplication } from './application';
import { DECLINE_CLOSES_AFTER_MS, STILL_OPEN, declinePending } from './declineQuestion';
import { recordStatusChange } from './statusLog';
import { closeAsksOfApplication } from './threadAsks';

/**
 * The reply sent at `sentAt` in this conversation said the user no longer wants the job: its
 * application (the one its mails are linked to) asks to close. A newer decline asks again, even
 * after Keep open. Returns whether an application was noted.
 */
export async function noteDecline(userId: string, threadId: string, sentAt: Date) {
  const linked = await prisma.email.findFirst({
    where: { userId, threadId, matchState: 'MATCHED', applicationId: { not: null } },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    select: { applicationId: true },
  });
  if (!linked?.applicationId) return false;
  const { count } = await prisma.application.updateMany({
    where: {
      id: linked.applicationId,
      userId,
      ...STILL_OPEN,
      AND: [{ OR: [{ declinedAt: null }, { declinedAt: { lt: sentAt } }] }],
    },
    data: { declinedAt: sentAt, declineAnswer: null, declineAnsweredAt: null },
  });
  if (count) logEvent('decline_noted', { userId, applicationId: linked.applicationId });
  return count > 0;
}

/** Close it or Keep open. Only while the question is waiting; otherwise 409. */
export async function answerDecline(
  userId: string,
  id: string,
  request: DeclineAnswerRequest,
): Promise<ApplicationResponse> {
  const answered = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM applications WHERE id = ${id}::uuid AND "userId" = ${userId}::uuid
      FOR UPDATE`;
    const app = await tx.application.findFirst({ where: { id, userId } });
    if (!app) throw new AppError(404, 'NOT_FOUND', 'Application not found');
    if (!declinePending(app))
      throw new AppError(
        409,
        'NO_DECLINE_QUESTION',
        'This application no longer asks to be closed. Reload it to see where it stands.',
      );
    const now = new Date();
    if (request.answer === 'KEEP_OPEN') {
      await tx.application.update({
        where: { id },
        data: { declineAnswer: 'KEPT_OPEN', declineAnsweredAt: now },
      });
      return 'KEPT_OPEN' as const;
    }
    await closeAfterDecline(tx, app, now);
    return 'CLOSED' as const;
  });
  if (answered === 'CLOSED') await closeAsksOfApplication(userId, id);
  logEvent('decline_answered', { userId, applicationId: id, answer: answered });
  const application = await getApplication(userId, id);
  if (!application) throw new AppError(404, 'NOT_FOUND', 'Application not found');
  return application;
}

/**
 * Closes the applications whose question waited three days with no answer and no newer mail
 * from the company. Runs every hour. Returns how many closed.
 */
export async function closeDueDeclines(): Promise<number> {
  const due = await prisma.application.findMany({
    where: {
      ...STILL_OPEN,
      declineAnswer: null,
      declinedAt: { lte: new Date(Date.now() - DECLINE_CLOSES_AFTER_MS) },
    },
    select: { id: true, userId: true, declinedAt: true },
  });
  let closed = 0;
  for (const { id, userId, declinedAt } of due) {
    if (!declinedAt) continue;
    const wroteAgain = await prisma.email.count({
      where: { applicationId: id, relevanceState: 'RELEVANT', receivedAt: { gt: declinedAt } },
    });
    if (wroteAgain) continue;
    const done = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM applications WHERE id = ${id}::uuid FOR UPDATE`;
      const app = await tx.application.findUnique({ where: { id } });
      // Answered, changed or declined again meanwhile: it stays as it is.
      if (!app || !declinePending(app) || app.declinedAt.getTime() !== declinedAt.getTime())
        return false;
      await closeAfterDecline(tx, app, new Date());
      return true;
    });
    if (!done) continue;
    await closeAsksOfApplication(userId, id);
    logEvent('decline_closed_by_itself', { userId, applicationId: id });
    closed++;
  }
  return closed;
}

/**
 * Sets the status to Closed as the user's own choice: they said no in their reply. It shows as
 * "Closed after you declined by mail", and the user can change it like any status they set.
 */
async function closeAfterDecline(
  tx: Prisma.TransactionClient,
  app: { id: string; aiStatus: ApplicationStatus | null; userStatus: ApplicationStatus | null },
  now: Date,
) {
  await tx.application.update({
    where: { id: app.id },
    data: {
      userStatus: 'CLOSED',
      userStatusSetAt: now,
      userStatusRevision: { increment: 1 },
      declineAnswer: 'CLOSED',
      declineAnsweredAt: now,
    },
  });
  await recordStatusChange(tx, {
    applicationId: app.id,
    before: app,
    after: { aiStatus: app.aiStatus, userStatus: 'CLOSED' },
    source: 'USER',
    changedAt: now,
  });
}
