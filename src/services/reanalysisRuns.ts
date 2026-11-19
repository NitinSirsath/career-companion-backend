/**
 * Reanalyze's runs (owner, 19 Nov 2026): one row per click, with the conversations it reads and
 * where it stands. The limits a run keeps live here too.
 */
import type { Prisma, ReanalysisRun as RunRow } from '@prisma/client';
import type { ReanalysisRun, ReanalysisStopReason } from '../contracts/reanalysis';
import { prisma } from '../db/prisma';
import { logEvent } from '../utils/log';

type Db = Prisma.TransactionClient | typeof prisma;

/** A conversation is read again at most once in this time, counted from the run that saved it. */
export const REANALYZE_COOLDOWN_MS = 10 * 60_000;
/** The most mails and replies one click reads. */
export const REANALYZE_MAX_MESSAGES = 20;
/** A run that takes longer stops, and saves nothing more. */
export const REANALYZE_TIME_LIMIT_MS = 10 * 60_000;
/**
 * A queued or running run older than this has no live job (its job's own limit is shorter), so it
 * counts as stopped: a server restart cannot block the next click for long.
 */
const LIVE_RUN_MS = 20 * 60_000;

const OPEN_STATES = ['QUEUED', 'RUNNING'] as const;

/** A run that cannot finish: the save writes nothing, and the run stops with this reason. */
export class ReanalysisStop extends Error {
  constructor(readonly reason: ReanalysisStopReason) {
    super(`Reanalyze stopped: ${reason}`);
    this.name = 'ReanalysisStop';
  }
}

const isLive = (run: Pick<RunRow, 'state' | 'createdAt'>, now: Date) =>
  (OPEN_STATES as readonly string[]).includes(run.state) &&
  now.getTime() - run.createdAt.getTime() < LIVE_RUN_MS;

/** The user's run that is queued or running now, if any. */
export async function openRun(db: Db, userId: string) {
  const now = new Date();
  const run = await db.reanalysisRun.findFirst({
    where: {
      userId,
      state: { in: [...OPEN_STATES] },
      createdAt: { gt: new Date(now.getTime() - LIVE_RUN_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  return run && isLive(run, now) ? run : null;
}

/** The newest run that reads this conversation, from either page. */
export const newestRunFor = (userId: string, key: string) =>
  prisma.reanalysisRun.findFirst({
    where: { userId, keys: { has: key } },
    orderBy: { createdAt: 'desc' },
  });

/** The newest run started from this application's page. */
export const newestApplicationRun = (userId: string, applicationId: string) =>
  prisma.reanalysisRun.findFirst({
    where: { userId, applicationId },
    orderBy: { createdAt: 'desc' },
  });

/** When a run saved each of these conversations within the last 10 minutes. */
export async function recentlySaved(userId: string, keys: string[]): Promise<Map<string, Date>> {
  if (!keys.length) return new Map();
  const runs = await prisma.reanalysisRun.findMany({
    where: {
      userId,
      savedKeys: { hasSome: keys },
      OR: [
        { finishedAt: { gt: new Date(Date.now() - REANALYZE_COOLDOWN_MS) } },
        { finishedAt: null, state: { in: [...OPEN_STATES] } },
      ],
    },
    select: { savedKeys: true, finishedAt: true, startedAt: true, createdAt: true },
  });
  const saved = new Map<string, Date>();
  for (const run of runs) {
    const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
    for (const key of run.savedKeys) {
      const before = saved.get(key);
      if (keys.includes(key) && (!before || before < at)) saved.set(key, at);
    }
  }
  return saved;
}

/** The run as the screens see it. A run left open by a restart shows as stopped. */
export function toRun(run: RunRow): ReanalysisRun {
  const live = isLive(run, new Date());
  const open = (OPEN_STATES as readonly string[]).includes(run.state);
  return {
    id: run.id,
    state: open && !live ? 'STOPPED' : run.state,
    stopReason: open && !live ? 'INTERRUPTED' : (run.stopReason as ReanalysisStopReason | null),
    conversations: run.keys.length,
    saved: run.savedKeys.length,
    changed: run.changed,
    gone: run.gone,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/** When the worker starts no job holds a run: those still running stop as interrupted. */
export async function stopInterruptedRuns() {
  const { count } = await prisma.reanalysisRun.updateMany({
    where: { state: 'RUNNING' },
    data: { state: 'STOPPED', stopReason: 'INTERRUPTED', finishedAt: new Date() },
  });
  if (count) logEvent('reanalysis_interrupted', { runs: count });
}
