/**
 * "AI is reading your mails" (owner, 24 Oct 2026): how far the AI is with the user's newest mails,
 * about how long the rest takes, and what it does now. It only counts rows: no AI call.
 *
 * - The batch starts at the sync that saved the user's oldest mail not done yet (waiting or being
 *   read). Its total is the user's mails saved since that sync began. A mail that stopped and waits
 *   for the user's OK counts as done here; the Mails page shows it.
 * - The mail reader has one line for all users, first in, first out. The mails ahead are other
 *   users' mail jobs queued before the user's newest one.
 * - The speed is how long the AI took for each mail finished in the last 5 minutes (both steps), for
 *   all users together, shared by the mails read at once. Time the reader stood idle does not
 *   count. With fewer than 6 mails, it is the load test's 1.2 seconds a mail (24 Oct 2026: 500
 *   mails in 10.4 minutes, 3 at once).
 * - There is no time while a pause holds back part of the mail, while batch mode is on, or when the
 *   line cannot be read. A pause shows when it ends instead.
 */
import { Prisma } from '@prisma/client';
import type { AIRole } from '../../contracts/aiCatalog';
import type { AIReadingJobMail, AIReadingStatusResponse, AIReadingStep } from '../../contracts/ai';
import { prisma } from '../../db/prisma';
import { emailWorkerConcurrency } from '../../utils/config';
import { logWarn } from '../../utils/log';
import { EMAIL_PROCESSING_JOB } from '../enqueue';
import { QUEUE_SCHEMA } from '../queue';
import { type ModelPause, type UserAccess, blockingPause, getAccessState } from './access';
import { nextRole } from './offer';
import { triageBatchEnabled } from './triage';

const NOT_DONE = ['PENDING', 'PROCESSING'] as const;
/** Mails saved further apart than this belong to different syncs. */
const SYNC_GAP_MS = 2 * 60_000;
const DAY_MS = 24 * 3_600_000;
export const SPEED_WINDOW_MS = 5 * 60_000;
export const MIN_SPEED_SAMPLE = 6;
export const FALLBACK_SECONDS_PER_MAIL = 1.2;
const SPEED_CACHE_MS = 5_000;
const STEP_LIMIT = 10;
const JOB_MAIL_LIMIT = 3;
/** Pauses with no known end for the user: the free AI's budget, or a problem on our side. */
const STOPPING_PAUSES: readonly string[] = ['FREE_AI_BUDGET', 'FREE_AI_PROBLEM'];

let speed: { at: number; secondsPerMail: number } | null = null;

/** Tests only: forget the shared speed. */
export const resetReadingSpeed = () => {
  speed = null;
};

/**
 * Seconds a mail takes the reader now, for all users together: the AI's time for the mails it
 * finished in the last 5 minutes, both steps, divided by the mails it reads at once. Worked out at
 * most once every 5 seconds and shared, because every reading user asks every 5 seconds.
 */
export async function secondsPerMail(now: Date): Promise<number> {
  if (speed && now.getTime() - speed.at < SPEED_CACHE_MS) return speed.secondsPerMail;
  // The column has no time zone: the bound is passed as text, in UTC as the column is.
  const since = new Date(now.getTime() - SPEED_WINDOW_MS).toISOString();
  const [row] = await prisma.$queryRaw<{ mails: number; seconds: number }[]>`
    SELECT count(*) FILTER (WHERE operation = 'classification')::int AS mails,
      coalesce(sum(extract(epoch FROM ("completedAt" - "startedAt"))), 0)::float AS seconds
    FROM ai_operations
    WHERE status = 'COMPLETED' AND "startedAt" IS NOT NULL AND "completedAt" > ${since}::timestamp`;
  const value =
    row && row.mails >= MIN_SPEED_SAMPLE
      ? Math.max(row.seconds / row.mails / emailWorkerConcurrency(), 0.1)
      : FALLBACK_SECONDS_PER_MAIL;
  speed = { at: now.getTime(), secondsPerMail: value };
  return value;
}

/**
 * The user's place in the reader's line, from pg-boss's own job table: how many mail jobs of the
 * user wait or run, and how many of other users' were queued before the user's newest one. Null
 * when the table cannot be read; the screens then show progress without a time.
 */
async function lineAhead(userId: string): Promise<{ queued: number; ahead: number } | null> {
  const jobs = Prisma.raw(`${QUEUE_SCHEMA}.job`);
  try {
    const [row] = await prisma.$queryRaw<{ queued: number; ahead: number }[]>`
      WITH mine AS (
        SELECT count(*)::int AS queued, max(created_on) AS newest FROM ${jobs}
        WHERE name = ${EMAIL_PROCESSING_JOB} AND state IN ('created', 'retry', 'active')
          AND data->>'userId' = ${userId}
      )
      SELECT mine.queued, (
        SELECT count(*)::int FROM ${jobs}
        WHERE name = ${EMAIL_PROCESSING_JOB} AND state IN ('created', 'retry', 'active')
          AND data->>'userId' <> ${userId} AND created_on <= mine.newest
      ) AS ahead
      FROM mine`;
    return row ?? null;
  } catch {
    logWarn('reading_line_unreadable', { userId });
    return null;
  }
}

