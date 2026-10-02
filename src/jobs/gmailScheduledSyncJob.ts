import type { PgBoss } from 'pg-boss';
import { prisma } from '../db/prisma';
import { getQueue } from '../services/queue';
import {
  GMAIL_SCHEDULE_QUEUE,
  GMAIL_SYNC_CRON,
  gmailScheduleConfig,
  latestSlot,
  setGmailScheduleRegistered,
} from '../services/gmailSchedule';
import { SyncInProgressError } from '../services/gmailSyncErrors';
import { errorCategory } from '../utils/errorCategory';
import { requestGmailSync } from './gmailSyncJob';
type Source = 'schedule' | 'startup';
const options = { retryLimit: 2, retryDelay: 60, expireInSeconds: 120 };
export async function runScheduledGmailSync(source: Source, now = new Date()) {
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
        console.error(
          JSON.stringify({
            event: 'gmail_scheduled_sync_request_failed',
            userId: connection.userId,
            ...errorCategory(error),
          }),
        );
      }
    }
  }
  console.log(
    JSON.stringify({
      event: 'gmail_scheduled_sync_run',
      source,
      slot: slot.toISOString(),
      timezone,
      lateBySeconds: Math.floor((now.getTime() - slot.getTime()) / 1000),
      ...counts,
      durationMs: Date.now() - started,
    }),
  );
  if (counts.failed) throw new Error('Scheduled Gmail requests failed');
  return counts;
}
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
  console.log(JSON.stringify({ event: 'worker_registered', queue: GMAIL_SCHEDULE_QUEUE }));
}
