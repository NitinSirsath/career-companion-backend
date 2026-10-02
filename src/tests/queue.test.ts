import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { getQueue, getStartedQueue, stopQueue } from '../services/queue';
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
