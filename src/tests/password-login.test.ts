import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { UserProfileSchema } from '../contracts/auth';
import { prisma } from '../db/prisma';
import { hashPassword, verifyPassword } from '../utils/passwordHash';

const DOMAIN = 'password-login.test';
const OWNER = `owner@${DOMAIN}`;
const GOOGLE_ONLY = `google-only@${DOMAIN}`;
const PASSWORD = 'correct horse battery';
const WRONG = { code: 'INVALID_CREDENTIALS', message: 'Email or password is wrong.' };

let owner: string;
let googleOnly: string;

const login = (email: string, password: string, agent = request(app)) =>
  agent.post('/api/auth/login').send({ email, password });
const me = (agent: ReturnType<typeof request.agent>) => agent.get('/api/auth/me');
const asUser = (email: string) => ({ 'X-Development-User': email });
const wrongTries = async (email: string, count: number) => {
  for (let i = 0; i < count; i++) expect((await login(email, 'not the password')).status).toBe(401);
};

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  owner = (
    await prisma.user.create({
      data: { email: OWNER, name: 'Owner', passwordHash: await hashPassword(PASSWORD) },
    })
  ).id;
  googleOnly = (
    await prisma.user.create({ data: { email: GOOGLE_ONLY, googleId: `google-${DOMAIN}` } })
  ).id;
});
beforeEach(async () => {
  await prisma.loginAttempt.deleteMany({});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.loginAttempt.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
});

describe('password hash', () => {
  it('stores a salted scrypt hash, never the password', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    expect(first).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(first).not.toContain(PASSWORD);
    expect(first).not.toBe(second);
    expect(await verifyPassword(PASSWORD, first)).toBe(true);
    expect(await verifyPassword('correct horse batterx', first)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'not-a-hash')).toBe(false);
    expect(await verifyPassword(PASSWORD, '')).toBe(false);
  });
});

