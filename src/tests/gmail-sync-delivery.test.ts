import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { JobWithMetadata } from 'pg-boss';
import { prisma } from '../db/prisma';
import * as gmailSync from '../services/gmailSync';
import { GmailAuthError, SyncBusyError, SyncSupersededError } from '../services/gmailSyncErrors';
import { handleGmailSyncJobs } from '../jobs/gmailSyncJob';
import { GmailSyncJobData } from '../services/enqueue';
import { requestGmailSync } from '../services/gmailSyncRequests';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../services/queue', () => ({ getQueue: async () => ({ send: mocks.send }) }));
let userId: string;
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: 'delivery@fixture.test' } })).id;
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});
afterEach(() => vi.restoreAllMocks());
it.each([new SyncBusyError(), new Error('temporary')])(
  'rejects retryable delivery failures',
  async (error) => {
    vi.spyOn(gmailSync, 'syncUser').mockRejectedValue(error);
    await expect(
      handleGmailSyncJobs([
        {
          id: 'fixture',
          data: { userId, claim: 'queued:fixture', trigger: 'scheduled' },
          retryCount: 2,
          retryLimit: 3,
        } as JobWithMetadata<GmailSyncJobData>,
      ]),
    ).rejects.toBe(error);
    expect(gmailSync.syncUser).toHaveBeenCalledWith(userId, 'queued:fixture', {
      trigger: 'scheduled',
      jobId: 'fixture',
      retryCount: 2,
      retryLimit: 3,
    });
  },
);
it.each([new GmailAuthError(), new SyncSupersededError()])(
  'acknowledges terminal authentication or obsolete deliveries',
  async (error) => {
    vi.spyOn(gmailSync, 'syncUser').mockRejectedValue(error);
    await expect(
      handleGmailSyncJobs([
        {
          id: 'fixture',
          data: { userId, claim: 'queued:fixture' },
          retryCount: 0,
          retryLimit: 3,
        } as JobWithMetadata<GmailSyncJobData>,
      ]),
    ).resolves.toBeUndefined();
  },
);
it('exposes a typed queue-unavailable failure and releases only its own claim', async () => {
  await prisma.gmailConnection.create({
    data: {
      userId,
      gmailEmail: 'delivery@fixture.test',
      status: 'CONNECTED',
      accessToken: 'fixture',
    },
  });
  mocks.send.mockRejectedValueOnce(new Error('secret transport details'));
  await expect(requestGmailSync(userId)).rejects.toMatchObject({
    code: 'QUEUE_UNAVAILABLE',
    message: 'Sync could not be started. Try again in a moment.',
  });
  expect(await prisma.gmailConnection.findUniqueOrThrow({ where: { userId } })).toMatchObject({
    syncStatus: 'FAILED',
    syncClaim: null,
    syncError: 'QUEUE_UNAVAILABLE',
  });
});
