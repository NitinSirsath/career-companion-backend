/**
 * Deleting from NorthList (owner, 26 Oct 2026): a conversation the user does not want kept, or an
 * application. Gmail is never changed: the app can only read it.
 */
import { prisma } from '../db/prisma';
import type { DeleteConversationRequest } from '../contracts/blockedSender';
import { AppError } from '../errors';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { blockDomain, conversationSender } from './blockedSenders';
import { threadKey } from './conversation';
import { conversationWhere } from './conversationQuery';
import { NOT_JOB_MAIL_FORGETS } from './mailRetention';

const BEING_READ =
  'The AI is reading a mail of this conversation right now. Try again in a minute.';

/**
 * Removes a conversation and everything the app took from it: subjects, senders, the AI's
 * reading, steps, history entries and agenda items, and the records of the user's replies. Each
 * mail keeps only its Gmail ids and date, as a mail that is not about a job does, so a sync does
 * not bring it back; the daily clean-up deletes it later (`mailRetention.ts`). A later mail in
 * the same thread still comes in. The application stays as it is.
 */
export async function deleteConversation(
  userId: string,
  anyKey: string,
  request: DeleteConversationRequest,
) {
  const key = await threadKey(userId, anyKey);
  return prisma.$transaction(async (tx) => {
    // Matching holds this lock, so no mail of the conversation is linked meanwhile.
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    const sender = await conversationSender(tx, userId, key);
    const mails = await tx.email.findMany({
      where: { userId, ...conversationWhere(key) },
      select: { id: true, processingState: true },
    });
    if (mails.some((mail) => mail.processingState === 'PROCESSING'))
      throw new AppError(409, 'MAIL_BEING_READ', BEING_READ);
    const blocked = request.block ? await blockDomain(tx, userId, sender, 'DELETE') : null;
    const emailId = { in: mails.map((mail) => mail.id) };
    await tx.action.deleteMany({ where: { emailId } });
    await tx.applicationEvent.deleteMany({ where: { emailId } });
    await tx.agendaItem.deleteMany({ where: { emailId } });
    await tx.aIOperation.deleteMany({ where: { emailId } });
    await tx.aIProcessingResult.deleteMany({ where: { emailId } });
    // A finished "not a job mail" result: a queued AI job for one of these mails adopts it and
    // never reads the mail again.
    await tx.aIProcessingResult.createMany({
      data: mails.map((mail) => ({
        emailId: mail.id,
        provider: 'deleted',
        model: 'none',
        contractVersion: 'deleted/v1',
        relevanceDecision: 'IRRELEVANT' as const,
        processingStatus: 'COMPLETED' as const,
        deterministic: true,
      })),
    });
    await tx.email.updateMany({
      where: { userId, id: emailId },
      data: {
        ...NOT_JOB_MAIL_FORGETS,
        relevanceState: 'IRRELEVANT',
        processingState: 'COMPLETED',
        processingErrorCategory: null,
        processingErrorStage: null,
        processingRetryable: null,
        processingFailedAt: null,
        applicationId: null,
        matchState: 'UNMATCHED',
        matchConfirmedBy: null,
        requestUserState: null,
        requestUserStateAt: null,
      },
    });
    await tx.outgoingEmail.deleteMany({ where: { userId, threadId: key } });
    return { deleted: mails.length, blocked: blocked?.domain ?? null };
  });
}

/**
 * Removes an application with its steps, history and agenda items, and what the user's automation
 * reported for it (owner, 1 Nov 2026: unlinked, those records were shown nowhere). Its mails stay in
 * Mails, no longer linked, so the conversation offers "Create application" again. Automation records
 * waiting for review or ignored, and jobs not applied to, stay. Archive stays for finished jobs.
 */
export async function deleteApplication(userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    // Automation intake links records under this lock. No other path takes both locks.
    await lockUser(tx, LOCK_NAMESPACE.externalSubmissions, userId);
    const application = await tx.application.findFirst({ where: { id, userId } });
    if (!application) throw new AppError(404, 'NOT_FOUND', 'Application not found.');
    await tx.email.updateMany({
      where: { userId, applicationId: id },
      data: { applicationId: null, matchState: 'UNMATCHED', matchConfirmedBy: null },
    });
    await tx.externalSubmission.deleteMany({ where: { userId, applicationId: id } });
    // Steps, history and agenda items go with it (cascade).
    await tx.application.delete({ where: { id } });
    return { deleted: true as const };
  });
}
