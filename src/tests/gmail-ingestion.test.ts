import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db/prisma';
import { GmailSyncService } from '../services/gmailSync';
import { GmailFetcherService } from '../services/gmailFetcher';
import { encryptToken, decryptToken } from '../utils/gmailTokenEncryption';
import { enqueueEmailProcessingJob } from '../jobs/emailProcessingJob';
import { configureAI } from './helpers/aiAccess';
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
  // Sync re-offers waiting emails only to users whose own AI access is ready (ADR-0001).
  await configureAI(userId);
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
  vi.mocked(enqueueEmailProcessingJob).mockResolvedValue('fixture-job');
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
    await prisma.gmailConnection.update({
      where: { userId },
      data: {
        lastHistoryId: '1',
        lastSyncedAt: new Date(),
        lastSyncedLookbackDays: 1,
        syncLookbackDays: 1,
      },
    });
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
    await prisma.gmailConnection.update({
      where: { userId },
      data: {
        lastHistoryId: '100',
        lastSyncedAt: new Date(),
        lastSyncedLookbackDays: 1,
        syncLookbackDays: 1,
      },
    });
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

describe('long-gap synchronization (S7-02)', () => {
  it('ingests mail from the gap with lookback 1 instead of silently dropping it', async () => {
    const now = Date.now();
    await prisma.gmailConnection.update({
      where: { userId },
      data: {
        lastHistoryId: 'old',
        lastSyncedAt: new Date(now - 5 * 86400_000),
        syncLookbackDays: 1,
      },
    });
    mocks.list.mockResolvedValue({
      data: { messages: [{ id: 'gap-mail' }, { id: 'recent-mail' }] },
    });
    mocks.get.mockImplementation(async ({ id }: { id: string }) => ({
      data: {
        id,
        internalDate: String(now - (id === 'gap-mail' ? 4 * 86400_000 : 3600_000)),
        labelIds: ['INBOX'],
      },
    }));
    await GmailSyncService.syncUser(userId);
    expect(
      (await prisma.email.findMany({ where: { userId }, orderBy: { gmailMessageId: 'asc' } })).map(
        (e) => e.gmailMessageId,
      ),
    ).toEqual(['gap-mail', 'recent-mail']);
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'newer_than:6d' }),
      expect.anything(),
    );
  });
});

describe('capped and failed scan persistence', () => {
  it('caps at 30 days, keeps the notice across uncapped runs, and replaces it on a later capped run', async () => {
    const now = Date.now();
    const old = new Date(now - 45 * 86400_000);
    await prisma.gmailConnection.update({
      where: { userId },
      data: { lastHistoryId: 'old', lastSyncedAt: old },
    });
    mocks.list.mockResolvedValue({ data: { messages: [{ id: 'twenty' }, { id: 'forty' }] } });
    mocks.get.mockImplementation(async ({ id }: { id: string }) => ({
      data: {
        id,
        internalDate: String(now - (id === 'twenty' ? 20 : 40) * 86400_000),
        labelIds: ['INBOX'],
      },
    }));
    await GmailSyncService.syncUser(userId);
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'newer_than:30d' }),
      expect.anything(),
    );
    expect(
      (await prisma.email.findMany({ where: { userId } })).map((e) => e.gmailMessageId),
    ).toEqual(['twenty']);
    const capped = await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } });
    expect(capped.unscannedFrom).toEqual(new Date(old.getTime() - 3600_000));
    expect(Math.abs(capped.unscannedUntil!.getTime() - (now - 30 * 86400_000))).toBeLessThan(2000);
    await GmailSyncService.syncUser(userId);
    const next = await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } });
    expect(next.unscannedFrom).toEqual(capped.unscannedFrom);
    expect(next.unscannedUntil).toEqual(capped.unscannedUntil);
    const older = new Date(now - 60 * 86400_000);
    await prisma.gmailConnection.update({ where: { userId }, data: { lastSyncedAt: older } });
    await GmailSyncService.syncUser(userId);
    expect(
      (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).unscannedFrom,
    ).toEqual(new Date(older.getTime() - 3600_000));
  });

  it('keeps checkpoints and gap metadata on failure, then retries the full gap', async () => {
    const lastSyncedAt = new Date(Date.now() - 5 * 86400_000);
    const unscannedFrom = new Date('2026-01-01');
    const unscannedUntil = new Date('2026-01-15');
    await prisma.gmailConnection.update({
      where: { userId },
      data: { lastSyncedAt, lastHistoryId: 'old', unscannedFrom, unscannedUntil },
    });
    mocks.list.mockRejectedValueOnce({ status: 503 });
    await expect(GmailSyncService.syncUser(userId)).rejects.toThrow();
    expect(await prisma.gmailConnection.findUnique({ where: { userId } })).toMatchObject({
      lastSyncedAt,
      lastHistoryId: 'old',
      unscannedFrom,
      unscannedUntil,
    });
    await GmailSyncService.syncUser(userId);
    expect(mocks.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'newer_than:6d' }),
      expect.anything(),
    );
  });

  it('keeps first sync at the configured window and preserves completed decisions across owners', async () => {
    await prisma.gmailConnection.update({ where: { userId }, data: { syncLookbackDays: 7 } });
    const other = await prisma.user.create({ data: { email: 'other-gap@fixture.test' } });
    try {
      const app = await prisma.application.create({ data: { userId, companyName: 'Existing' } });
      const email = await prisma.email.create({
        data: {
          userId,
          gmailMessageId: 'message-a',
          processingState: 'COMPLETED',
          matchState: 'MATCHED',
          matchConfirmedBy: 'USER_CONFIRMED',
          applicationId: app.id,
        },
      });
      const foreign = await prisma.email.create({
        data: { userId: other.id, gmailMessageId: 'message-a' },
      });
      await GmailSyncService.syncUser(userId);
      expect(mocks.list).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'newer_than:7d' }),
        expect.anything(),
      );
      expect(enqueueEmailProcessingJob).not.toHaveBeenCalled();
      expect(await prisma.email.findUnique({ where: { id: email.id } })).toEqual(email);
      expect(await prisma.email.findUnique({ where: { id: foreign.id } })).toEqual(foreign);
      expect(
        (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).unscannedFrom,
      ).toBeNull();
      await prisma.application.delete({ where: { id: app.id } });
    } finally {
      await prisma.user.delete({ where: { id: other.id } });
    }
  });
});

