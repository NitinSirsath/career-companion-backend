/**
 * The sandbox mailbox as a Gmail client. In dev mode `withGmail` hands this to its caller in
 * place of Google's client, so sync, the Gmail tab and the mail details page run their normal
 * code on sandbox mail. It answers, in Gmail's own response shapes, exactly the calls the app
 * makes; `src/tests/sandbox-gmail.test.ts` fails when the app starts to make another one.
 */
import { gmail_v1 } from 'googleapis';
import { prisma } from '../../db/prisma';
import { AppError } from '../../errors';
import { deliverSentMail } from './mailbox';
import { SENT_LABELS, fromRawMail, snippetOf, toGmailMessage } from './message';

const DAY_MS = 86_400_000;
const DEFAULT_PAGE = 100;

/** An error shaped like Google's, so callers treat it as they treat Gmail's own. */
const gmailError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

const pageSize = (maxResults: number | undefined) =>
  Math.min(Math.max(maxResults ?? DEFAULT_PAGE, 1), 500);

/** Pages are numbered by how many results came before. */
function offsetOf(pageToken: string | undefined): number {
  if (pageToken === undefined) return 0;
  if (!/^\d{1,9}$/.test(pageToken)) throw gmailError(400, 'Invalid pageToken');
  return Number(pageToken);
}

/** The app searches with `newer_than:Nd` only; any other search is refused, not ignored. */
function newerThan(q: string | undefined): Date | undefined {
  if (!q) return undefined;
  const days = /^newer_than:(\d{1,4})d$/.exec(q.trim());
  if (!days) throw gmailError(400, 'The sandbox mailbox does not know this search');
  return new Date(Date.now() - Number(days[1]) * DAY_MS);
}

const ref = (message: { id: string; threadId: string }) => ({
  id: message.id,
  threadId: message.threadId,
});

async function getProfile(userId: string): Promise<gmail_v1.Schema$Profile> {
  const [user, mailbox] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
    prisma.sandboxMessage.aggregate({
      where: { userId },
      _max: { historyId: true },
      _count: true,
    }),
  ]);
  return {
    emailAddress: user.email,
    messagesTotal: mailbox._count,
    // A mailbox with no mail yet starts its history at 0.
    historyId: String(mailbox._max.historyId ?? 0),
  };
}

async function listMessages(
  userId: string,
  params: gmail_v1.Params$Resource$Users$Messages$List,
): Promise<gmail_v1.Schema$ListMessagesResponse> {
  const since = newerThan(params.q);
  const offset = offsetOf(params.pageToken);
  const take = pageSize(params.maxResults);
  const found = await prisma.sandboxMessage.findMany({
    where: {
      userId,
      labelIds: { hasEvery: params.labelIds ?? [] },
      ...(since ? { internalDate: { gt: since } } : {}),
    },
    orderBy: { historyId: 'desc' },
    skip: offset,
    take: take + 1,
    select: { id: true, threadId: true },
  });
  return {
    messages: found.slice(0, take).map(ref),
    resultSizeEstimate: Math.min(found.length, take),
    ...(found.length > take ? { nextPageToken: String(offset + take) } : {}),
  };
}

async function getMessage(
  userId: string,
  params: gmail_v1.Params$Resource$Users$Messages$Get,
): Promise<gmail_v1.Schema$Message> {
  const message = params.id
    ? await prisma.sandboxMessage.findFirst({ where: { userId, id: params.id } })
    : null;
  if (!message) throw gmailError(404, 'Requested entity was not found.');
  return toGmailMessage(message, params.format, params.metadataHeaders);
}

/**
 * A mail the app sends for the user: it lands in the sandbox Sent folder, in its conversation.
 * Nothing leaves the app. Gmail refuses a mail it cannot read, and so does the sandbox.
 */
