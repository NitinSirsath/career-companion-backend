/**
 * Reanalyze (owner, 19 Nov 2026): the user asks the AI to read a conversation, or all of an
 * application's conversations, again with today's rules. Checked before any AI call (what it
 * reads, the 10-minute rule, the AI reads left with a reserve for new mail), then read in the
 * background: the replay (`reanalysisReplay.ts`) and one save per conversation
 * (`reanalysisSave.ts`). "New mails only" stays true: this runs only on the user's click.
 */
import type {
  ReanalysisBlock,
  ReanalysisPreview,
  ReanalysisRun,
  ReanalysisStatus,
} from '../contracts/reanalysis';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { logError, logEvent } from '../utils/log';
import { callsToday, resolveAIAccess } from './ai/access';
import { AIAccessError, AIProviderError } from './ai/errors';
import { dailyCallLimit } from './ai/usage';
import { threadKey } from './conversation';
import { enqueueReanalysis } from './enqueue';
import {
  REANALYZE_COOLDOWN_MS,
  REANALYZE_MAX_MESSAGES,
  REANALYZE_TIME_LIMIT_MS,
  ReanalysisStop,
  newestApplicationRun,
  newestRunFor,
  openRun,
  recentlySaved,
  toRun,
} from './reanalysisRuns';
import { isFinished, loadConversation, replayConversation, stillReading } from './reanalysisReplay';
import { saveReplay } from './reanalysisSave';
import type { ReanalysisStopReason } from '../contracts/reanalysis';

/** At most this many reads are kept free each day for new mail, or a fifth of the limit. */
const RESERVE_FOR_NEW_MAIL = 50;

const MESSAGES: Record<ReanalysisBlock, string> = {
  NOTHING_TO_READ: 'There is no job mail here the AI has finished reading.',
  STILL_READING: 'A mail or reply here is still being read. Try again in a minute.',
  RUN_OPEN: 'A Reanalyze is already running. Try again when it is done.',
  REANALYZED_RECENTLY: 'This was reanalyzed a few minutes ago. Try again after 10 minutes.',
  APPLICATION_ARCHIVED: 'This application is archived.',
  TOO_LONG: 'This conversation is too long to reanalyze (over 20 mails and replies).',
  AI_UNAVAILABLE: 'Your AI is not ready. Check it in Settings.',
  AI_RESERVE: 'Not enough AI reads left today. Some are kept for your new mail.',
  GMAIL_DISCONNECTED: 'Connect Gmail again to reanalyze.',
};

/** One conversation as the checks see it. */
interface Candidate {
  key: string;
  mails: number;
  replies: number;
  unfinished: number;
  block: ReanalysisBlock | null;
  newest: number;
}

async function describeConversation(userId: string, key: string): Promise<Candidate | null> {
  const snap = await loadConversation(prisma, userId, key);
  const jobMails = snap.mails.filter((mail) => mail.relevanceState === 'RELEVANT');
  if (!jobMails.length) return null;
  const finished = jobMails.filter(isFinished);
  const linkedArchived = snap.applications.some(
    (app) =>
      app.archivedAt &&
      jobMails.some((mail) => mail.matchState === 'MATCHED' && mail.applicationId === app.id),
  );
  return {
    key,
    mails: finished.length,
    replies: snap.replies.length,
    unfinished: jobMails.filter((mail) => mail.processingState === 'FAILED').length,
    block: conversationBlock(
      stillReading(snap),
      linkedArchived,
      finished.length,
      snap.replies.length,
    ),
    newest: Math.max(...jobMails.map((mail) => (mail.receivedAt ?? mail.createdAt).getTime())),
  };
}

/** Why this one conversation cannot run, in the order the user is told. */
function conversationBlock(
  reading: boolean,
  archived: boolean,
  mails: number,
  replies: number,
): ReanalysisBlock | null {
  if (reading) return 'STILL_READING';
  if (archived) return 'APPLICATION_ARCHIVED';
  if (!mails) return 'NOTHING_TO_READ';
  return mails + replies > REANALYZE_MAX_MESSAGES ? 'TOO_LONG' : null;
}

/** Why none of an application's conversations can run. */
function noneBlock(all: Candidate[], saved: Map<string, Date>): ReanalysisBlock {
  if (all.every((c) => saved.has(c.key))) return 'REANALYZED_RECENTLY';
  const blocks = all.map((c) => c.block);
  if (blocks.includes('STILL_READING')) return 'STILL_READING';
  return blocks.includes('TOO_LONG') ? 'TOO_LONG' : 'NOTHING_TO_READ';
}

/** The AI reads left today, the reserve, and the model that would read. */
async function aiRoom(userId: string) {
  try {
    const access = await resolveAIAccess(userId);
    const limit = dailyCallLimit(access.provider);
    return {
      readsLeft: Math.max(0, limit - (await callsToday(userId, new Date()))),
      reserve: Math.min(RESERVE_FOR_NEW_MAIL, Math.floor(limit / 5)),
      reader: { provider: access.provider, model: access.models.detailed.id },
      block: null,
    };
  } catch (err) {
    if (!(err instanceof AIAccessError)) throw err;
    const used = err.reason === 'SAFETY_LIMIT';
    return {
      readsLeft: used ? 0 : null,
      reserve: 0,
      reader: null,
      block: (used ? 'AI_RESERVE' : 'AI_UNAVAILABLE') as ReanalysisBlock,
    };
  }
}

