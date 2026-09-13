import { NotificationProvider, NotificationPayload, NotificationResult } from './NotificationProvider';

export class DiscordProvider implements NotificationProvider {
  async send(payload: NotificationPayload): Promise<NotificationResult> {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      // Configuration missing is not a retryable error. It's a permanent misconfiguration.
      return { success: false, retryable: false, errorCategory: 'MissingConfig', errorDetails: 'DISCORD_WEBHOOK_URL not configured.' };
    }

    try {
      const embed = {
        title: `Action Required: ${payload.companyName}`,
        color: 0x3498db, // blue
        fields: [
          { name: 'Role', value: payload.jobTitle || 'N/A', inline: true },
          { name: 'Action', value: payload.actionRequested, inline: true },
        ],
      };

      if (payload.deadline) {
        embed.fields.push({
          name: 'Deadline',
          value: new Date(payload.deadline).toLocaleString(),
          inline: false,
        });
      }

      const message = {
        content: `**Job Search Update**`,
        embeds: [embed],
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 seconds timeout

      let response: Response;
      try {
        response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.ok || response.status === 204) {
        return { success: true, retryable: false };
      }

      // Handle specific HTTP errors
      const status = response.status;
      
      // Retryable errors: Rate limits (429), Server errors (5xx)
      const isRetryable = status === 429 || status >= 500;
      
      return { 
        success: false, 
        retryable: isRetryable, 
        errorCategory: `HTTP_${status}`, 
        errorDetails: `Discord responded with status ${status}.` // Don't log full response text to avoid leaking secrets/pii
      };
      
    } catch (error) {
      // Network errors (e.g. timeout, DNS failure) are generally retryable
      let errorCategory = 'NetworkError';
      if (error instanceof Error && error.name === 'AbortError') {
        errorCategory = 'TimeoutError';
      }

      return {
        success: false,
        retryable: true,
        errorCategory,
        // Sanitized stable string to prevent leaking sensitive info from raw error messages
        errorDetails: 'Request failed due to a network error or timeout.',
      };
    }
  }
}
