import { ApplicationStatus, EmailCategory } from '@prisma/client';
import type { DashboardResponse } from '../contracts';

/**
 * The Dashboard's rules (owner, 27 Oct 2026; reworked 3 Nov 2026) as plain functions over one
 * user's data, so each rule has one home and can be tested on its own. `services/dashboard.ts`
 * loads the data.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const QUIET_AT_APPLIED_DAYS = 21;
const QUIET_LATER_DAYS = 14;
export const WEEK_COUNT = 12;
const QUIET_LIST_LIMIT = 50;
/** Up to this many days the series has a point per day; longer, a point per week. */
const DAILY_SERIES_DAYS = 120;

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

/** A YYYY-MM-DD day moved by whole days. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The last 12 weeks, oldest first, for the trend line under each number, whatever the period. */
export function trendWeeks(
  apps: DashApp[],
  now: Date,
  timeZone: string,
): DashboardResponse['trend']['weeks'] {
  const last = mondayOf(localDay(now, timeZone));
  const list = Array.from({ length: WEEK_COUNT }, (_, i) => ({
    weekStart: addDays(last, -7 * (WEEK_COUNT - 1 - i)),
    applicationsSent: 0,
    replies: 0,
    interviews: 0,
    offers: 0,
    rejections: 0,
  }));
  const index = new Map(list.map((week, i) => [week.weekStart, i]));
  const weekOf = (date: Date | null) =>
    date ? index.get(mondayOf(localDay(date, timeZone))) : undefined;
  const add = (
    date: Date | null,
    key: 'applicationsSent' | 'interviews' | 'offers' | 'rejections',
  ) => {
    const i = weekOf(date);
    if (i !== undefined) list[i][key] += 1;
  };
  for (const app of apps) {
    add(appliedDate(app), 'applicationsSent');
    for (const i of new Set(answerTimes(app).map(weekOf)))
      if (i !== undefined) list[i].replies += 1;
    add(reachedAt(app, INTERVIEW), 'interviews');
    add(reachedAt(app, OFFER), 'offers');
    add(rejectedAt(app), 'rejections');
  }
  return list;
}

/** A job mail of the period, for "Job mails per day". */
export interface JobMail {
  receivedAt: Date | null;
  category: EmailCategory | null;
  fakeOffer: boolean;
}

type MailType = 'replyMails' | 'interviewMails' | 'rejectionMails' | 'otherMails';

/** The four kinds of job mail on the chart. A mail with a fake-offer warning is never a reply. */
export function mailType(mail: JobMail): MailType {
  if (mail.fakeOffer) return 'otherMails';
  if (mail.category === 'RECRUITER' || mail.category === 'OFFER') return 'replyMails';
  if (mail.category === 'INTERVIEW' || mail.category === 'ASSESSMENT') return 'interviewMails';
  if (mail.category === 'REJECTION') return 'rejectionMails';
  return 'otherMails';
}

/**
 * The period day by day (week by week when it is longer than 120 days), in the user's time zone:
 * applications sent, replies and interviews as the totals count them, so the points add up to the
 * totals, and the job mails received by kind.
 */
