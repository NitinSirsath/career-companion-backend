/**
 * The sandbox mailbox of a dev-mode user: send a mail to the user, reply inside a conversation
 * as either side, and read the mailbox back. It stands in for the user's Gmail account and
 * holds mail text, so it is for dev mode only (`routes/sandbox.ts` answers 404 in prod).
 *
 * Sending writes only to `sandbox_messages`. The mail reaches the app when a sync pulls it
 * through the Gmail stand-in (`sandbox/gmail.ts`), exactly as real mail does.
 */
import { randomBytes, randomUUID } from 'crypto';
import type { SandboxMessage as StoredMessage } from '@prisma/client';
import {
  parseSandboxAddress,
  parseSandboxCc,
  type ListSandboxThreadsResponse,
  type ReplySandboxMailRequest,
  type ResetSandboxResponse,
  type SandboxFolder,
  type SandboxSendersResponse,
  type SandboxSentResponse,
  type SandboxThread,
  type SandboxThreadDetail,
  type SendSandboxMailRequest,
} from '../../contracts/sandbox';
import { prisma } from '../../db/prisma';
import { AppError } from '../../errors';
import { PAUSE_ISSUES } from '../ai/usage';
import { lockUser, LOCK_NAMESPACE } from '../../utils/advisoryLock';
import { sandboxMailResults, sentByUser } from './appResult';
import { RECEIVED_LABELS, SENT_LABELS, snippetOf, type RawMail } from './message';

const PAGE_SIZE = 25;
const SENDER_LIST_SIZE = 50;
/** A reply quotes the mail it answers; a long conversation must not grow without end. */
const BODY_LIMIT = 50_000;

const FOLDER_LABEL: Record<SandboxFolder, string> = { inbox: 'INBOX', sent: 'SENT' };

interface NewMessage {
  /** Left out for the first mail of a conversation. */
  threadId?: string;
  labelIds: string[];
  sender: string;
  recipient: string;
  /** The other people on the mail. Left out when there are none. */
  cc?: string | null;
  subject: string;
  inReplyTo?: string;
  referenceIds?: string;
  body: string;
}

async function userAddress(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, name: true },
  });
  return user.name ? `${user.name} <${user.email}>` : user.email;
}

/** Stores one message as the newest of the mailbox. A message with no thread starts one. */
async function deliver(userId: string, message: NewMessage): Promise<SandboxSentResponse> {
  const id = randomBytes(8).toString('hex');
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.sandboxMailbox, userId);
    const newest = await tx.sandboxMessage.aggregate({
      where: { userId },
      _max: { historyId: true },
    });
    const created = await tx.sandboxMessage.create({
      data: {
        ...message,
        id,
        userId,
        threadId: message.threadId ?? id,
        historyId: (newest._max.historyId ?? 0) + 1,
        messageId: `<${randomUUID()}@sandbox.mail>`,
        internalDate: new Date(),
      },
    });
    return { id: created.id, threadId: created.threadId };
  });
}

/** A new mail from anyone to the user: a new conversation in the user's inbox. */
export async function sendSandboxMail(
  userId: string,
  input: SendSandboxMailRequest,
): Promise<SandboxSentResponse> {
  return deliver(userId, {
    labelIds: RECEIVED_LABELS,
    sender: input.from,
    recipient: await userAddress(userId),
    cc: parseSandboxCc(input.cc ?? '')?.join(', ') || null,
    subject: input.subject,
    body: input.body,
  });
}

/** The typed text with the answered mail quoted below it, as a mail program writes a reply. */
function replyBody(text: string, answered: StoredMessage): string {
  const quoted = answered.body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  const reply = `${text}\n\nOn ${answered.internalDate.toUTCString()}, ${answered.sender} wrote:\n${quoted}`;
  return reply.slice(0, BODY_LIMIT);
}

