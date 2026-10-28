import { ApplicationStatus, EmailCategory } from '@prisma/client';
import type { DashboardResponse } from '../contracts';

/**
 * The Dashboard's rules (owner, 27 Oct 2026) as plain functions over one user's data, so each
 * rule has one home and can be tested on its own. `services/dashboard.ts` loads the data.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const QUIET_AT_APPLIED_DAYS = 21;
const QUIET_LATER_DAYS = 14;
export const WEEK_COUNT = 12;
const QUIET_LIST_LIMIT = 50;

/** Steps in job-search order. Rejected and Closed end a job; they are not a step reached. */
const STEP_RANK: Partial<Record<ApplicationStatus, number>> = {
  APPLIED: 0,
  RECRUITER_CONTACT: 1,
  ASSESSMENT: 2,
  INTERVIEW: 3,
  OFFER: 4,
};
export const RECRUITER = 1;
export const ASSESSMENT = 2;
export const INTERVIEW = 3;
export const OFFER = 4;

/** Mail types that answer an application. Follow-up mail is mostly "we got your application". */
const ANSWER_TYPES: readonly EmailCategory[] = [
  'RECRUITER',
  'ASSESSMENT',
  'INTERVIEW',
  'OFFER',
  'REJECTION',
];

export interface DashApp {
  id: string;
  companyName: string;
  jobTitle: string | null;
  aiStatus: ApplicationStatus | null;
  userStatus: ApplicationStatus | null;
  userStatusSetAt: Date | null;
  appliedAt: Date | null;
  createdAt: Date;
  archivedAt: Date | null;
  /** Live rows of the status-change log. */
  changes: { toStatus: ApplicationStatus | null; changedAt: Date }[];
  /** Matched job mails, fake offers left out. */
  mails: { receivedAt: Date | null; category: EmailCategory | null }[];
}

export interface Window {
  start: Date;
  end: Date;
}

export const inWindow = (date: Date | null, w: Window) => !!date && date >= w.start && date < w.end;

export const effectiveStatus = (app: DashApp) => app.userStatus ?? app.aiStatus;

const isClosedStatus = (status: ApplicationStatus | null) =>
  status === 'REJECTED' || status === 'CLOSED';

export const isActive = (app: DashApp) => !app.archivedAt && !isClosedStatus(effectiveStatus(app));

const minDate = (dates: (Date | null)[]) =>
  dates.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);
const maxDate = (dates: (Date | null)[]) =>
  dates.reduce<Date | null>((max, d) => (d && (!max || d > max) ? d : max), null);

/** `appliedAt`, else the first linked mail, else when the application was made. */
export function appliedDate(app: DashApp): Date {
  return app.appliedAt ?? minDate(app.mails.map((m) => m.receivedAt)) ?? app.createdAt;
}

export function firstAnswerAt(app: DashApp): Date | null {
  return minDate(
    app.mails
      .filter((m) => m.category && ANSWER_TYPES.includes(m.category))
      .map((m) => m.receivedAt),
  );
}

export const answerTimes = (app: DashApp) =>
  app.mails
    .filter((m) => m.category && ANSWER_TYPES.includes(m.category))
    .map((m) => m.receivedAt)
    .filter((d): d is Date => !!d);

const rankOf = (status: ApplicationStatus | null) => (status ? STEP_RANK[status] : undefined);

/**
 * The furthest step the job reached. The user's own open status is their correction of the AI,
 * so it wins; otherwise the furthest step in the log, so a rejected job keeps where it got to.
 */
export function reachedRank(app: DashApp): number {
  const own = rankOf(app.userStatus);
  if (own !== undefined) return own;
  const ranks = [...app.changes.map((c) => rankOf(c.toStatus)), rankOf(effectiveStatus(app))];
  return Math.max(0, ...ranks.filter((r): r is number => r !== undefined));
}

/** When the job first got at least this far, when the log knows. */
export function reachedAt(app: DashApp, rank: number): Date | null {
  if (reachedRank(app) < rank) return null;
  const fromLog = minDate(
    app.changes.filter((c) => (rankOf(c.toStatus) ?? -1) >= rank).map((c) => c.changedAt),
  );
  if (fromLog) return fromLog;
  return (rankOf(app.userStatus) ?? -1) >= rank ? app.userStatusSetAt : null;
}