describe('POST /api/auth/login', () => {
  it('signs in with the right email and password and starts a session', async () => {
    const agent = request.agent(app);
    const res = await login(OWNER, PASSWORD, agent);
    expect(res.status).toBe(200);
    expect(UserProfileSchema.parse(res.body)).toEqual({
      id: owner,
      email: OWNER,
      name: 'Owner',
      hasPassword: true,
      hasGoogle: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('scrypt');
    expect(String(res.headers['set-cookie'])).toContain('cc_session=');
    const profile = await me(agent);
    expect(profile.status).toBe(200);
    expect(profile.body.id).toBe(owner);
  });

  it('reads the email without minding letter case or spaces', async () => {
    expect((await login(`  Owner@${DOMAIN.toUpperCase()} `, PASSWORD)).status).toBe(200);
  });

  it('gives one answer for a wrong password, an unknown email and a user with no password', async () => {
    for (const [email, password] of [
      [OWNER, 'not the password'],
      [`nobody@${DOMAIN}`, PASSWORD],
      [GOOGLE_ONLY, PASSWORD],
    ]) {
      const res = await login(email, password);
      expect(res.status).toBe(401);
      expect(res.body.error).toEqual(WRONG);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('never repeats a submitted value in a validation error or a log line', async () => {
    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const)
      vi.spyOn(console, level).mockImplementation((line: unknown) => {
        logged.push(String(line));
      });
    const invalid = await login('not-an-email', 'marker-password-1');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    const wrong = await login(OWNER, 'marker-password-2');
    expect(wrong.status).toBe(401);
    const everything = JSON.stringify([invalid.body, wrong.body, logged]);
    expect(everything).not.toContain('marker-password');
    expect(logged.some((line) => line.includes('INVALID_CREDENTIALS'))).toBe(true);
    vi.restoreAllMocks();
  });
});

describe('guessing limit', () => {
  it('blocks an email for 15 minutes after 5 wrong tries, even for the right password', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    await wrongTries(OWNER, 5);
    const blocked = await login(OWNER, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(blocked.body.error.message).toBe('Too many tries. Try again in 15 minutes.');
    expect(blocked.body.error.details).toEqual({ retryAfterSeconds: 900 });
    // A blocked try is not counted, so the block cannot be kept alive by retrying.
    expect(await prisma.loginAttempt.count({ where: { email: OWNER } })).toBe(5);

    vi.setSystemTime(new Date('2026-10-12T10:14:59Z'));
    expect((await login(OWNER, PASSWORD)).body.error.details).toEqual({ retryAfterSeconds: 1 });
    vi.setSystemTime(new Date('2026-10-12T10:15:00Z'));
    expect((await login(OWNER, PASSWORD)).status).toBe(200);
  });

  it('blocks an unknown email the same way, so the block tells nothing', async () => {
    await wrongTries(`nobody@${DOMAIN}`, 5);
    const blocked = await login(`nobody@${DOMAIN}`, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('counts per email: another email on the same address is not blocked', async () => {
    await wrongTries(`nobody@${DOMAIN}`, 5);
    expect((await login(OWNER, PASSWORD)).status).toBe(200);
  });

  it('forgets the wrong tries of an email after a good sign-in', async () => {
    await wrongTries(OWNER, 4);
    expect((await login(OWNER, PASSWORD)).status).toBe(200);
    expect(await prisma.loginAttempt.count({ where: { email: OWNER } })).toBe(0);
    await wrongTries(OWNER, 4);
    expect((await login(OWNER, PASSWORD)).status).toBe(200);
  });

  it('blocks a network address after 20 wrong tries, whatever the email', async () => {
    for (let i = 0; i < 20; i++) await wrongTries(`guess-${i}@${DOMAIN}`, 1);
    const blocked = await login(OWNER, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('drops tries that are older than the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    await wrongTries(OWNER, 2);
    vi.setSystemTime(new Date('2026-10-12T10:20:00Z'));
    await wrongTries(OWNER, 1);
    expect(await prisma.loginAttempt.count({})).toBe(1);
  });
});

describe('POST /api/auth/password', () => {
  const setPassword = (email: string, body: object) =>
    request(app).post('/api/auth/password').set(asUser(email)).send(body);

  beforeEach(async () => {
    vi.stubEnv('ENABLE_DEV_AUTH', 'true');
    await prisma.user.update({ where: { id: googleOnly }, data: { passwordHash: null } });
    await prisma.user.update({
      where: { id: owner },
      data: { passwordHash: await hashPassword(PASSWORD) },
    });
  });

  it('needs a signed-in user', async () => {
    const res = await request(app)
      .post('/api/auth/password')
      .send({ newPassword: 'long enough 1' });
    expect(res.status).toBe(401);
  });

  it('lets a Google user set a first password and then sign in with it', async () => {
    const res = await setPassword(GOOGLE_ONLY, { newPassword: 'my first password' });
    expect(res.status).toBe(200);
    expect(UserProfileSchema.parse(res.body)).toMatchObject({ hasPassword: true, hasGoogle: true });
    expect((await login(GOOGLE_ONLY, 'my first password')).status).toBe(200);
  });

  it('asks for the current password before changing one', async () => {
    const missing = await setPassword(OWNER, { newPassword: 'a brand new password' });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('WRONG_PASSWORD');
    const wrong = await setPassword(OWNER, {
      currentPassword: 'not the password',
      newPassword: 'a brand new password',
    });
    expect(wrong.status).toBe(403);
    expect((await login(OWNER, PASSWORD)).status).toBe(200);

    const changed = await setPassword(OWNER, {
      currentPassword: PASSWORD,
      newPassword: 'a brand new password',
    });
    expect(changed.status).toBe(200);
    expect((await login(OWNER, PASSWORD)).status).toBe(401);
    expect((await login(OWNER, 'a brand new password')).status).toBe(200);
  });

  it('limits wrong current passwords like wrong sign-ins', async () => {
    for (let i = 0; i < 5; i++)
      expect(
        (
          await setPassword(OWNER, {
            currentPassword: 'guess',
            newPassword: 'a brand new password',
          })
        ).status,
      ).toBe(403);
    const blocked = await setPassword(OWNER, {
      currentPassword: PASSWORD,
      newPassword: 'a brand new password',
    });
    expect(blocked.status).toBe(429);
  });

  it('refuses a password shorter than 10 characters', async () => {
    const res = await setPassword(GOOGLE_ONLY, { newPassword: 'too short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: googleOnly } })).passwordHash).toBe(
      null,
    );
  });

  it('signs the user out everywhere else after a change', async () => {
    vi.stubEnv('ENABLE_DEV_AUTH', '');
    const here = request.agent(app);
    const elsewhere = request.agent(app);
    expect((await login(OWNER, PASSWORD, here)).status).toBe(200);
    expect((await login(OWNER, PASSWORD, elsewhere)).status).toBe(200);
    const changed = await here
      .post('/api/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new password' });
    expect(changed.status).toBe(200);
    expect((await me(here)).status).toBe(200);
    expect((await me(elsewhere)).status).toBe(401);
  });
});

describe('POST /api/auth/register', () => {
  const NEW = `new-user@${DOMAIN}`;
  const register = (body: object, agent = request(app)) =>
    agent.post('/api/auth/register').send(body);

  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { email: NEW } });
  });

  it('does not exist in prod mode', async () => {
    const res = await register({ email: NEW, password: 'a good long password' });
    expect(res.status).toBe(404);
    expect((await register({})).status).toBe(404);
    expect(await prisma.user.count({ where: { email: NEW } })).toBe(0);
  });

  it('creates a test user in dev mode and signs them in', async () => {
    vi.stubEnv('APP_MODE', 'dev');
    const agent = request.agent(app);
    const res = await register(
      { email: ` New-User@${DOMAIN} `, password: 'a good long password', name: 'New User' },
      agent,
    );
    expect(res.status).toBe(201);
    expect(UserProfileSchema.parse(res.body)).toMatchObject({
      email: NEW,
      name: 'New User',
      hasPassword: true,
      hasGoogle: false,
    });
    expect((await me(agent)).body.email).toBe(NEW);
    expect((await login(NEW, 'a good long password')).status).toBe(200);
  });

  it('refuses an email that is taken and a short password', async () => {
    vi.stubEnv('APP_MODE', 'dev');
    const taken = await register({ email: OWNER.toUpperCase(), password: 'a good long password' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('EMAIL_TAKEN');
    const short = await register({ email: NEW, password: 'too short' });
    expect(short.status).toBe(400);
    expect(await prisma.user.count({ where: { email: NEW } })).toBe(0);
  });
});

describe('Google sign-in in dev mode', () => {
  it('is off: both routes answer 404', async () => {
    vi.stubEnv('APP_MODE', 'dev');
    for (const path of ['/api/auth/connect', '/api/auth/callback?code=x&state=y']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });
});
