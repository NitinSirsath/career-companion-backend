import crypto from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/googleOAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/googleOAuth')>()),
  verifyGoogleLogin: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { verifyGoogleLogin } from '../services/googleOAuth';
import { cookieSecret, frontendUrl } from '../utils/config';

const DOMAIN = 'auth-return-to.test';
const OWNER = `owner@${DOMAIN}`;
const TESTER = `tester@${DOMAIN}`;
const RETURN_COOKIE = 'google_login_return';
const PAGE = '/applications/123';

const setCookies = (res: request.Response) =>
  (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
const returnCookie = (res: request.Response) =>
  setCookies(res).find((c) => c.startsWith(`${RETURN_COOKIE}=`));
const clearsReturnCookie = (res: request.Response) =>
  /^google_login_return=;.*Expires=Thu, 01 Jan 1970/.test(returnCookie(res) ?? '');

/** Starts Google sign-in as a browser would, optionally asking to come back to `returnTo`. */
async function startSignIn(returnTo?: string) {
  const agent = request.agent(app);
  const started = await agent
    .get('/api/auth/connect')
    .query(returnTo === undefined ? {} : { returnTo });
  const state = new URL(started.headers.location).searchParams.get('state') ?? '';
  return { agent, started, state };
}

/** Starts Google sign-in, then comes back from Google with `answer` (the code, by default). */
async function signInThroughGoogle(
  returnTo?: string,
  answer: (state: string) => Record<string, string> = (state) => ({ code: 'fixture-code', state }),
) {
  const { agent, state } = await startSignIn(returnTo);
  return agent.get('/api/auth/callback').query(answer(state));
}

beforeEach(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  vi.mocked(verifyGoogleLogin).mockReset();
  vi.mocked(verifyGoogleLogin).mockResolvedValue({
    googleId: 'return-to-google-id',
    email: OWNER,
    name: 'Owner',
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
});

describe('coming back from Google sign-in', () => {
  it('opens the home page when no page was asked for', async () => {
    const { started } = await startSignIn();
    expect(clearsReturnCookie(started)).toBe(true);

    const back = await signInThroughGoogle();
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe(`${frontendUrl()}/`);
  });

  it.each([PAGE, '/mails?tab=gmail'])('opens the page the user asked for (%s)', async (page) => {
    const back = await signInThroughGoogle(page);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe(`${frontendUrl()}${page}`);
    expect(clearsReturnCookie(back)).toBe(true);
    expect(await prisma.user.findUnique({ where: { email: OWNER } })).not.toBeNull();
  });

  it('keeps the page in a signed, short-lived, HttpOnly cookie, like the state', async () => {
    const { started } = await startSignIn(PAGE);
    const cookie = returnCookie(started) ?? '';
    expect(cookie).toMatch(/^google_login_return=s%3A/);
    expect(cookie).toContain('Max-Age=300');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '', 'applications/123'])(
    'never leaves the app (%j)',
    async (returnTo) => {
      const { started } = await startSignIn(returnTo);
      expect(clearsReturnCookie(started)).toBe(true);

      const back = await signInThroughGoogle(returnTo);
      expect(back.headers.location).toBe(`${frontendUrl()}/`);
    },
  );

  it('checks the cookie again on the way back', async () => {
    const value = '//evil.example';
    const signature = crypto
      .createHmac('sha256', cookieSecret())
      .update(value)
      .digest('base64')
      .replace(/=+$/, '');
    const { started, state } = await startSignIn();
    const stateCookie = setCookies(started)
      .find((c) => c.startsWith('google_login_state='))
      ?.split(';')[0];
    const forged = `${RETURN_COOKIE}=${encodeURIComponent(`s:${value}.${signature}`)}`;
    const back = await request(app)
      .get('/api/auth/callback')
      .query({ code: 'fixture-code', state })
      .set('Cookie', `${stateCookie}; ${forged}`);
    expect(back.headers.location).toBe(`${frontendUrl()}/`);
    expect(clearsReturnCookie(back)).toBe(true);
  });

  it('forgets the page of an earlier try', async () => {
    const agent = request.agent(app);
    await agent.get('/api/auth/connect').query({ returnTo: PAGE });
    const started = await agent.get('/api/auth/connect');
    const state = new URL(started.headers.location).searchParams.get('state');
    const back = await agent.get('/api/auth/callback').query({ code: 'fixture-code', state });
    expect(back.headers.location).toBe(`${frontendUrl()}/`);
  });
});

describe('a failed Google sign-in', () => {
  const failures: {
    error: string;
    answer: (state: string) => Record<string, string>;
    setUp?: () => void;
  }[] = [
    { error: 'denied', answer: () => ({ error: 'access_denied' }) },
    { error: 'csrf', answer: () => ({ code: 'fixture-code', state: 'another-state' }) },
    { error: 'missing_code', answer: (state) => ({ state }) },
    {
      error: 'test_account',
      answer: (state) => ({ code: 'fixture-code', state }),
      setUp: () => {
        vi.stubEnv('TEST_ACCOUNTS', `${TESTER}:a-long-random-test-password`);
        vi.mocked(verifyGoogleLogin).mockResolvedValue({
          googleId: 'tester-google-id',
          email: TESTER,
          name: null,
        });
      },
    },
    {
      error: 'server_error',
      answer: (state) => ({ code: 'fixture-code', state }),
      setUp: () => {
        vi.mocked(verifyGoogleLogin).mockRejectedValue(new Error('Google is down'));
      },
    },
  ];

  it.each(failures)('keeps the page asked for as next ($error)', async (failure) => {
    failure.setUp?.();
    const back = await signInThroughGoogle(PAGE, failure.answer);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe(
      `${frontendUrl()}/login?error=${failure.error}&next=${encodeURIComponent(PAGE)}`,
    );
    expect(clearsReturnCookie(back)).toBe(true);
  });

  it.each(failures)('leaves the login URL as it was without one ($error)', async (failure) => {
    failure.setUp?.();
    const back = await signInThroughGoogle(undefined, failure.answer);
    expect(back.headers.location).toBe(`${frontendUrl()}/login?error=${failure.error}`);
    expect(clearsReturnCookie(back)).toBe(true);
  });

  it('carries a page with a query safely as next', async () => {
    const back = await signInThroughGoogle('/mails?tab=gmail&q=a', () => ({
      error: 'access_denied',
    }));
    const next = new URL(back.headers.location).searchParams.get('next');
    expect(next).toBe('/mails?tab=gmail&q=a');
  });
});
