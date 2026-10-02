import { startGmailScheduledSync } from './gmailScheduledSyncJob';
import { GMAIL_SCHEDULE_QUEUE } from '../services/gmailSchedule';
import { startGmailSyncWorker } from './gmailSyncJob';
import { startEmailProcessingWorker } from './emailProcessingJob';
import { startNotificationWorker } from './notificationJob';
import { stopQueue, QUEUE_NAMES } from '../services/queue';
import { errorCategory } from '../utils/errorCategory';

export interface WorkerRegistration {
  queue: string;
  start: () => Promise<void>;
  failureEvent: string;
}
export function defaultWorkers(): WorkerRegistration[] {
  return [
    {
      queue: GMAIL_SCHEDULE_QUEUE,
      start: () => startGmailScheduledSync(),
      failureEvent: 'gmail_schedule_start_failed',
    },
    {
      queue: QUEUE_NAMES[2],
      start: startGmailSyncWorker,
      failureEvent: 'gmail_worker_start_failed',
    },
    {
      queue: QUEUE_NAMES[0],
      start: startEmailProcessingWorker,
      failureEvent: 'email_worker_start_failed',
    },
    {
      queue: QUEUE_NAMES[1],
      start: startNotificationWorker,
      failureEvent: 'notification_worker_start_failed',
    },
  ];
}
export async function startWorkers(
  workers = defaultWorkers(),
  options: {
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
    isShuttingDown?: () => boolean;
    onGiveUp?: () => void;
    stop?: () => Promise<void>;
  } = {},
): Promise<boolean> {
  const {
    maxAttempts = 8,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isShuttingDown = () => false,
    onGiveUp = () => process.exit(1),
    stop = stopQueue,
  } = options;
  let pending = workers;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isShuttingDown()) return false;
    const results = await Promise.allSettled(pending.map((worker) => worker.start()));
    if (isShuttingDown()) return false;
    const failed: WorkerRegistration[] = [];
    const retryInMs = attempt === maxAttempts ? null : Math.min(2000 * 2 ** (attempt - 1), 30_000);
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        const worker = pending[i];
        failed.push(worker);
        console.error(
          JSON.stringify({
            event: worker.failureEvent,
            queue: worker.queue,
            attempt,
            maxAttempts,
            retryInMs,
            ...errorCategory(result.reason),
          }),
        );
      }
    });
    if (!failed.length) {
      console.log(
        JSON.stringify({
          event: 'workers_ready',
          queues: workers.map((w) => w.queue),
          attempts: attempt,
        }),
      );
      return true;
    }
    pending = failed;
    if (retryInMs !== null) await sleep(retryInMs);
  }
  if (isShuttingDown()) return false;
  console.error(
    JSON.stringify({
      event: 'worker_start_gave_up',
      queues: pending.map((w) => w.queue),
      attempts: maxAttempts,
    }),
  );
  await stop().catch(() => undefined);
  if (!isShuttingDown()) onGiveUp();
  return false;
}
