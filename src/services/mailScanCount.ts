/**
 * "Mails scanned" on the Dashboard (owner, 3 Nov 2026): how many inbox mails the sync took in on
 * each day. Mail that is not about a job is deleted after 35 days (`mailRetention.ts`), so it is
 * counted when it arrives. Only the number is kept.
 */
import type { Prisma } from '@prisma/client';
import { utcDay } from './ai/usage';

/** The day a mail is counted on: its date in UTC, or today when Gmail gave no date. */
export function scanDay(receivedAt: Date | null, now = new Date()): string {
  return utcDay(receivedAt && !isNaN(receivedAt.getTime()) ? receivedAt : now);
}

/** Adds one new inbox mail to its day. Call it in the transaction that saves the mail. */
export async function countScannedMail(
  tx: Prisma.TransactionClient,
  userId: string,
  receivedAt: Date | null,
) {
  const day = scanDay(receivedAt);
  await tx.mailScanDay.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day, count: 1 },
    update: { count: { increment: 1 } },
  });
}
