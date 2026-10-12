/**
 * The test inbox read as a mailbox (manual test environment only). Stands in for Gmail on the
 * Mails page, so conversations can be opened without a real mailbox.
 */
import { prisma } from '../../db/prisma';
import type { ListMailboxThreadsResponse, MailMessage, MailThread } from '../../contracts';
import { SIMULATED_ID_PREFIX } from '../../contracts/testTools';
import { AppError } from '../../errors';
import { devMode } from '../../utils/config';
import { simulatedSnippet } from './simulatedMail';

const PAGE_SIZE = 20;
const TEST_REPLY_TEXT = 'Test reply sent from the test inbox.';

export async function listSimulatedThreads(userId: string): Promise<ListMailboxThreadsResponse> {
  const emails = await prisma.email.findMany({
    where: { userId, gmailMessageId: { startsWith: SIMULATED_ID_PREFIX }, threadId: { not: null } },
    include: { simulatedContent: { select: { body: true } } },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });
  const threads = new Map<string, typeof emails>();
  for (const email of emails) {
    const threadId = email.threadId ?? email.id;
    threads.set(threadId, [...(threads.get(threadId) ?? []), email]);
  }
  const items = [...threads.entries()].slice(0, PAGE_SIZE).map(([threadId, thread]) => ({
    threadId,
    subject: thread[thread.length - 1].subject,
    from: thread[0].sender,
    date: thread[0].receivedAt?.toISOString() ?? null,
    snippet: simulatedSnippet(thread[0].simulatedContent?.body ?? ''),
    messageCount: thread.length,
    unread: thread.some((email) => email.seenAt === null),
    conversationKey: thread.some((email) => email.relevanceState === 'RELEVANT') ? threadId : null,
  }));
  return { items, nextPageToken: null };
}

export async function readSimulatedThread(userId: string, threadId: string): Promise<MailThread> {
  const emails = devMode()
    ? await prisma.email.findMany({
        where: { userId, threadId },
        include: { simulatedContent: { select: { body: true } } },
      })
    : [];
  if (!emails.length) throw new AppError(404, 'NOT_FOUND', 'This mail is not available.');
  const replies = await prisma.outgoingEmail.findMany({ where: { userId, threadId } });
  const blank = { to: null, cc: null, html: null, truncated: false, attachments: [] };
  const messages: MailMessage[] = [
    ...emails.map((email) => ({
      ...blank,
      id: email.gmailMessageId,
      from: email.sender,
      date: email.receivedAt?.toISOString() ?? null,
      subject: email.subject,
      labels: ['Inbox'],
      sentByUser: false,
      text: email.simulatedContent?.body ?? null,
    })),
    ...replies.map((reply) => ({
      ...blank,
      id: reply.gmailMessageId,
      from: 'You',
      date: reply.sentAt.toISOString(),
      subject: null,
      labels: ['Sent'],
      sentByUser: true,
      text: TEST_REPLY_TEXT,
    })),
  ].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return { threadId, subject: messages[0].subject, messages };
}
