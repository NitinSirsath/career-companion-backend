import { afterAll, expect, it } from 'vitest';
import { getQueue, stopQueue } from '../services/queue';
import {
  GMAIL_SCHEDULE_QUEUE,
  isGmailScheduleRegistered,
  nextScheduledSyncAt,
} from '../services/gmailSchedule';
import { startGmailScheduledSync } from '../jobs/gmailScheduledSyncJob';
import { prisma } from '../db/prisma';
afterAll(async () => {
  const boss = await getQueue();
  await boss.unschedule(GMAIL_SCHEDULE_QUEUE);
  await stopQueue();
  await prisma.$executeRawUnsafe('DELETE FROM pgboss.job');
});
it('registers one durable schedule, one worker and one catch-up; disabling removes it', async () => {
  const boss = await getQueue();
  await prisma.$executeRawUnsafe('DELETE FROM pgboss.job');
  expect(nextScheduledSyncAt(true)).toBeNull();
  await startGmailScheduledSync();
  await startGmailScheduledSync();
  expect(await boss.getSchedule(GMAIL_SCHEDULE_QUEUE)).toMatchObject({
    cron: '0 0,18 * * *',
    timezone: 'Asia/Kolkata',
    options: expect.objectContaining({ missed: 'once' }),
  });
  expect(boss.getWipData().filter((w) => w.name === GMAIL_SCHEDULE_QUEUE)).toHaveLength(1);
  expect(
    await prisma.$queryRawUnsafe(
      "SELECT count(*)::int AS count FROM pgboss.job WHERE name='gmail-scheduled-sync-job' AND data->>'source'='startup'",
    ),
  ).toEqual([{ count: 1 }]);
  expect(isGmailScheduleRegistered()).toBe(true);
  expect(nextScheduledSyncAt(true)).toMatch(/^\d{4}-/);
  expect(nextScheduledSyncAt(false)).toBeNull();
  await startGmailScheduledSync({ enabled: false, timezone: 'Asia/Kolkata' });
  expect(await boss.getSchedule(GMAIL_SCHEDULE_QUEUE)).toBeNull();
  expect(nextScheduledSyncAt(true)).toBeNull();
});
