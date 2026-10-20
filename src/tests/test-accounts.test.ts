import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { UserProfileSchema } from '../contracts/auth';
import { prisma } from '../db/prisma';
import { ensureTestAccounts, isTestAccountEmail, usesSandbox } from '../services/testAccounts';
import { parseTEST_ACCOUNTS } from '../utils/config';
import { hashPassword, verifyPassword } from '../utils/passwordHash';

const DOMAIN = 'test-accounts.test';
const DEV1 = `dev1@${DOMAIN}`;
const DEV2 = `dev2@${DOMAIN}`;
const REAL = `real@${DOMAIN}`;
const PASSWORD_1 = 'first-long-random-password';
const PASSWORD_2 = 'second-long-random-password';
const REAL_PASSWORD = 'correct horse battery';
const SETTING = `${DEV1}:${PASSWORD_1},${DEV2}:${PASSWORD_2}`;

let real: string;

const userByEmail = (email: string) => prisma.user.findUniqueOrThrow({ where: { email } });
const testLogin = (email: string, password: string, agent = request(app)) =>
  agent.post('/api/auth/test-login').send({ email, password });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  real = (
    await prisma.user.create({
      data: { email: REAL, passwordHash: await hashPassword(REAL_PASSWORD) },
    })
  ).id;
});
beforeEach(async () => {
  vi.stubEnv('TEST_ACCOUNTS', SETTING);
  await prisma.loginAttempt.deleteMany({});
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.loginAttempt.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
});

describe('TEST_ACCOUNTS setting', () => {
  it('reads email:password pairs, and empty means none', () => {
    expect(parseTEST_ACCOUNTS(undefined)).toEqual([]);
    expect(parseTEST_ACCOUNTS(' ')).toEqual([]);
    expect(parseTEST_ACCOUNTS(`DEV1@${DOMAIN}:${PASSWORD_1}`)).toEqual([
      { email: DEV1, password: PASSWORD_1 },
    ]);
    // Only the first colon splits: a password may contain more.
    expect(parseTEST_ACCOUNTS(`${DEV1}:a:b:${PASSWORD_1}`)[0].password).toBe(`a:b:${PASSWORD_1}`);
  });

  it('refuses a bad value at startup', () => {
    expect(() => parseTEST_ACCOUNTS(PASSWORD_1)).toThrow('email:password pairs');
    expect(() => parseTEST_ACCOUNTS(`not-an-email:${PASSWORD_1}`)).toThrow('email:password pairs');
    expect(() => parseTEST_ACCOUNTS(`${DEV1}:short`)).toThrow('16 to 200 characters');
    expect(() => parseTEST_ACCOUNTS(`${SETTING},${DEV1}:${PASSWORD_2}`)).toThrow('twice');
    const six = Array.from({ length: 6 }, (_, i) => `d${i}@${DOMAIN}:${PASSWORD_1}`).join(',');
    expect(() => parseTEST_ACCOUNTS(six)).toThrow('at most 5');
  });

  it('knows a test account by its email, in any letter case', () => {
    expect(isTestAccountEmail(DEV1)).toBe(true);
    expect(isTestAccountEmail(` DEV2@${DOMAIN.toUpperCase()}`)).toBe(true);
    expect(isTestAccountEmail(REAL)).toBe(false);
    vi.stubEnv('TEST_ACCOUNTS', '');
    expect(isTestAccountEmail(DEV1)).toBe(false);
  });
});

describe('creating the test accounts at startup', () => {
  it('creates missing accounts, then updates a changed password and ends its sessions', async () => {
    await ensureTestAccounts();
    const dev1 = await userByEmail(DEV1);
    expect(await verifyPassword(PASSWORD_1, dev1.passwordHash!)).toBe(true);
    expect(await verifyPassword(PASSWORD_2, (await userByEmail(DEV2)).passwordHash!)).toBe(true);

    const agent = request.agent(app);
    expect((await testLogin(DEV1, PASSWORD_1, agent)).status).toBe(200);
    await ensureTestAccounts();
    expect((await agent.get('/api/auth/me')).status).toBe(200);

    vi.stubEnv('TEST_ACCOUNTS', `${DEV1}:a-new-long-random-password`);
    await ensureTestAccounts();
    expect((await userByEmail(DEV1)).id).toBe(dev1.id);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    expect((await testLogin(DEV1, 'a-new-long-random-password')).status).toBe(200);
    vi.stubEnv('TEST_ACCOUNTS', SETTING);
    await ensureTestAccounts();
  });

  it('leaves an account alone that is linked to Google', async () => {
    const linked = `linked@${DOMAIN}`;
    await prisma.user.create({ data: { email: linked, googleId: `google-${DOMAIN}` } });
    vi.stubEnv('TEST_ACCOUNTS', `${linked}:${PASSWORD_1}`);
    await ensureTestAccounts();
    expect((await userByEmail(linked)).passwordHash).toBeNull();
  });
});

