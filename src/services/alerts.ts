/**
 * Push alerts per device (owner, 30 Oct 2026): a user turns alerts on for each phone or computer
 * by itself. Turning on sends one alert at once, so the user sees that it works.
 */
import type {
  AlertKeyResponse,
  TurnOffAlertsRequest,
  TurnOffAlertsResponse,
  TurnOnAlertsRequest,
  TurnOnAlertsResponse,
} from '../contracts/alerts';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { vapidKeys } from '../utils/config';
import { logEvent } from '../utils/log';
import {
  AlertMessage,
  isAllowedPushEndpoint,
  pushHost,
  sendToDevice,
} from './notifications/webPush';

/** The alert a device gets right after alerts are turned on for it. */
export const FIRST_ALERT: AlertMessage = {
  title: 'Alerts are on',
  body: "You'll get an alert here when something needs you.",
  url: '/account',
  tag: 'alerts-on',
};

/** The public key a browser needs to turn alerts on; not available without the server's keys. */
export function alertKey(): AlertKeyResponse {
  const keys = vapidKeys();
  return keys
    ? { available: true, publicKey: keys.publicKey }
    : { available: false, publicKey: null };
}

/**
 * Saves this device for the user (a device another user had moves to this one) and sends it the
 * first alert. A device its push service already says is gone is removed again and refused.
 */
export async function turnOnAlerts(
  userId: string,
  request: TurnOnAlertsRequest,
): Promise<TurnOnAlertsResponse> {
  if (!vapidKeys())
    throw new AppError(409, 'ALERTS_NOT_AVAILABLE', 'Alerts are not set up on this server.');
  if (!isAllowedPushEndpoint(request.endpoint))
    throw new AppError(
      400,
      'ALERT_ENDPOINT_NOT_ALLOWED',
      'Alerts cannot be turned on in this browser.',
    );
  const keys = { p256dh: request.keys.p256dh, auth: request.keys.auth };
  const device = await prisma.pushDevice.upsert({
    where: { endpoint: request.endpoint },
    create: { userId, endpoint: request.endpoint, ...keys },
    update: { userId, ...keys },
  });
  const outcome = await sendToDevice(device, FIRST_ALERT);
  if (outcome === 'gone')
    throw new AppError(409, 'ALERT_DEVICE_GONE', 'This device did not accept alerts. Try again.');
  const firstAlertSent = outcome === 'sent';
  logEvent('alerts_turned_on', { userId, host: pushHost(device.endpoint), firstAlertSent });
  return { on: true, firstAlertSent };
}

/** Removes this device for the user. A device that is not theirs, or not saved, is left alone. */
export async function turnOffAlerts(
  userId: string,
  request: TurnOffAlertsRequest,
): Promise<TurnOffAlertsResponse> {
  const { count } = await prisma.pushDevice.deleteMany({
    where: { userId, endpoint: request.endpoint },
  });
  if (count) logEvent('alerts_turned_off', { userId, host: pushHost(request.endpoint) });
  return { on: false };
}
