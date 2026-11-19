/**
 * The AI reads the user's own replies (owner, 17 and 24 Oct 2026). A sent message is read once,
 * and only when its conversation had an open ask when it was sent: the AI gets those asks and the
 * user's new text, without the quoted earlier mail, and says what the reply does with each ask.
 * reply-read/v2 (owner, 17 Nov 2026): an answered ask closes as YOUR_REPLY, a declined one as
 * YOU_DECLINED; a question back keeps the reply "Replied" until their next mail; a reply that says
 * the user no longer wants the job asks to close the application. The text is read from Gmail for
 * the call and dropped: never stored, never logged. When the AI cannot read it, the conversation
 * keeps today's "Replied" from the send time.
 */
import type { RequestClosedReason } from '@prisma/client';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { logEvent, logWarn } from '../utils/log';
import { AIAccessError } from './ai/errors';
import {
  REPLY_READ_V2_CONTRACT,
  REPLY_TEXT_LIMIT,
  replyOutcomes,
  replyReadContractFor,
  type ReplyOutcome,
  type ReplyReadV2,
} from './ai/replyRead';
import { runUserCall } from './ai/userCall';
import { noteDecline } from './applicationDecline';
import { enqueueReplyReading } from './enqueue';
import { fetchMessageBody } from './gmailFetcher';
import { splitQuoted } from './mailText';
import { closeNamedAsks, openAsksBefore } from './threadAsks';

/** Tries before a reply is left unread: the same cap as a mail's AI step. */
export const REPLY_READ_TRIES = 3;
/** When a failed read with no known end of a pause is tried again. */
const RETRY_AFTER_MS = 60_000;

/** How an ask the reply settled closes. */
const CLOSES_AS: Partial<Record<ReplyOutcome, RequestClosedReason>> = {
  ANSWERED: 'YOUR_REPLY',
  DECLINED: 'YOU_DECLINED',
};

/** The conversation a sent message belongs to. */
const conversationOf = (sent: { userId: string; threadId: string }) => ({
  userId: sent.userId,
  threadId: sent.threadId,
});

/** The user's own new text: everything above the quoted earlier mail, without quoted lines. */
export const ownText = (body: string) => splitQuoted(body).own.slice(0, REPLY_TEXT_LIMIT);

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
    // The version is fixed now; only "Read my reply again" moves a reply to a newer one.
    await prisma.outgoingEmail.update({
      where: { id: sent.id },
      data: { replyReadState: 'WAITING', replyReadVersion: REPLY_READ_V2_CONTRACT.version },
    });
    await enqueueReplyReading(userId, sent.id);
  } catch (err) {
    logWarn('reply_read_not_queued', {
      userId,
      reason: err instanceof Error ? err.name : 'UNKNOWN',
    });
  }
}

/** Reply states the user may ask to read again: read with older rules, or not read at all. */
const READ_AGAIN_STATES = new Set(['READ', 'NOT_READ']);

/**
 * "Read my reply again" (owner, 19 Nov 2026): the newest reply in a conversation, read before
 * reply-read/v2 or left unread, gets one more read with today's rules. Only while an ask from
 * before it is still open; the read itself is the same job as for a new reply.
 */
export async function readReplyAgain(userId: string, key: string) {
  const sent = await prisma.outgoingEmail.findFirst({
    where: { userId, threadId: key },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
  });
  const open =
    sent && READ_AGAIN_STATES.has(sent.replyReadState ?? '')
      ? await openAsksBefore(prisma, conversationOf(sent), sent.sentAt)
      : [];
  if (!sent || !open.length)
    throw new AppError(409, 'NOTHING_TO_READ', 'There is no reply to read again here.');
  await prisma.outgoingEmail.update({
    where: { id: sent.id },
    data: {
      replyReadState: 'WAITING',
      replyReadVersion: REPLY_READ_V2_CONTRACT.version,
      replyReadTries: 0,
    },
  });
  await enqueueReplyReading(userId, sent.id);
  logEvent('reply_read_again', { userId });
  return { reading: true as const };
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
    const version = sent.replyReadVersion ?? replyReadContractFor(null).version;
    const reply = ownText(await fetchMessageBody(userId, sent.gmailMessageId));
    const read = reply ? await readReply(userId, version, open, reply) : NOTHING_READ;
    const outcomeOf = new Map(read.asks.map((entry) => [entry.id, entry.outcome]));
    const closes = open.flatMap(({ id }) => {
      const outcome = outcomeOf.get(id);
      const reason = outcome && CLOSES_AS[outcome];
      return reason ? [{ id, reason }] : [];
    });
    const closed = await closeNamedAsks(
      userId,
      { ...conversationOf(sent), before: sent.sentAt },
      closes,
      sent.gmailMessageId,
    );
    // A question back about an ask that stays open: the reply waits for their answer.
    const askedBack = open.some(({ id }) => outcomeOf.get(id) === 'ASKED_BACK');
    await prisma.outgoingEmail.update({
      where: { id: sent.id },
      data: { replyReadState: askedBack ? 'ASKED_BACK' : 'READ', replyReadAt: new Date() },
    });
    const declined = read.leavesJob && (await noteDecline(userId, sent.threadId, sent.sentAt));
    logEvent('reply_read', { userId, version, closed, askedBack, declined });
    return null;
  } catch (err) {
    return tryLater(sent.id, sent.replyReadTries, err);
  }
}

/** An empty reply (only quoted mail) settles nothing. */
const NOTHING_READ: ReplyReadV2 = { asks: [], leavesJob: false };

/** One AI read of the reply with the version it was queued for, as v2 reads it. */
async function readReply(
  userId: string,
  version: string,
  open: Awaited<ReturnType<typeof openAsksBefore>>,
  reply: string,
): Promise<ReplyReadV2> {
  const contract = replyReadContractFor(version);
  const { data } = await runUserCall({
    userId,
    purpose: 'reply-read',
    contract,
    call: (ai) =>
      ai.replies.read(
        { openAsks: open.map(({ id, ask, kind, askedAt }) => ({ id, ask, kind, askedAt })), reply },
        contract.version,
      ),
  });
  return replyOutcomes(contract.version, data);
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
