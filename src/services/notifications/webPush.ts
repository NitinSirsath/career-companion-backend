/**
 * Push alerts (owner, 30 Oct 2026): one alert to one device through its browser's push service,
 * signed with the VAPID keys. The server posts to the address the browser gave, so only https
 * addresses on the known push services are ever called. Keys are never logged, and an address
 * only by its host.
 */
import type { PushDevice } from '@prisma/client';
import webpush from 'web-push';
import { prisma } from '../../db/prisma';
import { vapidKeys } from '../../utils/config';
import { logWarn } from '../../utils/log';

/** What an alert carries. The service worker shows `title` and `body` and opens `url` on a tap. */
export interface AlertMessage {
  title: string;
  body: string;
  url: string;
  /** One alert per tag on a device: a newer one with the same tag replaces it. */
  tag: string;
}

/**
 * sent: the push service took it. gone: the device is no longer there (404 or 410). retryable:
 * busy, down or unreachable. failed: refused for another reason.
 */
export type PushOutcome = 'sent' | 'gone' | 'retryable' | 'failed';

/** An alert older than a day is not worth showing any more. */
const ALERT_TTL_SECONDS = 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

/** Google (Chrome, Edge on Android), Mozilla (Firefox), Apple (Safari) and Microsoft (Edge). */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
];
const PUSH_HOST_ENDINGS = ['.push.apple.com', '.notify.windows.com'];

/** True for an https address on a known push service, with no port or credentials in it. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    !url.port &&
    !url.username &&
    !url.password &&
    (PUSH_HOSTS.includes(host) || PUSH_HOST_ENDINGS.some((ending) => host.endsWith(ending)))
  );
}

/** The push service's host, the only part of an address that is logged. */
export function pushHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return 'invalid';
  }
}

export const devicesOf = (userId: string) => prisma.pushDevice.findMany({ where: { userId } });

/**
 * Sends one alert to one device and keeps the device list right: a device that took it notes
 * the time; one the push service no longer knows is removed. Never throws.
 */
export async function sendToDevice(
  device: PushDevice,
  message: AlertMessage,
  topic?: string,
): Promise<PushOutcome> {
  const outcome = await sendAlert(device, message, topic);
  if (outcome === 'sent')
    await prisma.pushDevice.updateMany({
      where: { id: device.id },
      data: { lastUsedAt: new Date() },
    });
  if (outcome === 'gone') await prisma.pushDevice.deleteMany({ where: { id: device.id } });
  return outcome;
}

async function sendAlert(
  device: PushDevice,
  message: AlertMessage,
  topic?: string,
): Promise<PushOutcome> {
  const keys = vapidKeys();
  if (!keys || !isAllowedPushEndpoint(device.endpoint)) return 'failed';
  try {
    await webpush.sendNotification(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      JSON.stringify(message),
      {
        vapidDetails: keys,
        TTL: ALERT_TTL_SECONDS,
        urgency: 'high',
        timeout: SEND_TIMEOUT_MS,
        ...(topic ? { topic } : {}),
      },
    );
    return 'sent';
  } catch (error) {
    const status = statusOf(error);
    const outcome = outcomeOf(error, status);
    logWarn('push_alert_failed', { host: pushHost(device.endpoint), status, outcome });
    return outcome;
  }
}

/** The push service's HTTP answer, when there was one. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

function outcomeOf(error: unknown, status: number | undefined): PushOutcome {
  if (status === 404 || status === 410) return 'gone';
  if (status === 429 || (status !== undefined && status >= 500)) return 'retryable';
  if (status !== undefined) return 'failed';
  // No answer: the network failed or timed out (worth another try), or the device's keys could
  // not seal the message (they never will).
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  return typeof code === 'string' || /timeout/i.test(message) ? 'retryable' : 'failed';
}
