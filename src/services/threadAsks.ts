/**
 * The asks of a conversation (owner, 24 Oct 2026): which earlier requests are still open, and
 * closing them when a newer mail or the user's reply settles them. A closed ask stays visible
 * with why it closed, and Reopen undoes it.
 */
import type { AskKind, Prisma, RequestClosedReason } from '@prisma/client';
import { prisma } from '../db/prisma';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { THREAD_EXTRACTION_VERSIONS, ThreadReadSchema } from './ai/contracts';
import { logEvent } from '../utils/log';
import { requestOf } from './emailRequest';

export { canReplyTo } from './emailRequest';

type Db = Prisma.TransactionClient | typeof prisma;

/** At most this many open asks go with a mail to the AI: the newest ones. */
export const OPEN_ASKS_LIMIT = 5;

/** A short, stable name for an ask in what the AI reads and answers. */
export const askId = (emailId: string) => `ask-${emailId.slice(0, 8)}`;

/**
 * A reply-by-mail ask closes when the user's reply answers it, never by hand (owner, 24 Oct 2026).
 * One read before the AI said how it is done may still be closed by hand.
 */
export const mayCloseByHand = (kind: AskKind | null | undefined) => kind !== 'REPLY_BY_MAIL';
export const CLOSES_BY_ITSELF =
  'This step closes by itself when your reply answers it. Reply to the mail, and it closes.';

export interface OpenAsk {
  /** `askId` of the asking email. */
  id: string;
  emailId: string;
  /** What the mail asks, in the AI's words. */
  ask: string;
  kind: AskKind | null;
  askedAt: string | null;
}

/** A message of a conversation: a received mail (`id`), or a sent one, which has no email row. */
interface ThreadMessage {
  id?: string;
  userId: string;
  threadId: string | null;
}

/**
 * The thread's asks that are still open and arrived before `before`, oldest first. An ask is open
 * while nothing closed it: no reason recorded, not marked done by the user, and no finished
 * action. A fake offer's safe step is never one of them.
 */
export async function openAsksBefore(
  db: Db,
  mail: ThreadMessage,
  before: Date | null,
): Promise<OpenAsk[]> {
  if (!mail.threadId) return [];
  const rows = await db.email.findMany({
    where: {
      userId: mail.userId,
      threadId: mail.threadId,
      ...(mail.id ? { id: { not: mail.id } } : {}),
      relevanceState: 'RELEVANT',
      requestClosedReason: null,
      ...(before ? { receivedAt: { lt: before } } : {}),
      aiProcessingResult: {
        is: { fakeOfferWarning: null, OR: [{ actionRequired: true }, { followUpRequired: true }] },
      },
    },
    include: {
      aiProcessingResult: true,
      actions: { where: { retiredAt: null }, select: { status: true } },
    },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
  });
  return rows
    .filter(
      (row) =>
        row.requestUserState !== 'DONE' &&
        row.actions.every((action) => action.status === 'PENDING'),
    )
    .slice(0, OPEN_ASKS_LIMIT)
    .reverse()
    .map((row) => {
      const request = requestOf(row.aiProcessingResult!, row.receivedAt, row.sender);
      const fallback = request?.kind === 'FOLLOW_UP' ? 'Follow up' : 'Action needed';
      return {
        id: askId(row.id),
        emailId: row.id,
        ask: request?.text?.trim() || fallback,
        kind: row.aiProcessingResult!.askKind,
        askedAt: row.receivedAt?.toISOString() ?? null,
      };
    });
}

/**
 * Closes these asks with their reason and finishes their pending actions. Asks that something
 * already closed keep their own reason. Returns how many closed now.
 */
