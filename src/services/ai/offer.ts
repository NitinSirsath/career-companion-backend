/**
 * Offers emails to AI processing. Gmail sync and AI settings both call this module, so neither
 * imports the other.
 */
import { prisma } from '../../db/prisma';
import { enqueueEmailProcessingJob, enqueueRelevanceTriage } from '../enqueue';
import { getAccessState, isProviderPause } from './access';
import { triageBatchEnabled } from './triage';
import { resumeAfterPause } from './usage';
import { logEvent } from '../../utils/log';

export const REOFFER_LIMIT = 100;

/** Queues a newly synced email: the user's batched relevance check when batching is on, else its own job. */
export async function enqueueForProcessing(userId: string, emailId: string): Promise<void> {
  if (triageBatchEnabled()) await enqueueRelevanceTriage(userId);
  else await enqueueEmailProcessingJob(userId, emailId);
}

/**
 * Re-offers up to 100 of the user's PENDING emails to the worker, newest first, so fresh mail is
 * not stuck behind a backlog. Covers the DB-insert / queue-send gap and emails that waited for AI
 * access. Does nothing while the user's AI access is not ready: those emails wait and are
 * re-offered when a pause ends (`resumeWaitingEmails`), by the next sync, or after the user fixes
 * access. Enqueueing is idempotent per email (singleton key).
 */
export async function reofferPendingEmails(
  userId: string,
  guard?: () => Promise<void>,
): Promise<number> {
  if ((await getAccessState(userId)).state !== 'READY') return 0;
  const pending = await prisma.email.findMany({
    where: { userId, processingState: 'PENDING' },
    orderBy: [{ receivedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: REOFFER_LIMIT,
    select: {
      id: true,
      aiProcessingResult: { select: { id: true } },
      aiOperations: { where: { operation: 'classification' }, select: { id: true } },
    },
  });
  let triageQueued = false;
  for (const email of pending) {
    await guard?.();
    // With batching on, an email with no result and no classification row goes to the batched
    // check; every other email continues on the per-email job, which reuses or resumes its row.
    if (triageBatchEnabled() && !email.aiProcessingResult && !email.aiOperations.length) {
      if (!triageQueued) {
        await enqueueRelevanceTriage(userId);
        triageQueued = true;
      }
      continue;
    }
    await enqueueEmailProcessingJob(userId, email.id);
  }
  return pending.length;
}

/**
 * Runs when a pause ends (the job queued when the pause started). If a newer pause is running,
 * the read waits for that one. Otherwise the waiting mail is offered again; if the provider is
 * still busy, the first call starts the next, longer pause and queues the next try. Problems that
 * need the user (key, billing, model) and the daily safety limit get no automatic try.
 */
export async function resumeWaitingEmails(userId: string): Promise<void> {
  const access = await getAccessState(userId);
  if (isProviderPause(access)) {
    await resumeAfterPause(userId, access.resumesAt);
    return;
  }
  const offered = await reofferPendingEmails(userId);
  logEvent('ai_resumed_after_pause', { userId, offered, access: access.state });
}
