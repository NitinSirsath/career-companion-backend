/**
 * Offers emails to AI processing. Gmail sync and AI settings both call this module, so neither
 * imports the other.
 */
import { prisma } from '../../db/prisma';
import { enqueueEmailProcessingJob, enqueueRelevanceTriage } from '../enqueue';
import { getAccessState } from './access';
import { triageBatchEnabled } from './triage';

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
 * re-offered by the next sync or after the user fixes access (no scheduler). Enqueueing is
 * idempotent per email (singleton key).
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