async function sendMessage(
  userId: string,
  params: gmail_v1.Params$Resource$Users$Messages$Send,
): Promise<gmail_v1.Schema$Message> {
  const { raw, threadId } = params.requestBody ?? {};
  const mail = raw ? fromRawMail(raw) : null;
  if (!mail || !threadId) throw gmailError(400, 'Invalid message');
  try {
    const sent = await deliverSentMail(userId, threadId, mail);
    return { id: sent.id, threadId: sent.threadId, labelIds: SENT_LABELS };
  } catch (err) {
    if (err instanceof AppError && err.status === 404)
      throw gmailError(404, 'Requested entity was not found.');
    throw err;
  }

/** Every sandbox mail is one history record: it was added. Labels never change afterwards. */
async function listHistory(
  userId: string,
  params: gmail_v1.Params$Resource$Users$History$List,
): Promise<gmail_v1.Schema$ListHistoryResponse> {
  const start = Number(params.pageToken ?? params.startHistoryId);
  if (!Number.isSafeInteger(start) || start < 0) throw gmailError(400, 'Invalid startHistoryId');
  const take = pageSize(params.maxResults);
  const added =
    !params.historyTypes || params.historyTypes.includes('messageAdded')
      ? await prisma.sandboxMessage.findMany({
          where: { userId, historyId: { gt: start } },
          orderBy: { historyId: 'asc' },
          take: take + 1,
          select: { id: true, threadId: true, labelIds: true, historyId: true },
        })
      : [];
  const page = added.slice(0, take);
  const last = page.length ? page[page.length - 1].historyId : start;
  return {
    history: page.map((message) => ({
      id: String(message.historyId),
      messages: [ref(message)],
      messagesAdded: [{ message: { ...ref(message), labelIds: message.labelIds } }],
    })),
    // Never ahead of what this answer covers, so a mail sent meanwhile is found next time.
    historyId: String(last),
    ...(added.length > take ? { nextPageToken: String(last) } : {}),
  };
}

async function listThreads(
  userId: string,
  params: gmail_v1.Params$Resource$Users$Threads$List,
): Promise<gmail_v1.Schema$ListThreadsResponse> {
  const offset = offsetOf(params.pageToken);
  const take = pageSize(params.maxResults);
  const found = await prisma.sandboxMessage.groupBy({
    by: ['threadId'],
    where: { userId, labelIds: { hasEvery: params.labelIds ?? [] } },
    _max: { historyId: true },
    orderBy: { _max: { historyId: 'desc' } },
    skip: offset,
    take: take + 1,
  });
  const page = found.slice(0, take);
  const newest = await prisma.sandboxMessage.findMany({
    where: { userId, threadId: { in: page.map((thread) => thread.threadId) } },
    orderBy: { historyId: 'desc' },
    distinct: ['threadId'],
    select: { threadId: true, body: true, historyId: true },
  });
  const byThread = new Map(newest.map((message) => [message.threadId, message]));
  return {
    threads: page.map((thread) => ({
      id: thread.threadId,
      snippet: snippetOf(byThread.get(thread.threadId)?.body ?? ''),
      historyId: String(byThread.get(thread.threadId)?.historyId ?? 0),
    })),
    resultSizeEstimate: page.length,
    ...(found.length > take ? { nextPageToken: String(offset + take) } : {}),
  };
}

async function getThread(
  userId: string,
  params: gmail_v1.Params$Resource$Users$Threads$Get,
): Promise<gmail_v1.Schema$Thread> {
  const messages = params.id
    ? await prisma.sandboxMessage.findMany({
        where: { userId, threadId: params.id },
        orderBy: { historyId: 'asc' },
      })
    : [];
  if (!messages.length) throw gmailError(404, 'Requested entity was not found.');
  return {
    id: params.id,
    historyId: String(messages[messages.length - 1].historyId),
    messages: messages.map((message) =>
      toGmailMessage(message, params.format, params.metadataHeaders),
    ),
  };
}

/** The labels sandbox mail can carry. There are no labels of the user's own. */
const LABELS: gmail_v1.Schema$Label[] = ['INBOX', 'SENT', 'CATEGORY_PERSONAL'].map((id) => ({
  id,
  name: id,
  type: 'system',
}));

export function sandboxGmail(userId: string): gmail_v1.Gmail {
  const client = {
    users: {
      getProfile: async () => ({ data: await getProfile(userId) }),
      labels: { list: async () => ({ data: { labels: LABELS } }) },
      history: {
        list: async (params: gmail_v1.Params$Resource$Users$History$List) => ({
          data: await listHistory(userId, params),
        }),
      },
      messages: {
        list: async (params: gmail_v1.Params$Resource$Users$Messages$List) => ({
          data: await listMessages(userId, params),
        }),
        get: async (params: gmail_v1.Params$Resource$Users$Messages$Get) => ({
          data: await getMessage(userId, params),
        }),
        send: async (params: gmail_v1.Params$Resource$Users$Messages$Send) => ({
          data: await sendMessage(userId, params),
        }),
        attachments: {
          // Sandbox mail has no attached files yet.
          get: async (): Promise<never> => {
            throw gmailError(404, 'Requested entity was not found.');
          },
        },
      },
      threads: {
        list: async (params: gmail_v1.Params$Resource$Users$Threads$List) => ({
          data: await listThreads(userId, params),
        }),
        get: async (params: gmail_v1.Params$Resource$Users$Threads$Get) => ({
          data: await getThread(userId, params),
        }),
      },
    },
  };
  // Only the calls above are stood in for; the rest of Google's client does not exist here.
  return client as unknown as gmail_v1.Gmail;
}
