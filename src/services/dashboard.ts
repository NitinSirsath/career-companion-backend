import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { DashboardResponseSchema, type DashboardPeriod, type DashboardQuery } from '../contracts';
import { conversationRows } from './conversationQuery';
import { aiTipForPage, makeAITip, ruleTips } from './dashboardTips';
import {
  answerSpeed,
  automationRows,
  funnel,
  goneQuiet,
  median,
  rate,
  rejectedAfter,
  replyHours,
  rightNow,
  topReasons,
  totals,
  weeks,
  appliedDate,
  type DashApp,
  type Window,
} from './dashboardMetrics';

type Tx = Prisma.TransactionClient;

const PERIOD_DAYS: Record<Exclude<DashboardPeriod, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};
const DAY_MS = 24 * 60 * 60 * 1000;
/** Open asks are counted from the conversation list; more than this is not a real inbox. */
const OPEN_ASK_LIMIT = 1000;

/**
 * The user's job search in numbers (owner, 27 Oct 2026), with its tips. The AI tip is the latest
 * one made by the queued job; reading the page never calls the AI.
 */
export async function readDashboard(userId: string, query: DashboardQuery) {
  const now = new Date();
  const numbers = await dashboardNumbers(userId, query, now);
  return DashboardResponseSchema.parse({
    ...numbers,
    tips: ruleTips(numbers, now),
    aiTip: await aiTipForPage(userId, query.timeZone, now),
  });
}

/** The queued job: the AI tip is made from the numbers of the last 30 days. */
export async function makeDashboardTip(userId: string, timeZone: string) {
  const now = new Date();
  await makeAITip(userId, await dashboardNumbers(userId, { period: '30d', timeZone }, now), now);
}

/**
 * One read snapshot of the user's own data; the rules are in `dashboardMetrics.ts`. Nothing is
 * cached: one user's data is small.
 */
