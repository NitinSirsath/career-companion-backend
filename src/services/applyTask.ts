/**
 * NorthList Apply runs as tasks (owner, 25 Nov 2026).
 *
 * A run lasts from the user's `ready` to the end of that session. The automation sends the run's
 * start time and plan with every entry (`task` on both MCP tools); the first entry makes the row,
 * keyed by (user, startedAt). A missing or malformed `task` never blocks an entry: the entry is
 * recorded without a run, so applying and syncing never depend on it.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ApplyTask, ApplyTaskSummary } from '../contracts';
import { prisma } from '../db/prisma';
import { SETTLED } from './applicationGroups';

const FUTURE_TOLERANCE_MS = 5 * 60_000;
export const TASK_PLAN_LIMIT = 20;

/** The `task` field of both tools. */
export const ApplyTaskInputSchema = z.strictObject({
  startedAt: z.iso.datetime({ offset: true }),
  plan: z
    .array(
      z.strictObject({
        site: z
          .string()
          .trim()
          .regex(/^[a-z][a-z0-9_]{0,49}$/),
        planned: z.number().int().min(0).max(100),
      }),
    )
    .max(TASK_PLAN_LIMIT),
});

export interface CanonicalTask {
  startedAt: Date;
  utcOffsetMinutes: number;
  plan: { site: string; planned: number }[];
}

