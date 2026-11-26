/**
 * The asks of a conversation (owner, 24 Oct 2026): which earlier requests are still open, and
 * closing them when a newer mail or the user's reply settles them. A closed ask stays visible
 * with why it closed, and Reopen undoes it.
 */
import type { AskKind, EmailRequestState, Prisma, RequestClosedReason } from '@prisma/client';
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
  return openAsksAmong(
    rows.map((row) => ({ ...row, result: row.aiProcessingResult! })),
    { before: null },
  );
}

/** A mail of the conversation as the open-asks rule reads it. */
export interface AskSource {
  id: string;
  receivedAt: Date | null;
  sender: string | null;
  requestClosedReason: RequestClosedReason | null;
  requestUserState: EmailRequestState | null;
  /** Its application actions that are not retired. */
  actions: { status: string }[];
  result: Parameters<typeof requestOf>[0];
}

/**
 * The open-asks rule on mails already in hand, newest five, oldest first: the database query above,
 * and Reanalyze's replay, which keeps the conversation in memory while it reads it again. An ask
 * is open while it asks for something, is not a fake offer's safe step, nothing closed it, the user
 * did not mark it done, and its actions are all pending.
 */
export function openAsksAmong(
  mails: AskSource[],
  { before, except }: { before: Date | null; except?: string },
): OpenAsk[] {
  const time = (mail: AskSource) => mail.receivedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return mails
    .filter(
      (mail) =>
        mail.id !== except &&
        (!before || (mail.receivedAt !== null && mail.receivedAt < before)) &&
        mail.requestClosedReason === null &&
        mail.result.fakeOfferWarning === null &&
        (!!mail.result.actionRequired || !!mail.result.followUpRequired) &&
        mail.requestUserState !== 'DONE' &&
        mail.actions.every((action) => action.status === 'PENDING'),
    )
    .sort((a, b) => time(b) - time(a) || (a.id < b.id ? 1 : -1))
    .slice(0, OPEN_ASKS_LIMIT)
    .reverse()
    .map((mail) => {
      const request = requestOf(mail.result, mail.receivedAt, mail.sender);
      const fallback = request?.kind === 'FOLLOW_UP' ? 'Follow up' : 'Action needed';
      return {
        id: askId(mail.id),
        emailId: mail.id,
        ask: request?.text?.trim() || fallback,
        kind: mail.result.askKind,
        askedAt: mail.receivedAt?.toISOString() ?? null,
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

/** The statuses that end an application: its open asks close with it. */
export const ENDED_STATUSES = ['REJECTED', 'CLOSED'] as const;

/** An open step of an application with the mail that asks for it. */
const stepWithMail = {
  type: true,
  applicationId: true,
  email: {
    select: {
      id: true,
      threadId: true,
      subject: true,
      sender: true,
      receivedAt: true,
      gmailMessageId: true,
      requestUserState: true,
      requestUserStateAt: true,
      aiProcessingResult: true,
    },
  },
} satisfies Prisma.ActionSelect;
type StepMail = NonNullable<Prisma.ActionGetPayload<{ select: typeof stepWithMail }>['email']>;

/** The user's open steps that come from mails whose request nothing closed yet. */
const openStepsOf = (tx: Prisma.TransactionClient, userId: string, applicationId?: string) =>
  tx.action.findMany({
    where: {
      application: { userId },
      ...(applicationId ? { applicationId } : {}),
      status: 'PENDING',
      retiredAt: null,
      email: { requestClosedReason: null },
    },
    select: stepWithMail,
  });

/** The user said it is open (Reopen or "Still open") after this moment: nothing closes it again. */
const keptOpenAfter = (mail: StepMail, moment: Date) =>
  mail.requestUserState === 'OPEN' && !!mail.requestUserStateAt && mail.requestUserStateAt > moment;

/**
 * An application that ended closes the open asks of the mails that came before it did (owner,
 * 26 Nov 2026), whoever ended it: the user, or a mail the AI read as a rejection, which is then
 * named as the mail that closed them. An ask that arrived later, or that the user opened again
 * since, stays. Reopen still works. Returns how many closed.
 */
export async function closeAsksOfEndedApplications(userId: string) {
  const ended = await prisma.application.findMany({
    where: {
      userId,
      OR: [
        { userStatus: { in: [...ENDED_STATUSES] } },
        { userStatus: null, aiStatus: { in: [...ENDED_STATUSES] } },
      ],
      actions: { some: { status: 'PENDING', retiredAt: null, emailId: { not: null } } },
    },
    select: {
      id: true,
      userStatusSetAt: true,
      statusChanges: {
        where: { retiredAt: null, toStatus: { in: [...ENDED_STATUSES] } },
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { changedAt: true, source: true, email: { select: { gmailMessageId: true } } },
      },
    },
  });
  let closed = 0;
  for (const app of ended) {
    const [change] = app.statusChanges;
    const endedAt = change?.changedAt ?? app.userStatusSetAt;
    if (!endedAt) continue;
    const byMessageId = change?.source === 'AI' ? (change.email?.gmailMessageId ?? null) : null;
    closed += await prisma.$transaction(async (tx) => {
      await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
      const steps = await openStepsOf(tx, userId, app.id);
      const emailIds = steps.flatMap(({ email }) =>
        email?.receivedAt && email.receivedAt < endedAt && !keptOpenAfter(email, endedAt)
          ? [email.id]
          : [],
      );
      return closeAsks(tx, [...new Set(emailIds)], { reason: 'APPLICATION_CLOSED', byMessageId });
    });
  }
  if (closed) logEvent('asks_closed', { userId, closed, by: 'application_ended' });
  return closed;
}

const REPEAT_PREFIX = /^(?:(?:re|fwd?|(?:gentle |kind |friendly )?reminder)\s*[:-]\s*)+/;

/** A mail's subject without "Re:", "Fwd:" or "Reminder:" before it; '' when it has none. */
const subjectKey = (subject: string | null) =>
  (subject ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(REPEAT_PREFIX, '').trim();

/** The sender's address alone, without the name. */
const senderKey = (sender: string | null) =>
  (sender?.match(/<([^>]+)>/)?.[1] ?? sender ?? '').trim().toLowerCase();

/**
 * What makes two asks the same ask: one application, one kind of step, one sender address, one
 * subject, and one deadline (or none on both). null for a mail with no subject or sender: such an
 * ask is never taken for another.
 */
function repeatKey(step: { type: string; applicationId: string }, mail: StepMail) {
  const subject = subjectKey(mail.subject);
  const sender = senderKey(mail.sender);
  const request =
    mail.aiProcessingResult && requestOf(mail.aiProcessingResult, mail.receivedAt, mail.sender);
  if (!subject || !sender || !request) return null;
  const deadline = request.deadline.deadline?.toISOString() ?? 'none';
  return [step.applicationId, step.type, sender, subject, deadline].join('\n');
}

/**
 * The same ask sent again in another conversation (a reminder mail) closes the older one as
 * replaced by the newer mail (owner, 26 Nov 2026): only the newest stays open. Asks inside one
 * conversation are the AI's to close when it reads the newer mail. One the user opened again after
 * the newer mail came stays. Returns how many closed.
 */
export async function closeRepeatedAsks(userId: string) {
  const closed = await prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    const groups = new Map<string, StepMail[]>();
    for (const step of await openStepsOf(tx, userId)) {
      const key = step.email && repeatKey(step, step.email);
      if (key && step.email) groups.set(key, [...(groups.get(key) ?? []), step.email]);
    }
    let count = 0;
    for (const mails of groups.values()) {
      const dated = mails.flatMap((mail) =>
        mail.receivedAt ? [{ mail, at: mail.receivedAt }] : [],
      );
      if (dated.length < 2) continue;
      const newest = dated.reduce((a, b) => (b.at > a.at ? b : a));
      const thread = (mail: StepMail) => mail.threadId ?? mail.id;
      const older = dated.filter(
        ({ mail, at }) =>
          at < newest.at && thread(mail) !== thread(newest.mail) && !keptOpenAfter(mail, newest.at),
      );
      count += await closeAsks(tx, [...new Set(older.map(({ mail }) => mail.id))], {
        reason: 'REPLACED_BY_MAIL',
        byMessageId: newest.mail.gmailMessageId,
      });
    }
    return count;
  });
  if (closed) logEvent('asks_closed', { userId, closed, by: 'asked_again' });
  return closed;
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
