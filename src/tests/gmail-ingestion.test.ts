import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db/prisma';
import { GmailSyncService } from '../services/gmailSync';
import { GmailFetcherService } from '../services/gmailFetcher';
import { encryptToken, decryptToken } from '../utils/gmailTokenEncryption';
import { enqueueEmailProcessingJob } from '../jobs/emailProcessingJob';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  history: vi.fn(),
  get: vi.fn(),
  profile: vi.fn(),
  credentials: {} as { access_token?: string; refresh_token?: string },
}));
vi.mock('../jobs/emailProcessingJob', () => ({ enqueueEmailProcessingJob: vi.fn() }));
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
let userId: string;
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: 'ingestion@audit.test' } })).id;
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});
beforeEach(async () => {
  vi.clearAllMocks();
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.gmailConnection.deleteMany({ where: { userId } });
  await prisma.gmailConnection.create({
    data: {
      userId,
      gmailEmail: 'ingestion@audit.test',
      status: 'CONNECTED',
      accessToken: encryptToken('old-access'),
      refreshToken: encryptToken('original-refresh'),
    },
  });
  mocks.profile.mockResolvedValue({ data: { historyId: '100' } });
  mocks.list.mockResolvedValue({ data: { messages: [{ id: 'message-a' }] } });
  mocks.history.mockResolvedValue({ data: { historyId: '101', history: [] } });
  mocks.get.mockImplementation(async ({ id }: { id: string }) => ({
    data: {
      id,
      internalDate: String(Date.now()),
      labelIds: ['INBOX'],
      payload: { headers: [{ name: 'Subject', value: 'Job interview' }] },
    },
  }));
  vi.mocked(enqueueEmailProcessingJob).mockResolvedValue(undefined);
});

describe('Gmail ingestion checkpoints and recovery', () => {
  it('uses history after initial sync and does not re-enqueue completed mail', async () => {
    await GmailSyncService.syncUser(userId);
    await prisma.email.updateMany({ where: { userId }, data: { processingState: 'COMPLETED' } });
    vi.mocked(enqueueEmailProcessingJob).mockClear();
    mocks.history.mockResolvedValue({
      data: { historyId: '102', history: [{ messagesAdded: [{ message: { id: 'message-a' } }] }] },
    });
    await GmailSyncService.syncUser(userId);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.history).toHaveBeenCalledWith(
      expect.objectContaining({ startHistoryId: '100' }),
      expect.anything(),
    );
    expect(enqueueEmailProcessingJob).not.toHaveBeenCalled();
    expect(await prisma.email.count({ where: { userId } })).toBe(1);
  });
  it('recovers insert-before-enqueue failure without advancing the history checkpoint', async () => {
    vi.mocked(enqueueEmailProcessingJob).mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(GmailSyncService.syncUser(userId)).rejects.toThrow();
    expect(
      (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).lastHistoryId,
    ).toBeNull();
    await GmailSyncService.syncUser(userId);
    expect(await prisma.email.count({ where: { userId } })).toBe(1);
    expect(enqueueEmailProcessingJob).toHaveBeenCalled();
  });
  it('falls back on expired history and traverses every provider page', async () => {
    await prisma.gmailConnection.update({ where: { userId }, data: { lastHistoryId: '1' } });
    mocks.history.mockRejectedValueOnce({ status: 404 });
    mocks.list
      .mockResolvedValueOnce({ data: { messages: [{ id: 'message-a' }], nextPageToken: 'page-2' } })
      .mockResolvedValueOnce({ data: { messages: [{ id: 'message-b' }] } });
    await GmailSyncService.syncUser(userId);
    expect(await prisma.email.count({ where: { userId } })).toBe(2);
    expect(mocks.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: 'page-2' }),
      expect.anything(),
    );
  });
  it('does not advance the checkpoint when a later history page fails', async () => {
    await prisma.gmailConnection.update({ where: { userId }, data: { lastHistoryId: '100' } });
    mocks.history
      .mockResolvedValueOnce({
        data: {
          historyId: '110',
          nextPageToken: 'second',
          history: [{ messagesAdded: [{ message: { id: 'message-a' } }] }],
        },
      })
      .mockRejectedValueOnce({ status: 503 });
    await expect(GmailSyncService.syncUser(userId)).rejects.toThrow();
    expect(
      (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).lastHistoryId,
    ).toBe('100');
  });
  it('excludes simultaneous syncs and recovers an expired claim', async () => {
    await prisma.gmailConnection.update({
      where: { userId },
      data: {
        syncStatus: 'SYNCING',
        syncLeaseUntil: new Date(Date.now() + 60_000),
        syncClaim: 'active',
      },
    });
    await expect(GmailSyncService.syncUser(userId)).rejects.toThrow('already in progress');
    await prisma.gmailConnection.update({
      where: { userId },
      data: { syncLeaseUntil: new Date(0) },
    });
    await GmailSyncService.syncUser(userId);
    expect((await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).syncStatus).toBe(
      'IDLE',
    );
  });
  it('does not revoke authorization for quota 403 errors', async () => {
    mocks.list.mockRejectedValueOnce({ status: 403 });
    await expect(GmailSyncService.syncUser(userId)).rejects.toThrow();
    expect((await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).status).toBe(
      'CONNECTED',
    );
  });
  it('persists library-refreshed credentials even after a partial sync fails', async () => {
    mocks.list.mockImplementationOnce(async () => {
      mocks.credentials.access_token = 'renewed';
      throw { status: 503 };
    });
    await expect(GmailSyncService.syncUser(userId)).rejects.toThrow();
    const saved = await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } });
    expect(decryptToken(saved.accessToken)).toBe('renewed');
    expect(decryptToken(saved.refreshToken!)).toBe('original-refresh');
  });
  it('cannot restore tokens after a concurrent disconnect', async () => {
    mocks.get.mockImplementationOnce(async () => {
      mocks.credentials.access_token = 'renewed';
      await prisma.gmailConnection.update({
        where: { userId },
        data: { status: 'NOT_CONNECTED', accessToken: '', refreshToken: null },
      });
      return { data: { labelIds: ['INBOX'] } };
    });
    await GmailFetcherService.fetchMessageMetadata(userId, 'message-a');
    expect(
      (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).accessToken,
    ).toBe('');
  });
});
