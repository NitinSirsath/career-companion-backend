import { randomUUID } from 'crypto';
import { prisma } from '../db/prisma';
import { getQueue } from '../services/queue';
import {
  GmailSyncService,
  GmailAuthError,
  SyncInProgressError,
  syncLease,
} from '../services/gmailSync';

export async function requestGmailSync(userId: string) {
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
    const queue = await getQueue();
    const id = await queue.send(
      'gmail-sync-job',
      { userId, claim },
      {
        singletonKey: claim,
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        expireInSeconds: 300,
      },
    );
    if (!id) throw new Error('Sync job was not queued');
    return { accepted: true as const };
  } catch (err) {
    await prisma.gmailConnection.updateMany({
      where: { userId, syncClaim: claim },
      data: {
        syncStatus: 'FAILED',
        syncClaim: null,
        syncLeaseUntil: null,
        syncError: 'QUEUE_UNAVAILABLE',
      },
    });
    throw err;
  }
}

export async function startGmailSyncWorker() {
  const queue = await getQueue();
  await queue.work<{ userId: string; claim: string }>('gmail-sync-job', async (jobs) => {
    for (const job of jobs) {
      try {
        await GmailSyncService.syncUser(job.data.userId, job.data.claim);
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'gmail_sync_failed',
            jobId: job.id,
            category: err instanceof Error ? err.name : 'UnknownError',
          }),
        );
        if (!(err instanceof GmailAuthError) && !(err instanceof SyncInProgressError)) throw err;
      }
    }
  });
}
