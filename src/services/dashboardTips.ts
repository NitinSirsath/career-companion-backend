/**
 * The Dashboard's tips (owner, 27 Oct 2026): up to three from fixed rules, only when true, and
 * one from the user's AI, made from their numbers by a queued job at most once a day.
 */
import { createHash } from 'node:crypto';
import type { DashboardResponse, DashboardTip } from '../contracts';
import { prisma } from '../db/prisma';
import { logEvent, logWarn } from '../utils/log';
import { getAccessState } from './ai/access';
import { DASHBOARD_TIP_CONTRACT } from './ai/dashboardTip';
import { runUserCall } from './ai/userCall';
import { enqueueDashboardTip } from './enqueue';
import { modelName } from './replyDraft';

export type DashboardNumbers = Omit<DashboardResponse, 'tips' | 'aiTip'>;
type Numbers = DashboardNumbers;

const RULE_TIP_LIMIT = 3;
/** A rate means something from this many applications (owner, 27 Oct 2026). */
const RATE_BASE = 5;
/** A site answers clearly more often: at least this many points more than another. */
const SITE_GAP_POINTS = 15;
/** Enough replies to say how fast the user answers. */
const REPLY_TIME_BASE = 3;
const EARLY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const percent = (count: number, of: number) => Math.round((count / of) * 100);

/** The tips that are true now, most useful first. No AI call. */
export function ruleTips(numbers: Numbers, now: Date): DashboardTip[] {
  const tips: DashboardTip[] = [];
  if (numbers.goneQuiet.count) tips.push({ kind: 'GONE_QUIET', count: numbers.goneQuiet.count });

  const { replied, medianReplyHours, waitingOverADay } = numbers.keepingUp;
  if (waitingOverADay || replied >= REPLY_TIME_BASE)
    tips.push({
      kind: 'REPLY_TIME',
      medianReplyHours: replied >= REPLY_TIME_BASE ? medianReplyHours : null,
      waitingOverADay,
    });

  const sites = numbers.automation.sites
    .filter((s) => s.platform && s.sent >= RATE_BASE)
    .map((s) => ({ site: s.platform as string, percent: percent(s.answered, s.sent) }))
    .sort((x, y) => y.percent - x.percent);
  const best = sites[0];
  const worst = sites.at(-1);
  if (best && worst && best !== worst && best.percent - worst.percent >= SITE_GAP_POINTS)
    tips.push({
      kind: 'SITE_ANSWERS_MORE',
      site: best.site,
      percent: best.percent,
      otherSite: worst.site,
      otherPercent: worst.percent,
    });

  const started = numbers.dataStartsAt ? new Date(numbers.dataStartsAt) : null;
  if (started && now.getTime() - started.getTime() < EARLY_DAYS * DAY_MS)
    tips.push({ kind: 'EARLY_DAYS', medianDays: numbers.answerSpeed.medianDays });

  return tips.slice(0, RULE_TIP_LIMIT);
}

/** What the AI reads: counts, rates and site names only. Never a company, name or mail. */
export function aiTipInput(numbers: Numbers) {
  return {
    totals: numbers.totals,
    funnel: numbers.funnel,
    rates: numbers.rates,
    rejectedAfter: numbers.rejectedAfter,
    daysToFirstAnswer: {
      answered: numbers.answerSpeed.answered,
      median: numbers.answerSpeed.medianDays,
      eightInTen: numbers.answerSpeed.p80Days,
    },
    yourReplies: {
      replied: numbers.keepingUp.replied,
      medianHours: numbers.keepingUp.medianReplyHours,
      waitingOverADay: numbers.keepingUp.waitingOverADay,
    },
    jobsGoneQuiet: numbers.goneQuiet.count,
    automation: numbers.automation.used
      ? {
          sites: numbers.automation.sites.map((s) => ({
            ...s,
            platform: s.platform ?? 'not automation',
          })),
          workModes: numbers.automation.workModes,
          lookedAt: numbers.automation.lookedAt,
          sent: numbers.automation.sent,
          skipped: numbers.automation.skipped,
          needsYou: numbers.automation.needsYou,
        }
      : null,
  };
}

export const numbersHash = (input: object) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

/**
 * The AI tip the page shows: the latest one, while the user's AI works. When a day has passed
 * since the last try, a job is queued to make a new one; the page never waits for it.
 */
export async function aiTipForPage(userId: string, timeZone: string, now: Date) {
  const access = await getAccessState(userId);
  if (access.state !== 'READY') return null;
  const row = await prisma.dashboardAITip.findUnique({ where: { userId } });
  if (!row || now.getTime() - row.triedAt.getTime() >= DAY_MS)
    await enqueueDashboardTip(userId, timeZone, now);
  if (!row?.text || !row.provider || !row.model || !row.madeAt) return null;
  return {
    text: row.text,
    modelName: modelName(row.provider, row.model),
    createdAt: row.madeAt.toISOString(),
  };
}

/**
 * The job: one AI call when a day has passed and the numbers changed. A failed try waits for the
 * next day, like a made one; the rule tips still show meanwhile.
 */
export async function makeAITip(userId: string, numbers: Numbers, now: Date) {
  const row = await prisma.dashboardAITip.findUnique({ where: { userId } });
  if (row && now.getTime() - row.triedAt.getTime() < DAY_MS) return;
  const input = aiTipInput(numbers);
  const hash = numbersHash(input);
  const tried = { triedAt: now };
  if (row?.numbersHash === hash) {
    await prisma.dashboardAITip.update({ where: { userId }, data: tried });
    return;
  }
  await prisma.dashboardAITip.upsert({
    where: { userId },
    create: { userId, ...tried },
    update: tried,
  });
  try {
    const { data, provider, model } = await runUserCall({
      userId,
      purpose: 'dashboard-tip',
      contract: DASHBOARD_TIP_CONTRACT,
      call: (ai) => ai.dashboardTip(input),
    });
    const text = data.tip.trim();
    if (!text) return;
    await prisma.dashboardAITip.update({
      where: { userId },
      data: { text, provider, model, madeAt: new Date(), numbersHash: hash },
    });
    logEvent('dashboard_tip_made', { userId, provider, model });
  } catch (err) {
    logWarn('dashboard_tip_failed', {
      userId,
      error: err instanceof Error ? err.name : 'UNKNOWN',
    });
  }
}