/**
 * What a Reanalyze of these conversations would read now, and whether it may start. One
 * conversation: it is refused when it cannot run. An application: the conversations that cannot
 * run, or that would pass 20 mails and replies, are left out.
 */
async function plan(userId: string, keys: string[], fromApplication: boolean) {
  const all = (await Promise.all(keys.map((key) => describeConversation(userId, key)))).filter(
    (candidate): candidate is Candidate => candidate !== null,
  );
  if (!all.length) throw new AppError(404, 'NOT_FOUND', 'Not found');
  all.sort((a, b) => b.newest - a.newest);
  const saved = await recentlySaved(
    userId,
    all.map((candidate) => candidate.key),
  );
  const { chosen, leftOut } = choose(all, saved, fromApplication);
  const first = chosen[0];
  const savedAt = first
    ? saved.get(first.key)
    : [...saved.values()].sort((a, b) => a.getTime() - b.getTime())[0];
  const mails = chosen.reduce((sum, c) => sum + c.mails, 0);
  const replies = chosen.reduce((sum, c) => sum + c.replies, 0);
  const maxReads = mails * 2 + replies;
  const room = await aiRoom(userId);
  const block =
    (await runBlock(userId, { all, chosen, saved, fromApplication })) ??
    (await accessBlock(userId, room, maxReads));
  const preview: ReanalysisPreview = {
    conversations: chosen.length,
    mails,
    replies,
    maxReads,
    readsLeft: room.readsLeft,
    reserve: room.reserve,
    reader: room.reader,
    leftOut,
    unfinishedMails: chosen.reduce((sum, c) => sum + c.unfinished, 0),
    blocked: block,
    retryAt:
      block === 'REANALYZED_RECENTLY' && savedAt
        ? new Date(savedAt.getTime() + REANALYZE_COOLDOWN_MS).toISOString()
        : null,
  };
  return { preview, keys: chosen.map((c) => c.key) };
}

/**
 * The conversations to read, newest first, up to 20 mails and replies. One conversation is always
 * chosen, so its numbers show with the reason it cannot run; an application's others are left out.
 */
function choose(all: Candidate[], saved: Map<string, Date>, fromApplication: boolean) {
  const chosen: Candidate[] = [];
  let leftOut = 0;
  let total = 0;
  for (const candidate of all) {
    const size = candidate.mails + candidate.replies;
    const fits =
      !candidate.block && !saved.has(candidate.key) && total + size <= REANALYZE_MAX_MESSAGES;
    if (fits || (!fromApplication && chosen.length === 0)) {
      chosen.push(candidate);
      total += size;
    } else leftOut++;
  }
  return { chosen, leftOut };
}

/** A run open, or the chosen conversations cannot run. */
async function runBlock(
  userId: string,
  {
    all,
    chosen,
    saved,
    fromApplication,
  }: { all: Candidate[]; chosen: Candidate[]; saved: Map<string, Date>; fromApplication: boolean },
): Promise<ReanalysisBlock | null> {
  if (await openRun(prisma, userId)) return 'RUN_OPEN';
  if (!chosen.length) return noneBlock(all, saved);
  if (fromApplication) return null;
  return chosen[0].block ?? (saved.has(chosen[0].key) ? 'REANALYZED_RECENTLY' : null);
}

/** Gmail must be connected, and the AI ready with enough reads left after the reserve. */
async function accessBlock(
  userId: string,
  room: Awaited<ReturnType<typeof aiRoom>>,
  maxReads: number,
): Promise<ReanalysisBlock | null> {
  const connection = await prisma.gmailConnection.findUnique({
    where: { userId },
    select: { status: true },
  });
  if (connection?.status !== 'CONNECTED') return 'GMAIL_DISCONNECTED';
  if (room.block) return room.block;
  return room.readsLeft !== null && room.readsLeft - maxReads < room.reserve ? 'AI_RESERVE' : null;
}

/** The conversations of an application, by their thread. */
async function applicationKeys(userId: string, applicationId: string) {
  const app = await prisma.application.findFirst({
    where: { id: applicationId, userId },
    select: { archivedAt: true },
  });
  if (!app) throw new AppError(404, 'NOT_FOUND', 'Not found');
  if (app.archivedAt)
    throw new AppError(409, 'APPLICATION_ARCHIVED', MESSAGES.APPLICATION_ARCHIVED);
  const mails = await prisma.email.findMany({
    where: { userId, applicationId, matchState: 'MATCHED', relevanceState: 'RELEVANT' },
    select: { id: true, threadId: true },
  });
  return [...new Set(mails.map((mail) => mail.threadId ?? mail.id))];
}

