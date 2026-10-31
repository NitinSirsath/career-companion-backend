/**
 * Delivers one action's notification, on Discord (the owner only) and as a push alert on the
 * devices of the action's user: who may receive it, when it is skipped or suppressed, the claim
 * that prevents a double send, and the recorded outcome. Each channel has its own delivery row.
 */
import { NotificationProviderType, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { discordUserId, vapidKeys } from '../../utils/config';
import { logDebug, logError, logEvent, logWarn } from '../../utils/log';
import { suppressNotifications } from '../notificationSuppression';
import {
  NotificationPayload,
  NotificationProvider,
  NotificationResult,
} from './NotificationProvider';
import { AlertMessage, devicesOf, PushOutcome, sendToDevice } from './webPush';

const MAX_DELIVERY_ATTEMPTS = 4;
/** A push alert shows this much of the step's text at most. */
const ALERT_BODY_MAX = 180;

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
  if (!(await stillWanted(action, 'DISCORD'))) return;
  if (!(await claimAndRecheck(actionId, 'DISCORD'))) return;
  const result = await provider.send(payloadFor(action));
  await recordResult(actionId, 'DISCORD', result);
  reportResult(actionId, 'DISCORD', result);
}

/**
 * Sends the action's push alert to every device of its user that turned alerts on. Delivered
 * once any device took it, so no device ever gets it twice; throws only when no device took it
 * and a try was worth repeating, so the queue tries again.
 */
export async function deliverActionPushAlert(actionId: string) {
  const action = await loadAction(actionId);
  if (!action) {
    logWarn('notification_failed', { reason: 'action_not_found', actionId, provider: 'WEB_PUSH' });
    return;
  }
  if (!vapidKeys()) {
    logDebug('notification_skipped', { reason: 'alerts_not_set_up', actionId });
    return;
  }
  if (!(await stillWanted(action, 'WEB_PUSH'))) return;
  const devices = await devicesOf(action.application.userId);
  if (!devices.length) {
    logDebug('notification_skipped', { reason: 'no_devices', actionId });
    return;
  }
  if (!(await claimAndRecheck(actionId, 'WEB_PUSH'))) return;
  const message = stepAlert(action);
  // The topic lets a push service replace an alert for this action that is still waiting.
  const topic = action.id.replace(/-/g, '');
  const outcomes = await Promise.all(devices.map((device) => sendToDevice(device, message, topic)));
  const result = pushResult(outcomes);
  await recordResult(actionId, 'WEB_PUSH', result);
  reportResult(actionId, 'WEB_PUSH', result);
}

/**
 * Open, not archived or snoozed (those are suppressed for good), not sent on this channel yet,
 * and of a kind worth a notification.
 */
async function stillWanted(action: ActionWithApplication, provider: NotificationProviderType) {
  if (!isOpen(action)) return false;
  if (isHidden(action)) {
    await suppressNotifications(prisma, [action.id]);
    return false;
  }
  if (await alreadyDelivered(action.id, provider)) {
    logDebug('notification_skipped', { reason: 'already_delivered', actionId: action.id });
    return false;
  }
  // Only actions the user must act on or follow up are worth a notification.
  if (action.type !== 'ACTION_REQUIRED' && action.type !== 'FOLLOW_UP_REQUIRED') {
    logDebug('notification_skipped', {
      reason: 'ineligible_action_type',
      actionId: action.id,
      type: action.type,
    });
    return false;
  }
  return true;
}

/** Takes the claim, then checks again: the user may have archived, snoozed or completed it. */
async function claimAndRecheck(actionId: string, provider: NotificationProviderType) {
  if (!(await claimDelivery(actionId, provider))) {
    logDebug('notification_skipped', { reason: 'claimed_or_terminal', actionId });
    return false;
  }
  const current = await loadAction(actionId);
  if (!current || !isOpen(current) || isHidden(current)) {
    await markSuppressed(actionId, provider);
    return false;
  }
  return true;
}

