/**
 * The Admin page's data (owner, 18 Nov 2026): account facts and counts only. Nothing here reads a
 * mail's text, subject or sender. A handful of queries for all accounts at once (the beta keeps
 * them under 100), never one query per account.
 */
import { z } from 'zod';
import type {
  AdminAccount,
  AdminFreeAIMoney,
  AdminGmailState,
  AdminKeyProblem,
  AdminOverview,
} from '../contracts/admin';
import { AdminFreeAIPauseReasonSchema, AdminKeyProblemSchema } from '../contracts/admin';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { betaUserLimit, freeAIOpenRouterKey, mailDailyReplyLimit } from '../utils/config';
import { logWarn } from '../utils/log';
import { isFreeAI } from './ai/freeAI';
import { dailyCallLimit, utcDay } from './ai/usage';
import { isTestAccountEmail } from './testAccounts';
import { suspensionOf } from './user';

const DAY_MS = 86_400_000;
const CHART_DAYS = 14;
const MAILS_CHECKED_DAYS = 30;
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_TIMEOUT_MS = 5000;

const userSelect = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  lastActiveAt: true,
  suspendedAt: true,
  suspendReason: true,
  resumeRequest: true,
  resumeRequestedAt: true,
  gmailConnection: { select: { status: true, syncStatus: true, lastSyncedAt: true } },
  aiConfiguration: { select: { provider: true, accessIssue: true } },
  _count: { select: { applications: true } },
} as const;

type UserRow = Awaited<ReturnType<typeof loadUsers>>[number];

function loadUsers(where: { id?: string } = {}) {
  return prisma.user.findMany({ where, select: userSelect, orderBy: { createdAt: 'desc' } });
}

/** Per-account counts, each from one grouped query over all the accounts asked for. */
async function loadCounts(userIds: string[], now: Date) {
  const since24h = new Date(now.getTime() - DAY_MS);
  const scanFrom = utcDay(new Date(now.getTime() - (MAILS_CHECKED_DAYS - 1) * DAY_MS));
  const [usage, replies, failed, scans] = await Promise.all([
    prisma.aIUsageDay.findMany({
      where: { userId: { in: userIds }, day: utcDay(now) },
      select: { userId: true, calls: true },
    }),
    prisma.mailReply.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, createdAt: { gt: since24h } },
      _count: { _all: true },
    }),
    prisma.aIOperation.findMany({
      where: {
        status: 'FAILED',
        updatedAt: { gt: since24h },
        email: { userId: { in: userIds } },
      },
      select: { emailId: true, email: { select: { userId: true } } },
      distinct: ['emailId'],
    }),
    prisma.mailScanDay.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, day: { gte: scanFrom } },
      _sum: { count: true },
    }),
  ]);
  const failedBy = new Map<string, number>();
  for (const row of failed)
    failedBy.set(row.email.userId, (failedBy.get(row.email.userId) ?? 0) + 1);
  return {
    callsToday: new Map(usage.map((row) => [row.userId, row.calls])),
    repliesLast24h: new Map(replies.map((row) => [row.userId, row._count._all])),
    failedLast24h: failedBy,
    mailsChecked: new Map(scans.map((row) => [row.userId, row._sum.count ?? 0])),
  };
}

function gmailState(connection: UserRow['gmailConnection']): AdminGmailState {
  if (!connection || connection.status === 'NOT_CONNECTED') return 'NOT_CONNECTED';
  if (connection.status === 'REVOKED') return 'ACCESS_REMOVED';
  return connection.syncStatus === 'FAILED' ? 'SYNC_FAILING' : 'CONNECTED';
}

function keyProblem(configuration: UserRow['aiConfiguration']): AdminKeyProblem | null {
  if (!configuration || isFreeAI(configuration.provider)) return null;
  const parsed = AdminKeyProblemSchema.safeParse(configuration.accessIssue);
  return parsed.success ? parsed.data : null;
}

