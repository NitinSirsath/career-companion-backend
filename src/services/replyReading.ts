/**
 * The AI reads the user's own replies (owner, 17 and 24 Oct 2026). A sent message is read once,
 * and only when its conversation had an open ask when it was sent: the AI gets those asks and the
 * user's new text, without the quoted earlier mail, and says which asks the reply settles. Those
 * close as YOUR_REPLY. The text is read from Gmail for the call and dropped: never stored, never
 * logged. When the AI cannot read it, the conversation keeps today's "Replied" from the send time.
 */
import { prisma } from '../db/prisma';
import { logEvent, logWarn } from '../utils/log';
import { AIAccessError } from './ai/errors';
import { REPLY_READ_CONTRACT, REPLY_TEXT_LIMIT } from './ai/replyRead';
import { runUserCall } from './ai/userCall';
import { enqueueReplyReading } from './enqueue';
import { fetchMessageBody } from './gmailFetcher';
import { closeNamedAsks, openAsksBefore } from './threadAsks';

/** Tries before a reply is left unread: the same cap as a mail's AI step. */
export const REPLY_READ_TRIES = 3;
/** When a failed read with no known end of a pause is tried again. */
const RETRY_AFTER_MS = 60_000;

/** The first line of the quoted earlier mail, as Gmail and other mail apps write it. */
const QUOTE_START = [
  /^On .+ wrote:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^From: .+/,
  /^_{5,}\s*$/,
];

/** The conversation a sent message belongs to. */
const conversationOf = (sent: { userId: string; threadId: string }) => ({
  userId: sent.userId,
  threadId: sent.threadId,
});

/** The user's own new text: everything above the quoted earlier mail, without quoted lines. */
export function ownText(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const end = lines.findIndex((line) => QUOTE_START.some((start) => start.test(line.trim())));
  return (end === -1 ? lines : lines.slice(0, end))
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()
    .slice(0, REPLY_TEXT_LIMIT);
}

/**
 * A sent message was just recorded: when its conversation has an open ask from before it, mark
 * it WAITING and queue its read. Best effort: the reply is noted either way.
 */
export async function noteSentForReading(userId: string, outgoingEmailId: string) {
  try {
    const sent = await prisma.outgoingEmail.findFirst({
      where: { id: outgoingEmailId, userId, replyReadState: null },
    });
    if (!sent) return;
    const open = await openAsksBefore(prisma, conversationOf(sent), sent.sentAt);
    if (!open.length) return;
    await prisma.outgoingEmail.update({
      where: { id: sent.id },
      data: { replyReadState: 'WAITING' },
    });
    await enqueueReplyReading(userId, sent.id);
  } catch (err) {
    logWarn('reply_read_not_queued', {
      userId,
      reason: err instanceof Error ? err.name : 'UNKNOWN',
    });
  }
}

/**
 * Reads one waiting reply. Returns when to try again (a pause, the daily limit, or no answer), or
 * null when it is done: read, nothing left open, or left unread for good.
 */
export async function readSentReply(userId: string, outgoingEmailId: string): Promise<Date | null> {
  const sent = await prisma.outgoingEmail.findFirst({
    where: { id: outgoingEmailId, userId, replyReadState: 'WAITING' },
  });
  if (!sent) return null;
  const open = await openAsksBefore(prisma, conversationOf(sent), sent.sentAt);
  if (!open.length) {
    // Something else closed them meanwhile: nothing left to read for.
    await prisma.outgoingEmail.update({ where: { id: sent.id }, data: { replyReadState: null } });
    return null;
  }
  try {
    const reply = ownText(await fetchMessageBody(userId, sent.gmailMessageId));
    const answered = reply
      ? (
          await runUserCall({
            userId,
            purpose: 'reply-read',
            contract: REPLY_READ_CONTRACT,
            call: (ai) =>
              ai.replies.read({
                openAsks: open.map(({ id, ask, kind, askedAt }) => ({ id, ask, kind, askedAt })),
                reply,
              }),
          })
        ).data.answeredAsks
      : [];
    const closed = await closeNamedAsks(
      userId,
      { ...conversationOf(sent), before: sent.sentAt },
      answered.map((id) => ({ id, reason: 'YOUR_REPLY' as const })),
      sent.gmailMessageId,
    );
    await prisma.outgoingEmail.update({
      where: { id: sent.id },
      data: { replyReadState: 'READ', replyReadAt: new Date() },
    });
    logEvent('reply_read', { userId, closed });
    return null;
  } catch (err) {
    return tryLater(sent.id, sent.replyReadTries, err);
  }
}

/** A failed read: try again later, or leave the reply unread ("Replied", as before). */
async function tryLater(id: string, tries: number, err: unknown): Promise<Date | null> {
  const used = tries + 1;
  // The user must act first (not set up, a key or billing problem): no try would work now.
  const waitsForUser = err instanceof AIAccessError && !err.resumesAt;
  if (waitsForUser || used >= REPLY_READ_TRIES) {
    await prisma.outgoingEmail.update({
      where: { id },
      data: { replyReadState: 'NOT_READ', replyReadTries: used },
    });
    logWarn('reply_not_read', { reason: errorReason(err), tries: used });
    return null;
  }
  await prisma.outgoingEmail.update({ where: { id }, data: { replyReadTries: used } });
  const resumesAt = err instanceof AIAccessError ? err.resumesAt : null;
  return resumesAt ?? new Date(Date.now() + RETRY_AFTER_MS);
}

function errorReason(err: unknown): string {
  if (err instanceof AIAccessError) return err.reason;
  return err instanceof Error ? err.name : 'UNKNOWN';
}
