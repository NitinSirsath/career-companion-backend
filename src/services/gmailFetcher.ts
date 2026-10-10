import { gmail_v1 } from 'googleapis';
import { gmailCallOptions } from './googleTransport';
import { withGmail } from './gmailClient';
import { isSimulatedId } from '../contracts/testTools';
import { readSimulatedEmail, simulatedSnippet } from './testTools/simulatedMail';

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

export async function fetchMessageMetadata(
  userId: string,
  gmailMessageId: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ labelIds: string[] | null; snippet: string | null }> {
  // Test-inbox emails (test environment only) are read from the database, never from Gmail.
  if (isSimulatedId(gmailMessageId)) {
    const content = await readSimulatedEmail(userId, gmailMessageId);
    return { labelIds: content.labels, snippet: simulatedSnippet(content.body) };
  }
  return withGmail(
    userId,
    async (gmail) => {
      const { data } = await gmail.users.messages.get(
        { userId: 'me', id: gmailMessageId, format: 'metadata' },
        gmailCallOptions(options.signal),
      );
      return { labelIds: data.labelIds ?? null, snippet: data.snippet ?? null };
    },
    options,
  );
}
export async function fetchMessageBody(
  userId: string,
  gmailMessageId: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (isSimulatedId(gmailMessageId))
    return (await readSimulatedEmail(userId, gmailMessageId)).body.slice(0, 8000);
  return withGmail(
    userId,
    async (gmail) => {
      const { data } = await gmail.users.messages.get(
        { userId: 'me', id: gmailMessageId, format: 'full' },
        gmailCallOptions(options.signal),
      );
      return extractBody(data).slice(0, 8000);
    },
    options,
  );
}
