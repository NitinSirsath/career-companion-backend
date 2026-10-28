import type { PgBoss } from 'pg-boss';
import { getQueue, type QUEUE_NAMES } from '../services/queue';
import { cleanUpOldMail } from '../services/mailRetention';
import { logDebug, logEvent } from '../utils/log';

export const MAIL_CLEANUP_QUEUE = 'mail-cleanup-job' satisfies (typeof QUEUE_NAMES)[number];
/** Once a day, at night (UTC). */
export const MAIL_CLEANUP_CRON = '30 3 * * *';
const options = { retryLimit: 2, retryDelay: 300, expireInSeconds: 600 };
const workers = new WeakSet<PgBoss>();

/** Deletes old non-job mails every day (`mailRetention.ts`), and once when the server starts. */
export async function startMailCleanupWorker() {
  const boss = await getQueue();
  await boss.schedule(MAIL_CLEANUP_QUEUE, MAIL_CLEANUP_CRON, {}, options);
  if (!workers.has(boss)) {
    await boss.work(MAIL_CLEANUP_QUEUE, { batchSize: 1 }, async () => {
      const removed = await cleanUpOldMail();
      logEvent('mail_cleanup_done', removed);
    });
    workers.add(boss);
    await boss.send(MAIL_CLEANUP_QUEUE, {}, { ...options, singletonKey: 'startup' });
  }
  logDebug('worker_registered', { queue: MAIL_CLEANUP_QUEUE });
}