/**
 * When the batch began: the sync that saved the user's oldest mail not done yet (or, when nothing
 * waits, the newest mail). The reader takes the oldest mail first, so the done mails of that sync
 * are older than it. One sync saves its mails seconds apart and syncs run an hour apart, so the
 * batch begins after the last gap of more than 2 minutes before that mail.
 */
async function batchStart(userId: string, oldest: { id: string; createdAt: Date }) {
  // Times stay inside the database: its timestamps have no time zone.
  const [row] = await prisma.$queryRaw<{ start: Date | null }[]>`
    WITH oldest AS (SELECT "createdAt" AS at FROM emails WHERE id = ${oldest.id}::uuid)
    SELECT max("createdAt") AS start FROM (
      SELECT "createdAt", lag("createdAt") OVER (ORDER BY "createdAt") AS previous
      FROM emails, oldest
      WHERE "userId" = ${userId}::uuid AND "createdAt" <= oldest.at
        AND "createdAt" > oldest.at - ${`${DAY_MS / 1000} seconds`}::interval
    ) mails
    WHERE previous IS NULL OR "createdAt" - previous > ${`${SYNC_GAP_MS / 1000} seconds`}::interval`;
  return row?.start ?? oldest.createdAt;
}

/** The time left, or null when it cannot be worked out. */
function timeLeft(
  notDone: number,
  line: { queued: number; ahead: number } | null,
  perMail: number,
): number | null {
  if (!line?.queued || triageBatchEnabled()) return null;
  return Math.round((line.ahead + notDone) * perMail);
}

type Decision = Pick<AIReadingStatusResponse, 'state' | 'reason' | 'model' | 'resumesAt'> & {
  /** Reading, but a pause holds back the mails that need some of the models: no time. */
  partly: boolean;
};

/**
 * What the batch waits for, in the AI notice's order: the user's own problem, Career Companion's
 * pause, the pause of every model the waiting mails need, then the daily limit.
 */
function decide(access: UserAccess, roles: AIRole[]): Decision {
  const none = { model: null, resumesAt: null, partly: false };
  if (access.state === 'NOT_SET_UP' || access.state === 'NEEDS_ATTENTION')
    return { ...none, state: 'NEEDS_YOU', reason: access.reason, model: access.modelId };
  if (access.reason === 'PAUSED' || access.reason === 'FREE_AI_OFF')
    return { ...none, state: 'STOPPED', reason: access.reason };
  const held = roles
    .map((role) => blockingPause(access.pauses, [role]))
    .filter((pause): pause is ModelPause => !!pause);
  if (held.length && held.length === roles.length) {
    // Reading goes on when the first of them ends.
    const first = held.reduce((a, b) => (a.resumesAt <= b.resumesAt ? a : b));
    if (STOPPING_PAUSES.includes(first.reason))
      return { ...none, state: 'STOPPED', reason: first.reason, model: first.model };
    return {
      ...none,
      state: 'PAUSED',
      reason: first.reason,
      model: first.model,
      resumesAt: first.resumesAt.toISOString(),
    };
  }
  if (access.reason === 'SAFETY_LIMIT')
    return {
      ...none,
      state: 'PAUSED',
      reason: 'SAFETY_LIMIT',
      resumesAt: access.resumesAt?.toISOString() ?? null,
    };
  return { ...none, state: 'READING', reason: null, partly: held.length > 0 };
}

const STEP_SELECT = {
  id: true,
  subject: true,
  processingState: true,
  relevanceState: true,
  updatedAt: true,
  aiOperations: {
    select: {
      operation: true,
      status: true,
      provider: true,
      model: true,
      startedAt: true,
      completedAt: true,
    },
  },
  aiProcessingResult: { select: { category: true, companyName: true, jobTitle: true } },
} satisfies Prisma.EmailSelect;

type StepMail = Prisma.EmailGetPayload<{ select: typeof STEP_SELECT }>;

type StepOp = StepMail['aiOperations'][number];

/** The step's call, and when it ran or ended; the mail's last change when no call is known. */
function call(mail: StepMail, op: StepOp | undefined, at: Date | null | undefined) {
  return {
    provider: op?.provider ?? null,
    model: op?.model ?? null,
    at: (at ?? mail.updatedAt).toISOString(),
  };
}

const NOTHING_FOUND = { category: null, companyName: null, jobTitle: null };

/** What the AI found in a job mail. */
function found(mail: StepMail) {
  const result = mail.aiProcessingResult;
  return {
    category: result?.category ?? null,
    companyName: result?.companyName ?? null,
    jobTitle: result?.jobTitle ?? null,
  };
}

