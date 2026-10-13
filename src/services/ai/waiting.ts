/**
 * "Read waiting mails now": the user asks for a new try instead of waiting for a pause to end.
 */
import type { ReadWaitingMailResponse } from '../../contracts/ai';
import { prisma } from '../../db/prisma';
import { getAccessState, isProviderPause } from './access';
import { reofferPendingEmails } from './offer';
import { readSettings } from './settings';
import { logEvent } from '../../utils/log';

/**
 * Ends a running pause and offers the user's waiting mail again, then returns the AI settings.
 *
 * Only the pause ends: the count of failed tries stays, so if the provider is still busy the next
 * pause is longer. Every try is a real call and counts toward the daily safety limit, which
 * bounds repeated clicks. Nothing is offered while access needs the user (key, billing, model),
 * the daily safety limit is reached, or Career Companion has paused AI.
 */
export async function readWaitingNow(userId: string): Promise<ReadWaitingMailResponse> {
  const paused = isProviderPause(await getAccessState(userId));
  if (paused)
    await prisma.aIConfiguration.updateMany({ where: { userId }, data: { cooldownUntil: null } });
  const offered = await reofferPendingEmails(userId);
  logEvent('ai_read_waiting_requested', { userId, endedPause: paused, offered });
  return readSettings(userId);
}
