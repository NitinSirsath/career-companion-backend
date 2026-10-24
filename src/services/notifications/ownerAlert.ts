import { discordWebhookUrl } from '../../utils/config';
import { logWarn } from '../../utils/log';

const TIMEOUT_MS = 5000;

/**
 * Sends one plain message to the owner's Discord webhook. Best effort: returns false when no
 * webhook is set or Discord does not take it, and never throws.
 */
export async function sendOwnerAlert(text: string): Promise<boolean> {
  const webhookUrl = discordWebhookUrl();
  if (!webhookUrl) {
    logWarn('owner_alert_not_sent', { reason: 'no_webhook' });
    return false;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
      signal: controller.signal,
    });
    if (response.ok) return true;
    logWarn('owner_alert_not_sent', { reason: 'rejected', status: response.status });
    return false;
  } catch {
    logWarn('owner_alert_not_sent', { reason: 'no_answer' });
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
