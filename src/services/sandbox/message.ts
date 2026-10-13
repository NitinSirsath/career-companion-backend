/**
 * A sandbox message in the shape Gmail gives its messages, so the app reads sandbox mail with
 * the same code as real mail (`gmailSync.ts`, `gmailFetcher.ts`, `mailbox.ts`).
 */
import type { SandboxMessage } from '@prisma/client';
import { gmail_v1 } from 'googleapis';

/** Gmail's name for the "Primary" tab. Every received sandbox mail arrives there. */
export const RECEIVED_LABELS = ['INBOX', 'CATEGORY_PERSONAL'];
export const SENT_LABELS = ['SENT'];

/** Like Gmail's snippet: the start of the text on one line. */
export const snippetOf = (body: string): string => body.replace(/\s+/g, ' ').trim().slice(0, 200);

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The HTML part a mail program would send for this plain text. */
export const htmlOf = (body: string): string =>
  `<div dir="ltr">${escapeHtml(body).replace(/\r?\n/g, '<br>')}</div>`;

const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

function headersOf(message: SandboxMessage): gmail_v1.Schema$MessagePartHeader[] {
  return [
    { name: 'MIME-Version', value: '1.0' },
    { name: 'Date', value: message.internalDate.toUTCString() },
    { name: 'Message-ID', value: message.messageId },
    ...(message.inReplyTo ? [{ name: 'In-Reply-To', value: message.inReplyTo }] : []),
    ...(message.referenceIds ? [{ name: 'References', value: message.referenceIds }] : []),
    { name: 'Subject', value: message.subject },
    { name: 'From', value: message.sender },
    { name: 'To', value: message.recipient },
    ...(message.cc ? [{ name: 'Cc', value: message.cc }] : []),
    { name: 'Content-Type', value: `multipart/alternative; boundary="sandbox-${message.id}"` },
  ];
}

function textPart(partId: string, mimeType: string, text: string): gmail_v1.Schema$MessagePart {
  return {
    partId,
    mimeType,
    filename: '',
    headers: [{ name: 'Content-Type', value: `${mimeType}; charset="UTF-8"` }],
    body: { size: Buffer.byteLength(text, 'utf8'), data: encode(text) },
  };
}

/**
 * `full` carries the text as a plain part and an HTML part, as a mail from Gmail's own compose
 * window does. `metadata` carries only the headers asked for, or all of them.
 */
export function toGmailMessage(
  message: SandboxMessage,
  format: string = 'full',
  metadataHeaders?: string[],
): gmail_v1.Schema$Message {
  const wanted = metadataHeaders?.map((name) => name.toLowerCase());
  const headers = headersOf(message);
  const base = {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds,
    snippet: snippetOf(message.body),
    historyId: String(message.historyId),
    internalDate: String(message.internalDate.getTime()),
    sizeEstimate: Buffer.byteLength(message.body, 'utf8'),
  };
  if (format === 'minimal') return base;
  if (format === 'metadata')
    return {
      ...base,
      payload: {
        mimeType: 'multipart/alternative',
        headers: wanted
          ? headers.filter((header) => wanted.includes((header.name ?? '').toLowerCase()))
          : headers,
      },
    };
  return {
    ...base,
    payload: {
      partId: '',
      mimeType: 'multipart/alternative',
      filename: '',
      headers,
      body: { size: 0 },
      parts: [
        textPart('0', 'text/plain', message.body),
        textPart('1', 'text/html', htmlOf(message.body)),
      ],
    },
  };
}

/** What the sandbox keeps of a mail handed to Gmail's send call. */
export interface RawMail {
  to: string;
  cc?: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
  body: string;
}

/** "=?UTF-8?B?…?=" words in a header, as a mail program writes text outside ASCII. */
const decodeWords = (value: string) =>
  value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/gi, (_word, data: string) =>
      Buffer.from(data, 'base64').toString('utf8'),
    );

/**
 * Reads the mail the app hands to Gmail's send call (`raw`: a whole plain-text mail, base64url),
 * the way Gmail would. Null when it is not a mail the app writes: the caller refuses it.
 */
export function fromRawMail(raw: string): RawMail | null {
  const mail = Buffer.from(raw, 'base64url').toString('utf8');
  const split = mail.indexOf('\r\n\r\n');
  if (split < 0) return null;
  const headers = new Map<string, string>();
  // A header line that starts with a space continues the line before it.
  for (const line of mail
    .slice(0, split)
    .replace(/\r\n[ \t]+/g, ' ')
    .split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  const to = headers.get('to');
  if (!to || headers.get('content-transfer-encoding') !== 'base64') return null;
  const cc = headers.get('cc');
  return {
    to: decodeWords(to),
    ...(cc ? { cc: decodeWords(cc) } : {}),
    subject: decodeWords(headers.get('subject') ?? ''),
    inReplyTo: headers.get('in-reply-to'),
    references: headers.get('references'),
    body: Buffer.from(mail.slice(split + 4), 'base64').toString('utf8'),
  };
}
