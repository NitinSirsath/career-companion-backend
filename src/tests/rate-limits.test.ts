import crypto from 'crypto';
import { Server } from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { createIntegrationToken } from '../services/integrationTokens';
import { addressKind } from '../middleware/clientAddressCheck';
import {
  MCP_ADDRESS_PER_MINUTE,
  MCP_TOKEN_PER_MINUTE,
  SIGN_IN_PER_MINUTE,
  SIGNED_IN_PER_MINUTE,
  SIGNED_OUT_PER_MINUTE,
} from '../middleware/rateLimits';
import { parseMAIL_DAILY_REPLY_LIMIT, parseRATE_LIMITS } from '../utils/config';

const DOMAIN = '@rate-limits.test';
let owner: string;
/** One server for the whole file: hundreds of requests, without a new server for each. */
let server: Server;
let address = 0;
/** A network address of its own for each test: the limits count per address. */
const nextAddress = () => `203.0.113.${(address += 1)}`;
const from = (ip: string) => ({ 'X-Forwarded-For': ip });
const signSid = (sid: string, secret: string) =>
  `${sid}.${crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '')}`;

async function sessionCookie(userId: string) {
  const sid = crypto.randomUUID();
  await prisma.session.create({
    data: {
      sid,
      sess: { cookie: { originalMaxAge: 86_400_000, httpOnly: true, path: '/' }, userId },
      expire: new Date(Date.now() + 86_400_000),
    },
  });
  return `cc_session=${encodeURIComponent(`s:${signSid(sid, process.env.SESSION_SECRET!)}`)}`;
}

async function statuses(count: number, send: () => request.Test) {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push((await send()).status);
  return out;
}

