import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db/prisma';
import { app } from '../index';

const EMAIL = 'request-context@audit.test';
let userId: string;

beforeAll(async () => {
  process.env.ENABLE_DEV_AUTH = 'true';
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  userId = (await prisma.user.create({ data: { email: EMAIL } })).id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function capture() {
  const lines: string[] = [];
  for (const method of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  }
  return () =>
    lines
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('request context', () => {
  it('adds X-Request-Id to every response', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs a failed request once, with its path, status, user and request ID', async () => {
    const logs = capture();
    const response = await request(app)
      .put('/api/ai/settings?source=test')
      .set('X-Development-User', EMAIL)
      .send({ provider: 42 });

    const failed = logs().filter((line) => line.event === 'request_failed');
    expect(failed).toEqual([
      expect.objectContaining({
        level: 'error',
        method: 'PUT',
        path: '/api/ai/settings',
        status: response.status,
        userId,
        requestId: response.headers['x-request-id'],
        category: 'ZodError',
      }),
    ]);
    expect(response.status).toBe(400);
  });

  it('logs a rejected request as a warning and stays quiet for a logged-out one', async () => {
    const logs = capture();
    const missing = await request(app).get('/api/ai/nothing-here').set('X-Development-User', EMAIL);
    await request(app).get('/api/ai/settings');

    const completed = logs().filter((line) => line.event === 'request_completed');
    expect(completed).toEqual([
      expect.objectContaining({
        level: 'warn',
        path: '/api/ai/nothing-here',
        status: 404,
        requestId: missing.headers['x-request-id'],
      }),
    ]);
  });
});
