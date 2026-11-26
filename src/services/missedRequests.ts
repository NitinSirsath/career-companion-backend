/**
 * "Missed" (owner, 26 Nov 2026): a request that went stale leaves Needs action by itself. Nothing
 * is stored and no job runs: the rule is worked out when a list is read, from the request's
 * deadline, the last thing that happened in its thread, and the user's own "Still open". The mail
 * list, the Dashboard, an application's to-do count and the alerts all read it from here.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import type { Missed } from '../contracts';
import { requestOf } from './emailRequest';

type Db = Prisma.TransactionClient | typeof prisma;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A deadline is missed one day after it passed: on the day after, the request still shows "Past due". */
export const MISSED_AFTER_DEADLINE_MS = DAY_MS;
/** With no deadline: this long with no mail, no reply and no "Still open" in the thread. */
export const MISSED_AFTER_QUIET_MS = 7 * DAY_MS;
/** With no deadline, when the last message is the user's own reply: they did not answer it. */
export const MISSED_AFTER_REPLY_MS = 7 * DAY_MS;

/** What the rule reads of one request. */
export interface RequestClock {
  receivedAt: Date | null;
  deadline: Date | null;
  deadlinePrecision: 'DATE' | 'DATETIME' | null;
  /** When the user last said it is open ("Still open" or Reopen); null when they never did. */
  keptOpenAt: Date | null;
  /** The newest mail received in the thread, a job mail or not. */
  lastMailAt: Date | null;
  /** The user's newest message in the thread. */
  lastSentAt: Date | null;
}

/** A date-only deadline lasts to the end of its day (UTC, as the date itself is kept). */
const deadlineEnd = (clock: RequestClock) =>
  clock.deadline &&
  new Date(clock.deadline.getTime() + (clock.deadlinePrecision === 'DATE' ? DAY_MS : 0));

/**
 * Since when the request is missed, and why; null while it still needs action.
 *
 * With a deadline, only the deadline counts: missed one day after it passed. "Still open" after the
 * deadline sets it aside, and the request is then read like one with no deadline.
 * With no deadline, the thread's last event counts: the request's own mail, a newer mail, the
 * user's reply or their "Still open". Missed 7 days after it (owner, 26 Nov 2026: 7, not 14); when
 * it is the user's own reply, the reason says that they did not answer. So "Still open" keeps a
 * request in Needs action for 7 days, and anything that happens in the thread starts the days
 * again.
 */
export function missedSince(clock: RequestClock): { reason: Missed['reason']; since: Date } | null {
  const end = deadlineEnd(clock);
  const keptOpenAfterDeadline = !!end && !!clock.keptOpenAt && clock.keptOpenAt > end;
  if (end && !keptOpenAfterDeadline)
    return { reason: 'DEADLINE_PASSED', since: new Date(end.getTime() + MISSED_AFTER_DEADLINE_MS) };
  if (!clock.receivedAt) return null;
  const theirs = Math.max(clock.receivedAt.getTime(), clock.lastMailAt?.getTime() ?? 0);
  const others = Math.max(theirs, clock.keptOpenAt?.getTime() ?? 0);
  const sent = clock.lastSentAt?.getTime() ?? 0;
  return sent > others
    ? { reason: 'NO_ANSWER', since: new Date(sent + MISSED_AFTER_REPLY_MS) }
    : { reason: 'QUIET', since: new Date(others + MISSED_AFTER_QUIET_MS) };
}

/** The newest date per thread of the user's mails or sent messages. */
async function newestByThread(db: Db, userId: string, threadIds: string[]) {
  const where = { userId, threadId: { in: threadIds } };
  const mails = await db.email.groupBy({ by: ['threadId'], where, _max: { receivedAt: true } });
  const sent = await db.outgoingEmail.groupBy({ by: ['threadId'], where, _max: { sentAt: true } });
  return {
    lastMailAt: new Map(mails.map((row) => [row.threadId, row._max.receivedAt])),
    lastSentAt: new Map(sent.map((row) => [row.threadId, row._max.sentAt])),
  };
}

/**
 * The user's requests that are missed now, by the email that asks. Read from every request nothing
 * has closed; whether a request is otherwise open, replied to or done stays the caller's rule.
 */
export async function missedRequests(db: Db, userId: string): Promise<Map<string, Missed>> {
  const asks = await db.email.findMany({
    where: {
      userId,
      relevanceState: 'RELEVANT',
      requestClosedReason: null,
      OR: [{ requestUserState: null }, { requestUserState: 'OPEN' }],
      aiProcessingResult: {
        is: {
          OR: [
            { actionRequired: true },
            { followUpRequired: true },
            { fakeOfferWarning: { not: null } },
          ],
        },
      },
    },
    select: {
      id: true,
      threadId: true,
      receivedAt: true,
      sender: true,
      requestUserState: true,
      requestUserStateAt: true,
      aiProcessingResult: true,
    },
  });
  if (!asks.length) return new Map();
  const threadIds = [...new Set(asks.flatMap((ask) => (ask.threadId ? [ask.threadId] : [])))];
  const { lastMailAt, lastSentAt } = await newestByThread(db, userId, threadIds);
  const now = Date.now();
  const missed = new Map<string, Missed>();
  for (const ask of asks) {
    const request =
      ask.aiProcessingResult && requestOf(ask.aiProcessingResult, ask.receivedAt, ask.sender);
    if (!request) continue;
    const found = missedSince({
      receivedAt: ask.receivedAt,
      deadline: request.deadline.deadline,
      deadlinePrecision: request.deadline.precision,
      keptOpenAt: ask.requestUserState === 'OPEN' ? ask.requestUserStateAt : null,
      lastMailAt: (ask.threadId && lastMailAt.get(ask.threadId)) || null,
      lastSentAt: (ask.threadId && lastSentAt.get(ask.threadId)) || null,
    });
    if (found && found.since.getTime() <= now)
      missed.set(ask.id, { reason: found.reason, since: found.since.toISOString() });
  }
  return missed;
}

/** Why a step is missed: an open step from a mail whose request is; null for any other step. */
export const missedStep = (
  step: { status: string; emailId: string | null },
  missed: Map<string, Missed>,
) => (step.status === 'PENDING' && step.emailId ? (missed.get(step.emailId) ?? null) : null);

/**
 * How many open steps of each application are missed: they are not part of its to-do count, as
 * their mails are not part of Needs action.
 */
export async function missedStepCounts(db: Db, userId: string, applicationIds: string[]) {
  const missed = await missedRequests(db, userId);
  if (!missed.size || !applicationIds.length) return new Map<string, number>();
  const rows = await db.action.groupBy({
    by: ['applicationId'],
    where: {
      applicationId: { in: applicationIds },
      status: 'PENDING',
      retiredAt: null,
      emailId: { in: [...missed.keys()] },
    },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.applicationId, row._count._all]));
}
