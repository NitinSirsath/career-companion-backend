import { gmail_v1 } from 'googleapis';
import { withGmail } from './gmailClient';

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

export class GmailFetcherService {
  static async fetchMessageMetadata(
    userId: string,
    gmailMessageId: string,
  ): Promise<{ labelIds: string[] | null; snippet: string | null }> {
    return withGmail(userId, async (gmail) => {
      const { data } = await gmail.users.messages.get(
        { userId: 'me', id: gmailMessageId, format: 'metadata' },
        { timeout: 15_000 },
      );
      return { labelIds: data.labelIds ?? null, snippet: data.snippet ?? null };
    });
  }
  static async fetchMessageBody(userId: string, gmailMessageId: string): Promise<string> {
    return withGmail(userId, async (gmail) => {
      const { data } = await gmail.users.messages.get(
        { userId: 'me', id: gmailMessageId, format: 'full' },
        { timeout: 15_000 },
      );
      return extractBody(data).slice(0, 8000);
    });
  }
}
