import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { frontendUrl } from '../utils/config';

describe('safety headers', () => {
  it('sends them on health, API, MCP and unknown paths, and never names Express', async () => {
    const answers = await Promise.all([
      request(app).get('/health'),
      request(app).get('/api/app-mode'),
      request(app).get('/mcp'),
      request(app).get('/api/no-such-path'),
    ]);
    for (const res of answers) {
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
    for (const res of answers.slice(0, 3))
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none';frame-ancestors 'none'",
      );
    // Express's own 404 page replaces the policy with its stricter "default-src 'none'".
    expect(answers[3].status).toBe(404);
    expect(answers[3].headers['content-security-policy']).toBe("default-src 'none'");
  });

  it('keeps cookie calls from the app working', async () => {
    const res = await request(app).get('/api/app-mode').set('Origin', frontendUrl());
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(frontendUrl());
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});