/** The answer of a mail the AI finished: a job mail with what it found, or not a job mail. */
function answer(mail: StepMail): Omit<AIReadingStep, 'emailId' | 'subject'> {
  const done = (operation: string) =>
    mail.aiOperations.find((op) => op.operation === operation && op.status === 'COMPLETED');
  const sorted = done('classification');
  if (mail.relevanceState !== 'RELEVANT')
    return {
      step: 'NOT_JOB',
      ...NOTHING_FOUND,
      ...call(mail, sorted, sorted?.completedAt),
    };
  const read = done('extraction') ?? sorted;
  return { step: 'JOB', ...found(mail), ...call(mail, read, read?.completedAt) };
}

/** Where one mail is now: the step that runs, or its answer. Null while it only waits. */
function stepOf(mail: StepMail): AIReadingStep | null {
  const mailOf = { emailId: mail.id, subject: mail.subject };
  const running = mail.aiOperations.find((op) => op.status === 'PROCESSING');
  if (running)
    return {
      ...mailOf,
      step: running.operation === 'extraction' ? 'READING_DETAILS' : 'SORTING',
      ...NOTHING_FOUND,
      ...call(mail, running, running.startedAt),
    };
  if (mail.processingState === 'FAILED')
    return {
      ...mailOf,
      step: 'STOPPED',
      ...NOTHING_FOUND,
      ...call(mail, undefined, null),
    };
  return mail.processingState === 'COMPLETED' ? { ...mailOf, ...answer(mail) } : null;
}

/** The newest mails of the batch the AI works on or answered, oldest first. */
async function newestSteps(userId: string, since: Date): Promise<AIReadingStep[]> {
  const mails = await prisma.email.findMany({
    where: { userId, createdAt: { gte: since }, aiOperations: { some: {} } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: STEP_LIMIT,
    select: STEP_SELECT,
  });
  return mails
    .map(stepOf)
    .filter((step): step is AIReadingStep => !!step)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** The job mails the batch found so far: how many, and the newest three. */
async function jobMailsFound(
  userId: string,
  since: Date,
): Promise<{ count: number; newest: AIReadingJobMail[] }> {
  const where = {
    userId,
    createdAt: { gte: since },
    processingState: 'COMPLETED' as const,
    relevanceState: 'RELEVANT' as const,
  };
  const [count, newest] = await Promise.all([
    prisma.email.count({ where }),
    prisma.email.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: JOB_MAIL_LIMIT,
      select: {
        id: true,
        aiProcessingResult: { select: { category: true, companyName: true, jobTitle: true } },
      },
    }),
  ]);
  return {
    count,
    newest: newest.map((mail) => ({
      emailId: mail.id,
      category: mail.aiProcessingResult?.category ?? null,
      companyName: mail.aiProcessingResult?.companyName ?? null,
      jobTitle: mail.aiProcessingResult?.jobTitle ?? null,
    })),
  };
}

const NOTHING: AIReadingStatusResponse = {
  state: 'NONE',
  reason: null,
  provider: null,
  model: null,
  notDone: 0,
  done: 0,
  total: 0,
  inLine: false,
  secondsLeft: null,
  resumesAt: null,
  steps: [],
  jobMails: { count: 0, newest: [] },
};

/**
 * Nothing waits: with the job mails of the user's last batch, so "done" names them all, also the
 * ones the last mails found after the screens last asked.
 */
async function nothingWaits(userId: string): Promise<AIReadingStatusResponse> {
  const newest = await prisma.email.findFirst({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, createdAt: true },
  });
  if (!newest) return NOTHING;
  return { ...NOTHING, jobMails: await jobMailsFound(userId, await batchStart(userId, newest)) };
}

/** The user's reading status for `GET /api/ai/reading`. */
export async function readingStatus(
  userId: string,
  now = new Date(),
): Promise<AIReadingStatusResponse> {
  const waiting = await prisma.email.findMany({
    where: { userId, processingState: { in: [...NOT_DONE] } },
    select: {
      id: true,
      createdAt: true,
      aiOperations: { where: { operation: 'classification' }, select: { status: true } },
    },
  });
  if (!waiting.length) return nothingWaits(userId);
  const since = await batchStart(
    userId,
    waiting.reduce((oldest, mail) => (mail.createdAt < oldest.createdAt ? mail : oldest)),
  );
  const [total, access, config, steps, jobMails] = await Promise.all([
    prisma.email.count({ where: { userId, createdAt: { gte: since } } }),
    getAccessState(userId),
    prisma.aIConfiguration.findUnique({ where: { userId }, select: { provider: true } }),
    newestSteps(userId, since),
    jobMailsFound(userId, since),
  ]);
  const notDone = waiting.length;
  const done = total - notDone;
  const { partly, ...decision } = decide(access, [...new Set(waiting.map(nextRole))]);
  const reading = decision.state === 'READING';
  const line = reading ? await lineAhead(userId) : null;
  return {
    ...decision,
    provider: config?.provider ?? null,
    notDone,
    done,
    total,
    inLine: reading && done === 0 && (line?.ahead ?? 0) > 0,
    secondsLeft: reading && !partly ? timeLeft(notDone, line, await secondsPerMail(now)) : null,
    steps,
    jobMails,
  };
}