async function alreadyDelivered(actionId: string, provider: NotificationProviderType) {
  const delivery = await prisma.notificationDelivery.findUnique({
    where: { actionId_provider: { actionId, provider } },
  });
  return delivery?.status === 'DELIVERED';
}

/**
 * Commits a claim before delivery. A crash after sending leaves it claimed; neither the webhook
 * nor a push service has an idempotency key, so a claimed delivery is never sent again
 * automatically.
 */
async function claimDelivery(actionId: string, provider: NotificationProviderType) {
  await prisma.notificationDelivery.createMany({
    data: [{ actionId, provider }],
    skipDuplicates: true,
  });
  const claimed = await prisma.notificationDelivery.updateMany({
    where: {
      actionId,
      provider,
      status: { in: ['PENDING', 'FAILED_RETRYABLE'] },
      claimedAt: null,
      attemptCount: { lt: MAX_DELIVERY_ATTEMPTS },
    },
    data: { claimedAt: new Date(), lastAttemptAt: new Date(), attemptCount: { increment: 1 } },
  });
  return claimed.count > 0;
}

async function markSuppressed(actionId: string, provider: NotificationProviderType) {
  await prisma.notificationDelivery.updateMany({
    where: { actionId, provider, status: { not: 'DELIVERED' } },
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

/**
 * The push alert for a step (owner, 30 Oct 2026): the company and the step, never mail text. A
 * step with no words of its own shows its kind ("Follow up required"), as the app does.
 */
function stepAlert(action: ActionWithApplication): AlertMessage {
  const kind = action.type.replace(/_/g, ' ').toLowerCase();
  const text = action.description || kind.charAt(0).toUpperCase() + kind.slice(1);
  return {
    title: action.application.companyName,
    body: text.length > ALERT_BODY_MAX ? `${text.slice(0, ALERT_BODY_MAX - 1)}…` : text,
    url: `/applications/${action.applicationId}`,
    tag: action.id,
  };
}

/** Delivered if any device took it; otherwise retried only when a failure may pass. */
function pushResult(outcomes: PushOutcome[]): NotificationResult {
  if (outcomes.includes('sent')) return { success: true, retryable: false };
  const count = (outcome: PushOutcome) => outcomes.filter((o) => o === outcome).length;
  const errorDetails = `No device took the alert (gone ${count('gone')}, busy or unreachable ${count('retryable')}, refused ${count('failed')}).`;
  return outcomes.includes('retryable')
    ? { success: false, retryable: true, errorCategory: 'PushServiceUnavailable', errorDetails }
    : { success: false, retryable: false, errorCategory: 'PushRefused', errorDetails };
}

function deliveryStatus(result: NotificationResult) {
  if (result.success) return 'DELIVERED';
  return result.retryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT';
}

/** A retryable failure releases the claim so the next attempt can take it. */
async function recordResult(
  actionId: string,
  provider: NotificationProviderType,
  result: NotificationResult,
) {
  await prisma.notificationDelivery.update({
    where: { actionId_provider: { actionId, provider } },
    data: {
      status: deliveryStatus(result),
      claimedAt: result.retryable ? null : undefined,
      errorDetails: result.errorDetails || null,
    },
  });
}

function reportResult(
  actionId: string,
  provider: NotificationProviderType,
  result: NotificationResult,
) {
  if (result.success) {
    logEvent('notification_delivered', { actionId, provider });
    return;
  }
  const fields = {
    actionId,
    provider,
    errorCategory: result.errorCategory,
    retryable: result.retryable,
  };
  // A permanent failure is not thrown, so the queue completes the job and does not retry it.
  if (!result.retryable) {
    logError('notification_error', fields);
    return;
  }
  logWarn('notification_error', fields);
  throw new Error(`Notification failed: ${result.errorCategory}. Will retry.`);
}
