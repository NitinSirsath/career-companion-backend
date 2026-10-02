import { GMAIL_SCHEDULE_QUEUE } from '../services/gmailSchedule';
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { getQueue, getStartedQueue, stopQueue, QUEUE_NAMES } from '../services/queue';
import { defaultWorkers, startWorkers } from '../jobs/startWorkers';
import { prisma } from '../db/prisma';
afterAll(async () => {
  if (getStartedQueue()) await getStartedQueue()!.unschedule(GMAIL_SCHEDULE_QUEUE);
  await stopQueue();
});
describe('liveness and worker readiness', () => {
  it('does not start a queue or touch sessions for health and readiness', async () => {
    await stopQueue();
    const health = await request(app).get('/health').set('Cookie', 'cc_session=invalid');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', message: 'Career Companion Backend is healthy.' });
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.workers).toEqual(
      Object.fromEntries([...QUEUE_NAMES, GMAIL_SCHEDULE_QUEUE].map((n) => [n, 'not_registered'])),
    );
    for (const res of [health, ready]) {
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(getStartedQueue()).toBeUndefined();
  });
  it('tracks real worker registration rather than queue startup alone', async () => {
    const queue = await getQueue();
    expect((await request(app).get('/ready')).status).toBe(503);
    await prisma.$executeRawUnsafe('DELETE FROM pgboss.job');
    expect(await startWorkers(defaultWorkers())).toBe(true);
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(ready.body.workers).toEqual(
      Object.fromEntries([...QUEUE_NAMES, GMAIL_SCHEDULE_QUEUE].map((n) => [n, 'registered'])),
    );
    await queue.offWork('discord-notification-job', { wait: true });
    const stopped = await request(app).get('/ready');
    expect(stopped.status).toBe(503);
    expect(stopped.body.workers['discord-notification-job']).toBe('not_registered');
    expect(stopped.body.workers['gmail-sync-job']).toBe('registered');
  });
});
