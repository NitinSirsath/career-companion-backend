import { afterAll, expect, it } from 'vitest';
import { prisma } from '../db/prisma';
import { randomUUID } from 'crypto';
import { getQueue, getStartedQueue, stopQueue, QUEUE_NAMES } from '../services/queue';
import {
  aiResumeJobOptions,
  enqueueAiResume,
  enqueueRelevanceTriage,
  relevanceTriageJobOptions,
} from '../services/enqueue';
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
  expect(QUEUE_NAMES.slice(0, 3)).toEqual([
    'email-processing-job',
    'discord-notification-job',
    'gmail-sync-job',
  ]);
  expect(QUEUE_NAMES[3]).toBe('relevance-triage-job');
  expect(relevanceTriageJobOptions('user-1')).toMatchObject({
    singletonKey: 'triage:user-1',
    startAfter: 10,
  });
  expect(QUEUE_NAMES[4]).toBe('ai-resume-job');
});

it('starts a resume job just after the pause ends, one per user', () => {
  const pauseEndsAt = new Date('2026-10-13T10:00:00.000Z');
  expect(aiResumeJobOptions('user-1', pauseEndsAt)).toMatchObject({
    singletonKey: 'resume:user-1',
    startAfter: new Date('2026-10-13T10:00:02.000Z'),
  });
});

it('keeps one waiting resume job per user and lets a running one queue the next', async () => {
  const queue = await getQueue();
  const userA = `test-resume-a-${randomUUID()}`;
  const userB = `test-resume-b-${randomUUID()}`;
  const inOneMinute = () => new Date(Date.now() + 60_000);

  const firstA = await enqueueAiResume(userA, inOneMinute());
  expect(firstA).toBeTruthy();
  expect(await enqueueAiResume(userA, inOneMinute())).toBeNull();
  expect(await enqueueAiResume(userB, inOneMinute())).toBeTruthy();

  let queuedWhileRunning: string | null = null;
  let ran!: () => void;
  const done = new Promise<void>((resolve) => {
    ran = resolve;
  });
  const workerId = await queue.work<{ userId: string }>(
    'ai-resume-job',
    { batchSize: 1 },
    async (jobs) => {
      if (jobs[0].data.userId !== userA) return;
      // Still busy: the running job queues the try for the end of the next pause.
      queuedWhileRunning = await enqueueAiResume(userA, inOneMinute());
      ran();
    },
  );

  try {
    await prisma.$executeRawUnsafe(
      'UPDATE pgboss.job SET start_after = now() WHERE name = $1 AND id = $2::uuid',
      'ai-resume-job',
      firstA,
    );
    queue.notifyWorker(workerId);
    await Promise.race([
      done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('resume job did not run')), 10_000),
      ),
    ]);
    expect(queuedWhileRunning).toBeTruthy();
  } finally {
    await queue.offWork('ai-resume-job', { id: workerId });
    await prisma.$executeRawUnsafe(
      "DELETE FROM pgboss.job WHERE name = 'ai-resume-job' AND data->>'userId' = ANY($1::text[])",
      [userA, userB],
    );
  }
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
  const activeReached = new Promise<void>((resolve) => {
    active = resolve;
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });

  const workerId = await queue.work<{ userId: string }>(
    'relevance-triage-job',
    { batchSize: 1 },
    async (jobs) => {
      if (jobs[0].data.userId === userA) {
        active();
        await hold;
      }
    },
  );

  try {
    await prisma.$executeRawUnsafe(
      'UPDATE pgboss.job SET start_after = now() WHERE name = $1 AND id = $2::uuid',
      'relevance-triage-job',
      firstA,
    );
    queue.notifyWorker(workerId);
    await Promise.race([
      activeReached,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('triage job did not become active')), 10_000),
      ),
    ]);
    expect(await enqueueRelevanceTriage(userA)).toBeTruthy();
  } finally {
    release();
    await queue.offWork('relevance-triage-job', { id: workerId });
    await prisma.$executeRawUnsafe(
      "DELETE FROM pgboss.job WHERE name = 'relevance-triage-job' AND data->>'userId' = ANY($1::text[])",
      [userA, userB],
    );
  }
});
