/**
 * What the app keeps of a mail that is not about a job, and for how long (owner, 26 Oct 2026).
 * Such a mail keeps only its Gmail ids, its date and the decision, so a later sync knows it was
 * read and does not pay the AI for it again. Its subject, sender and error text are cleared when
 * it is found not to be about a job.
 */
import { prisma } from '../db/prisma';

/** Fields cleared on an email the moment it is found not to be about a job. */
export const NOT_JOB_MAIL_FORGETS = {
  subject: null,
  sender: null,
  processingErrorDetails: null,
} as const;

/**
 * A kept non-job mail is deleted this many days after it was received. A sync never reads further
 * back than 30 days (`MAX_SYNC_WINDOW_DAYS`), so a deleted mail is never fetched again.
 */
export const NOT_JOB_MAIL_KEPT_DAYS = 35;

const DAY_MS = 86_400_000;

/**
 * Deletes non-job mails received more than `NOT_JOB_MAIL_KEPT_DAYS` ago, and the records of
 * mail the user sent in threads that hold no job mail. Safe to repeat.
 */
export async function cleanUpOldMail(now = new Date()) {
  const before = new Date(now.getTime() - NOT_JOB_MAIL_KEPT_DAYS * DAY_MS);
  const mails = await prisma.email.deleteMany({
    where: {
      relevanceState: 'IRRELEVANT',
      OR: [{ receivedAt: { lt: before } }, { receivedAt: null, createdAt: { lt: before } }],
    },
  });
  // A sent-mail record only shows that the user replied in a job conversation.
  const sent = await prisma.$executeRaw`
    DELETE FROM "outgoing_emails" o
    WHERE NOT EXISTS (
      SELECT 1 FROM "emails" e
      WHERE e."userId" = o."userId" AND e."threadId" = o."threadId"
        AND e."relevanceState" <> 'IRRELEVANT'
    )`;
  return { mails: mails.count, sent };
}
