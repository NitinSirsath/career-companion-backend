import { getQueue } from '../services/queue';
import { prisma } from '../db/prisma';
import { DiscordProvider } from '../services/notifications/DiscordProvider';
import { NotificationPayload } from '../services/notifications/NotificationProvider';

export const NOTIFICATION_JOB = 'discord-notification-job';

export interface NotificationJobData {
  actionId: string;
}

export async function enqueueNotificationJob(actionId: string) {
  const queue = await getQueue();
  const jobId = `notify-discord-${actionId}`; // idempotency key
  
  await queue.send(NOTIFICATION_JOB, { actionId }, {
    singletonKey: jobId,
    singletonSeconds: 300,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
  });
}

export async function startNotificationWorker() {
  const queue = await getQueue();
  const discordProvider = new DiscordProvider();

  await queue.work(NOTIFICATION_JOB, async (jobs: { id: string, data: NotificationJobData }[]) => {
    const job = jobs[0];
    const { actionId } = job.data;

    // 1. Fetch action and check if we already delivered this successfully
    const action = await prisma.action.findUnique({
      where: { id: actionId },
      include: {
        application: true,
      }
    });

    if (!action) {
      console.warn(JSON.stringify({ event: 'notification_failed', reason: 'action_not_found', actionId }));
      return; // Nothing to do
    }

    if (!process.env.DISCORD_USER_ID || action.application.userId !== process.env.DISCORD_USER_ID) {
      console.warn(JSON.stringify({ event: 'notification_skipped', reason: 'recipient_not_configured_for_owner', actionId }));
      return;
    }
    if (action.status !== 'PENDING') return;

    // Check idempotency: Did we already deliver it?
    const existingDelivery = await prisma.notificationDelivery.findUnique({
      where: {
        actionId_provider: {
          actionId,
          provider: 'DISCORD'
        }
      }
    });

    if (existingDelivery && existingDelivery.status === 'DELIVERED') {
      console.log(JSON.stringify({ event: 'notification_skipped', reason: 'already_delivered', actionId }));
      return;
    }

    // Determine eligibility based on Action properties
    // Rules from prompt: Important interview-related action, Assessment requiring user action, Offer-related event, Important recruiter/interview follow-up, Action approaching or reaching its deadline.
    // For MVP: We will notify on ACTION_REQUIRED and FOLLOW_UP_REQUIRED
    const isEligible = action.type === 'ACTION_REQUIRED' || action.type === 'FOLLOW_UP_REQUIRED';
    
    if (!isEligible) {
       console.log(JSON.stringify({ event: 'notification_skipped', reason: 'ineligible_action_type', actionId, type: action.type }));
       return;
    }

    const payload: NotificationPayload = {
      actionId: action.id,
      companyName: action.application.companyName,
      jobTitle: action.application.jobTitle,
      actionRequested: action.description || action.type,
      actionType: action.type,
      deadline: action.deadline ? action.deadline.toISOString() : null,
    };

    // Commit a claim before delivery. A crash after sending leaves it claimed;
    // webhook delivery has no provider idempotency key, so do not auto-resend.
    await prisma.notificationDelivery.createMany({ data: [{ actionId, provider: 'DISCORD' }], skipDuplicates: true });
    const claimed = await prisma.notificationDelivery.updateMany({ where: {
      actionId, provider: 'DISCORD', status: { in: ['PENDING', 'FAILED_RETRYABLE'] }, claimedAt: null, attemptCount: { lt: 4 },
    }, data: { claimedAt: new Date(), lastAttemptAt: new Date(), attemptCount: { increment: 1 } } });
    if (!claimed.count) {
      console.log(JSON.stringify({ event: 'notification_skipped', reason: 'claimed_or_terminal', actionId }));
      return;
    }
    const result = await discordProvider.send(payload);
    await prisma.notificationDelivery.update({ where: { actionId_provider: { actionId, provider: 'DISCORD' } }, data: {
      status: result.success ? 'DELIVERED' : result.retryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT',
      claimedAt: result.retryable ? null : undefined,
      errorDetails: result.errorDetails || null,
    } });

    if (!result.success) {
      const logData = {
        event: 'notification_error',
        actionId,
        errorCategory: result.errorCategory,
        retryable: result.retryable
      };
      
      if (result.retryable) {
        console.warn(JSON.stringify(logData));
        throw new Error(`Notification failed: ${result.errorCategory}. Will retry.`);
      } else {
        console.error(JSON.stringify(logData));
        // Don't throw for permanent failures so pg-boss marks the job as completed/won't retry
      }
    } else {
       console.log(JSON.stringify({ event: 'notification_delivered', actionId }));
    }
  });
}