describe('request ownership fencing', () => {
  it('reclaims only an expired attempt of the same request', async () => {
    await prisma.gmailConnection.update({
      where: { userId },
      data: {
        syncStatus: 'SYNCING',
        syncClaim: 'queued:one:attempt:0:old',
        syncLeaseUntil: new Date(Date.now() + 60000),
      },
    });
    await expect(GmailSyncService.syncUser(userId, 'queued:one')).rejects.toThrow(
      'already in progress',
    );
    await expect(GmailSyncService.syncUser(userId, 'queued:two')).rejects.toThrow('superseded');
    expect(mocks.list).not.toHaveBeenCalled();
    await prisma.gmailConnection.update({
      where: { userId },
      data: { syncLeaseUntil: new Date(0) },
    });
    await GmailSyncService.syncUser(userId, 'queued:one', {
      retryCount: 1,
      jobId: 'job-fixture',
      retryLimit: 3,
    });
    expect(
      (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).lastHistoryId,
    ).toBe('100');
  });

  it.each(['claim', 'disconnect', 'expire'])(
    'rejects an insert after %s changes during Google I/O',
    async (change) => {
      const original = await mocks.get.getMockImplementation()!({ id: 'message-a' });
      mocks.get.mockImplementationOnce(async () => {
        await prisma.gmailConnection.update({
          where: { userId },
          data:
            change === 'claim'
              ? { syncClaim: 'replacement' }
              : change === 'disconnect'
                ? { status: 'NOT_CONNECTED', accessToken: '', refreshToken: null }
                : { syncLeaseUntil: new Date(0) },
        });
        return original;
      });
      const events = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(GmailSyncService.syncUser(userId)).rejects.toThrow('superseded');
        expect(await prisma.email.count({ where: { userId } })).toBe(0);
        expect(enqueueEmailProcessingJob).not.toHaveBeenCalled();
        expect(
          (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).lastHistoryId,
        ).toBeNull();
        expect(
          events.mock.calls
            .map(([value]) => JSON.parse(value))
            .filter((e) => e.event === 'gmail_sync_superseded'),
        ).toEqual([
          expect.objectContaining({ checkpointCommitted: false, checkpointAdvanced: false }),
        ]);
      } finally {
        events.mockRestore();
      }
    },
  );

  it('stops a cancelled delivery before inserting the just-fetched message', async () => {
    const original = await mocks.get.getMockImplementation()!({ id: 'message-a' });
    const controller = new AbortController();
    mocks.get.mockImplementationOnce(async () => {
      controller.abort();
      return original;
    });
    await expect(
      GmailSyncService.syncUser(userId, undefined, { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(await prisma.email.count({ where: { userId } })).toBe(0);
  });

  it('retains the request across partial failure and retries without duplicate email rows', async () => {
    await prisma.gmailConnection.update({
      where: { userId },
      data: { syncClaim: 'queued:retry', syncStatus: 'SYNCING' },
    });
    mocks.list
      .mockResolvedValueOnce({ data: { messages: [{ id: 'message-a' }], nextPageToken: 'two' } })
      .mockRejectedValueOnce({ status: 503 });
    await expect(GmailSyncService.syncUser(userId, 'queued:retry')).rejects.toThrow();
    expect(await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).toMatchObject({
      syncClaim: 'queued:retry',
      lastHistoryId: null,
    });
    await GmailSyncService.syncUser(userId, 'queued:retry', { retryCount: 1 });
    expect(await prisma.email.count({ where: { userId } })).toBe(1);
  });

  it('caps pending recovery and stops offering immediately when ownership changes', async () => {
    await prisma.email.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        userId,
        gmailMessageId: `pending-${i}`,
        receivedAt: new Date(1700000000000 + i),
      })),
    });
    mocks.list.mockResolvedValue({ data: { messages: [] } });
    await GmailSyncService.syncUser(userId, undefined, { trigger: 'scheduled' });
    expect(enqueueEmailProcessingJob).toHaveBeenCalledTimes(100);
    vi.mocked(enqueueEmailProcessingJob).mockClear();
    vi.mocked(enqueueEmailProcessingJob).mockImplementationOnce(async () => {
      await prisma.gmailConnection.update({
        where: { userId },
        data: { syncClaim: 'replacement' },
      });
      return 'fixture';
    });
    await expect(GmailSyncService.syncUser(userId)).rejects.toThrow('superseded');
    expect(enqueueEmailProcessingJob).toHaveBeenCalledTimes(1);
  });
});
