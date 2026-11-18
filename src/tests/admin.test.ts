import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/notifications/ownerAlert', () => ({ sendOwnerAlert: vi.fn() }));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { AdminFreeAIMoneySchema, AdminOverviewSchema } from '../contracts/admin';
import { UserProfileSchema } from '../contracts/auth';
import { sendOwnerAlert } from '../services/notifications/ownerAlert';
import { createIntegrationToken, verifyIntegrationToken } from '../services/integrationTokens';
import { parseADMIN_EMAILS } from '../utils/config';

const DOMAIN = 'admin-page.test';
const ADMIN = `owner@${DOMAIN}`;
const USER = `user@${DOMAIN}`;
const OTHER = `other@${DOMAIN}`;

const as = (email: string) => ({ 'X-Development-User': email });
const ids: Record<string, string> = {};

async function makeUser(email: string, extra: Record<string, unknown> = {}) {
  const user = await prisma.user.create({ data: { email, name: email.split('@')[0], ...extra } });
  ids[email] = user.id;
  return user;
}

beforeEach(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  vi.stubEnv('ADMIN_EMAILS', ADMIN);
  vi.mocked(sendOwnerAlert).mockReset();
  await makeUser(ADMIN);
  await makeUser(USER);
  await makeUser(OTHER);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
});

describe('ADMIN_EMAILS setting', () => {
  it('is a comma list of emails, lower-cased; empty means nobody', () => {
    expect(parseADMIN_EMAILS(undefined)).toEqual([]);
    expect(parseADMIN_EMAILS(' ')).toEqual([]);
    expect(parseADMIN_EMAILS('A@x.com, b@y.org')).toEqual(['a@x.com', 'b@y.org']);
    expect(() => parseADMIN_EMAILS('a@x.com,nope')).toThrow('ADMIN_EMAILS');
  });
});

describe('who may open the Admin page', () => {
  it('answers 404 to a signed-out request, a normal user, and everyone when ADMIN_EMAILS is empty', async () => {
    expect((await request(app).get('/api/admin')).status).toBe(404);
    expect((await request(app).get('/api/admin').set(as(USER))).status).toBe(404);
    vi.stubEnv('ADMIN_EMAILS', '');
    expect((await request(app).get('/api/admin').set(as(ADMIN))).status).toBe(404);
  });

  it('marks the admin in the profile, and nobody else', async () => {
    const admin = await request(app).get('/api/auth/me').set(as(ADMIN));
    expect(UserProfileSchema.parse(admin.body)).toMatchObject({ admin: true, suspension: null });
    const user = await request(app).get('/api/auth/me').set(as(USER));
    expect(user.body).toMatchObject({ admin: false });
  });
});

describe('GET /api/admin', () => {
  it('lists every account with its facts and counts, and never a mail', async () => {
    const day = new Date().toISOString().slice(0, 10);
    await prisma.gmailConnection.create({
      data: {
        userId: ids[USER],
        gmailEmail: USER,
        status: 'CONNECTED',
        syncStatus: 'FAILED',
        accessToken: 'x',
      },
    });
    await prisma.gmailConnection.create({
      data: { userId: ids[OTHER], gmailEmail: OTHER, status: 'REVOKED', accessToken: 'x' },
    });
    await prisma.aIUsageDay.create({ data: { userId: ids[USER], day, calls: 7 } });
    await prisma.mailScanDay.create({ data: { userId: ids[USER], day, count: 12 } });
    const email = await prisma.email.create({
      data: {
        userId: ids[USER],
        gmailMessageId: 'admin-page-1',
        threadId: 'admin-page-1',
        subject: 'Secret subject',
        sender: 'secret@sender.test',
        receivedAt: new Date(),
      },
    });
    await prisma.aIOperation.create({
      data: { emailId: email.id, operation: 'relevance', version: 'v1', status: 'FAILED' },
    });

    const res = await request(app).get('/api/admin').set(as(ADMIN));
    expect(res.status).toBe(200);
    const overview = AdminOverviewSchema.parse(res.body);
    expect(JSON.stringify(res.body)).not.toMatch(/Secret subject|secret@sender/);
    expect(overview.aiCallsByDay).toHaveLength(14);
    expect(overview.aiCallsByDay.at(-1)).toEqual({ day, calls: 7 });
    const byEmail = Object.fromEntries(overview.accounts.map((a) => [a.email, a]));
    expect(byEmail[ADMIN]).toMatchObject({ self: true, gmail: { state: 'NOT_CONNECTED' } });
    expect(byEmail[USER]).toMatchObject({
      self: false,
      gmail: { state: 'SYNC_FAILING' },
      aiFailedLast24h: 1,
      mailsChecked30d: 12,
      applications: 0,
      suspension: null,
    });
    expect(byEmail[OTHER].gmail.state).toBe('ACCESS_REMOVED');
  });

  it('records "last active" on a signed-in request, at most once an hour', async () => {
    await request(app).get('/api/auth/me').set(as(USER));
    const first = (await prisma.user.findUniqueOrThrow({ where: { id: ids[USER] } })).lastActiveAt;
    expect(first).not.toBeNull();
    await request(app).get('/api/auth/me').set(as(USER));
    const second = (await prisma.user.findUniqueOrThrow({ where: { id: ids[USER] } })).lastActiveAt;
    expect(second).toEqual(first);
  });
});