export function series(
  apps: DashApp[],
  mails: JobMail[],
  w: Window,
  timeZone: string,
): DashboardResponse['series'] {
  const first = localDay(w.start, timeZone);
  const last = localDay(new Date(w.end.getTime() - 1), timeZone);
  const span = Math.round(
    (new Date(`${last}T00:00:00Z`).getTime() - new Date(`${first}T00:00:00Z`).getTime()) / DAY_MS,
  );
  const bucket = span + 1 > DAILY_SERIES_DAYS ? 'week' : 'day';
  const keyOf = (day: string) => (bucket === 'week' ? mondayOf(day) : day);
  const step = bucket === 'week' ? 7 : 1;
  const points: DashboardResponse['series']['points'] = [];
  for (let day = keyOf(first); day <= keyOf(last); day = addDays(day, step))
    points.push({
      start: day,
      applicationsSent: 0,
      replies: 0,
      interviews: 0,
      replyMails: 0,
      interviewMails: 0,
      rejectionMails: 0,
      otherMails: 0,
    });
  const index = new Map(points.map((point, i) => [point.start, i]));
  const at = (date: Date | null) =>
    date && inWindow(date, w) ? index.get(keyOf(localDay(date, timeZone))) : undefined;
  const add = (date: Date | null, key: keyof Omit<(typeof points)[number], 'start'>) => {
    const i = at(date);
    if (i !== undefined) points[i][key] += 1;
  };
  for (const app of apps) {
    add(appliedDate(app), 'applicationsSent');
    add(minDate(answerTimes(app).filter((t) => inWindow(t, w))), 'replies');
    add(reachedAt(app, INTERVIEW), 'interviews');
  }
  for (const mail of mails) add(mail.receivedAt, mailType(mail));
  return { bucket, points };
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

/** The middle value; null for no values. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 10) / 10;
}

/**
 * The usual wait for a reply: the median days from applied to the first answer, for the jobs whose
 * first answer came in the period. Null when none did.
 */
export function usualReplyDays(apps: DashApp[], w: Window): number | null {
  return median(
    apps
      .map((app) => ({ app, first: firstAnswerAt(app) }))
      .filter(({ first }) => inWindow(first, w))
      .map(({ app, first }) => daysBetween(appliedDate(app), first as Date)),
  );
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

const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MONTH_FIRST = new RegExp(
  `\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`,
  'g',
);
const DAY_FIRST = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s*(\\d{4}))?`,
  'g',
);
const DAY_RANGE = new RegExp(`${MONTH}\\s+\\d{1,2}\\s*(?:-|–|to)\\s*\\d{1,2}\\b`);
const DAY_CHOICE = /\b\d{1,2}(?:st|nd|rd|th)?\s*(?:or|and|&|\/)\s*\d{1,2}(?:st|nd|rd|th)?\b/;

function validDay(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : null;
}

/**
 * The day of an interview from the date the AI read off the mail, which is free text such as
 * "Thursday, November 5, 2026" or "2026-11-05". A range or a choice of days ("November 2-6", "5 or
 * 6 November") is not a booked interview: null. A date with no year takes the mail's year, or the
 * next one when that would put it two months before the mail.
 */
export function interviewDay(text: string | null, mailDate: Date | null): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (DAY_RANGE.test(lower) || DAY_CHOICE.test(lower)) return null;
  const baseYear = (mailDate ?? new Date()).getUTCFullYear();
  const withYear = (month: number, day: number, year: string | undefined) => {
    if (year) return validDay(Number(year), month, day);
    const guess = validDay(baseYear, month, day);
    if (!guess || !mailDate) return guess;
    return new Date(`${guess}T00:00:00Z`).getTime() < mailDate.getTime() - 60 * DAY_MS
      ? validDay(baseYear + 1, month, day)
      : guess;
  };
  const days = new Set<string>();
  for (const m of lower.matchAll(ISO_DAY)) {
    const day = validDay(Number(m[1]), Number(m[2]), Number(m[3]));
    if (day) days.add(day);
  }
  for (const m of lower.matchAll(MONTH_FIRST)) {
    const day = withYear(MONTHS.indexOf(m[1]) + 1, Number(m[2]), m[3]);
    if (day) days.add(day);
  }
  for (const m of lower.matchAll(DAY_FIRST)) {
    const day = withYear(MONTHS.indexOf(m[2]) + 1, Number(m[1]), m[3]);
    if (day) days.add(day);
  }
  return days.size === 1 ? [...days][0] : null;
}

/** The time of an interview as HH:mm from the AI's free text ("10:00 AM IST", "14:30"), or null. */
export function interviewClock(text: string | null): string | null {
  if (!text) return null;
  const twelve = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\b\.?/i.exec(text);
  if (twelve) {
    const hour = Number(twelve[1]);
    if (hour < 1 || hour > 12) return null;
    const pm = twelve[3].toLowerCase() === 'p';
    return `${String((hour % 12) + (pm ? 12 : 0)).padStart(2, '0')}:${twelve[2] ?? '00'}`;
  }
  const clock = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  return clock ? `${clock[1].padStart(2, '0')}:${clock[2]}` : null;
}

/** A job mail that gives an interview date, with what the page shows about it. */
export interface InterviewMail {
  conversationKey: string;
  receivedAt: Date | null;
  applicationId: string | null;
  companyName: string | null;
  jobTitle: string | null;
  interviewDate: string | null;
  interviewTime: string | null;
  /** The job is archived, rejected or closed. */
  jobClosed: boolean;
}

/** Each conversation's newest mail that gives an interview date. */
function newestPerConversation(mails: InterviewMail[]): InterviewMail[] {
  const time = (mail: InterviewMail) => mail.receivedAt?.getTime() ?? 0;
  const newest = new Map<string, InterviewMail>();
  for (const mail of mails) {
    const kept = newest.get(mail.conversationKey);
    if (!kept || time(mail) > time(kept)) newest.set(mail.conversationKey, mail);
  }
  return [...newest.values()];
}

/**
 * Interviews coming up (owner, 3 Nov 2026), from the dates the AI read off job mails. Each
 * conversation counts its newest date; a closed job does not count; the same interview found in
 * two conversations counts once. Today counts all day: the AI's time has no reliable time zone.
 */
export function upcomingInterviews(
  mails: InterviewMail[],
  now: Date,
  timeZone: string,
): DashboardResponse['now']['interviews'] {
  const today = localDay(now, timeZone);
  const found = new Map<string, NonNullable<DashboardResponse['now']['interviews']['next']>>();
  for (const mail of newestPerConversation(mails)) {
    const date = interviewDay(mail.interviewDate, mail.receivedAt);
    if (!date || date < today || mail.jobClosed) continue;
    const time = interviewClock(mail.interviewTime);
    const key = `${mail.applicationId ?? mail.conversationKey}|${date}|${time ?? ''}`;
    if (!found.has(key))
      found.set(key, {
        applicationId: mail.applicationId,
        companyName: mail.companyName,
        jobTitle: mail.jobTitle,
        conversationKey: mail.conversationKey,
        date,
        time,
      });
  }
  const list = [...found.values()].sort(
    (x, y) => x.date.localeCompare(y.date) || (x.time ?? '99:99').localeCompare(y.time ?? '99:99'),
  );
  return { count: list.length, next: list[0] ?? null };
}

export const rate = (count: number, of: number) => ({ count, of });
