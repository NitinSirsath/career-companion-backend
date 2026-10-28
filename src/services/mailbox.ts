/**
 * The user's Gmail read live for the Mails page: the inbox list, one thread with its text, and
 * attachments. Nothing read here is stored or logged; it goes straight to the signed-in user.
 */
import { gmail_v1 } from 'googleapis';
import { prisma } from '../db/prisma';
import {
  mailAddressOf,
  mailboxKey,
  splitMailAddresses,
  type ListMailboxThreadsResponse,
  type MailAttachment,
  type MailMessage,
  type MailThread,
  type MailboxThread,
} from '../contracts';
import { AppError } from '../errors';
import { googleStatus, withGmail } from './gmailClient';
import { gmailCallOptions } from './googleTransport';
import { htmlToText } from './mailHtml';

const PAGE_SIZE = 20;
/** Far above any written email; a longer text is cut and marked as cut. */
const BODY_LIMIT = 500_000;
/** Gmail's own limit for one message. */
const ATTACHMENT_LIMIT = 25 * 1024 * 1024;
const READ_BUDGET_MS = 20_000;
const ATTACHMENT_BUDGET_MS = 60_000;

const SYSTEM_LABELS: Record<string, string> = {
  INBOX: 'Inbox',
  SENT: 'Sent',
  IMPORTANT: 'Important',
  STARRED: 'Starred',
  UNREAD: 'Unread',
  SPAM: 'Spam',
  TRASH: 'Trash',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
};

async function gmailConnected(userId: string) {
  const connection = await prisma.gmailConnection.findUnique({
    where: { userId },
    select: { status: true },
  });
  return connection?.status === 'CONNECTED';
}

/** Runs one bounded read against Gmail and turns its failures into answers the user can act on. */
export async function readGmail<T>(
  userId: string,
  budgetMs: number,
  work: (gmail: gmail_v1.Gmail, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!(await gmailConnected(userId)))
    throw new AppError(409, 'GMAIL_NOT_CONNECTED', 'Connect Gmail to read your mail here.');
  const signal = AbortSignal.timeout(budgetMs);
  try {
    return await withGmail(userId, (gmail) => work(gmail, signal), { signal });
  } catch (error) {
    const status = googleStatus(error);
    if (status === 401)
      throw new AppError(409, 'GMAIL_NOT_CONNECTED', 'Gmail access ended. Reconnect Gmail.');
    if (status === 404) throw new AppError(404, 'NOT_FOUND', 'This mail is not in Gmail any more.');
    if (status === 400) throw new AppError(400, 'BAD_REQUEST', 'Gmail did not accept the request.');
    throw new AppError(502, 'GMAIL_UNAVAILABLE', 'Gmail could not be read right now. Try again.');
  }
}

export const header = (message: gmail_v1.Schema$Message, name: string) =>
  message.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? null;

function messageDate(message: gmail_v1.Schema$Message) {
  const date = message.internalDate ? new Date(Number(message.internalDate)) : null;
  return date && !isNaN(date.getTime()) ? date.toISOString() : null;
}

/** One page of the inbox, newest first, exactly as Gmail orders it. */
export async function listMailboxThreads(
  userId: string,
  pageToken?: string,
): Promise<ListMailboxThreadsResponse> {
  const page = await readGmail(userId, READ_BUDGET_MS, async (gmail, signal) => {
    const list = await gmail.users.threads.list(
      { userId: 'me', labelIds: ['INBOX'], maxResults: PAGE_SIZE, pageToken },
      gmailCallOptions(signal),
    );
    const threads = await Promise.all(
      (list.data.threads ?? []).flatMap((listed) =>
        listed.id ? [readThreadSummary(gmail, signal, listed.id, listed.snippet ?? '')] : [],
      ),
    );
    return { threads, nextPageToken: list.data.nextPageToken ?? null };
  });
  const tracked = await prisma.email.findMany({
    where: {
      userId,
      relevanceState: 'RELEVANT',
      threadId: { in: page.threads.map((thread) => thread.threadId) },
    },
    select: { threadId: true },
    distinct: ['threadId'],
  });
  const conversations = new Set(tracked.map((email) => email.threadId));
  return {
    items: page.threads.map((thread) => ({
      ...thread,
      conversationKey: conversations.has(thread.threadId) ? thread.threadId : null,
    })),
    nextPageToken: page.nextPageToken,
  };
}

