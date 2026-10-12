import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db/prisma';
import { syncUser } from '../services/gmailSync';
import { encryptToken } from '../utils/gmailTokenEncryption';
import { enqueueEmailProcessingJob } from '../services/enqueue';
import { configureAI } from './helpers/aiAccess';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  history: vi.fn(),
  get: vi.fn(),
  profile: vi.fn(),
  credentials: {} as { access_token?: string; refresh_token?: string },
}));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueEmailProcessingJob: vi.fn(),
}));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        get credentials() {
          return mocks.credentials;
        }
        setCredentials(credentials: typeof mocks.credentials) {
          mocks.credentials = { ...credentials };
        }
      },
    },
    gmail: () => ({
      users: {
        messages: { list: mocks.list, get: mocks.get },
        history: { list: mocks.history },
        getProfile: mocks.profile,
      },
    }),
  },
}));

type Mail = { threadId: string; labelIds: string[]; internalDate?: number };
let userId: string;
let mailbox: Record<string, Mail>;
const SENT_AT = Date.UTC(2026, 9, 10, 12);

const outgoing = () =>
  prisma.outgoingEmail.findMany({ where: { userId }, orderBy: { gmailMessageId: 'asc' } });
const added = (...ids: string[]) => ({
  messagesAdded: ids.map((id) => ({
    message: { id, threadId: mailbox[id].threadId, labelIds: mailbox[id].labelIds },
  })),
});
/** The next sync reads only what changed since the last checkpoint. */
async function afterFirstSync(history: object[]) {
  await prisma.gmailConnection.update({
    where: { userId },
    data: {
      lastHistoryId: '100',
      lastSyncedAt: new Date(),
      lastSyncedLookbackDays: 1,
      syncLookbackDays: 1,
    },
  });
  mocks.history.mockResolvedValue({ data: { historyId: '101', history } });
}

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: 'sent-mail@audit.test' } })).id;
  await configureAI(userId);
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});
beforeEach(async () => {
  vi.clearAllMocks();
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.outgoingEmail.deleteMany({ where: { userId } });
  await prisma.gmailConnection.deleteMany({ where: { userId } });
  await prisma.gmailConnection.create({
    data: {
      userId,
      gmailEmail: 'sent-mail@audit.test',
      status: 'CONNECTED',
      accessToken: encryptToken('access'),
      refreshToken: encryptToken('refresh'),
    },
  });
  mailbox = {
    inbound: { threadId: 'thread-1', labelIds: ['INBOX'] },
    reply: { threadId: 'thread-1', labelIds: ['SENT'], internalDate: SENT_AT },
    unrelated: { threadId: 'thread-9', labelIds: ['SENT'], internalDate: SENT_AT },
  };
  mocks.profile.mockResolvedValue({ data: { historyId: '100' } });
  mocks.history.mockResolvedValue({ data: { historyId: '101', history: [] } });
  mocks.list.mockImplementation(async ({ labelIds }: { labelIds: string[] }) => ({
    data: {
      messages: Object.entries(mailbox)
        .filter(([, mail]) => mail.labelIds.includes(labelIds[0]))
        .map(([id, mail]) => ({ id, threadId: mail.threadId })),
    },
  }));
  mocks.get.mockImplementation(async ({ id }: { id: string }) => ({
    data: {
      id,
      threadId: mailbox[id].threadId,
      internalDate: String(mailbox[id].internalDate ?? Date.now()),
      labelIds: mailbox[id].labelIds,
      payload: { headers: [{ name: 'Subject', value: 'Secret subject' }] },
    },
  }));
  vi.mocked(enqueueEmailProcessingJob).mockResolvedValue('fixture-job');
});

describe('the user’s own replies', () => {
  it('records a reply found by a full sync, for a conversation we hold only', async () => {
    await syncUser(userId);
    expect(await outgoing()).toMatchObject([
      { gmailMessageId: 'reply', threadId: 'thread-1', sentAt: new Date(SENT_AT) },
    ]);
    // The sent scan asks Gmail for sent mail of the same window as the inbox scan.
    expect(mocks.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ labelIds: ['SENT'], q: 'newer_than:1d' }),
      expect.anything(),
    );
  });

  it('never stores a sent message as an email, and never offers it to AI', async () => {
    await syncUser(userId);
    const emails = await prisma.email.findMany({ where: { userId } });
    expect(emails.map((email) => email.gmailMessageId)).toEqual(['inbound']);
    // Every offer to AI is for the inbox email (it is re-offered while it waits).
    const offered = vi.mocked(enqueueEmailProcessingJob).mock.calls.map(([, emailId]) => emailId);
    expect(new Set(offered)).toEqual(new Set([emails[0].id]));
    // Only IDs and the time are kept.
    expect(Object.keys((await outgoing())[0]).sort()).toEqual(
      ['createdAt', 'gmailMessageId', 'id', 'sentAt', 'threadId', 'userId'].sort(),
    );
  });

  it('does not scan sent mail while no conversation is held', async () => {
    mailbox = { reply: mailbox.reply };
    await syncUser(userId);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(await outgoing()).toHaveLength(0);
  });

  it('records a reply found in the history, after the inbox mail of the same page', async () => {
    await afterFirstSync([added('reply', 'inbound', 'unrelated')]);
    await syncUser(userId);
    expect((await outgoing()).map((sent) => sent.gmailMessageId)).toEqual(['reply']);
    expect(mocks.list).not.toHaveBeenCalled();
    // Sent-only messages are not fetched as inbox mail; the unrelated one is never fetched.
    expect(mocks.get.mock.calls.map(([params]) => params.id).sort()).toEqual(['inbound', 'reply']);
  });

  it('records each reply once, however often it is seen', async () => {
    await syncUser(userId);
    await afterFirstSync([added('reply'), added('reply')]);
    mocks.get.mockClear();
    await syncUser(userId);
    expect(await outgoing()).toHaveLength(1);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('treats a message the user sent to themselves as inbox mail', async () => {
    mailbox = { self: { threadId: 'thread-2', labelIds: ['INBOX', 'SENT'] } };
    await syncUser(userId);
    expect(await prisma.email.count({ where: { userId, gmailMessageId: 'self' } })).toBe(1);
    expect(await outgoing()).toHaveLength(0);
  });

  it('skips a draft or a message Gmail no longer has', async () => {
    mailbox.reply.labelIds = ['DRAFT'];
    await afterFirstSync([
      { messagesAdded: [{ message: { id: 'reply', threadId: 'thread-1', labelIds: ['SENT'] } }] },
      added('inbound'),
    ]);
    await syncUser(userId);
    expect(await outgoing()).toHaveLength(0);
  });
});
