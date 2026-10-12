/**
 * Gives a job-mail conversation its application in one step: a new application filled from what
 * the AI read, or one the user already has. Every unresolved email of the conversation is linked.
 */
import type { Application, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import type { LinkConversation, LinkConversationResponse } from '../contracts';
import { AppError, CHANGE_REJECTED } from '../errors';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { logEvent } from '../utils/log';
import { getApplication } from './application';
import { getConversation } from './conversation';
import { conversationWhere } from './conversationQuery';
import { applyMatch, candidateApplications, matchEmailToApplication, sameCompany } from './matcher';

/** How many waiting emails are checked for the same company after a link, newest first. */
const SWEEP_LIMIT = 1000;

export async function linkConversation(
  userId: string,
  key: string,
  request: LinkConversation,
): Promise<LinkConversationResponse> {
  const { application, created, mails } = await prisma.$transaction(async (tx) => {
    // The same lock as matching, so two clicks cannot create the application twice.
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    const thread = await tx.email.findMany({
      where: { userId, relevanceState: 'RELEVANT', ...conversationWhere(key) },
      include: { aiProcessingResult: true },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
    if (!thread.length) throw new AppError(404, 'NOT_FOUND', 'Conversation not found.');
    if (thread.some((mail) => mail.matchState === 'MATCHED' && mail.applicationId))
      throw new AppError(409, 'CONVERSATION_LINKED', CHANGE_REJECTED);
    const waiting = thread.flatMap((mail) =>
      mail.aiProcessingResult && ['UNMATCHED', 'AMBIGUOUS'].includes(mail.matchState)
        ? [{ id: mail.id, result: mail.aiProcessingResult }]
        : [],
    );
    if (!waiting.length) throw new AppError(409, 'CONVERSATION_NOT_LINKABLE', CHANGE_REJECTED);
    const target =
      'applicationId' in request
        ? await chosenApplication(tx, userId, request.applicationId)
        : await applicationFromEmails(tx, userId, request, thread);
    return { ...target, mails: waiting };
  });

  for (const mail of mails) await confirmMatch(mail.id, application.id, mail.result);
  const swept = await sweepSameCompany(userId, key, application);
  logEvent('conversation_linked', {
    userId,
    applicationId: application.id,
    created,
    linkedEmails: mails.length,
    sweptEmails: swept,
  });

  const response = await getApplication(userId, application.id);
  if (!response) throw new AppError(404, 'APPLICATION_NOT_FOUND', 'Application not found.');
  return {
    application: response,
    conversation: (await getConversation(userId, key)).conversation,
    created,
  };
}

type ThreadMail = Prisma.EmailGetPayload<{ include: { aiProcessingResult: true } }>;

/** The application the user picked: theirs, and still active. */
async function chosenApplication(tx: Prisma.TransactionClient, userId: string, id: string) {
  const application = await tx.application.findFirst({ where: { id, userId } });
  if (!application) throw new AppError(404, 'APPLICATION_NOT_FOUND', 'Application not found.');
  if (application.archivedAt) throw new AppError(409, 'APPLICATION_ARCHIVED', CHANGE_REJECTED);
  return { application, created: false };
}

/**
 * The application for what the AI read, newest email first: the one the user already has for
 * this company and role, or a new one. `thread` is oldest first.
 */
async function applicationFromEmails(
  tx: Prisma.TransactionClient,
  userId: string,
  request: { companyName?: string; jobTitle?: string },
  thread: ThreadMail[],
) {
  const results = [...thread].reverse().flatMap((mail) => mail.aiProcessingResult ?? []);
  const companyName =
    request.companyName ?? results.find((result) => result.companyName)?.companyName;
  if (!companyName)
    throw new AppError(
      400,
      'COMPANY_REQUIRED',
      'The company could not be read from this email. Enter the company name.',
    );
  const jobTitle = request.jobTitle ?? results.find((result) => result.jobTitle)?.jobTitle ?? null;
  const candidates = await candidateApplications(tx, userId, companyName, jobTitle);
  if (candidates.length > 1)
    throw new AppError(
      409,
      'APPLICATION_CHOICE_REQUIRED',
      'More than one of your applications fits this conversation. Choose one.',
      { candidates: candidates.map(candidateSummary) },
    );
  if (candidates.length === 1) return { application: candidates[0], created: false };

  const first = thread[0];
  const application = await tx.application.create({
    data: {
      userId,
      companyName,
      jobTitle,
      // A confirmation arrives when the user applies; other email says nothing about that day.
      appliedAt: first.aiProcessingResult?.category === 'FOLLOW_UP' ? first.receivedAt : null,
    },
  });
  return { application, created: true };
}

const candidateSummary = (app: Application) => ({
  id: app.id,
  companyName: app.companyName,
  jobTitle: app.jobTitle,
});

type MatchArguments = Parameters<typeof applyMatch>;

/** A decision made elsewhere in the meantime is a conflict to show, not a server fault. */
async function confirmMatch(emailId: string, applicationId: string, result: MatchArguments[2]) {
  try {
    await applyMatch(emailId, applicationId, result, 'USER_CONFIRMED');
  } catch (error) {
    if (
      error instanceof Error &&
      ['INVALID_MATCH_STATE', 'APPLICATION_NOT_FOUND', 'EMAIL_NOT_FOUND'].includes(error.message)
    )
      throw new AppError(409, 'MATCH_CONFLICT', CHANGE_REJECTED);
    throw error;
  }
}

/**
 * Job emails that waited because the company had no application yet get matched now, by the
 * matcher's own rules. Without this, each of the company's other conversations would offer to
 * create the same application again. No AI call is made.
 */
async function sweepSameCompany(userId: string, key: string, application: Application) {
  const waiting = await prisma.email.findMany({
    where: {
      userId,
      relevanceState: 'RELEVANT',
      matchState: 'UNMATCHED',
      matchConfirmedBy: null,
      aiProcessingResult: { companyName: { not: null } },
      NOT: conversationWhere(key),
    },
    select: { id: true, aiProcessingResult: { select: { companyName: true } } },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: SWEEP_LIMIT,
  });
  const sameCompanyEmails = waiting.filter((email) => {
    const company = email.aiProcessingResult?.companyName;
    return !!company && sameCompany(company, application.companyName);
  });
  // Oldest first, so the application's timeline records them in the order they arrived.
  for (const email of sameCompanyEmails.reverse()) await matchEmailToApplication(email.id);
  return sameCompanyEmails.length;
}
