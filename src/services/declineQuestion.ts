/**
 * "Close the application?" after the user declined by mail (owner, 17 Nov 2026): when the user's
 * reply says they no longer want the job, the app asks before it closes the application, and
 * closes it by itself three days after the reply unless the user answered or the company wrote
 * again. How the question and the status line read; the writes are in `applicationDecline.ts`.
 */
import { ApplicationStatus, DeclineAnswer, Prisma } from '@prisma/client';

/** How long after the reply the application closes by itself. */
export const DECLINE_CLOSES_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** Statuses the question still applies to: anything but Rejected and Closed. */
const OPEN_STATUSES: ApplicationStatus[] = [
  'APPLIED',
  'RECRUITER_CONTACT',
  'ASSESSMENT',
  'INTERVIEW',
  'OFFER',
];

/**
 * An application that is not archived and whose status the user sees is not Rejected or Closed.
 * Spelled out: NOT over nullable columns would drop the rows with no status.
 */
export const STILL_OPEN = {
  archivedAt: null,
  OR: [
    { userStatus: { in: OPEN_STATUSES } },
    { userStatus: null, aiStatus: { in: OPEN_STATUSES } },
    { userStatus: null, aiStatus: null },
  ],
} satisfies Prisma.ApplicationWhereInput;

/** What the question needs of an application. */
export interface DeclineFields {
  archivedAt: Date | null;
  aiStatus: ApplicationStatus | null;
  userStatus: ApplicationStatus | null;
  userStatusSetAt: Date | null;
  declinedAt: Date | null;
  /** When Reanalyze found the decline in an older reply; null when it was read as it came. */
  declineNotedAt?: Date | null;
  declineAnswer: DeclineAnswer | null;
  declineAnsweredAt: Date | null;
}

/**
 * When the three days start: the reply, or, for a decline Reanalyze found in an older reply, when it
 * found it, so the user can still answer (owner, 19 Nov 2026).
 */
export const declineClockStart = (app: { declinedAt: Date; declineNotedAt?: Date | null }) =>
  app.declineNotedAt ?? app.declinedAt;

const isOpen = (app: DeclineFields) => {
  const status = app.userStatus ?? app.aiStatus;
  return !app.archivedAt && (status === null || OPEN_STATUSES.includes(status));
};

/** The question is waiting for the user's answer. */
export const declinePending = (app: DeclineFields): app is DeclineFields & { declinedAt: Date } =>
  app.declinedAt !== null && app.declineAnswer === null && isOpen(app);

/**
 * The question and the status line, as the screens show them. `lastMailAt` is the newest job
 * mail of the application: one after the reply means the company wrote again, so it does not
 * close by itself.
 */
export function declineView(app: DeclineFields, lastMailAt: Date | null) {
  const pending = declinePending(app);
  const wroteAgain = pending && !!lastMailAt && lastMailAt > app.declinedAt;
  // Only while the status is still the one the answer set: a later change by hand wins.
  const answeredAt = app.declineAnswer === 'CLOSED' ? app.declineAnsweredAt : null;
  const closedAfterDecline =
    !!answeredAt &&
    app.userStatus === 'CLOSED' &&
    app.userStatusSetAt?.getTime() === answeredAt.getTime();
  return {
    decline: pending
      ? {
          repliedAt: app.declinedAt.toISOString(),
          closesAt: wroteAgain
            ? null
            : new Date(declineClockStart(app).getTime() + DECLINE_CLOSES_AFTER_MS).toISOString(),
        }
      : null,
    closedAfterDeclineAt: closedAfterDecline ? answeredAt.toISOString() : null,
  };
}

/** The newest job mail of each application, for `declineView`. */
export const newestMail = {
  where: { relevanceState: 'RELEVANT' },
  orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
  take: 1,
  select: { receivedAt: true },
} satisfies Prisma.Application$emailsArgs;