async function readThreadSummary(
  gmail: gmail_v1.Gmail,
  signal: AbortSignal,
  threadId: string,
  snippet: string,
): Promise<Omit<MailboxThread, 'conversationKey'>> {
  const { data } = await gmail.users.threads.get(
    {
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    },
    gmailCallOptions(signal),
  );
  const messages = data.messages ?? [];
  const newest = messages[messages.length - 1];
  return {
    threadId,
    subject: messages[0] ? header(messages[0], 'subject') : null,
    from: newest ? header(newest, 'from') : null,
    date: newest ? messageDate(newest) : null,
    snippet,
    messageCount: messages.length,
    unread: messages.some((message) => message.labelIds?.includes('UNREAD')),
  };
}

/** The user's own mail address at Gmail. Null without a connection. */
export async function mailboxAddress(userId: string): Promise<string | null> {
  const connection = await prisma.gmailConnection.findUnique({
    where: { userId },
    select: { gmailEmail: true },
  });
  return connection?.gmailEmail ?? null;
}

/** One thread with every message's text, the user's own messages included. Drafts are left out. */
export async function readMailThread(userId: string, threadId: string): Promise<MailThread> {
  const own = await mailboxAddress(userId);
  const { thread, labels } = await readGmail(userId, READ_BUDGET_MS, async (gmail, signal) => {
    const [found, labelList] = await Promise.all([
      gmail.users.threads.get(
        { userId: 'me', id: threadId, format: 'full' },
        gmailCallOptions(signal),
      ),
      gmail.users.labels.list({ userId: 'me' }, gmailCallOptions(signal)),
    ]);
    return { thread: found.data, labels: labelList.data.labels ?? [] };
  });
  const names = labelNames(labels);
  const messages = (thread.messages ?? [])
    .filter((message) => !message.labelIds?.includes('DRAFT'))
    .map((message) => toMailMessage(message, names));
  const answered = replyTarget(thread, own);
  return {
    threadId,
    subject: messages[0]?.subject ?? null,
    messages,
    replyTo: answered?.to ?? null,
    replyCc: answered?.cc ?? [],
  };
}

/** The mail a reply from the app answers, and where that reply goes. */
export interface ReplyTarget {
  /** The answered mail's Reply-To when it has one, else its sender, as Gmail holds it. */
  to: string;
  /** Everyone else on the answered mail. A reply to all also goes to them. */
  cc: string[];
  subject: string | null;
  /** The answered mail's Message-ID and References headers, which keep the reply in the thread. */
  messageId: string | null;
  references: string | null;
  from: string | null;
  sentAt: Date | null;
  /**
   * The answered mail's text, quoted below the reply: its plain-text part, else the words of its
   * HTML part (most company mails come as HTML only).
   */
  text: string | null;
}

/**
 * Everyone else on the answered mail: its To and Cc addresses as written, each once, without the
 * user's own mailbox and without the address the reply goes to anyway.
 */
function otherRecipients(
  answered: gmail_v1.Schema$Message,
  to: string,
  own: string | null,
): string[] {
  const taken = new Set(splitMailAddresses(to).map(mailboxKey));
  if (own) taken.add(mailboxKey(own));
  const listed = [header(answered, 'to'), header(answered, 'cc')].flatMap((line) =>
    line ? splitMailAddresses(line) : [],
  );
  return listed.filter((entry) => {
    const mailbox = mailboxKey(entry);
    if (!mailAddressOf(entry).includes('@') || taken.has(mailbox)) return false;
    taken.add(mailbox);
    return true;
  });
}

/**
 * The newest mail of the thread that someone else wrote: a reply from the app answers that one.
 * Null when nobody else wrote, so the app never writes to an address the user did not hear from.
 * `own` is the user's own address, which is never among the other people of a reply to all.
 */
export function replyTarget(
  thread: gmail_v1.Schema$Thread,
  own: string | null,
): ReplyTarget | null {
  const answered = (thread.messages ?? [])
    .filter((message) => !message.labelIds?.some((label) => label === 'DRAFT' || label === 'SENT'))
    .pop();
  const to = answered && (header(answered, 'reply-to') || header(answered, 'from'));
  if (!answered || !to || !to.includes('@')) return null;
  const date = answered.internalDate ? new Date(Number(answered.internalDate)) : null;
  return {
    to,
    cc: otherRecipients(answered, to, own),
    subject: header(answered, 'subject'),
    messageId: header(answered, 'message-id'),
    references: header(answered, 'references'),
    from: header(answered, 'from'),
    sentAt: date && !isNaN(date.getTime()) ? date : null,
    text: quotableText(readParts(answered.payload)),
  };
}