export async function closeAsks(
  tx: Prisma.TransactionClient,
  emailIds: string[],
  closure: { reason: RequestClosedReason; byMessageId: string | null },
): Promise<number> {
  if (!emailIds.length) return 0;
  const open = await tx.email.findMany({
    where: { id: { in: emailIds }, requestClosedReason: null },
    select: { id: true },
  });
  const ids = open.map((email) => email.id);
  if (!ids.length) return 0;
  const now = new Date();
  await tx.email.updateMany({
    where: { id: { in: ids } },
    data: {
      requestClosedReason: closure.reason,
      requestClosedAt: now,
      requestClosedByMessageId: closure.byMessageId,
    },
  });
  await tx.action.updateMany({
    where: { emailId: { in: ids }, status: 'PENDING', retiredAt: null },
    data: { status: 'COMPLETED', snoozedUntil: null, actionRevision: { increment: 1 } },
  });
  return ids.length;
}

/** What a reopened ask loses: why and when it closed. */
export const OPEN_AGAIN = {
  requestClosedReason: null,
  requestClosedAt: null,
  requestClosedByMessageId: null,
} as const;

/**
 * Closes the open asks that the AI's answer names, by their ids from `openAsks`. Ids it made up,
 * or of asks closed meanwhile, close nothing.
 */
export async function closeNamedAsks(
  userId: string,
  mail: ThreadMessage & { before: Date | null },
  named: { id: string; reason: RequestClosedReason }[],
  byMessageId: string,
): Promise<number> {
  if (!named.length) return 0;
  const closed = await prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    const open = await openAsksBefore(tx, mail, mail.before);
    let count = 0;
    for (const reason of new Set(named.map((entry) => entry.reason))) {
      const ids = new Set(named.filter((entry) => entry.reason === reason).map((e) => e.id));
      const emailIds = open.filter((ask) => ids.has(ask.id)).map((ask) => ask.emailId);
      count += await closeAsks(tx, emailIds, { reason, byMessageId });
    }
    return count;
  });
  if (closed) logEvent('asks_closed', { userId, emailId: mail.id, closed });
  return closed;
}

/**
 * Closes the open asks that this mail's AI read named, as replaced by it or confirmed done. Read
 * from the stored answer, so a job that runs again closes the same asks and nothing more.
 */
export async function closeAsksFromRead(userId: string, emailId: string) {
  const op = await prisma.aIOperation.findFirst({
    where: {
      emailId,
      operation: 'extraction',
      status: 'COMPLETED',
      version: { in: [...THREAD_EXTRACTION_VERSIONS] },
    },
    select: { result: true },
  });
  const read = op && ThreadReadSchema.safeParse(op.result);
  const named = (read?.success ? (read.data.closedAsks ?? []) : []).map((entry) => ({
    id: entry.id,
    reason:
      entry.reason === 'CONFIRMED_DONE'
        ? ('CONFIRMED_BY_MAIL' as const)
        : ('REPLACED_BY_MAIL' as const),
  }));
  if (!named.length) return 0;
  const email = await prisma.email.findFirst({
    where: { id: emailId, userId },
    select: { id: true, userId: true, threadId: true, receivedAt: true, gmailMessageId: true },
  });
  if (!email) return 0;
  return closeNamedAsks(
    userId,
    { ...email, before: email.receivedAt },
    named,
    email.gmailMessageId,
  );
}

/**
 * The user set the application to Rejected or Closed: the open asks that came from its mails
 * close too (owner, 24 Oct 2026). Reopen still works.
 */
export async function closeAsksOfApplication(userId: string, applicationId: string) {
  const closed = await prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    const pending = await tx.action.findMany({
      where: {
        applicationId,
        application: { userId },
        status: 'PENDING',
        retiredAt: null,
        emailId: { not: null },
      },
      select: { emailId: true },
    });
    const emailIds = [...new Set(pending.flatMap((action) => action.emailId ?? []))];
    return closeAsks(tx, emailIds, { reason: 'APPLICATION_CLOSED', byMessageId: null });
  });
  if (closed) logEvent('asks_closed', { userId, applicationId, closed });
  return closed;
}