/** Minutes east of UTC from an ISO 8601 time: `Z` is 0, `+05:30` is 330. */
export function offsetMinutes(iso: string): number {
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * The run sent with an entry, or null when none was sent or it does not match the contract (then
 * the entry is recorded without a run). A start in the future is not a run either.
 */
export function parseTaskInput(raw: unknown, now = new Date()): CanonicalTask | null {
  if (raw === undefined || raw === null) return null;
  const parsed = ApplyTaskInputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const startedAt = new Date(parsed.data.startedAt);
  if (startedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return null;
  // One row per plan item: a repeated site keeps its first number.
  const seen = new Set<string>();
  const plan = parsed.data.plan.filter((item) => !seen.has(item.site) && seen.add(item.site));
  return { startedAt, utcOffsetMinutes: offsetMinutes(parsed.data.startedAt), plan };
}

type Db = Prisma.TransactionClient | typeof prisma;

const samePlan = (stored: Prisma.JsonValue, plan: CanonicalTask['plan']) =>
  JSON.stringify(
    Array.isArray(stored)
      ? stored.map((item) => {
          const { site, planned } = item as { site?: unknown; planned?: unknown };
          return [site, planned];
        })
      : null,
  ) === JSON.stringify(plan.map((item) => [item.site, item.planned]));

/**
 * The run's row for this user, made on its first entry. Called under the per-user submissions
 * lock, so two entries of one run never make two rows. The newest plan sent wins.
 */
export async function saveTask(db: Db, userId: string, task: CanonicalTask): Promise<string> {
  const stored = await db.applyTask.findUnique({
    where: { userId_startedAt: { userId, startedAt: task.startedAt } },
    select: { id: true, plan: true },
  });
  if (stored) {
    if (!samePlan(stored.plan, task.plan))
      await db.applyTask.update({ where: { id: stored.id }, data: { plan: task.plan } });
    return stored.id;
  }
  const created = await db.applyTask.create({
    data: {
      userId,
      startedAt: task.startedAt,
      utcOffsetMinutes: task.utcOffsetMinutes,
      plan: task.plan,
    },
    select: { id: true },
  });
  return created.id;
}

// ─── The list ───────────────────────────────────────────────────────────────

/** Submissions the user did not set aside count as sent. */
const SENT = { matchState: { not: 'IGNORED' } } satisfies Prisma.ExternalSubmissionWhereInput;

type PlanRow = { site: string; planned: number };
const planOf = (stored: Prisma.JsonValue): PlanRow[] =>
  Array.isArray(stored)
    ? stored.flatMap((item) => {
        const { site, planned } = (item ?? {}) as { site?: unknown; planned?: unknown };
        return typeof site === 'string' && typeof planned === 'number' ? [{ site, planned }] : [];
      })
    : [];

/**
 * Sent per plan item. A job source's job counts toward the source (its `discoverySource`) when the
 * source is in the plan; otherwise toward the site it was sent on. A site outside the plan is added
 * after the plan items, with no planned number.
 */
export function planCounts(
  plan: PlanRow[],
  sent: { platform: string; discoverySource: string | null }[],
): ApplyTask['plan'] {
  const items = plan.map((item) => ({
    site: item.site,
    planned: item.planned as number | null,
    sent: 0,
  }));
  const bySite = new Map(items.map((item) => [item.site, item]));
  for (const entry of sent) {
    const site =
      entry.discoverySource && bySite.has(entry.discoverySource)
        ? entry.discoverySource
        : entry.platform;
    let item = bySite.get(site);
    if (!item) {
      item = { site, planned: null, sent: 0 };
      bySite.set(site, item);
      items.push(item);
    }
    item.sent += 1;
  }
  return items;
}

const latest = (...times: (Date | null | undefined)[]) =>
  times.reduce<Date | null>((max, t) => (t && (!max || t > max) ? t : max), null);

/** The owner's runs, newest start first. Fetches one extra row for the next-page check. */
export async function listApplyTasks(
  userId: string,
  limit: number,
  offset: number,
): Promise<ApplyTask[]> {
  const rows = await prisma.applyTask.findMany({
    where: { userId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    skip: offset,
    select: {
      id: true,
      startedAt: true,
      utcOffsetMinutes: true,
      plan: true,
      submissions: {
        where: SENT,
        select: { platform: true, discoverySource: true, submittedAt: true },
      },
      notSubmittedJobs: { select: { loggedAt: true } },
    },
  });
  return rows.map((row) => {
    const lastAt = latest(
      ...row.submissions.map((s) => s.submittedAt),
      ...row.notSubmittedJobs.map((j) => j.loggedAt),
    );
    return {
      id: row.id,
      startedAt: row.startedAt.toISOString(),
      utcOffsetMinutes: row.utcOffsetMinutes,
      lastAt: lastAt ? lastAt.toISOString() : null,
      sent: row.submissions.length,
      notSent: row.notSubmittedJobs.length,
      plan: planCounts(planOf(row.plan), row.submissions),
    };
  });
}

/** Totals over all of the owner's runs, and the Apply applications that belong to none. */
export async function applyTaskSummary(userId: string): Promise<ApplyTaskSummary> {
  const settled = { userId, ...SETTLED } satisfies Prisma.ExternalSubmissionWhereInput;
  const [tasks, sent, notSent, earlier] = await Promise.all([
    prisma.applyTask.findMany({ where: { userId }, select: { id: true, startedAt: true } }),
    prisma.externalSubmission.groupBy({
      by: ['taskId'],
      where: { userId, taskId: { not: null }, ...SENT },
      _count: { _all: true },
      _max: { submittedAt: true },
    }),
    prisma.notSubmittedJob.groupBy({
      by: ['taskId'],
      where: { userId, taskId: { not: null } },
      _max: { loggedAt: true },
    }),
    prisma.application.count({
      where: {
        userId,
        externalSubmissions: { some: settled, none: { ...settled, taskId: { not: null } } },
      },
    }),
  ]);
  const sentBy = new Map(sent.map((g) => [g.taskId, g]));
  const notSentBy = new Map(notSent.map((g) => [g.taskId, g]));
  let minutes = 0;
  for (const task of tasks) {
    const last = latest(
      sentBy.get(task.id)?._max.submittedAt,
      notSentBy.get(task.id)?._max.loggedAt,
    );
    if (last && last > task.startedAt)
      minutes += (last.getTime() - task.startedAt.getTime()) / 60_000;
  }
  return {
    tasks: tasks.length,
    sent: sent.reduce((n, g) => n + g._count._all, 0),
    minutes: Math.round(minutes),
    earlier,
  };
}