beforeAll(async () => {
  app.set('trust proxy', 1);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  owner = (await prisma.user.create({ data: { email: `owner${DOMAIN}` } })).id;
});
beforeEach(() => {
  vi.stubEnv('RATE_LIMITS', 'on');
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  app.set('trust proxy', false);
  await new Promise((r) => server.close(r));
  await prisma.session.deleteMany({ where: { sess: { path: ['userId'], equals: owner } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('request limits', () => {
  it('counts signed-out requests per network address and says how long to wait', async () => {
    const ip = nextAddress();
    const allowed = await statuses(SIGNED_OUT_PER_MINUTE, () =>
      request(server).get('/api/app-mode').set(from(ip)),
    );
    expect(new Set(allowed)).toEqual(new Set([200]));
    const refused = await request(server).get('/api/app-mode').set(from(ip));
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(refused.body.error.message).toBe('Too many requests. Wait a minute and try again.');
    expect(refused.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Another address is not affected.
    expect((await request(server).get('/api/app-mode').set(from(nextAddress()))).status).toBe(200);
  });

  it('counts signed-in requests per user, whatever the address', async () => {
    const cookie = await sessionCookie(owner);
    const read = () =>
      request(server).get('/api/auth/me').set('Cookie', cookie).set(from(nextAddress()));
    const allowed = await statuses(SIGNED_IN_PER_MINUTE, read);
    expect(new Set(allowed)).toEqual(new Set([200]));
    expect((await read()).status).toBe(429);
  }, 60_000);

  it('counts the sign-in routes on their own, per network address', async () => {
    const ip = nextAddress();
    const allowed = await statuses(SIGN_IN_PER_MINUTE, () =>
      request(server).get('/api/auth/connect').set(from(ip)),
    );
    expect(new Set(allowed)).toEqual(new Set([302]));
    const refused = await request(server).get('/api/auth/connect').set(from(ip));
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('TOO_MANY_REQUESTS');
    // The other auth routes do not count against sign-in.
    expect((await request(server).get('/api/auth/me').set(from(ip))).status).toBe(401);
  });

  it('turns every limit off with RATE_LIMITS=off', async () => {
    vi.stubEnv('RATE_LIMITS', 'off');
    const ip = nextAddress();
    const all = await statuses(SIGNED_OUT_PER_MINUTE + 5, () =>
      request(server).get('/api/app-mode').set(from(ip)),
    );
    expect(new Set(all)).toEqual(new Set([200]));
  });

  it('leaves health checks alone', async () => {
    const ip = nextAddress();
    const all = await statuses(SIGNED_OUT_PER_MINUTE + 5, () =>
      request(server).get('/health').set(from(ip)),
    );
    expect(new Set(all)).toEqual(new Set([200]));
  });
});

describe('request limits on /mcp', () => {
  const mcp = (ip: string, bearer?: string) => {
    const req = request(server)
      .post('/mcp')
      .set(from(ip))
      .set('Accept', 'application/json, text/event-stream');
    return (bearer ? req.set('Authorization', `Bearer ${bearer}`) : req).send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
  };

  it('counts per network address before the token check', async () => {
    const ip = nextAddress();
    const refusedByToken = await statuses(MCP_ADDRESS_PER_MINUTE, () => mcp(ip));
    expect(new Set(refusedByToken)).toEqual(new Set([401]));
    const refused = await mcp(ip);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many requests. Wait a minute and try again.' },
      id: null,
    });
  });

  it('counts per token after the token check', async () => {
    await prisma.integrationToken.deleteMany({ where: { userId: owner } });
    const { plaintextToken } = await createIntegrationToken(owner, { name: 'limits' });
    const allowed = await statuses(MCP_TOKEN_PER_MINUTE, () => mcp(nextAddress(), plaintextToken));
    expect(allowed.every((status) => status !== 429)).toBe(true);
    expect((await mcp(nextAddress(), plaintextToken)).status).toBe(429);
  });
});

describe('password sign-in bursts', () => {
  it('checks at most 20 passwords from one address, even when the tries arrive at once', async () => {
    vi.stubEnv('RATE_LIMITS', 'off');
    const ip = nextAddress();
    await prisma.loginAttempt.deleteMany({ where: { ip } });
    const answers = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        request(server)
          .post('/api/auth/login')
          .set(from(ip))
          .send({ email: `burst${i}${DOMAIN}`, password: 'wrong-password-123' }),
      ),
    );
    const codes = answers.map((res) => res.body.error?.code);
    const checked = codes.filter((code) => code === 'INVALID_CREDENTIALS').length;
    const refused = codes.filter((code) => code === 'TOO_MANY_ATTEMPTS').length;
    expect(checked + refused).toBe(30);
    expect(checked).toBeLessThanOrEqual(20);
    await prisma.loginAttempt.deleteMany({ where: { ip } });
  });

  it('keeps no try of a refused attempt and forgets a right one', async () => {
    vi.stubEnv('RATE_LIMITS', 'off');
    const ip = nextAddress();
    const email = `owner${DOMAIN}`;
    const { hashPassword } = await import('../utils/passwordHash');
    await prisma.user.update({
      where: { id: owner },
      data: { passwordHash: await hashPassword('right-password-123') },
    });
    await prisma.loginAttempt.deleteMany({ where: { email } });
    const wrong = await request(server)
      .post('/api/auth/login')
      .set(from(ip))
      .send({ email, password: 'wrong-password-123' });
    expect(wrong.status).toBe(401);
    expect(await prisma.loginAttempt.count({ where: { email } })).toBe(1);
    const right = await request(server)
      .post('/api/auth/login')
      .set(from(ip))
      .send({ email, password: 'right-password-123' });
    expect(right.status).toBe(200);
    expect(await prisma.loginAttempt.count({ where: { email } })).toBe(0);
  });
});

describe('request bodies the server cannot read', () => {
  it('answers 413 for a body over the limit', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email: `big${DOMAIN}`, password: 'x'.repeat(300_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('settings and the address check', () => {
  it('reads RATE_LIMITS and MAIL_DAILY_REPLY_LIMIT', () => {
    expect(parseRATE_LIMITS('on')).toBe(true);
    expect(parseRATE_LIMITS('off')).toBe(false);
    expect(parseRATE_LIMITS('')).toBe(false); // tests run without limits unless they turn them on
    expect(() => parseRATE_LIMITS('yes')).toThrow('RATE_LIMITS must be on or off');
    expect(parseMAIL_DAILY_REPLY_LIMIT(undefined)).toBe(50);
    expect(parseMAIL_DAILY_REPLY_LIMIT('0')).toBe(0);
    expect(() => parseMAIL_DAILY_REPLY_LIMIT('1001')).toThrow();
  });

  it('tells public, private and missing addresses apart without naming them', () => {
    expect(addressKind('203.0.113.7')).toBe('public');
    expect(addressKind('::ffff:203.0.113.7')).toBe('public');
    expect(addressKind('2001:4860:4860::8888')).toBe('public');
    for (const inside of [
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '100.64.3.4',
      '127.0.0.1',
      '::1',
      'fd00::1',
    ])
      expect(addressKind(inside)).toBe('private');
    expect(addressKind(undefined)).toBe('missing');
    expect(addressKind('not an address')).toBe('missing');
  });
});
