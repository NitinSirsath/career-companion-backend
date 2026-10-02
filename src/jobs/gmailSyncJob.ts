import { JobWithMetadata } from 'pg-boss';
import { SyncQueueError, SyncSupersededError } from '../services/gmailSyncErrors';
import { randomUUID } from 'crypto';
import { prisma } from '../db/prisma';
import { getQueue } from '../services/queue';
import {
  GmailSyncService,
  GmailAuthError,
  SyncInProgressError,
  syncLease,
} from '../services/gmailSync';

export async function requestGmailSync(userId: string, trigger: 'manual' | 'scheduled' = 'manual') {
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
      { userId, claim, trigger },
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
  } catch {
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
    console.error(
      JSON.stringify({
        event: 'gmail_sync_failed',
        category: 'QUEUE_UNAVAILABLE',
        trigger,
        userId,
        requestId: claim,
      }),
    );
    throw new SyncQueueError();
  }
}

export interface GmailSyncJobData {
  userId: string;
  claim: string;
  trigger?: 'manual' | 'scheduled';
}
export async function handleGmailSyncJobs(jobs: JobWithMetadata<GmailSyncJobData>[]) {
  for (const job of jobs) {
    try {
      await GmailSyncService.syncUser(job.data.userId, job.data.claim, {
        trigger: job.data.trigger,
        jobId: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
    } catch (error) {
      if (!(error instanceof GmailAuthError) && !(error instanceof SyncSupersededError))
        throw error;
    }
  }
}
export async function startGmailSyncWorker() {
  const queue = await getQueue();
  await queue.work('gmail-sync-job', { includeMetadata: true, batchSize: 1 }, handleGmailSyncJobs);
  console.log(JSON.stringify({ event: 'worker_registered', queue: 'gmail-sync-job' }));
}
