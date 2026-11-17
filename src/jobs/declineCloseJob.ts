import type { PgBoss } from 'pg-boss';
import { getQueue, type QUEUE_NAMES } from '../services/queue';
import { closeDueDeclines } from '../services/applicationDecline';
import { logDebug, logEvent } from '../utils/log';

export const DECLINE_CLOSE_QUEUE = 'decline-close-job' satisfies (typeof QUEUE_NAMES)[number];
/** Every hour: an application closes within an hour of its three days. */
export const DECLINE_CLOSE_CRON = '20 * * * *';
const options = { retryLimit: 2, retryDelay: 300, expireInSeconds: 600 };
const workers = new WeakSet<PgBoss>();

/**
 * Closes the applications whose "Close the application?" waited three days with no answer
 * (`applicationDecline.ts`), every hour and once when the server starts.
 */
export async function startDeclineCloseWorker() {
  const boss = await getQueue();
  await boss.schedule(DECLINE_CLOSE_QUEUE, DECLINE_CLOSE_CRON, {}, options);
  if (!workers.has(boss)) {
    await boss.work(DECLINE_CLOSE_QUEUE, { batchSize: 1 }, async () => {
      const closed = await closeDueDeclines();
      if (closed) logEvent('decline_close_done', { closed });
    });
    workers.add(boss);
    await boss.send(DECLINE_CLOSE_QUEUE, {}, { ...options, singletonKey: 'startup' });
  }
  logDebug('worker_registered', { queue: DECLINE_CLOSE_QUEUE });
}
