/**
 * A reply the user sends from the mail details page. It goes out through `withGmail`, the same
 * door as every Gmail read: the user's own Gmail in prod, the sandbox mailbox in dev mode.
 *
 * - The reply answers the newest mail from someone else and goes to that mail's sender. A reply
 *   to all also goes to the other people on that mail. The request carries no address, so the app
 *   cannot write to anyone who was not on the mail.
 * - A reply is sent once. Its own ID is written down before the send call; the same ID never
 *   sends a second mail, and nothing is ever sent again by the app itself.
 * - The text goes to Gmail and is not stored or logged. Only the IDs and the time are kept.
 */
import { Prisma } from '@prisma/client';
import type { SendMailReplyRequest, SendMailReplyResponse } from '../contracts';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { logError, logEvent, logWarn } from '../utils/log';
import { googleStatus, withGmail } from './gmailClient';
import { maySend } from './gmailConnection';
import { gmailCallOptions } from './googleTransport';
import { ReplyTarget, mailboxAddress, readGmail, replyTarget } from './mailbox';
import { usesSandbox } from './testAccounts';
import { noteSentForReading } from './replyReading';

const READ_BUDGET_MS = 20_000;
const SEND_BUDGET_MS = 30_000;
/** The answered mail is quoted below the reply; a very long one is cut. */
const QUOTE_LIMIT = 20_000;
const LINE = '\r\n';

const unconfirmed = () =>
  new AppError(
    502,
    'MAIL_REPLY_UNCONFIRMED',
    'Could not confirm that your reply was sent. Check the conversation before you send it again.',
  );

// ─── The mail itself ────────────────────────────────────────────────────────

/** A header value can never start a new header line. */
const oneLine = (value: string) => value.replace(/[\r\n\0]+/g, ' ').trim();

const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

