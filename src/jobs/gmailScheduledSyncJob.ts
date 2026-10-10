import type { PgBoss } from 'pg-boss';
import { getQueue } from '../services/queue';
import {
  GMAIL_SCHEDULE_QUEUE,
  GMAIL_SYNC_CRON,
  setGmailScheduleRegistered,
} from '../services/gmailSchedule';
import { gmailScheduleConfig } from '../utils/config';
import { runScheduledGmailSync } from '../services/gmailSyncRequests';
import { logDebug } from '../utils/log';
type Source = 'schedule' | 'startup';
const options = { retryLimit: 2, retryDelay: 60, expireInSeconds: 120 };
// Retrying schedule/send registration must not add another local worker.
const workers = new WeakSet<PgBoss>();
const catchups = new WeakSet<PgBoss>();
export async function startGmailScheduledSync(config = gmailScheduleConfig()) {
  setGmailScheduleRegistered(false);
  const boss = await getQueue();
  if (!config.enabled) {
    await boss.unschedule(GMAIL_SCHEDULE_QUEUE);
    if (workers.has(boss)) {
      await boss.offWork(GMAIL_SCHEDULE_QUEUE, { wait: true });
      workers.delete(boss);
    }
    return;
  }
  await boss.schedule(
    GMAIL_SCHEDULE_QUEUE,
    GMAIL_SYNC_CRON,
    { source: 'schedule' },
    { ...options, tz: config.timezone, missed: 'once' },
  );
  if (!workers.has(boss)) {
    await boss.work<{ source: Source }>(GMAIL_SCHEDULE_QUEUE, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await runScheduledGmailSync(job.data.source);
    });
    workers.add(boss);
  }
  if (!catchups.has(boss)) {
    if (!(await boss.send(GMAIL_SCHEDULE_QUEUE, { source: 'startup' }, options)))
      throw new Error('Scheduled catch-up was not queued');
    catchups.add(boss);
  }
  setGmailScheduleRegistered(true);
  logDebug('worker_registered', { queue: GMAIL_SCHEDULE_QUEUE });
}