async function status(
  run: Awaited<ReturnType<typeof newestRunFor>>,
  preview: (() => Promise<ReanalysisPreview>) | null,
): Promise<ReanalysisStatus> {
  const shown = run && toRun(run);
  const open = shown?.state === 'QUEUED' || shown?.state === 'RUNNING';
  return { run: shown ?? null, preview: open || !preview ? null : await preview() };
}

/** GET /api/conversations/:key/reanalyze */
export async function conversationReanalysis(userId: string, anyKey: string, withPreview: boolean) {
  const key = await threadKey(userId, anyKey);
  const preview = async () => (await plan(userId, [key], false)).preview;
  return status(await newestRunFor(userId, key), withPreview ? preview : null);
}

/** GET /api/applications/:id/reanalyze */
export async function applicationReanalysis(
  userId: string,
  applicationId: string,
  withPreview: boolean,
) {
  const keys = await applicationKeys(userId, applicationId);
  const preview = async () => (await plan(userId, keys, true)).preview;
  return status(await newestApplicationRun(userId, applicationId), withPreview ? preview : null);
}

/** POST /api/conversations/:key/reanalyze */
export async function startConversationReanalysis(userId: string, anyKey: string) {
  const key = await threadKey(userId, anyKey);
  return start(userId, [key], null);
}

/** POST /api/applications/:id/reanalyze */
export async function startApplicationReanalysis(userId: string, applicationId: string) {
  return start(userId, await applicationKeys(userId, applicationId), applicationId);
}

/** Starts a run when the checks pass; 409 with the check's code when not. */
async function start(
  userId: string,
  keys: string[],
  applicationId: string | null,
): Promise<ReanalysisRun> {
  const { preview, keys: chosen } = await plan(userId, keys, applicationId !== null);
  const run = await prisma.$transaction(async (tx) => {
    // Two clicks or two tabs: the second waits here, then finds the first run open.
    await lockUser(tx, LOCK_NAMESPACE.reanalysis, userId);
    if (!preview.blocked && (await openRun(tx, userId))) preview.blocked = 'RUN_OPEN';
    if (preview.blocked)
      throw new AppError(409, preview.blocked, MESSAGES[preview.blocked], {
        retryAt: preview.retryAt,
      });
    return tx.reanalysisRun.create({ data: { userId, applicationId, keys: chosen } });
  });
  try {
    await enqueueReanalysis(userId, run.id);
  } catch (err) {
    await finish(run.id, 'STOPPED', 'FAILED');
    throw err;
  }
  logEvent('reanalysis_started', { userId, runId: run.id, conversations: run.keys.length });
  return toRun(run);
}

const finish = (
  runId: string,
  state: 'SAVED' | 'STOPPED',
  stopReason: ReanalysisStopReason | null,
) =>
  prisma.reanalysisRun.updateMany({
    where: { id: runId, state: { in: ['QUEUED', 'RUNNING'] } },
    data: { state, stopReason, finishedAt: new Date() },
  });

/** Why a run stopped, from what was thrown. */
export function stopReasonOf(err: unknown): ReanalysisStopReason {
  if (err instanceof ReanalysisStop) return err.reason;
  if (err instanceof AIAccessError) {
    if (err.reason === 'SAFETY_LIMIT' || err.reason === 'FREE_AI_BUDGET') return 'AI_LIMIT';
    const busy = ['RATE_LIMITED', 'PROVIDER_BUSY', 'PROVIDER_UNAVAILABLE', 'FREE_AI_BUSY'];
    return busy.includes(err.reason) ? 'AI_BUSY' : 'AI_UNAVAILABLE';
  }
  return 'FAILED';
}

/**
 * The background job: reads and saves each conversation in turn. The first failure stops the run;
 * conversations saved before it stay saved, and nothing of the failed one changes.
 */
export async function runReanalysis(userId: string, runId: string) {
  const claimed = await prisma.reanalysisRun.updateMany({
    where: { id: runId, userId, state: 'QUEUED' },
    data: { state: 'RUNNING', startedAt: new Date() },
  });
  if (!claimed.count) return;
  const run = await prisma.reanalysisRun.findUniqueOrThrow({ where: { id: runId } });
  const deadline = Date.now() + REANALYZE_TIME_LIMIT_MS;
  for (const key of run.keys) {
    try {
      const snap = await loadConversation(prisma, userId, key);
      if (snap.suspended) throw new ReanalysisStop('SUSPENDED');
      // A new mail being read, or the application archived, since the click.
      if (stillReading(snap) || snap.applications.some((app) => app.archivedAt))
        throw new ReanalysisStop('NEW_ACTIVITY');
      const replay = await replayConversation(userId, snap, { deadline });
      await saveReplay(userId, runId, snap, replay);
    } catch (err) {
      const reason = stopReasonOf(err);
      await finish(runId, 'STOPPED', reason);
      if (reason === 'FAILED' && !(err instanceof AIProviderError))
        logError('reanalysis_failed', { userId, runId }, err);
      logEvent('reanalysis_stopped', { userId, runId, reason });
      return;
    }
  }
  await finish(runId, 'SAVED', null);
  logEvent('reanalysis_saved', { userId, runId, conversations: run.keys.length });
}