async function dashboardNumbers(userId: string, query: DashboardQuery, now: Date) {
  return prisma.$transaction(
    async (tx) => {
      const apps = await loadApplications(tx, userId);
      const submissions = await tx.externalSubmission.findMany({
        where: { userId },
        select: { platform: true, workMode: true, submittedAt: true, applicationId: true },
      });
      const dataStartsAt = await firstDataDay(tx, userId, apps, submissions);
      const { current, previous } = windows(query.period, now, dataStartsAt);
      const sent = funnel(apps, current);
      return {
        generatedAt: now.toISOString(),
        period: query.period,
        timeZone: query.timeZone,
        dataStartsAt: dataStartsAt?.toISOString() ?? null,
        data: await dataLine(tx, userId),
        totals: {
          current: totals(apps, current),
          previous: previous ? totals(apps, previous) : null,
        },
        rightNow: rightNow(apps),
        funnel: sent,
        rejectedAfter: rejectedAfter(apps, current),
        weeks: weeks(apps, now, query.timeZone),
        goneQuiet: goneQuiet(apps, now),
        answerSpeed: answerSpeed(apps, current),
        keepingUp: await keepingUp(tx, userId, current, now),
        automation: {
          used: submissions.length > 0,
          ...automationRows(apps, submissions, current),
          ...(await automationCoverage(tx, userId, current, submissions)),
        },
        rates: {
          response: rate(sent.answered, sent.applied),
          interview: rate(sent.interview, sent.applied),
          offer: rate(sent.offer, sent.applied),
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function loadApplications(tx: Tx, userId: string): Promise<DashApp[]> {
  const rows = await tx.application.findMany({
    where: { userId },
    select: {
      id: true,
      companyName: true,
      jobTitle: true,
      aiStatus: true,
      userStatus: true,
      userStatusSetAt: true,
      appliedAt: true,
      createdAt: true,
      archivedAt: true,
      statusChanges: { where: { retiredAt: null }, select: { toStatus: true, changedAt: true } },
      emails: {
        where: {
          matchState: 'MATCHED',
          relevanceState: 'RELEVANT',
          aiProcessingResult: { fakeOfferWarning: null },
        },
        select: { receivedAt: true, aiProcessingResult: { select: { category: true } } },
      },
    },
  });
  return rows.map(({ statusChanges, emails, ...app }) => ({
    ...app,
    changes: statusChanges,
    mails: emails.map((e) => ({
      receivedAt: e.receivedAt,
      category: e.aiProcessingResult?.category ?? null,
    })),
  }));
}

/** The first day the numbers can cover: the first job mail, application or submission. */
async function firstDataDay(
  tx: Tx,
  userId: string,
  apps: DashApp[],
  submissions: { submittedAt: Date }[],
): Promise<Date | null> {
  const firstMail = await tx.email.aggregate({
    where: { userId, relevanceState: 'RELEVANT' },
    _min: { receivedAt: true },
  });
  const dates = [
    firstMail._min.receivedAt,
    ...apps.map(appliedDate),
    ...submissions.map((s) => s.submittedAt),
  ].filter((d): d is Date => !!d);
  return dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
}

/** The period ends now. The one before it has the same length; "all" has none. */
function windows(period: DashboardPeriod, now: Date, dataStartsAt: Date | null) {
  if (period === 'all')
    return { current: { start: dataStartsAt ?? now, end: now }, previous: null };
  const length = PERIOD_DAYS[period] * DAY_MS;
  const start = new Date(now.getTime() - length);
  return {
    current: { start, end: now },
    previous: { start: new Date(start.getTime() - length), end: start },
  };
}

async function dataLine(tx: Tx, userId: string) {
  const [jobMailsRead, notLinked, waitingForAI, fakeOffers] = await Promise.all([
    tx.email.count({ where: { userId, relevanceState: 'RELEVANT', processingState: 'COMPLETED' } }),
    tx.email.count({
      where: { userId, relevanceState: 'RELEVANT', matchState: { in: ['UNMATCHED', 'AMBIGUOUS'] } },
    }),
    tx.email.count({ where: { userId, processingState: { in: ['PENDING', 'PROCESSING'] } } }),
    tx.email.count({
      where: {
        userId,
        relevanceState: 'RELEVANT',
        aiProcessingResult: { fakeOfferWarning: { not: null } },
      },
    }),
  ]);
  return { jobMailsRead, notLinked, waitingForAI, fakeOffers };
}

async function keepingUp(tx: Tx, userId: string, w: Window, now: Date) {
  const asks = await tx.email.findMany({
    where: {
      userId,
      relevanceState: 'RELEVANT',
      receivedAt: { gte: w.start, lt: w.end },
      aiProcessingResult: { askKind: 'REPLY_BY_MAIL', fakeOfferWarning: null },
    },
    select: { threadId: true, receivedAt: true },
  });
  const threads = [...new Set(asks.map((a) => a.threadId).filter((t): t is string => !!t))];
  const sent = threads.length
    ? await tx.outgoingEmail.findMany({
        where: { userId, threadId: { in: threads } },
        select: { threadId: true, sentAt: true },
      })
    : [];
  const hours = replyHours(asks, sent);
  const closed = await tx.email.groupBy({
    by: ['requestClosedReason'],
    where: { userId, requestClosedAt: { gte: w.start, lt: w.end } },
    _count: { _all: true },
  });
  const closedBy = (...reasons: string[]) =>
    closed
      .filter((c) => c.requestClosedReason && reasons.includes(c.requestClosedReason))
      .reduce((sum, c) => sum + c._count._all, 0);
  const open = await conversationRows(
    tx,
    userId,
    { request: 'open' },
    {
      limit: OPEN_ASK_LIMIT,
      offset: 0,
    },
  );
  const waitingOverADay = await tx.email.count({
    where: {
      id: { in: open.map((c) => c.requestEmailId).filter((id): id is string => !!id) },
      receivedAt: { lt: new Date(now.getTime() - DAY_MS) },
      aiProcessingResult: { askKind: 'REPLY_BY_MAIL' },
    },
  });
  return {
    replied: hours.length,
    medianReplyHours: median(hours),
    waitingOverADay,
    closed: {
      yourReply: closedBy('YOUR_REPLY'),
      youSaidDone: closedBy('YOU_SAID_DONE'),
      newerMail: closedBy('REPLACED_BY_MAIL', 'CONFIRMED_BY_MAIL'),
      applicationClosed: closedBy('APPLICATION_CLOSED'),
    },
    openNow: open.length,
  };
}

async function automationCoverage(
  tx: Tx,
  userId: string,
  w: Window,
  submissions: { submittedAt: Date }[],
) {
  const notSent = await tx.notSubmittedJob.findMany({
    where: { userId, loggedAt: { gte: w.start, lt: w.end } },
    select: { outcome: true, reason: true },
  });
  const sent = submissions.filter((s) => s.submittedAt >= w.start && s.submittedAt < w.end).length;
  const skipped = notSent.filter((n) => n.outcome === 'SKIPPED');
  const needsYou = notSent.length - skipped.length;
  return {
    lookedAt: sent + notSent.length,
    sent,
    skipped: skipped.length,
    needsYou,
    topSkipReasons: topReasons(skipped.map((n) => n.reason)),
  };
}