/** A reply in a conversation: from the user (`me`), or again from the other person (`them`). */
export async function replyInSandbox(
  userId: string,
  threadId: string,
  input: ReplySandboxMailRequest,
): Promise<SandboxSentResponse> {
  const thread = await threadMessages(userId, threadId);
  const answered = thread[thread.length - 1];
  const me = await userAddress(userId);
  const them = otherPerson(thread);
  const subject = thread[0].subject;
  return deliver(userId, {
    threadId,
    ...(input.as === 'me'
      ? { labelIds: SENT_LABELS, sender: me, recipient: them }
      : { labelIds: RECEIVED_LABELS, sender: them, recipient: me, cc: copiedPeople(thread) }),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo: answered.messageId,
    referenceIds: [answered.referenceIds, answered.messageId].filter(Boolean).join(' '),
    body: replyBody(input.body, answered),
  });
}

/**
 * A mail the app sent for the user through Gmail's send call (a reply written on the mail details
 * page). It is stored as the user's own sent mail of that conversation. The text is what the app
 * built, quote included, so nothing is added here.
 */
export async function deliverSentMail(
  userId: string,
  threadId: string,
  mail: RawMail,
): Promise<SandboxSentResponse> {
  await threadMessages(userId, threadId);
  return deliver(userId, {
    threadId,
    labelIds: SENT_LABELS,
    sender: await userAddress(userId),
    recipient: mail.to,
    cc: mail.cc,
    subject: mail.subject,
    inReplyTo: mail.inReplyTo,
    referenceIds: mail.references,
    body: mail.body.slice(0, BODY_LIMIT),
  });
}

async function threadMessages(userId: string, threadId: string): Promise<StoredMessage[]> {
  const messages = await prisma.sandboxMessage.findMany({
    where: { userId, threadId },
    orderBy: { historyId: 'asc' },
  });
  if (!messages.length) throw new AppError(404, 'NOT_FOUND', 'Conversation not found.');
  return messages;
}

/** Whoever wrote to the user last. Every conversation starts with a mail to the user. */
function otherPerson(thread: StoredMessage[]): string {
  const received = thread.filter((message) => !sentByUser(message));
  return received.length ? received[received.length - 1].sender : thread[0].recipient;
}

/** The people in Cc of the newest mail to the user. They stay on it when that person writes again. */
function copiedPeople(thread: StoredMessage[]): string | null {
  const received = thread.filter((message) => !sentByUser(message));
  return received.length ? received[received.length - 1].cc : null;
}

/** One page of conversations that have a mail in the folder, newest first. */
export async function listSandboxThreads(
  userId: string,
  folder: SandboxFolder,
  pageToken?: string,
): Promise<ListSandboxThreadsResponse> {
  const offset = Number(pageToken ?? 0);
  const inFolder = { userId, labelIds: { has: FOLDER_LABEL[folder] } };
  const found = await prisma.sandboxMessage.groupBy({
    by: ['threadId'],
    where: inFolder,
    _max: { historyId: true },
    orderBy: { _max: { historyId: 'desc' } },
    skip: offset,
    take: PAGE_SIZE + 1,
  });
  const page = found.slice(0, PAGE_SIZE).map((thread) => thread.threadId);
  const [user, everything, shown] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
    prisma.sandboxMessage.findMany({ where: { userId }, select: { id: true, labelIds: true } }),
    prisma.sandboxMessage.findMany({
      where: { userId, threadId: { in: page } },
      orderBy: { historyId: 'asc' },
    }),
  ]);
  const results = await sandboxMailResults(userId, everything);
  const notSynced = (id: string) => results.get(id)?.state === 'NOT_SYNCED';
  const items = page.map((threadId): SandboxThread => {
    const thread = shown.filter((message) => message.threadId === threadId);
    const listed = thread.filter((message) => message.labelIds.includes(FOLDER_LABEL[folder]));
    const newest = listed[listed.length - 1];
    return {
      threadId,
      subject: thread[0].subject,
      party: otherPerson(thread),
      snippet: snippetOf(newest.body),
      date: newest.internalDate.toISOString(),
      messageCount: thread.length,
      notSynced: thread.filter((message) => notSynced(message.id)).length,
      state: results.get(newest.id)?.state ?? 'NOT_SYNCED',
    };
  });
  const count = (label: string) =>
    everything.filter((message) => message.labelIds.includes(label)).length;
  return {
    mailbox: user.email,
    items,
    nextPageToken: found.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
    notSyncedTotal: everything.filter((message) => notSynced(message.id)).length,
    counts: { inbox: count(FOLDER_LABEL.inbox), sent: count(FOLDER_LABEL.sent) },
  };
}

