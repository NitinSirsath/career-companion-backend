/**
 * "What the app has read" on the Gmail sync page (owner, 17 Nov 2026): the last 30 days, today
 * included, by the day each mail arrived. "Mails checked" comes from `MailScanDay`, which keeps
 * only the number. The other counts come from the mails the app still holds: a mail that is not
 * about a job is kept 35 days (`mailRetention.ts`), so the 30 days are complete.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import type { GmailSummaryResponse } from '../contracts/gmail';
import { utcDay } from './ai/usage';

export const SUMMARY_DAYS = 30;
const DAY_MS = 86_400_000;

/** Midnight UTC of the first of the 30 days; the last one is today. */
export function summaryStart(now = new Date()): Date {
  const today = new Date(`${utcDay(now)}T00:00:00.000Z`);
  return new Date(today.getTime() - (SUMMARY_DAYS - 1) * DAY_MS);
}

/** A mail with no Gmail date counts on the day it was saved, as `scanDay` does. */
const arrivedSince = (start: Date): Prisma.EmailWhereInput => ({
  OR: [{ receivedAt: { gte: start } }, { receivedAt: null, createdAt: { gte: start } }],
});

export async function readGmailSummary(
  userId: string,
  now = new Date(),
): Promise<GmailSummaryResponse> {
  const start = summaryStart(now);
  const recent = { userId, ...arrivedSince(start) };
  const [checked, jobMails, notJobMails, waiting, fakeOffers, failed] = await prisma.$transaction([
    prisma.mailScanDay.aggregate({
      where: { userId, day: { gte: utcDay(start) } },
      _sum: { count: true },
    }),
    prisma.email.count({ where: { ...recent, relevanceState: 'RELEVANT' } }),
    prisma.email.count({ where: { ...recent, relevanceState: 'IRRELEVANT' } }),
    prisma.email.count({
      where: { ...recent, relevanceState: 'UNPROCESSED', processingState: { not: 'FAILED' } },
    }),
    prisma.email.count({
      where: {
        ...recent,
        relevanceState: 'RELEVANT',
        aiProcessingResult: { fakeOfferWarning: { not: null } },
      },
    }),
    // Any date: the same mails the "Every mail it read" list shows with a stopped AI state.
    prisma.email.count({
      where: {
        userId,
        relevanceState: { in: ['RELEVANT', 'UNPROCESSED'] },
        processingState: 'FAILED',
      },
    }),
  ]);

  return {
    days: SUMMARY_DAYS,
    since: start.toISOString(),
    checked: checked._sum.count ?? 0,
    jobMails,
    notJobMails,
    waiting,
    fakeOffers,
    failed,
  };
}
