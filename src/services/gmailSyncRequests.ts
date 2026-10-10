/**
 * Asking for a Gmail sync: the Sync button and the twice-daily schedule. A request claims the
 * user's connection and queues one sync job; the sync itself runs in `gmailSync.ts`.
 */
import { randomUUID } from 'crypto';
import { prisma } from '../db/prisma';
import { errorCategory } from '../utils/errorCategory';
import { logError, logEvent } from '../utils/log';
import { enqueueGmailSync } from './enqueue';
import { assertSyncCanStart } from './gmailConnection';
import { gmailScheduleConfig, latestSlot } from './gmailSchedule';
import { syncLease } from './gmailSync';
import { SyncInProgressError, SyncQueueError } from './gmailSyncErrors';

type SyncTrigger = 'manual' | 'scheduled';

/** Claims the user's connection and queues a sync. Throws when a sync already holds the lease. */
export async function requestGmailSync(userId: string, trigger: SyncTrigger = 'manual') {
  const claim = `queued:${randomUUID()}`;
  const accepted = await prisma.gmailConnection.updateMany({
    where: {
      userId,
      status: 'CONNECTED',
      OR: [
        { syncStatus: { not: 'SYNCING' } },
        { syncLeaseUntil: { lt: new Date() } },
        { syncLeaseUntil: null },
      ],
    },
    data: { syncStatus: 'SYNCING', syncClaim: claim, syncLeaseUntil: syncLease(), syncError: null },
  });
  if (!accepted.count) throw new SyncInProgressError('A sync is already in progress');
  try {
    const id = await enqueueGmailSync({ userId, claim, trigger });
    if (!id) throw new Error('Sync job was not queued');
    return { accepted: true as const };
  } catch {
    await releaseClaim(userId, claim);
    logError('gmail_sync_failed', {
      category: 'QUEUE_UNAVAILABLE',
      trigger,
      userId,
      requestId: claim,
    });
    throw new SyncQueueError();
  }
}

/** Best effort: a claim that could not be released simply runs out with its lease. */
async function releaseClaim(userId: string, claim: string) {
  await prisma.gmailConnection
    .updateMany({
      where: { userId, syncClaim: claim },
      data: {
        syncStatus: 'FAILED',
        syncClaim: null,
        syncLeaseUntil: null,
        syncError: 'QUEUE_UNAVAILABLE',
      },
    })
    .catch(() => undefined);
}

/** The Sync button: checks that Gmail is connected and idle, then requests a sync. */
export async function startManualSync(userId: string) {
  await assertSyncCanStart(userId);
  return requestGmailSync(userId);
}

/**
 * One scheduled run: requests a sync for every connected user who has not synced since the
 * latest schedule slot. One user's failure does not stop the others; the run then throws so
 * the queue retries it.
 */
export async function runScheduledGmailSync(source: 'schedule' | 'startup', now = new Date()) {
  const started = Date.now();
  const { timezone } = gmailScheduleConfig();
  const slot = latestSlot(now, timezone);
  const connections = await prisma.gmailConnection.findMany({
    where: { status: 'CONNECTED' },
    select: { userId: true, lastSyncedAt: true },
  });
  const counts = {
    connected: connections.length,
    requested: 0,
    skippedRecent: 0,
    skippedBusy: 0,
    skippedRevoked: await prisma.gmailConnection.count({ where: { status: 'REVOKED' } }),
    failed: 0,
  };
  for (const connection of connections) {
    if (connection.lastSyncedAt && connection.lastSyncedAt >= slot) {
      counts.skippedRecent++;
      continue;
    }
    try {
      await requestGmailSync(connection.userId, 'scheduled');
      counts.requested++;
    } catch (error) {
      if (error instanceof SyncInProgressError) counts.skippedBusy++;
      else {
        counts.failed++;
        logError('gmail_scheduled_sync_request_failed', {
          userId: connection.userId,
          ...errorCategory(error),
        });
      }
    }
  }
  logEvent('gmail_scheduled_sync_run', {
    source,
    slot: slot.toISOString(),
    timezone,
    lateBySeconds: Math.floor((now.getTime() - slot.getTime()) / 1000),
    ...counts,
    durationMs: Date.now() - started,
  });
  if (counts.failed) throw new Error('Scheduled Gmail requests failed');
  return counts;
}