/** One conversation: every mail of both sides with its text and what the app did with it. */
export async function readSandboxThread(
  userId: string,
  threadId: string,
): Promise<SandboxThreadDetail> {
  const thread = await threadMessages(userId, threadId);
  const results = await sandboxMailResults(userId, thread);
  return {
    threadId,
    subject: thread[0].subject,
    party: otherPerson(thread),
    messages: thread.map((message) => ({
      id: message.id,
      from: message.sender,
      to: message.recipient,
      cc: message.cc,
      date: message.internalDate.toISOString(),
      sentByUser: sentByUser(message),
      text: message.body,
      result: results.get(message.id) ?? { state: 'NOT_SYNCED', failure: null, job: null },
    })),
  };
}

/** Sender addresses used before, newest first. An address is listed once, by its mail address. */
export async function listSandboxSenders(userId: string): Promise<SandboxSendersResponse> {
  const received = await prisma.sandboxMessage.findMany({
    where: { userId, labelIds: { has: FOLDER_LABEL.inbox } },
    orderBy: { historyId: 'desc' },
    select: { sender: true },
    take: 500,
  });
  const senders = new Map<string, string>();
  for (const { sender } of received) {
    const key = parseSandboxAddress(sender)?.email.toLowerCase() ?? sender;
    if (!senders.has(key)) senders.set(key, sender);
  }
  return { senders: [...senders.values()].slice(0, SENDER_LIST_SIZE) };
}

/**
 * Empties the user's sandbox mailbox and deletes what the app made from it: emails (with their
 * AI rows), recorded replies, applications (with events, actions and agenda), automation
 * submissions, AI batches and AI day counts. Clears an AI rate-limit pause and the sync
 * checkpoint. Keeps the user, the AI settings and the sandbox connection.
 */
export async function resetSandbox(userId: string): Promise<ResetSandboxResponse> {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.sandboxMailbox, userId);
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    const messages = await tx.sandboxMessage.deleteMany({ where: { userId } });
    const emails = await tx.email.deleteMany({ where: { userId } });
    await tx.outgoingEmail.deleteMany({ where: { userId } });
    const applications = await tx.application.deleteMany({ where: { userId } });
    await tx.externalSubmission.deleteMany({ where: { userId } });
    await tx.aIBatch.deleteMany({ where: { userId } });
    await tx.aIUsageDay.deleteMany({ where: { userId } });
    await tx.aIConfiguration.updateMany({
      where: { userId },
      data: { cooldownUntil: null, consecutiveFailures: 0 },
    });
    await tx.aIConfiguration.updateMany({
      where: { userId, accessIssue: { in: PAUSE_ISSUES } },
      data: { accessIssue: null, accessIssueModel: null },
    });
    // The mailbox starts again at history 0, so the next sync must start again too.
    await tx.gmailConnection.updateMany({
      where: { userId },
      data: {
        lastHistoryId: null,
        lastSyncedAt: null,
        lastSyncedLookbackDays: null,
        unscannedFrom: null,
        unscannedUntil: null,
        syncError: null,
      },
    });
    return {
      deletedMessages: messages.count,
      deletedEmails: emails.count,
      deletedApplications: applications.count,
    };
  });
}