describe('signing in', () => {
  beforeAll(async () => {
    vi.stubEnv('TEST_ACCOUNTS', SETTING);
    await ensureTestAccounts();
    vi.unstubAllEnvs();
  });

  it('signs a test account in on the test sign-in, marked as a test account', async () => {
    const agent = request.agent(app);
    const res = await testLogin(DEV2, PASSWORD_2, agent);
    expect(res.status).toBe(200);
    expect(UserProfileSchema.parse(res.body)).toMatchObject({ email: DEV2, testAccount: true });
    expect((await agent.get('/api/auth/me')).body).toMatchObject({ testAccount: true });
  });

  it('keeps the guessing limit and the same answer for a wrong password', async () => {
    const res = await testLogin(DEV2, 'not-the-password-at-all');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses any other email on the test sign-in', async () => {
    const res = await testLogin(REAL, REAL_PASSWORD);
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({
      code: 'NOT_TEST_ACCOUNT',
      message: 'This page is for test accounts only.',
    });
  });

  it('sends a test account from the normal sign-in to its own page', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: DEV1, password: PASSWORD_1 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USE_TEST_LOGIN');
    const realUser = await request(app)
      .post('/api/auth/login')
      .send({ email: REAL, password: REAL_PASSWORD });
    expect(realUser.status).toBe(200);
    expect(realUser.body.testAccount).toBe(false);
  });

  it('does not let a test account set its password in the app', async () => {
    const agent = request.agent(app);
    await testLogin(DEV1, PASSWORD_1, agent);
    const res = await agent
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD_1, newPassword: 'another-long-password' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TEST_ACCOUNT');
  });
});

describe('the mail sandbox outside dev mode', () => {
  const signedIn = async (email: string, password: string) => {
    const agent = request.agent(app);
    const login = email === REAL ? '/api/auth/login' : '/api/auth/test-login';
    expect((await agent.post(login).send({ email, password })).status).toBe(200);
    return agent;
  };

  beforeAll(async () => {
    vi.stubEnv('TEST_ACCOUNTS', SETTING);
    await ensureTestAccounts();
    vi.unstubAllEnvs();
  });

  it('is the mailbox of a test account only', async () => {
    expect(await usesSandbox((await userByEmail(DEV1)).id)).toBe(true);
    expect(await usesSandbox(real)).toBe(false);
    vi.stubEnv('TEST_ACCOUNTS', '');
    expect(await usesSandbox((await userByEmail(DEV1)).id)).toBe(false);
  });

  it('answers a test account and 404 for a real user', async () => {
    const tester = await signedIn(DEV1, PASSWORD_1);
    expect((await tester.get('/api/sandbox/threads')).status).toBe(200);
    const realUser = await signedIn(REAL, REAL_PASSWORD);
    expect((await realUser.get('/api/sandbox/threads')).status).toBe(404);
  });

  it('answers 404 before sign-in when no test accounts are set up', async () => {
    vi.stubEnv('TEST_ACCOUNTS', '');
    expect((await request(app).get('/api/sandbox/threads')).status).toBe(404);
  });

  it('connects a test account to the sandbox mailbox at once, never to Google', async () => {
    const tester = await signedIn(DEV2, PASSWORD_2);
    const res = await tester.get('/api/gmail/connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('google');
    const status = await tester.get('/api/gmail/status');
    expect(status.body).toMatchObject({ connected: true, canSend: true });
    expect((await tester.post('/api/gmail/disconnect')).status).toBe(200);
  });
});