/** A mail's text to quote: its plain-text part, else its HTML part's words, else nothing. */
function quotableText({ text, html }: Parts): string | null {
  if (text?.trim()) return text;
  return html ? htmlToText(html) || null : null;
}

/** Label ID to the name to show: the user's own labels, and the system labels worth showing. */
function labelNames(labels: gmail_v1.Schema$Label[]) {
  const names = new Map<string, string>(Object.entries(SYSTEM_LABELS));
  for (const label of labels)
    if (label.id && label.name && label.type === 'user') names.set(label.id, label.name);
  return names;
}

type Parts = { text: string | null; html: string | null; attachments: MailAttachment[] };

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');

const attachmentOf = (part: gmail_v1.Schema$MessagePart): MailAttachment[] =>
  part.filename && part.body?.attachmentId && part.partId
    ? [
        {
          partId: part.partId,
          filename: part.filename,
          mimeType: part.mimeType ?? 'application/octet-stream',
          size: part.body.size ?? 0,
        },
      ]
    : [];

/** The part's own text when it is plain text or HTML and not an attached file. */
const textOf = (part: gmail_v1.Schema$MessagePart, mimeType: string) =>
  !part.filename && part.mimeType === mimeType && part.body?.data ? decode(part.body.data) : null;

/** Walks a message's parts: the first plain text, the first HTML, and every attached file. */
function readParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  found: Parts = { text: null, html: null, attachments: [] },
): Parts {
  if (!part) return found;
  found.attachments.push(...attachmentOf(part));
  found.text ??= textOf(part, 'text/plain');
  found.html ??= textOf(part, 'text/html');
  for (const child of part.parts ?? []) readParts(child, found);
  return found;
}

function toMailMessage(message: gmail_v1.Schema$Message, names: Map<string, string>): MailMessage {
  const parts = readParts(message.payload);
  return {
    id: message.id ?? '',
    from: header(message, 'from'),
    to: header(message, 'to'),
    cc: header(message, 'cc'),
    date: messageDate(message),
    subject: header(message, 'subject'),
    labels: (message.labelIds ?? []).flatMap((id) => names.get(id) ?? []),
    sentByUser: !!message.labelIds?.includes('SENT'),
    text: parts.text?.slice(0, BODY_LIMIT) ?? null,
    html: parts.html?.slice(0, BODY_LIMIT) ?? null,
    truncated: (parts.text?.length ?? 0) > BODY_LIMIT || (parts.html?.length ?? 0) > BODY_LIMIT,
    attachments: parts.attachments,
  };
}

function findPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  partId: string,
): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  if (part.partId === partId) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, partId);
    if (found) return found;
  }
  return undefined;
}

/**
 * One attached file. The part is looked up in the message again, so the file name comes from
 * Gmail and never from the request.
 */
export async function readMailAttachment(
  userId: string,
  messageId: string,
  partId: string,
): Promise<{ filename: string; data: Buffer }> {
  const found = await readGmail(userId, ATTACHMENT_BUDGET_MS, async (gmail, signal) => {
    const message = await gmail.users.messages.get(
      { userId: 'me', id: messageId, format: 'full' },
      gmailCallOptions(signal),
    );
    const part = findPart(message.data.payload, partId);
    if (!part?.filename || !part.body?.attachmentId) return null;
    if ((part.body.size ?? 0) > ATTACHMENT_LIMIT) return { filename: part.filename, data: null };
    const attachment = await gmail.users.messages.attachments.get(
      { userId: 'me', messageId, id: part.body.attachmentId },
      { ...gmailCallOptions(signal), timeout: ATTACHMENT_BUDGET_MS },
    );
    return { filename: part.filename, data: attachment.data.data ?? null };
  });
  if (!found) throw new AppError(404, 'NOT_FOUND', 'Attachment not found.');
  if (!found.data)
    throw new AppError(
      413,
      'ATTACHMENT_TOO_LARGE',
      'This attachment is too large to download here. Open the email in Gmail.',
    );
  return { filename: found.filename, data: Buffer.from(found.data, 'base64url') };
}
