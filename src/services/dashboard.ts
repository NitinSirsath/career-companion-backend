import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { DashboardResponseSchema, type DashboardPeriod, type DashboardQuery } from '../contracts';
import { conversationRows } from './conversationQuery';
import { utcDay } from './ai/usage';
import {
  automationRows,
  funnel,
  goneQuiet,
  localDay,
  rate,
  series,
  topReasons,
  totals,
  trendWeeks,
  upcomingInterviews,
  usualReplyDays,
  appliedDate,
  type DashApp,
  type InterviewMail,
  type JobMail,
  type Window,
} from './dashboardMetrics';

type Tx = Prisma.TransactionClient;

const PERIOD_DAYS: Record<Exclude<DashboardPeriod, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};
const DAY_MS = 24 * 60 * 60 * 1000;
/** "Needs you now" counts from the Mails lists; more than this is not a real inbox. */
const CONVERSATION_LIMIT = 1000;

/**
 * The user's job search in numbers (owner, 27 Oct 2026). Reading the page never calls the AI; the
 * tips, with the AI tip, were removed on 3 Nov 2026 (owner).
 */
export async function readDashboard(userId: string, query: DashboardQuery) {
  return DashboardResponseSchema.parse(await dashboardNumbers(userId, query, new Date()));
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
      const mails = await jobMailsIn(tx, userId, current);
      return {
        generatedAt: now.toISOString(),
        period: query.period,
        timeZone: query.timeZone,
        dataStartsAt: dataStartsAt?.toISOString() ?? null,
        now: await needsYouNow(tx, userId, now, query.timeZone),
        totals: {
          current: totals(apps, current),
          previous: previous ? totals(apps, previous) : null,
        },
        trend: { weeks: trendWeeks(apps, now, query.timeZone) },
        series: series(apps, mails, current, query.timeZone),
        funnel: sent,
        rates: {
          response: rate(sent.answered, sent.applied),
          interview: rate(sent.interview, sent.applied),
          offer: rate(sent.offer, sent.applied),
        },
        usualReplyDays: usualReplyDays(apps, current),
        goneQuiet: goneQuiet(apps, now),
        mailbox: await mailbox(tx, userId, current, mails.length),
        automation: {
          used: submissions.length > 0,
          ...automationRows(apps, submissions, current),
          ...(await automationCoverage(tx, userId, current, submissions)),
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

/** The job mails received in the period, for "Job mails per day". */
async function jobMailsIn(tx: Tx, userId: string, w: Window): Promise<JobMail[]> {
  const rows = await tx.email.findMany({
    where: { userId, relevanceState: 'RELEVANT', receivedAt: { gte: w.start, lt: w.end } },
    select: {
      receivedAt: true,
      aiProcessingResult: { select: { category: true, fakeOfferWarning: true } },
    },
  });
  return rows.map((row) => ({
    receivedAt: row.receivedAt,
    category: row.aiProcessingResult?.category ?? null,
    fakeOffer: !!row.aiProcessingResult?.fakeOfferWarning,
  }));
}

/** "Needs you now" (owner, 3 Nov 2026): the same lists the Mails page shows, and interviews. */
async function needsYouNow(tx: Tx, userId: string, now: Date, timeZone: string) {
  const all = { limit: CONVERSATION_LIMIT, offset: 0 };
  const unseen = await conversationRows(tx, userId, { unseen: 'true' }, all);
  const open = await conversationRows(tx, userId, { request: 'open' }, all);
  const today = localDay(now, timeZone);
  const waitingOverADay = await tx.email.count({
    where: {
      id: { in: open.map((c) => c.requestEmailId).filter((id): id is string => !!id) },
      receivedAt: { lt: new Date(now.getTime() - DAY_MS) },
      aiProcessingResult: { askKind: 'REPLY_BY_MAIL' },
    },
  });
  return {
    newJobMails: {
      count: unseen.length,
      today: unseen.filter(
        (c) => c.lastReceivedAt && localDay(c.lastReceivedAt, timeZone) === today,
      ).length,
    },
    needsAction: { count: open.length, waitingOverADay },
    interviews: upcomingInterviews(await interviewMails(tx, userId), now, timeZone),
  };
}

/** Job mails the AI read an interview date off, with their job, for "Interviews coming up". */
async function interviewMails(tx: Tx, userId: string): Promise<InterviewMail[]> {
  const rows = await tx.email.findMany({
    where: {
      userId,
      relevanceState: 'RELEVANT',
      aiProcessingResult: { interviewDate: { not: null }, fakeOfferWarning: null },
    },
    select: {
      id: true,
      threadId: true,
      receivedAt: true,
      applicationId: true,
      application: {
        select: {
          companyName: true,
          jobTitle: true,
          archivedAt: true,
          userStatus: true,
          aiStatus: true,
        },
      },
      aiProcessingResult: {
        select: { interviewDate: true, interviewTime: true, companyName: true, jobTitle: true },
      },
    },
  });
  return rows.map(({ application: app, aiProcessingResult, ...row }) => {
    const ai = aiProcessingResult ?? NO_AI_DATES;
    return {
      conversationKey: row.threadId ?? row.id,
      receivedAt: row.receivedAt,
      applicationId: row.applicationId,
      companyName: app?.companyName ?? ai.companyName,
      jobTitle: app?.jobTitle ?? ai.jobTitle,
      interviewDate: ai.interviewDate,
      interviewTime: ai.interviewTime,
      jobClosed: jobClosed(app),
    };
  });
}

const NO_AI_DATES = { interviewDate: null, interviewTime: null, companyName: null, jobTitle: null };

/** An archived, rejected or closed job: its interviews do not count. */
function jobClosed(
  app: { archivedAt: Date | null; userStatus: string | null; aiStatus: string | null } | null,
) {
  if (!app) return false;
  const status = app.userStatus ?? app.aiStatus;
  return !!app.archivedAt || status === 'REJECTED' || status === 'CLOSED';
}

/** "Your mailbox": inbox mails scanned and job mails, all time and in the period. */
async function mailbox(tx: Tx, userId: string, w: Window, jobMailsInPeriod: number) {
  const job = { userId, relevanceState: 'RELEVANT' as const };
  const [scannedAll, scannedInPeriod, jobMails, notLinked, fakeOffers] = await Promise.all([
    tx.mailScanDay.aggregate({ where: { userId }, _sum: { count: true } }),
    tx.mailScanDay.aggregate({
      where: { userId, day: { gte: utcDay(w.start) } },
      _sum: { count: true },
    }),
    tx.email.count({ where: job }),
    tx.email.count({ where: { ...job, matchState: { in: ['UNMATCHED', 'AMBIGUOUS'] } } }),
    tx.email.count({ where: { ...job, aiProcessingResult: { fakeOfferWarning: { not: null } } } }),
  ]);
  return {
    scanned: {
      total: scannedAll._sum.count ?? 0,
      inPeriod: scannedInPeriod._sum.count ?? 0,
    },
    jobMails: { total: jobMails, inPeriod: jobMailsInPeriod },
    notLinked,
    fakeOffers,
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
