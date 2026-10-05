import { afterAll, expect, it } from 'vitest';
import { prisma } from '../db/prisma';
import { randomUUID } from 'crypto';
import { getQueue, getStartedQueue, stopQueue, QUEUE_NAMES } from '../services/queue';
import { enqueueRelevanceTriage, relevanceTriageJobOptions } from '../jobs/relevanceTriageJob';
it('shares initialization and throttles duplicate jobs using PostgreSQL', async () => {
  const [a, b] = await Promise.all([getQueue(), getQueue()]);
  expect(a).toBe(b);
  const key = `test-${randomUUID()}`;
  const options = { singletonKey: key, singletonSeconds: 300 };
  const ids = await Promise.all([
    a.send('email-processing-job', { userId: 'test', emailId: 'test' }, options),
    b.send('email-processing-job', { userId: 'test', emailId: 'test' }, options),
  ]);
  expect(ids.filter(Boolean)).toHaveLength(1);
  await a.cancel('email-processing-job', ids.find(Boolean)!);
});
afterAll(() => stopQueue());

it('discards failed queue initialization and starts afresh on recovery', async () => {
  await stopQueue();
  const original = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL =
      'postgresql://cc:x@127.0.0.1:1/career_companion_closed_test?schema=public';
    await expect(getQueue()).rejects.toThrow();
    expect(getStartedQueue()).toBeUndefined();
  } finally {
    process.env.DATABASE_URL = original;
  }
  const queue = await getQueue();
  expect(getStartedQueue()).toBe(queue);
});

it('keeps existing queue positions and configures triage as a ten-second per-user singleton', () => {
  expect(QUEUE_NAMES.slice(0, 3)).toEqual(['email-processing-job', 'discord-notification-job', 'gmail-sync-job']);
  expect(QUEUE_NAMES[3]).toBe('relevance-triage-job');
  expect(relevanceTriageJobOptions('user-1')).toMatchObject({ singletonKey: 'triage:user-1', startAfter: 10 });
});


it('deduplicates triage jobs per user across queued and active states', async () => {
  const queue = await getQueue();
  const userA = `test-triage-a-${randomUUID()}`;
  const userB = `test-triage-b-${randomUUID()}`;

  const firstA = await enqueueRelevanceTriage(userA);
  expect(firstA).toBeTruthy();
  expect(await enqueueRelevanceTriage(userA)).toBeNull();
  expect(await enqueueRelevanceTriage(userB)).toBeTruthy();

  let active!: () => void;
  const activeReached = new Promise<void>((resolve) => { active = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });

  const workerId = await queue.work('relevance-triage-job', { batchSize: 1 }, async (jobs) => {
    if (jobs[0].data.userId === userA) {
      active();
      await hold;
    }
  });

  try {
    await prisma.$executeRawUnsafe(
      'UPDATE pgboss.job SET start_after = now() WHERE name = $1 AND id = $2',
      'relevance-triage-job',
      firstA,
    );
    queue.notifyWorker(workerId);
    await Promise.race([
      activeReached,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('triage job did not become active')), 10_000)),
    ]);
    expect(await enqueueRelevanceTriage(userA)).toBeTruthy();
  } finally {
    release();
    await queue.offWork({ id: workerId });
  }
});
