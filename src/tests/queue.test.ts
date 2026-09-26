import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { getQueue, stopQueue } from '../services/queue';
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
