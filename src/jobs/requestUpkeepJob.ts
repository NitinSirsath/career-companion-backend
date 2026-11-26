import type { PgBoss } from 'pg-boss';
import { getQueue, type QUEUE_NAMES } from '../services/queue';
import { tidyAllRequests } from '../services/requestUpkeep';
import { matchAllWaitingMails } from '../services/waitingMails';
import { logDebug } from '../utils/log';

export const REQUEST_UPKEEP_QUEUE = 'request-upkeep-job' satisfies (typeof QUEUE_NAMES)[number];
/** Every hour: what a mail's own read did not settle is settled within the hour. */
export const REQUEST_UPKEEP_CRON = '40 * * * *';
const options = { retryLimit: 2, retryDelay: 300, expireInSeconds: 600 };
const workers = new WeakSet<PgBoss>();

/**
 * Keeps stored requests in step with today's rules (`requestUpkeep.ts`), every hour and once when
 * the server starts: the start is what brings mails saved before a rule up to date. Before that,
 * job mails that wait for an application are matched again (`waitingMails.ts`), so what they link
 * is tidied in the same run.
 */
export async function startRequestUpkeepWorker() {
  const boss = await getQueue();
  await boss.schedule(REQUEST_UPKEEP_QUEUE, REQUEST_UPKEEP_CRON, {}, options);
  if (!workers.has(boss)) {
    await boss.work(REQUEST_UPKEEP_QUEUE, { batchSize: 1 }, async () => {
      await matchAllWaitingMails();
      await tidyAllRequests();
    });
    workers.add(boss);
    await boss.send(REQUEST_UPKEEP_QUEUE, {}, { ...options, singletonKey: 'startup' });
  }
  logDebug('worker_registered', { queue: REQUEST_UPKEEP_QUEUE });
}