function toAccount(
  user: UserRow,
  counts: Awaited<ReturnType<typeof loadCounts>>,
  adminUserId: string,
): AdminAccount {
  const provider = user.aiConfiguration?.provider ?? null;
  const aiLimit = dailyCallLimit(provider);
  const replyLimit = mailDailyReplyLimit();
  const calls = counts.callsToday.get(user.id) ?? 0;
  const replies = counts.repliesLast24h.get(user.id) ?? 0;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    testAccount: isTestAccountEmail(user.email),
    self: user.id === adminUserId,
    createdAt: user.createdAt.toISOString(),
    lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
    gmail: {
      state: gmailState(user.gmailConnection),
      lastSyncedAt: user.gmailConnection?.lastSyncedAt?.toISOString() ?? null,
    },
    ai: { provider, keyProblem: keyProblem(user.aiConfiguration) },
    limitsReached: {
      ai: provider !== null && aiLimit > 0 && calls >= aiLimit,
      replies: replyLimit > 0 && replies >= replyLimit,
    },
    aiDailyLimit: aiLimit,
    aiFailedLast24h: counts.failedLast24h.get(user.id) ?? 0,
    mailsChecked30d: counts.mailsChecked.get(user.id) ?? 0,
    applications: user._count.applications,
    suspension: suspensionOf(user),
  };
}

/** AI calls of all accounts per UTC day: the last 14 days, oldest first, today last. */
async function aiCallsByDay(now: Date) {
  const days = Array.from({ length: CHART_DAYS }, (_, i) =>
    utcDay(new Date(now.getTime() - (CHART_DAYS - 1 - i) * DAY_MS)),
  );
  const rows = await prisma.aIUsageDay.groupBy({
    by: ['day'],
    where: { day: { gte: days[0] } },
    _sum: { calls: true },
  });
  const byDay = new Map(rows.map((row) => [row.day, row._sum.calls ?? 0]));
  return days.map((day) => ({ day, calls: byDay.get(day) ?? 0 }));
}

export async function readAdminOverview(
  adminUserId: string,
  now = new Date(),
): Promise<AdminOverview> {
  const users = await loadUsers();
  const [counts, pauses, chart] = await Promise.all([
    loadCounts(
      users.map((user) => user.id),
      now,
    ),
    prisma.freeAIPause.findMany({ where: { resumesAt: { gt: now } }, orderBy: { model: 'asc' } }),
    aiCallsByDay(now),
  ]);
  return {
    generatedAt: now.toISOString(),
    betaUserLimit: betaUserLimit(),
    accounts: users.map((user) => toAccount(user, counts, adminUserId)),
    freeAIPauses: pauses.flatMap((pause) => {
      const reason = AdminFreeAIPauseReasonSchema.safeParse(pause.reason);
      if (!reason.success) return [];
      return [
        { model: pause.model, reason: reason.data, resumesAt: pause.resumesAt.toISOString() },
      ];
    }),
    aiCallsByDay: chart,
  };
}

/** One account as the Admin page shows it, after Suspend or Resume. */
export async function readAdminAccount(adminUserId: string, userId: string, now = new Date()) {
  const [user] = await loadUsers({ id: userId });
  if (!user) throw new AppError(404, 'NOT_FOUND', 'This account does not exist.');
  return toAccount(user, await loadCounts([user.id], now), adminUserId);
}

/** The parts of OpenRouter's `GET /api/v1/key` answer the page uses (US dollars). */
const OpenRouterKeySchema = z.object({
  data: z.object({
    limit: z.number().nullable(),
    limit_remaining: z.number().nullable(),
    usage_daily: z.number(),
    usage_monthly: z.number(),
  }),
});

/**
 * What the free AI key spent today and this month, and what is left under its credit limit, asked
 * from OpenRouter with the key itself. The account balance needs a management key, which can also
 * make and delete keys, so the page shows the key's own limit instead. Never stored.
 */
export async function readFreeAIMoney(): Promise<AdminFreeAIMoney> {
  const key = freeAIOpenRouterKey();
  if (!key) return { state: 'NO_KEY' };
  try {
    const response = await fetch(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    });
    if (!response.ok) {
      logWarn('admin_free_ai_money_unavailable', { reason: 'status', status: response.status });
      return { state: 'UNAVAILABLE' };
    }
    const parsed = OpenRouterKeySchema.safeParse(await response.json());
    if (!parsed.success) {
      logWarn('admin_free_ai_money_unavailable', { reason: 'answer_shape' });
      return { state: 'UNAVAILABLE' };
    }
    const { limit, limit_remaining, usage_daily, usage_monthly } = parsed.data.data;
    return {
      state: 'OK',
      todayUsd: Math.max(0, usage_daily),
      monthUsd: Math.max(0, usage_monthly),
      limitUsd: limit === null ? null : Math.max(0, limit),
      leftUsd: limit === null ? null : limit_remaining,
    };
  } catch {
    logWarn('admin_free_ai_money_unavailable', { reason: 'no_answer' });
    return { state: 'UNAVAILABLE' };
  }
}
