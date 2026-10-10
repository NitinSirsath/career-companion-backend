import { JobWithMetadata } from 'pg-boss';
import { GMAIL_SYNC_JOB, GmailSyncJobData } from '../services/enqueue';
import { getQueue } from '../services/queue';
import { syncUser } from '../services/gmailSync';
import { GmailAuthError, SyncSupersededError } from '../services/gmailSyncErrors';
import { logDebug } from '../utils/log';

export async function handleGmailSyncJobs(jobs: JobWithMetadata<GmailSyncJobData>[]) {
  for (const job of jobs) {
    try {
      await syncUser(job.data.userId, job.data.claim, {
        trigger: job.data.trigger,
        jobId: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
        signal: job.signal,
      });
    } catch (error) {
      if (!(error instanceof GmailAuthError) && !(error instanceof SyncSupersededError))
        throw error;
    }
  }
}
export async function startGmailSyncWorker() {
  const queue = await getQueue();
  await queue.work(GMAIL_SYNC_JOB, { includeMetadata: true, batchSize: 1 }, handleGmailSyncJobs);
  logDebug('worker_registered', { queue: GMAIL_SYNC_JOB });
}
