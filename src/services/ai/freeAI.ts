/**
 * The free AI (owner, 24 Oct 2026; ADR-0001 amendment): the catalog provider 'career-companion'
 * runs on Career Companion's own OpenRouter key for every user who chose it. One pause per model is
 * shared by all of them, so one busy answer holds everyone back instead of each user asking
 * OpenRouter again. Nothing here is the user's to fix: a credit, key or model problem pauses the
 * free AI, tries again every hour, and tells the owner once.
 */
import { AIAccessIssue, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { AppError } from '../../errors';
import { freeAIEnabled, freeAIOpenRouterKey } from '../../utils/config';
import { logEvent, logWarn } from '../../utils/log';
import { sendOwnerAlert } from '../notifications/ownerAlert';
import type { FreeAIReason } from './errors';

export const FREE_AI_PROVIDER = 'career-companion';

export const isFreeAI = (providerId: string | null | undefined) => providerId === FREE_AI_PROVIDER;

/** The free AI runs only while its key is set and it is switched on. */
export const freeAIAvailable = () => !!freeAIOpenRouterKey() && freeAIEnabled();

/** Career Companion's key for the free AI. Read it only after `freeAIAvailable()`. */
export function freeAIKey(): string {
  const key = freeAIOpenRouterKey();
  if (!key) throw new Error('The free AI key is not set');
  return key;
}

/** Problems that wait an hour and are told to the owner; any other pause is a busy one. */
const PROBLEMS: readonly AIAccessIssue[] = [
  'ACCOUNT_OR_BILLING',
  'KEY_REJECTED',
  'MODEL_UNAVAILABLE',
  'KEY_UNREADABLE',
];
export const isFreeAIProblem = (issue: AIAccessIssue) => PROBLEMS.includes(issue);

const SHARED_PAUSES: readonly string[] = ['FREE_AI_BUSY', 'FREE_AI_BUDGET', 'FREE_AI_PROBLEM'];

/** A shared pause of the free AI: work that meets one queues its own read for when it ends. */
export const isFreeAIPause = (reason: string) => SHARED_PAUSES.includes(reason);

/** How a shared pause shows to the user. */
export function freeReason(issue: AIAccessIssue): Exclude<FreeAIReason, 'FREE_AI_OFF'> {
  if (issue === 'ACCOUNT_OR_BILLING') return 'FREE_AI_BUDGET';
  return isFreeAIProblem(issue) ? 'FREE_AI_PROBLEM' : 'FREE_AI_BUSY';
}

/** The free AI runs on Career Companion's key: there is no key to check or replace. */
export const noFreeAIKey = () =>
  new AppError(409, 'AI_PROVIDER_HAS_NO_KEY', 'The free AI has no key to check or replace.');

/** The shared pause that stops a call of this free AI model now. */
export async function blockingFreePause(db: Prisma.TransactionClient, model: string, now: Date) {
  const pause = await db.freeAIPause.findUnique({ where: { model } });
  return pause && pause.resumesAt > now ? pause : null;
}

const ALERTS: Partial<Record<AIAccessIssue, string>> = {
  ACCOUNT_OR_BILLING:
    "OpenRouter says the free AI key's credit is used up. Add credit or raise the key's limit on openrouter.ai.",
  KEY_REJECTED: 'OpenRouter refused the free AI key. Check FREE_AI_OPENROUTER_KEY on the server.',
  MODEL_UNAVAILABLE: 'OpenRouter has no server for the free AI model that keeps nothing.',
};

/**
 * Tells the owner, once per problem, that the free AI is paused for a credit, key or model problem.
 * Runs after the transaction that recorded the pause, so a rolled-back pause tells nobody.
 * Best effort.
 */
export async function alertOwnerOfFreePause(): Promise<void> {
  try {
    const due = await prisma.freeAIPause.findMany({
      where: { alertedAt: null, reason: { in: [...PROBLEMS] } },
    });
    for (const pause of due) {
      // Only one alert per problem, also when two failures end at the same moment.
      const claimed = await prisma.freeAIPause.updateMany({
        where: { model: pause.model, reason: pause.reason, alertedAt: null },
        data: { alertedAt: new Date() },
      });
      if (!claimed.count) continue;
      const sent = await sendOwnerAlert(
        `NorthList free AI is paused for every user on it. ${ALERTS[pause.reason] ?? ''} Their mails wait and are tried again every hour.`,
      );
      logEvent('free_ai_owner_alerted', { model: pause.model, reason: pause.reason, sent });
    }
  } catch {
    logWarn('free_ai_owner_alert_failed', {});
  }
}
