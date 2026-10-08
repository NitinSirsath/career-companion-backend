import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';

describe('request context', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds X-Request-Id to every response', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the same request ID for a failing request log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await request(app)
      .post('/api/auth/connect')
      .set('Content-Type', 'application/json')
      .send('{');

    const lines = spy.mock.calls.map((call) => String(call[0]));
    const failed = lines
      .map((value) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })
      .find((value) => value?.event === 'request_failed');

    expect(failed).toMatchObject({
      event: 'request_failed',
      path: '/api/auth/connect',
      status: 400,
      requestId: response.headers['x-request-id'],
    });
  });
});
