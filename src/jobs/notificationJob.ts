import {
  NOTIFICATION_JOB,
  NotificationJobData,
  WEB_PUSH_NOTIFICATION_JOB,
} from '../services/enqueue';
import { getQueue } from '../services/queue';
import {
  deliverActionNotification,
  deliverActionPushAlert,
} from '../services/notifications/delivery';
import { DiscordProvider } from '../services/notifications/DiscordProvider';
import { logDebug } from '../utils/log';

export async function startNotificationWorker() {
  const queue = await getQueue();
  const discordProvider = new DiscordProvider();

  await queue.work(NOTIFICATION_JOB, async (jobs: { id: string; data: NotificationJobData }[]) => {
    await deliverActionNotification(jobs[0].data.actionId, discordProvider);
  });
  logDebug('worker_registered', { queue: NOTIFICATION_JOB });
}

/** Push alerts have their own queue, so a slow push service never holds up Discord. */
export async function startWebPushNotificationWorker() {
  const queue = await getQueue();
  await queue.work(
    WEB_PUSH_NOTIFICATION_JOB,
    async (jobs: { id: string; data: NotificationJobData }[]) => {
      await deliverActionPushAlert(jobs[0].data.actionId);
    },
  );
  logDebug('worker_registered', { queue: WEB_PUSH_NOTIFICATION_JOB });
}