/** When the job was rejected, for a job that is rejected now. */
export function rejectedAt(app: DashApp): Date | null {
  if (effectiveStatus(app) !== 'REJECTED') return null;
  const fromLog = minDate(
    app.changes.filter((c) => c.toStatus === 'REJECTED').map((c) => c.changedAt),
  );
  return fromLog ?? (app.userStatus === 'REJECTED' ? app.userStatusSetAt : null);
}

export const wasAnswered = (app: DashApp) => !!firstAnswerAt(app) || reachedRank(app) >= RECRUITER;

export function totals(apps: DashApp[], w: Window) {
  return {
    applicationsSent: apps.filter((a) => inWindow(appliedDate(a), w)).length,
    repliesReceived: apps.filter((a) => answerTimes(a).some((t) => inWindow(t, w))).length,
    interviewsReached: apps.filter((a) => inWindow(reachedAt(a, INTERVIEW), w)).length,
    offers: apps.filter((a) => inWindow(reachedAt(a, OFFER), w)).length,
    rejections: apps.filter((a) => inWindow(rejectedAt(a), w)).length,
  };
}

export function rightNow(apps: DashApp[]): DashboardResponse['rightNow'] {
  const counts = { APPLIED: 0, RECRUITER_CONTACT: 0, ASSESSMENT: 0, INTERVIEW: 0, OFFER: 0 };
  for (const app of apps.filter(isActive)) {
    const status = effectiveStatus(app) ?? 'APPLIED';
    if (status in counts) counts[status as keyof typeof counts] += 1;
  }
  return counts;
}

export function funnel(apps: DashApp[], w: Window): DashboardResponse['funnel'] {
  const sent = apps.filter((a) => inWindow(appliedDate(a), w));
  const atLeast = (rank: number) => sent.filter((a) => reachedRank(a) >= rank).length;
  return {
    applied: sent.length,
    answered: sent.filter(wasAnswered).length,
    recruiterContact: atLeast(RECRUITER),
    assessment: atLeast(ASSESSMENT),
    interview: atLeast(INTERVIEW),
    offer: atLeast(OFFER),
  };
}

export function rejectedAfter(apps: DashApp[], w: Window): DashboardResponse['rejectedAfter'] {
  const result = { noAnswer: 0, recruiterContact: 0, assessment: 0, interview: 0 };
  for (const app of apps.filter((a) => inWindow(rejectedAt(a), w))) {
    const rank = reachedRank(app);
    if (rank >= INTERVIEW) result.interview += 1;
    else if (rank === ASSESSMENT) result.assessment += 1;
    else if (rank === RECRUITER) result.recruiterContact += 1;
    else result.noAnswer += 1;
  }
  return result;
}

/** The calendar day of an instant in the user's time zone, as YYYY-MM-DD. */
export function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** The Monday on or before a YYYY-MM-DD day. */
export function mondayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function weeks(apps: DashApp[], now: Date, timeZone: string): DashboardResponse['weeks'] {
  const last = new Date(`${mondayOf(localDay(now, timeZone))}T00:00:00Z`);
  const list = Array.from({ length: WEEK_COUNT }, (_, i) => {
    const start = new Date(last);
    start.setUTCDate(last.getUTCDate() - 7 * (WEEK_COUNT - 1 - i));
    return {
      weekStart: start.toISOString().slice(0, 10),
      applicationsSent: 0,
      answers: 0,
      interviews: 0,
    };
  });
  const index = new Map(list.map((week, i) => [week.weekStart, i]));
  const weekOf = (date: Date | null) =>
    date ? index.get(mondayOf(localDay(date, timeZone))) : undefined;
  for (const app of apps) {
    const sent = weekOf(appliedDate(app));
    if (sent !== undefined) list[sent].applicationsSent += 1;
    for (const i of new Set(answerTimes(app).map(weekOf)))
      if (i !== undefined) list[i].answers += 1;
    const interview = weekOf(reachedAt(app, INTERVIEW));
    if (interview !== undefined) list[interview].interviews += 1;
  }
  return list;
}

const daysBetween = (from: Date, to: Date) =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));

/**
 * Jobs gone quiet (owner, 27 Oct 2026): 21 days at Applied with no answer, or 14 days in a later
 * step with no new mail. Quiet counts from the last thing that happened to the job.
 */
