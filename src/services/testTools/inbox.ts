/**
 * The test inbox (manual test environment only): delivers made-up emails without Gmail and
 * resets what a test user made. The emails are fake; everything after delivery is the real path.
 */
import { randomUUID } from 'crypto';
import { prisma } from '../../db/prisma';
import {
  SIMULATED_ID_PREFIX,
  type DeliverTestEmailRequest,
  type DeliverTestEmailResponse,
  type ResetTestDataResponse,
} from '../../contracts/testTools';
import { AppError } from '../../errors';
import { lockUser, LOCK_NAMESPACE } from '../../utils/advisoryLock';
import { enqueueForProcessing } from '../ai/offer';

/** Saves one test email and hands it to the same queue as a newly synced Gmail email. */
export async function deliverTestEmail(
  userId: string,
  input: DeliverTestEmailRequest,
): Promise<DeliverTestEmailResponse> {
  const threadId = input.threadId ?? `${SIMULATED_ID_PREFIX}thread-${randomUUID()}`;
  const email = await prisma.$transaction(async (tx) => {
    const created = await tx.email.create({
      data: {
        userId,
        gmailMessageId: `${SIMULATED_ID_PREFIX}${randomUUID()}`,
        threadId,
        sender: input.sender,
        subject: input.subject || null,
        receivedAt: new Date(),
      },
    });
    await tx.simulatedEmailContent.create({
      data: { emailId: created.id, userId, labels: ['INBOX', input.label], body: input.body },
    });
    return created;
  });
  await enqueueForProcessing(userId, email.id);
  return { emailId: email.id, threadId };
}

/**
 * Deletes what a test user made: emails (with their AI rows and test content), applications
 * (with events, actions and agenda), automation submissions, AI batches and AI day counts, and
 * clears an AI rate-limit pause. Keeps the user, AI settings, Gmail connection and integration
 * tokens. Refused when the user has any real Gmail email: real mail is never deleted.
 */
export async function resetTestData(userId: string): Promise<ResetTestDataResponse> {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    const realMail = await tx.email.count({
      where: { userId, NOT: { gmailMessageId: { startsWith: SIMULATED_ID_PREFIX } } },
    });
    if (realMail > 0)
      throw new AppError(
        409,
        'REAL_MAIL_PRESENT',
        'This user has real Gmail mail. Reset never deletes real mail: use a separate test login or a fresh test database.',
      );
    const emails = await tx.email.deleteMany({ where: { userId } });
    const applications = await tx.application.deleteMany({ where: { userId } });
    await tx.externalSubmission.deleteMany({ where: { userId } });
    await tx.aIBatch.deleteMany({ where: { userId } });
    await tx.aIUsageDay.deleteMany({ where: { userId } });
    await tx.aIConfiguration.updateMany({
      where: { userId },
      data: { cooldownUntil: null, consecutiveFailures: 0 },
    });
    await tx.aIConfiguration.updateMany({
      where: { userId, accessIssue: { in: ['RATE_LIMITED', 'PROVIDER_UNAVAILABLE'] } },
      data: { accessIssue: null, accessIssueModel: null },
    });
    return { deletedEmails: emails.count, deletedApplications: applications.count };
  });
}
