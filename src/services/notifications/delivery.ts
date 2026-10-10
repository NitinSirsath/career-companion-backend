/**
 * Delivers one action's Discord notification: who may receive it, when it is skipped or
 * suppressed, the claim that prevents a double send, and the recorded outcome.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { discordUserId } from '../../utils/config';
import { logDebug, logError, logEvent, logWarn } from '../../utils/log';
import { suppressNotifications } from '../notificationSuppression';
import {
  NotificationPayload,
  NotificationProvider,
  NotificationResult,
} from './NotificationProvider';

const MAX_DELIVERY_ATTEMPTS = 4;

type ActionWithApplication = Prisma.ActionGetPayload<{ include: { application: true } }>;

const loadAction = (actionId: string) =>
  prisma.action.findUnique({ where: { id: actionId }, include: { application: true } });

const isOpen = (action: ActionWithApplication) => !action.retiredAt && action.status === 'PENDING';

const isHidden = (action: ActionWithApplication) =>
  !!action.application.archivedAt || (!!action.snoozedUntil && action.snoozedUntil > new Date());

/**
 * Sends the notification unless it is not ours to send, no longer wanted, or already sent.
 * Throws only for a retryable provider failure, so the queue tries again.
 */
export async function deliverActionNotification(actionId: string, provider: NotificationProvider) {
  const action = await loadAction(actionId);
  if (!action) {
    logWarn('notification_failed', { reason: 'action_not_found', actionId });
    return;
  }
  const owner = discordUserId();
  if (!owner || action.application.userId !== owner) {
    logWarn('notification_skipped', { reason: 'recipient_not_configured_for_owner', actionId });
    return;
  }
  if (!isOpen(action)) return;
  if (isHidden(action)) {
    await suppressNotifications(prisma, [actionId]);
    return;
  }
  if (await alreadyDelivered(actionId)) {
    logDebug('notification_skipped', { reason: 'already_delivered', actionId });
    return;
  }
  // Only actions the user must act on or follow up are worth a notification.
  if (action.type !== 'ACTION_REQUIRED' && action.type !== 'FOLLOW_UP_REQUIRED') {
    logDebug('notification_skipped', {
      reason: 'ineligible_action_type',
      actionId,
      type: action.type,
    });
    return;
  }
  if (!(await claimDelivery(actionId))) {
    logDebug('notification_skipped', { reason: 'claimed_or_terminal', actionId });
    return;
  }
  // The user may have archived, snoozed or completed the action while the claim was taken.
  const current = await loadAction(actionId);
  if (!current || !isOpen(current) || isHidden(current)) {
    await markSuppressed(actionId);
    return;
  }
  const result = await provider.send(payloadFor(action));
  await recordResult(actionId, result);
  reportResult(actionId, result);
}

async function alreadyDelivered(actionId: string) {
  const delivery = await prisma.notificationDelivery.findUnique({
    where: { actionId_provider: { actionId, provider: 'DISCORD' } },
  });
  return delivery?.status === 'DELIVERED';
}

/**
 * Commits a claim before delivery. A crash after sending leaves it claimed; webhook delivery
 * has no provider idempotency key, so a claimed delivery is never sent again automatically.
 */
async function claimDelivery(actionId: string) {
  await prisma.notificationDelivery.createMany({
    data: [{ actionId, provider: 'DISCORD' }],
    skipDuplicates: true,
  });
  const claimed = await prisma.notificationDelivery.updateMany({
    where: {
      actionId,
      provider: 'DISCORD',
      status: { in: ['PENDING', 'FAILED_RETRYABLE'] },
      claimedAt: null,
      attemptCount: { lt: MAX_DELIVERY_ATTEMPTS },
    },
    data: { claimedAt: new Date(), lastAttemptAt: new Date(), attemptCount: { increment: 1 } },
  });
  return claimed.count > 0;
}

async function markSuppressed(actionId: string) {
  await prisma.notificationDelivery.updateMany({
    where: { actionId, provider: 'DISCORD', status: { not: 'DELIVERED' } },
    data: { status: 'FAILED_PERMANENT', errorDetails: 'USER_SUPPRESSED' },
  });
}

function payloadFor(action: ActionWithApplication): NotificationPayload {
  return {
    actionId: action.id,
    companyName: action.application.companyName,
    jobTitle: action.application.jobTitle,
    actionRequested: action.description || action.type,
    actionType: action.type,
    deadline: action.deadline ? action.deadline.toISOString() : null,
    deadlinePrecision: action.deadlinePrecision,
  };
}

function deliveryStatus(result: NotificationResult) {
  if (result.success) return 'DELIVERED';
  return result.retryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT';
}

/** A retryable failure releases the claim so the next attempt can take it. */
async function recordResult(actionId: string, result: NotificationResult) {
  await prisma.notificationDelivery.update({
    where: { actionId_provider: { actionId, provider: 'DISCORD' } },
    data: {
      status: deliveryStatus(result),
      claimedAt: result.retryable ? null : undefined,
      errorDetails: result.errorDetails || null,
    },
  });
}

function reportResult(actionId: string, result: NotificationResult) {
  if (result.success) {
    logEvent('notification_delivered', { actionId });
    return;
  }
  const fields = { actionId, errorCategory: result.errorCategory, retryable: result.retryable };
  // A permanent failure is not thrown, so the queue completes the job and does not retry it.
  if (!result.retryable) {
    logError('notification_error', fields);
    return;
  }
  logWarn('notification_error', fields);
  throw new Error(`Notification failed: ${result.errorCategory}. Will retry.`);
}