export function goneQuiet(apps: DashApp[], now: Date): DashboardResponse['goneQuiet'] {
  const quiet = apps
    .filter(isActive)
    .map((app) => {
      const status = effectiveStatus(app);
      const atApplied = (rankOf(status) ?? 0) === 0;
      const last = maxDate([
        appliedDate(app),
        ...app.mails.map((m) => m.receivedAt),
        ...app.changes.map((c) => c.changedAt),
        app.userStatusSetAt,
      ]);
      const daysQuiet = last ? daysBetween(last, now) : 0;
      const limit = atApplied ? QUIET_AT_APPLIED_DAYS : QUIET_LATER_DAYS;
      const isQuiet = daysQuiet >= limit && (!atApplied || !firstAnswerAt(app));
      return isQuiet
        ? {
            applicationId: app.id,
            companyName: app.companyName,
            jobTitle: app.jobTitle,
            status,
            daysQuiet,
          }
        : null;
    })
    .filter((job) => job !== null)
    .sort((x, y) => y.daysQuiet - x.daysQuiet);
  return { count: quiet.length, jobs: quiet.slice(0, QUIET_LIST_LIMIT) };
}

/** The middle value, and the value 8 in 10 stay at or under; null for no values. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 10) / 10;
}

export function percentile80(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.8 * sorted.length) - 1];
}

export function answerSpeed(apps: DashApp[], w: Window): DashboardResponse['answerSpeed'] {
  const answered = apps
    .map((app) => ({ app, first: firstAnswerAt(app) }))
    .filter(({ first }) => inWindow(first, w))
    .map(({ app, first }) => ({
      companyName: app.companyName,
      days: daysBetween(appliedDate(app), first as Date),
    }));
  const days = answered.map((a) => a.days);
  return {
    answered: answered.length,
    medianDays: median(days),
    p80Days: percentile80(days),
    slowest: [...answered].sort((x, y) => y.days - x.days).slice(0, 3),
  };
}

export interface Submission {
  platform: string;
  workMode: string | null;
  submittedAt: Date;
  applicationId: string | null;
}

/** Sites and work modes: only the automation reports them, so other jobs are one row of their own. */
export function automationRows(apps: DashApp[], submissions: Submission[], w: Window) {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const inPeriod = submissions.filter((s) => inWindow(s.submittedAt, w) && s.applicationId);
  const group = <K>(keyOf: (s: Submission) => K) => {
    const groups = new Map<K, Set<string>>();
    for (const s of inPeriod) {
      const key = keyOf(s);
      groups.set(key, (groups.get(key) ?? new Set()).add(s.applicationId as string));
    }
    return groups;
  };
  const score = (ids: Set<string>) => {
    const list = [...ids].map((id) => byId.get(id)).filter((a): a is DashApp => !!a);
    return {
      sent: list.length,
      answered: list.filter(wasAnswered).length,
      interviews: list.filter((a) => reachedRank(a) >= INTERVIEW).length,
    };
  };
  const automated = new Set(submissions.map((s) => s.applicationId));
  const others = apps.filter((a) => !automated.has(a.id) && inWindow(appliedDate(a), w));
  const sites: DashboardResponse['automation']['sites'] = [...group((s) => s.platform)].map(
    ([platform, ids]) => ({ platform, ...score(ids) }),
  );
  if (others.length) sites.push({ platform: null, ...score(new Set(others.map((a) => a.id))) });
  const workModes = [...group((s) => s.workMode?.trim().toLowerCase() || null)].map(
    ([workMode, ids]) => {
      const { sent, answered } = score(ids);
      return { workMode, sent, answered };
    },
  );
  const bySent = <T extends { sent: number }>(rows: T[]) => rows.sort((x, y) => y.sent - x.sent);
  return { sites: bySent(sites), workModes: bySent(workModes) };
}

export function topReasons(reasons: string[], limit = 3) {
  const counts = new Map<string, number>();
  for (const reason of reasons.map((r) => r.trim()).filter(Boolean))
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((x, y) => y.count - x.count || x.reason.localeCompare(y.reason))
    .slice(0, limit);
}

/** Hours from each mail that asked for an answer by mail to the user's first reply after it. */
export function replyHours(
  asks: { threadId: string | null; receivedAt: Date | null }[],
  sent: { threadId: string; sentAt: Date }[],
): number[] {
  const byThread = new Map<string, Date[]>();
  for (const s of sent) byThread.set(s.threadId, [...(byThread.get(s.threadId) ?? []), s.sentAt]);
  return asks.flatMap((ask) => {
    if (!ask.threadId || !ask.receivedAt) return [];
    const after = (byThread.get(ask.threadId) ?? []).filter((d) => d > (ask.receivedAt as Date));
    const first = minDate(after);
    return first ? [(first.getTime() - ask.receivedAt.getTime()) / (60 * 60 * 1000)] : [];
  });
}

export const rate = (count: number, of: number) => ({ count, of });