describe('suspend and resume', () => {
  const suspend = (email: string, reason = 'Too many replies sent in one hour.') =>
    request(app).post(`/api/admin/accounts/${ids[email]}/suspend`).set(as(ADMIN)).send({ reason });

  it("needs a reason and refuses the admin's own account", async () => {
    expect((await suspend(USER, '  ')).status).toBe(400);
    const self = await suspend(ADMIN);
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('CANNOT_SUSPEND_SELF');
  });

  it('lets a suspended user see only the profile and the resume request', async () => {
    const res = await suspend(USER);
    expect(res.status).toBe(200);
    expect(res.body.account.suspension).toMatchObject({
      reason: 'Too many replies sent in one hour.',
      request: null,
    });

    const blocked = await request(app).get('/api/dashboard').set(as(USER));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');
    const me = await request(app).get('/api/auth/me').set(as(USER));
    expect(me.status).toBe(200);
    expect(me.body.suspension.reason).toBe('Too many replies sent in one hour.');

    const sent = await request(app)
      .post('/api/auth/resume-request')
      .set(as(USER))
      .send({ text: 'My brother used my login. Please turn it back on.' });
    expect(sent.status).toBe(200);
    expect(sent.body.suspension.request.text).toBe(
      'My brother used my login. Please turn it back on.',
    );
    await request(app).post('/api/auth/resume-request').set(as(USER)).send({ text: 'Changed.' });
    // The owner is told once, with no email and no text in the message.
    expect(sendOwnerAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendOwnerAlert).mock.calls[0][0]).not.toMatch(/user@|brother/);

    const overview = AdminOverviewSchema.parse(
      (await request(app).get('/api/admin').set(as(ADMIN))).body,
    );
    expect(overview.accounts.find((a) => a.email === USER)?.suspension?.request?.text).toBe(
      'Changed.',
    );

    const resumed = await request(app)
      .post(`/api/admin/accounts/${ids[USER]}/resume`)
      .set(as(ADMIN));
    expect(resumed.body.account.suspension).toBeNull();
    expect((await request(app).get('/api/dashboard').set(as(USER))).status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: ids[USER] } });
    expect(row).toMatchObject({
      suspendReason: null,
      resumeRequest: null,
      resumeRequestedAt: null,
    });
  });

  it('refuses a resume request from an account that is not suspended', async () => {
    const res = await request(app)
      .post('/api/auth/resume-request')
      .set(as(USER))
      .send({ text: 'Hi' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_SUSPENDED');
  });

  it('a suspended admin cannot open the Admin page', async () => {
    await prisma.user.update({ where: { id: ids[ADMIN] }, data: { suspendedAt: new Date() } });
    expect((await request(app).get('/api/admin').set(as(ADMIN))).status).toBe(404);
  });

  it('stops NorthList Apply tokens, and Resume lets them work again', async () => {
    const { plaintextToken: token } = await createIntegrationToken(ids[USER], { name: 'Agent' });
    await suspend(USER);
    expect(await verifyIntegrationToken(token)).toBeNull();

    await request(app).post(`/api/admin/accounts/${ids[USER]}/resume`).set(as(ADMIN));
    expect(await verifyIntegrationToken(token)).toMatchObject({ userId: ids[USER] });
  });
});

describe('GET /api/admin/free-ai-money', () => {
  const money = async () =>
    AdminFreeAIMoneySchema.parse(
      (await request(app).get('/api/admin/free-ai-money').set(as(ADMIN))).body,
    );

  it('says NO_KEY when the free AI key is not set', async () => {
    vi.stubEnv('FREE_AI_OPENROUTER_KEY', '');
    expect(await money()).toEqual({ state: 'NO_KEY' });
  });

  it('shows what the key spent today and this month, and what is left under its limit', async () => {
    vi.stubEnv('FREE_AI_OPENROUTER_KEY', 'sk-or-v1-fixture');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            limit: 10,
            limit_remaining: 6.18,
            usage_daily: 0.42,
            usage_monthly: 3.1,
            usage: 3.82,
          },
        }),
        { status: 200 },
      ),
    );
    expect(await money()).toEqual({
      state: 'OK',
      todayUsd: 0.42,
      monthUsd: 3.1,
      limitUsd: 10,
      leftUsd: 6.18,
    });
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/key');
  });

  it('shows no "left" when the key has no limit, and UNAVAILABLE when OpenRouter fails', async () => {
    vi.stubEnv('FREE_AI_OPENROUTER_KEY', 'sk-or-v1-fixture');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { limit: null, limit_remaining: null, usage_daily: 0, usage_monthly: 1 },
        }),
        { status: 200 },
      ),
    );
    expect(await money()).toMatchObject({ state: 'OK', limitUsd: null, leftUsd: null });
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect(await money()).toEqual({ state: 'UNAVAILABLE' });
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    expect(await money()).toEqual({ state: 'UNAVAILABLE' });
  });
});
