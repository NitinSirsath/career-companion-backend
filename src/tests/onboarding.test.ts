/**
 * The guided first run (owner, 22 Nov 2026): a new account starts at the first step, the step the
 * user reached is kept so leaving halfway continues there, finishing ends it for good, and every
 * account made before it existed never sees it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueGmailSync: vi.fn().mockResolvedValue('sync-job'),
  enqueueEmailProcessingJob: vi.fn().mockResolvedValue(undefined),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { UserProfileSchema } from '../contracts/auth';

const DOMAIN = 'first-run-onboarding.test';
const NEW_USER = `new@${DOMAIN}`;
const OTHER = `other@${DOMAIN}`;
const as = (email: string) => ({ 'X-Development-User': email });

const me = async (email = NEW_USER) =>
  UserProfileSchema.parse((await request(app).get('/api/auth/me').set(as(email))).body);
const save = (body: object, email = NEW_USER) =>
  request(app).post('/api/auth/onboarding').set(as(email)).send(body);
const finish = (email = NEW_USER) =>
  request(app).post('/api/auth/onboarding/finish').set(as(email));

beforeEach(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  await prisma.user.create({ data: { email: NEW_USER } });
  await prisma.user.create({ data: { email: OTHER } });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
});

describe('the first run on the signed-in profile', () => {
  it('starts a new account at the first step', async () => {
    expect((await me()).onboarding).toEqual({ step: 'welcome' });
  });

  it('keeps the step the user reached, for this account only', async () => {
    const res = await save({ step: 'theme' });
    expect(res.status).toBe(200);
    expect(UserProfileSchema.parse(res.body).onboarding).toEqual({ step: 'theme' });
    expect((await me()).onboarding).toEqual({ step: 'theme' });
    expect((await me(OTHER)).onboarding).toEqual({ step: 'welcome' });
  });

  it('goes back a step as well as forward', async () => {
    await save({ step: 'ai' });
    await save({ step: 'gmail' });
    expect((await me()).onboarding).toEqual({ step: 'gmail' });
  });

  it('refuses a step that does not exist, and anything else in the body', async () => {
    expect((await save({ step: 'payments' })).status).toBe(400);
    expect((await save({ step: 'theme', done: true })).status).toBe(400);
    expect((await save({})).status).toBe(400);
    expect((await me()).onboarding).toEqual({ step: 'welcome' });
  });

  it('ends for good once finished: a late step save does not open it again', async () => {
    await save({ step: 'alerts' });
    const res = await finish();
    expect(res.status).toBe(200);
    expect(UserProfileSchema.parse(res.body).onboarding).toBeNull();
    expect((await finish()).status).toBe(200);
    await save({ step: 'tour' });
    expect((await me()).onboarding).toBeNull();
    const row = await prisma.user.findUniqueOrThrow({ where: { email: NEW_USER } });
    expect(row.onboardingStep).toBe('alerts');
    expect(row.onboardingDoneAt).not.toBeNull();
    expect((await me(OTHER)).onboarding).toEqual({ step: 'welcome' });
  });

  it('needs a signed-in user', async () => {
    expect((await request(app).post('/api/auth/onboarding').send({ step: 'gmail' })).status).toBe(
      401,
    );
    expect((await request(app).post('/api/auth/onboarding/finish')).status).toBe(401);
  });

  it('starts again at the first step when the stored step is no longer one', async () => {
    await prisma.user.update({ where: { email: NEW_USER }, data: { onboardingStep: 'old-step' } });
    expect((await me()).onboarding).toEqual({ step: 'welcome' });
  });

  it('shows on an account made by the dev-mode sign-up', async () => {
    vi.stubEnv('APP_MODE', 'dev');
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: `signup@${DOMAIN}`, password: 'a good long password' });
    expect(res.status).toBe(201);
    expect(UserProfileSchema.parse(res.body).onboarding).toEqual({ step: 'welcome' });
  });
});

describe('the migration', () => {
  it('marks every account that exists then as done, so no existing user sees the first run', async () => {
    const sql = readFileSync(
      path.resolve(
        __dirname,
        '../../prisma/migrations/20261122100000_first_run_onboarding/migration.sql',
      ),
      'utf8',
    );
    const update = sql.split(';').find((part) => part.includes('UPDATE'));
    expect(update).toBeDefined();
    // Run on this test database's users: those of this file and any left by other files.
    await prisma.$executeRawUnsafe(update as string);
    expect((await me()).onboarding).toBeNull();
    expect((await me(OTHER)).onboarding).toBeNull();
    expect(await prisma.user.count({ where: { onboardingDoneAt: null } })).toBe(0);
  });
});

describe('Connect Gmail from the first run', () => {
  it('comes back to the first run, which no other page outside the list can do', async () => {
    vi.stubEnv('APP_MODE', 'dev');
    const back = await request(app)
      .get('/api/gmail/connect')
      .query({ returnTo: '/welcome' })
      .set(as(NEW_USER));
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe(${process.env.FRONTEND_URL}/welcome);
    const elsewhere = await request(app)
      .get('/api/gmail/connect')
      .query({ returnTo: '/welcome/other' })
      .set(as(OTHER));
    expect(elsewhere.headers.location).toBe(${process.env.FRONTEND_URL}/gmail);
  });
});
