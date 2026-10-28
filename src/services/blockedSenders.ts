/**
 * Companies whose new mail the app does not read (owner, 26 Oct 2026). Sync checks the From line
 * of a new mail before it saves anything, so blocked mail is never stored or sent to AI. Mail
 * that came while a company was blocked is not fetched after an unblock (new mails only).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { blockableDomain, type BlockedSender } from '../contracts/blockedSender';
import { AppError } from '../errors';
import { conversationWhere } from './conversationQuery';
import { threadKey } from './conversation';

type Db = Prisma.TransactionClient | typeof prisma;

const NOT_BLOCKABLE =
  'Only mail from a company can be blocked, not LinkedIn or a mail provider anyone can use.';

const toResponse = (row: {
  id: string;
  domain: string;
  source: BlockedSender['source'];
  createdAt: Date;
}): BlockedSender => ({
  id: row.id,
  domain: row.domain,
  source: row.source,
  createdAt: row.createdAt.toISOString(),
});

/** The company domains the user blocked, for one sync. */
export async function blockedDomains(userId: string): Promise<string[]> {
  const rows = await prisma.blockedSender.findMany({ where: { userId }, select: { domain: true } });
  return rows.map((row) => row.domain);
}

export async function listBlockedSenders(userId: string) {
  const rows = await prisma.blockedSender.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return { items: rows.map(toResponse) };
}

/** The sender of a conversation's newest job mail: the one the Mails page shows. */
export async function conversationSender(db: Db, userId: string, key: string) {
  const newest = await db.email.findFirst({
    where: { userId, relevanceState: 'RELEVANT', ...conversationWhere(key) },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    select: { sender: true },
  });
  if (!newest) throw new AppError(404, 'NOT_FOUND', 'Conversation not found.');
  return newest.sender;
}

/** Blocks a company domain. Blocking it again keeps the first block. */
export async function blockDomain(
  db: Db,
  userId: string,
  sender: string | null,
  source: BlockedSender['source'],
) {
  const domain = blockableDomain(sender);
  if (!domain) throw new AppError(409, 'NOT_BLOCKABLE', NOT_BLOCKABLE);
  return toResponse(
    await db.blockedSender.upsert({
      where: { userId_domain: { userId, domain } },
      create: { userId, domain, source },
      update: {},
    }),
  );
}

/** "Block new mails from …" in a conversation's menu: the conversation itself stays. */
export async function blockConversationSender(userId: string, anyKey: string) {
  const key = await threadKey(userId, anyKey);
  return blockDomain(prisma, userId, await conversationSender(prisma, userId, key), 'MENU');
}

/** Lets the company's new mail in again. Safe to repeat. */
export async function unblockSender(userId: string, id: string) {
  await prisma.blockedSender.deleteMany({ where: { id, userId } });
  return { unblocked: true as const };
}
