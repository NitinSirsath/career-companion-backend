import { gmail_v1 } from './google';
import { gmailCallOptions } from './googleTransport';
import { withGmail } from './gmailClient';
import { header } from './mailbox';

function extractTextFromParts(parts: gmail_v1.Schema$MessagePart[]): string {
  let htmlText = '';

  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      const text = Buffer.from(part.body.data, 'base64').toString('utf8');
      if (text.trim()) return text;
    }
    if (part.mimeType === 'text/html' && part.body?.data) {
      const html = Buffer.from(part.body.data, 'base64').toString('utf8');
      // basic stripping of unsafe/unnecessary markup
      const stripped = html
        .replace(/<style[^>]*>.*?<\/style>/gis, '')
        .replace(/<script[^>]*>.*?<\/script>/gis, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (stripped && !htmlText) {
        htmlText = stripped;
      }
    }
    if (part.parts && part.parts.length > 0) {
      const childText = extractTextFromParts(part.parts);
      if (childText) return childText;
    }
  }

  return htmlText;
}

function extractBody(message: gmail_v1.Schema$Message): string {
  if (message.payload?.parts) {
    return extractTextFromParts(message.payload.parts);
  } else if (message.payload?.body?.data) {
    const raw = Buffer.from(message.payload.body.data, 'base64').toString('utf8');
    if (message.payload.mimeType === 'text/html') {
      return raw
        .replace(/<style[^>]*>.*?<\/style>/gis, '')
        .replace(/<script[^>]*>.*?<\/script>/gis, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    return raw;
  }
  return '';
}

/**
 * True for a mail sent as a mailing: it carries a `List-Unsubscribe` header, which a mail one
 * person writes to another never has.
 */
const isMailing = (message: gmail_v1.Schema$Message) =>
  !!header(message, 'list-unsubscribe')?.trim();

/** What the sorting step reads of a mail. `bulk` is set only for a mail sent as a mailing. */
export async function fetchMessageMetadata(
  userId: string,
  gmailMessageId: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ labelIds: string[] | null; snippet: string | null; bulk?: true }> {
  return withGmail(
    userId,
    async (gmail) => {
      const { data } = await gmail.users.messages.get(
        { userId: 'me', id: gmailMessageId, format: 'metadata' },
        gmailCallOptions(options.signal),
      );
      return {
        labelIds: data.labelIds ?? null,
        snippet: data.snippet ?? null,
        ...(isMailing(data) ? { bulk: true as const } : {}),
      };
    },
    options,
  );
}
/**
 * The most of a body kept in memory for one read. The AI reads far less (`EXTRACTION_BODY_LIMIT`);
 * the rest only tells whether the mail was cut and lets quoted mail go last (owner, 17 Nov 2026).
 */
export const BODY_READ_LIMIT = 200_000;

export async function fetchMessageBody(
  userId: string,
  gmailMessageId: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  return withGmail(
    userId,
    async (gmail) => {
      const { data } = await gmail.users.messages.get(
        { userId: 'me', id: gmailMessageId, format: 'full' },
        gmailCallOptions(options.signal),
      );
      return extractBody(data).slice(0, BODY_READ_LIMIT);
    },
    options,
  );
}
