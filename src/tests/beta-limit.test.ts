import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/googleOAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/googleOAuth')>()),
  verifyGoogleLogin: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { verifyGoogleLogin } from '../services/googleOAuth';
import { BetaFullError, findOrCreateGoogleUser } from '../services/user';
import { DEFAULT_BETA_USER_LIMIT, frontendUrl, parseBETA_USER_LIMIT } from '../utils/config';

const DOMAIN = 'beta-limit.test';
const NEWCOMER = `newcomer@${DOMAIN}`;
const MEMBER = `member@${DOMAIN}`;
const TESTER = `tester@${DOMAIN}`;

/** Signs in through Google as a browser would, as `email`; the browser and Google's answer. */
async function googleSignIn(email: string, googleId = `google-${email}`) {
  vi.mocked(verifyGoogleLogin).mockResolvedValue({ googleId, email, name: 'Someone' });
  const agent = request.agent(app);
  const started = await agent.get('/api/auth/connect');
  const state = new URL(started.headers.location).searchParams.get('state') ?? '';
  const back = await agent.get('/api/auth/callback').query({ code: 'fixture-code', state });
  return { agent, back };
}
const signInAs = async (email: string, googleId?: string) =>
  (await googleSignIn(email, googleId)).back;

const allAccounts = () => prisma.user.count();
/**
 * Sets the limit to the accounts that exist now, plus `spare` places. One member always exists
 * first: a limit of 0 would mean no limit.
 */
async function fillTheBeta(spare = 0) {
  await prisma.user.upsert({
    where: { email: MEMBER },
    create: { email: MEMBER, googleId: 'google-member' },
    update: {},
  });
  vi.stubEnv('BETA_USER_LIMIT', String((await allAccounts()) + spare));
}

beforeEach(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  vi.mocked(verifyGoogleLogin).mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
});

describe('BETA_USER_LIMIT setting', () => {
  it('is 99 when unset or empty, any whole number when set, and 0 means no limit', () => {
    expect(DEFAULT_BETA_USER_LIMIT).toBe(99);
    expect(parseBETA_USER_LIMIT(undefined)).toBe(99);
    expect(parseBETA_USER_LIMIT('')).toBe(99);
    expect(parseBETA_USER_LIMIT('40')).toBe(40);
    expect(parseBETA_USER_LIMIT('0')).toBe(0);
    for (const bad of ['-1', '1.5', 'ninety', ' 9'])
      expect(() => parseBETA_USER_LIMIT(bad)).toThrow(/BETA_USER_LIMIT/);
  });
});

describe('new accounts and the beta limit', () => {
  it('creates a new account while the beta has a place', async () => {
    await fillTheBeta(1);
    const back = await signInAs(NEWCOMER);
    expect(back.headers.location).toBe(`${frontendUrl()}/`);
    expect(await prisma.user.findUnique({ where: { email: NEWCOMER } })).not.toBeNull();
  });

  it('refuses a new account when the beta is full, and starts no session', async () => {
    await fillTheBeta();
    const { agent, back } = await googleSignIn(NEWCOMER);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe(`${frontendUrl()}/login?error=beta_full`);
    expect(await prisma.user.findUnique({ where: { email: NEWCOMER } })).toBeNull();
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('lets an existing user in when the beta is full, by Google ID and by email', async () => {
    await prisma.user.create({ data: { email: NEWCOMER } });
    await fillTheBeta();
    expect((await signInAs(MEMBER, 'google-member')).headers.location).toBe(`${frontendUrl()}/`);
    expect((await signInAs(NEWCOMER)).headers.location).toBe(`${frontendUrl()}/`);
    const linked = await prisma.user.findUniqueOrThrow({ where: { email: NEWCOMER } });
    expect(linked.googleId).toBe(`google-${NEWCOMER}`);
  });

  it('does not count test accounts', async () => {
    await prisma.user.create({ data: { email: TESTER } });
    // Every account that exists counts as a place, so only leaving the test account out frees one.
    await fillTheBeta();
    expect((await signInAs(NEWCOMER)).headers.location).toBe(
      `${frontendUrl()}/login?error=beta_full`,
    );
    vi.stubEnv('TEST_ACCOUNTS', `${TESTER}:a-long-random-test-password`);
    expect((await signInAs(NEWCOMER)).headers.location).toBe(`${frontendUrl()}/`);
  });

  it('has no limit at 0', async () => {
    vi.stubEnv('BETA_USER_LIMIT', '0');
    expect((await signInAs(NEWCOMER)).headers.location).toBe(`${frontendUrl()}/`);
  });

  it('gives the last place to one of two sign-ups at the same moment', async () => {
    await fillTheBeta(1);
    const results = await Promise.allSettled([
      findOrCreateGoogleUser('google-first', `first@${DOMAIN}`, null),
      findOrCreateGoogleUser('google-second', `second@${DOMAIN}`, null),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(BetaFullError);
    expect(await prisma.user.count({ where: { email: { endsWith: `@${DOMAIN}` } } })).toBe(2);
  });
});