/** Text outside ASCII in a header is written as UTF-8 "encoded words", cut between characters. */
function encodeHeaderText(text: string): string {
  const value = oneLine(text);
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 42) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`)
    .join(`${LINE} `);
}

/**
 * The address line as Gmail gave it when it is plain ASCII. A name outside ASCII is left out and
 * only the addresses are kept, which every mail server accepts.
 */
export function recipientHeader(to: string): string | null {
  const value = oneLine(to);
  if (isAscii(value)) return value;
  const addresses = value.match(/[^\s<>,;"]+@[^\s<>,;"]+/g)?.filter(isAscii) ?? [];
  return addresses.length ? addresses.join(', ') : null;
}

/**
 * The Cc line of a reply to all, one address on each line so no line grows too long. Null when
 * nobody else is on the mail.
 */
export function copyHeader(others: string[]): string | null {
  const addresses = others.flatMap((entry) => recipientHeader(entry) ?? []);
  return addresses.length ? addresses.join(`,${LINE} `) : null;
}

export const replySubject = (subject: string | null): string => {
  const value = oneLine(subject ?? '');
  return /^re:/i.test(value) ? value : `Re: ${value}`.trim();
};

/** The typed text with the answered mail quoted below it, as a mail program writes a reply. */
export function replyBody(text: string, answered: ReplyTarget): string {
  if (!answered.text?.trim()) return text;
  const quoted = answered.text
    .slice(0, QUOTE_LIMIT)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  const when = answered.sentAt ? `On ${answered.sentAt.toUTCString()}, ` : '';
  return `${text}\n\n${when}${oneLine(answered.from ?? answered.to)} wrote:\n${quoted}`;
}

/**
 * The reply as one plain-text mail (RFC 5322), the form Gmail's send call takes. `toAll` puts the
 * other people of the answered mail in Cc.
 */
export function buildReplyMail(text: string, answered: ReplyTarget, toAll = false): string | null {
  const to = recipientHeader(answered.to);
  if (!to) return null;
  const cc = toAll ? copyHeader(answered.cc) : null;
  const messageId = answered.messageId && oneLine(answered.messageId);
  const references = [answered.references && oneLine(answered.references), messageId]
    .filter(Boolean)
    .join(' ');
  const body = Buffer.from(replyBody(text, answered), 'utf8').toString('base64');
  return [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeaderText(replySubject(answered.subject))}`,
    ...(messageId ? [`In-Reply-To: ${messageId}`, `References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    ...(body.match(/.{1,76}/g) ?? []),
  ].join(LINE);
}

// ─── Sending once ───────────────────────────────────────────────────────────

const replyKey = (userId: string, id: string) => ({ userId_id: { userId, id } });

const sentAnswer = (reply: { gmailMessageId: string; threadId: string; sentAt: Date }) => ({
  id: reply.gmailMessageId,
  threadId: reply.threadId,
  sentAt: reply.sentAt.toISOString(),
});

/**
 * Writes the reply's ID down before anything is sent. Returns the answer of an earlier send with
 * the same ID, so a request that is repeated sends nothing; null when this is the first one.
 */
async function claimReply(
  userId: string,
  threadId: string,
  replyId: string,
): Promise<SendMailReplyResponse | null> {
  try {
    await prisma.mailReply.create({ data: { userId, id: replyId, threadId } });
    return null;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
  }
  const earlier = await prisma.mailReply.findUnique({ where: replyKey(userId, replyId) });
  if (earlier?.gmailMessageId && earlier.sentAt && earlier.threadId === threadId)
    return sentAnswer({
      ...earlier,
      gmailMessageId: earlier.gmailMessageId,
      sentAt: earlier.sentAt,
    });
  // An earlier send with this ID is running or ended without an answer: it may have gone out.
  throw unconfirmed();
}

/** Nothing was sent: the ID is free again, so the user can send the same reply after a fix. */
const releaseReply = (userId: string, replyId: string) =>
  prisma.mailReply.deleteMany({ where: { userId, id: replyId, gmailMessageId: null } });

/** Gmail said no before sending anything. Turns its answer into one the user can act on. */
async function refusal(userId: string, status: number, rateLimited: boolean): Promise<AppError> {
  if (status === 401)
    return new AppError(409, 'GMAIL_NOT_CONNECTED', 'Gmail access ended. Reconnect Gmail.');
  if (status === 429 || rateLimited)
    return new AppError(502, 'GMAIL_UNAVAILABLE', 'Gmail is busy. Nothing was sent. Try again.');
  if (status === 403) {
    // The saved grant does not cover sending after all (the user took it back at Google).
    await prisma.gmailConnection.updateMany({ where: { userId }, data: { canSend: false } });
    return sendNotAllowed();
  }
  if (status === 404)
    return new AppError(404, 'NOT_FOUND', 'This conversation is not in Gmail any more.');
  return new AppError(400, 'BAD_REQUEST', 'Gmail did not accept the reply. Nothing was sent.');
}

const sendNotAllowed = () =>
  new AppError(
    403,
    'GMAIL_SEND_NOT_ALLOWED',
    'NorthList may read your Gmail but not send from it. Allow sending to reply from here.',
  );

async function assertMaySend(userId: string): Promise<void> {
  const connection = await prisma.gmailConnection.findUnique({
    where: { userId },
    select: { status: true, canSend: true },
  });
  if (!connection || connection.status !== 'CONNECTED')
    throw new AppError(409, 'GMAIL_NOT_CONNECTED', 'Connect Gmail to reply from here.');
  if (!maySend(connection, await usesSandbox(userId))) throw sendNotAllowed();
}

/** Sends the mail. Any failure without a clear "no" from Gmail may still have sent it. */
async function sendThroughGmail(userId: string, threadId: string, raw: string): Promise<string> {
  const signal = AbortSignal.timeout(SEND_BUDGET_MS);
  try {
    const sent = await withGmail(
      userId,
      (gmail) =>
        gmail.users.messages.send(
          { userId: 'me', requestBody: { raw, threadId } },
          gmailCallOptions(signal),
        ),
      { signal },
    );
    if (!sent.data.id) throw unconfirmed();
    return sent.data.id;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const status = googleStatus(err);
    const rateLimited = (err as { reason?: string }).reason === 'rate_limit';
    if (status !== undefined && status >= 400 && status < 500)
      throw await refusal(userId, status, rateLimited);
    throw unconfirmed();
  }
}

/**
 * Notes the sent reply at once, so the conversation shows "Replied" without waiting for a sync.
 * The mail is out already: if the note cannot be written, the user is still told it was sent, and
 * the next sync notes the reply as it notes replies written in Gmail itself.
 */
async function recordSent(userId: string, replyId: string, threadId: string, messageId: string) {
  const sentAt = new Date();
  try {
    const held = await prisma.email.findFirst({
      where: { userId, threadId },
      select: { id: true },
    });
    const [, recorded] = await prisma.$transaction([
      prisma.mailReply.update({
        where: replyKey(userId, replyId),
        data: { gmailMessageId: messageId, sentAt },
      }),
      // Only in conversations the app holds, as the sync does.
      ...(held
        ? [
            prisma.outgoingEmail.upsert({
              where: { userId_gmailMessageId: { userId, gmailMessageId: messageId } },
              create: { userId, gmailMessageId: messageId, threadId, sentAt },
              update: {},
            }),
          ]
        : []),
    ]);
    // The AI reads it once when the conversation has an open ask (`replyReading.ts`).
    if (recorded) await noteSentForReading(userId, recorded.id);
  } catch (err) {
    logError('mail_reply_not_recorded', { userId }, err);
  }
  return sentAt;
}

export async function sendMailReply(
  userId: string,
  threadId: string,
  request: SendMailReplyRequest,
): Promise<SendMailReplyResponse> {
  await assertMaySend(userId);
  const earlier = await claimReply(userId, threadId, request.replyId);
  if (earlier) return earlier;

  let raw: string;
  try {
    const thread = await readGmail(userId, READ_BUDGET_MS, async (gmail, signal) => {
      const found = await gmail.users.threads.get(
        { userId: 'me', id: threadId, format: 'full' },
        gmailCallOptions(signal),
      );
      return found.data;
    });
    const answered = replyTarget(thread, await mailboxAddress(userId));
    const mail = answered && buildReplyMail(request.text, answered, request.toAll === true);
    if (!mail)
      throw new AppError(
        409,
        'MAIL_REPLY_NO_RECIPIENT',
        'There is no mail from someone else in this conversation to reply to.',
      );
    raw = Buffer.from(mail, 'utf8').toString('base64url');
  } catch (err) {
    // Nothing was sent yet, whatever went wrong.
    await releaseReply(userId, request.replyId);
    throw err;
  }

  let messageId: string;
  try {
    messageId = await sendThroughGmail(userId, threadId, raw);
  } catch (err) {
    const notSent = err instanceof AppError && err.code !== 'MAIL_REPLY_UNCONFIRMED';
    if (notSent) await releaseReply(userId, request.replyId);
    logWarn('mail_reply_not_sent', {
      userId,
      outcome: err instanceof AppError ? err.code : 'UNEXPECTED',
    });
    throw err;
  }

  const sentAt = await recordSent(userId, request.replyId, threadId, messageId);
  logEvent('mail_reply_sent', { userId });
  return { id: messageId, threadId, sentAt: sentAt.toISOString() };
}
