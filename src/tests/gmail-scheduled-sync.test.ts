import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../db/prisma';
import { runScheduledGmailSync } from '../jobs/gmailScheduledSyncJob';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../services/queue', () => ({ getQueue: async () => ({ send: mocks.send }) }));
const now = new Date('2026-10-02T12:31:00Z');
let ids: string[] = [];
beforeAll(async () => {
  for (let i = 0; i < 5; i++)
    ids.push((await prisma.user.create({ data: { email: `scheduled-${i}@fixture.test` } })).id);
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
beforeEach(async () => {
  mocks.send.mockReset().mockResolvedValue('fixture-job');
  await prisma.gmailConnection.deleteMany({ where: { userId: { in: ids } } });
  for (const [i, userId] of ids.entries())
    await prisma.gmailConnection.create({
      data: {
        userId,
        gmailEmail: `scheduled-${i}@fixture.test`,
        accessToken: 'fixture',
        status: i === 3 ? 'REVOKED' : i === 4 ? 'NOT_CONNECTED' : 'CONNECTED',
        lastSyncedAt: i === 1 ? now : null,
        ...(i === 2
          ? {
              syncStatus: 'SYNCING',
              syncClaim: 'manual',
              syncLeaseUntil: new Date(Date.now() + 60000),
            }
          : {}),
      },
    });
});
it('skips recent, busy and disconnected users, including duplicate fan-outs', async () => {
  const before = await prisma.gmailConnection.findUnique({ where: { userId: ids[2] } });
  const counts = await runScheduledGmailSync('startup', now);
  expect(counts).toEqual({
    connected: 3,
    requested: 1,
    skippedRecent: 1,
    skippedBusy: 1,
    skippedRevoked: 1,
    failed: 0,
  });
  await runScheduledGmailSync('schedule', now);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send).toHaveBeenCalledWith(
    'gmail-sync-job',
    expect.objectContaining({ userId: ids[0], trigger: 'scheduled' }),
    expect.anything(),
  );
  expect(await prisma.gmailConnection.findUnique({ where: { userId: ids[2] } })).toEqual(before);
});
it('continues after a user queue failure then rejects for retry', async () => {
  await prisma.gmailConnection.update({ where: { userId: ids[1] }, data: { lastSyncedAt: null } });
  mocks.send.mockRejectedValueOnce(new Error('fixture failure'));
  await expect(runScheduledGmailSync('schedule', now)).rejects.toThrow('requests failed');
  expect(mocks.send).toHaveBeenCalledTimes(2);
  await runScheduledGmailSync('schedule', now);
  expect(mocks.send).toHaveBeenCalledTimes(3);
});
