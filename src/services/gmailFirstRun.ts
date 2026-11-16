/**
 * Right after Gmail is connected (owner, 15 Nov 2026): a user with no AI yet, who agreed on the
 * "Connect Gmail" button that NorthList's free AI reads their job mails, gets the free AI at once,
 * and the first sync starts without a button. Both are best effort: Gmail stays connected when
 * either fails, and the AI providers page and the hourly sync are still there.
 */
import { prisma } from '../db/prisma';
import { logEvent, logWarn } from '../utils/log';
import { saveProvider } from './ai/connections';
import { offeredProvider } from './ai/access';
import { FREE_AI_PROVIDER } from './ai/freeAI';
import { requestGmailSync } from './gmailSyncRequests';
import { SyncInProgressError } from './gmailSyncErrors';

/**
 * The free AI, for a user who has no provider at all (none active, none saved), when it can run
 * and `consent` is the free AI's current data-use version. Anything else changes nothing.
 */
async function turnOnFreeAI(userId: string, consent: string | null): Promise<void> {
  const provider = offeredProvider(FREE_AI_PROVIDER);
  if (!consent || !provider || consent !== provider.disclosure.version) return;
  try {
    const [active, saved] = await Promise.all([
      prisma.aIConfiguration.count({ where: { userId } }),
      prisma.aISavedProvider.count({ where: { userId } }),
    ]);
    if (active || saved) return;
    await saveProvider(userId, provider.id, { consentDisclosure: consent });
    logEvent('free_ai_on_at_gmail_connect', { userId });
  } catch {
    logWarn('free_ai_on_at_gmail_connect_failed', { userId });
  }
}

/** The first sync, at once. A sync already running is fine; a queue problem is logged there. */
async function startFirstSync(userId: string): Promise<void> {
  try {
    await requestGmailSync(userId);
  } catch (err) {
    if (!(err instanceof SyncInProgressError))
      logWarn('gmail_connect_sync_not_started', { userId });
  }
}

/**
 * After a Gmail connection is saved: the free AI first, so the mails of the first sync are read
 * by it, then the sync. `freeAIConsent` is the version the user agreed to, or null. Never throws.
 */
export async function afterGmailConnected(
  userId: string,
  freeAIConsent: string | null,
): Promise<void> {
  await turnOnFreeAI(userId, freeAIConsent);
  await startFirstSync(userId);
}
