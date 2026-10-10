import { NOTIFICATION_JOB, NotificationJobData } from '../services/enqueue';
import { getQueue } from '../services/queue';
import { deliverActionNotification } from '../services/notifications/delivery';
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
