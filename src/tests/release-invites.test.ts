import { Server } from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { AdminInvitesResponseSchema, InviteResponseSchema } from '../contracts/invites';
import { INVITE_PER_DAY, INVITE_PER_MINUTE, inviteLimits } from '../middleware/rateLimits';
import { RELEASE_INVITES_MAX } from '../services/releaseInvites';

const DOMAIN = 'release-invites.test';
const ADMIN = `owner@${DOMAIN}`;
const USER = `user@${DOMAIN}`;
const as = (email: string) => ({ 'X-Development-User': email });
const ask = (body: Record<string, unknown>) => request(app).post('/api/invites').send(body);
const invites = () =>
  prisma.releaseInvite.findMany({
    where: { email: { endsWith: `@${DOMAIN}` } },
    orderBy: { createdAt: 'asc' },
  });

const clean = async () => {
  await prisma.releaseInvite.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
};

beforeEach(async () => {
  await clean();
  vi.stubEnv('ADMIN_EMAILS', ADMIN);
  await prisma.user.create({ data: { email: ADMIN } });
  await prisma.user.create({ data: { email: USER } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(clean);

describe('POST /api/invites', () => {
  it('saves the email, lower case, with where the person heard about NorthList', async () => {
    const answer = await ask({ email: `  Ada@${DOMAIN.toUpperCase()} `, source: 'LINKEDIN' });
    expect(answer.status).toBe(200);
    expect(InviteResponseSchema.parse(answer.body)).toEqual({ saved: true });
    expect(await invites()).toMatchObject([
      { email: `ada@${DOMAIN}`, source: 'LINKEDIN', otherSource: null },
    ]);
  });

  it('keeps the person’s own words with Other', async () => {
    const answer = await ask({
      email: `bo@${DOMAIN}`,
      source: 'OTHER',
      otherSource: ' A podcast ',
    });
    expect(answer.status).toBe(200);
    expect(await invites()).toMatchObject([{ source: 'OTHER', otherSource: 'A podcast' }]);
  });

  it('gives the same answer for the same email again and keeps the first request', async () => {
    await ask({ email: `cy@${DOMAIN}`, source: 'FRIEND' });
    const [first] = await invites();
    const again = await ask({ email: `CY@${DOMAIN}`, source: 'X' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ saved: true });
    expect(await invites()).toEqual([first]);
  });

  it('refuses a wrong email, an unknown source, Other without words, words without Other and extra fields', async () => {
    const wrong = [
      { email: 'not-an-email', source: 'FRIEND' },
      { email: `dee@${DOMAIN}`, source: 'TV' },
      { email: `dee@${DOMAIN}`, source: 'OTHER' },
      { email: `dee@${DOMAIN}`, source: 'OTHER', otherSource: '   ' },
      { email: `dee@${DOMAIN}`, source: 'FRIEND', otherSource: 'A podcast' },
      { email: `dee@${DOMAIN}`, source: 'OTHER', otherSource: 'x'.repeat(101) },
      { email: `dee@${DOMAIN}`, source: 'FRIEND', name: 'Dee' },
      { source: 'FRIEND' },
    ];
    for (const body of wrong) {
      const answer = await ask(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error.code).toBe('VALIDATION_ERROR');
      // The answer never repeats what was sent.
      expect(JSON.stringify(answer.body)).not.toContain('dee@');
    }
    expect(await invites()).toEqual([]);
  });

  it('works signed out and signed in alike', async () => {
    expect((await ask({ email: `eve@${DOMAIN}`, source: 'SEARCH' }).set(as(USER))).status).toBe(
      200,
    );
    expect(await invites()).toHaveLength(1);
  });

  it('stops saving new emails once the list is full, with words to show', async () => {
    vi.spyOn(prisma.releaseInvite, 'count').mockResolvedValue(RELEASE_INVITES_MAX);
    const answer = await ask({ email: `fay@${DOMAIN}`, source: 'YOUTUBE' });
    expect(answer.status).toBe(503);
    expect(answer.body.error).toMatchObject({
      code: 'INVITE_LIST_FULL',
      message: 'We could not save your request. Write to us instead.',
    });
    expect(await invites()).toEqual([]);
  });
});

describe('request limits for invites', () => {
  let server: Server;
  let address = 0;
  const nextAddress = () => `198.51.100.${(address += 1)}`;

  beforeAll(async () => {
    app.set('trust proxy', 1);
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
  });
  afterAll(async () => {
    app.set('trust proxy', false);
    await new Promise((r) => server.close(r));
  });

  it('allows a few per network address a minute and a day', async () => {
    expect([INVITE_PER_MINUTE, INVITE_PER_DAY]).toEqual([5, 20]);
    expect(inviteLimits).toHaveLength(2);
    vi.stubEnv('RATE_LIMITS', 'on');
    const ip = nextAddress();
    const send = (n: number) =>
      request(server)
        .post('/api/invites')
        .set('X-Forwarded-For', ip)
        .send({ email: `limit${n}@${DOMAIN}`, source: 'FRIEND' });
    for (let n = 0; n < INVITE_PER_MINUTE; n += 1) expect((await send(n)).status).toBe(200);
    const refused = await send(99);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(await invites()).toHaveLength(INVITE_PER_MINUTE);
    // Another address is not affected.
    const other = await request(server)
      .post('/api/invites')
      .set('X-Forwarded-For', nextAddress())
      .send({ email: `other@${DOMAIN}`, source: 'FRIEND' });
    expect(other.status).toBe(200);
  });
});

describe('GET /api/admin/invites', () => {
  it('answers 404 to anyone but the admin', async () => {
    expect((await request(app).get('/api/admin/invites')).status).toBe(404);
    expect((await request(app).get('/api/admin/invites').set(as(USER))).status).toBe(404);
  });

  it('lists every request, newest first, with the source and the date', async () => {
    await prisma.releaseInvite.createMany({
      data: [
        { email: `old@${DOMAIN}`, source: 'FRIEND', createdAt: new Date('2026-11-20T10:00:00Z') },
        {
          email: `new@${DOMAIN}`,
          source: 'OTHER',
          otherSource: 'A podcast',
          createdAt: new Date('2026-11-22T10:00:00Z'),
        },
      ],
    });
    const answer = await request(app).get('/api/admin/invites').set(as(ADMIN));
    expect(answer.status).toBe(200);
    const mine = AdminInvitesResponseSchema.parse(answer.body).invites.filter((row) =>
      row.email.endsWith(`@${DOMAIN}`),
    );
    expect(mine).toEqual([
      {
        email: `new@${DOMAIN}`,
        source: 'OTHER',
        otherSource: 'A podcast',
        createdAt: '2026-11-22T10:00:00.000Z',
      },
      {
        email: `old@${DOMAIN}`,
        source: 'FRIEND',
        otherSource: null,
        createdAt: '2026-11-20T10:00:00.000Z',
      },
    ]);
  });
});
