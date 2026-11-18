/**
 * Account suspension (owner, 18 Nov 2026). The owner suspends an account from the Admin page with a
 * reason the user sees. A suspended user still signs in, but sees only the suspended page with an
 * "Ask to resume" form: every other API route answers 403 ACCOUNT_SUSPENDED (middleware/auth.ts).
 * The scheduled Gmail sync, NorthList Apply tokens and push alerts skip the account. Nothing is
 * deleted and Google access is kept, so Resume brings everything back; the next sync reads the mail
 * that came in meanwhile, up to 30 days back.
 */
import { AppError } from '../errors';
import { prisma } from '../db/prisma';
import { sendOwnerAlert } from './notifications/ownerAlert';
import { logEvent } from '../utils/log';

/** True while the owner has the account suspended. */
export async function isSuspended(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { suspendedAt: true },
  });
  return Boolean(user?.suspendedAt);
}

/** Suspends the account, or changes the reason of one already suspended. */
export async function suspendAccount(adminUserId: string, userId: string, reason: string) {
  if (adminUserId === userId)
    throw new AppError(409, 'CANNOT_SUSPEND_SELF', 'You cannot suspend your own account.');
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { suspendedAt: true },
  });
  if (!user) throw new AppError(404, 'NOT_FOUND', 'This account does not exist.');
  await prisma.user.update({
    where: { id: userId },
    data: { suspendedAt: user.suspendedAt ?? new Date(), suspendReason: reason },
  });
  logEvent('account_suspended', { userId, reasonChanged: Boolean(user.suspendedAt) });
}

/** Ends the suspension; the user's request text is deleted with it. */
export async function resumeAccount(userId: string) {
  const { count } = await prisma.user.updateMany({
    where: { id: userId },
    data: { suspendedAt: null, suspendReason: null, resumeRequest: null, resumeRequestedAt: null },
  });
  if (!count) throw new AppError(404, 'NOT_FOUND', 'This account does not exist.');
  logEvent('account_resumed', { userId });
}

/**
 * Saves the suspended user's "Ask to resume" text, replacing an earlier one. The owner is told on
 * Discord the first time only, with no email or text in the message.
 */
export async function saveResumeRequest(userId: string, text: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { suspendedAt: true, resumeRequestedAt: true },
  });
  if (!user?.suspendedAt)
    throw new AppError(409, 'NOT_SUSPENDED', 'Your account is not suspended.');
  await prisma.user.update({
    where: { id: userId },
    data: { resumeRequest: text, resumeRequestedAt: new Date() },
  });
  logEvent('resume_request_saved', { userId, first: !user.resumeRequestedAt });
  if (!user.resumeRequestedAt)
    await sendOwnerAlert(
      'NorthList: a suspended account asked to be resumed. See Needs a look on the Admin page.',
    );
}
