import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';

// ─── Mock google-auth-library ────────────────────────────────────────────────────────
vi.mock('google-auth-library', () => {
  const mockGetToken = vi.fn().mockResolvedValue({
    tokens: {
      access_token: 'mock_google_auth_access_token',
      id_token: 'mock_google_auth_id_token',
    },
  });

  const mockVerifyIdToken = vi.fn().mockResolvedValue({
    getPayload: () => ({
      iss: 'https://accounts.google.com',
      sub: 'mock_google_id_123',
      email: 'auth_test_user@gmail.com',
      name: 'Auth Test User',
    }),
  });

  const mockGenerateAuthUrl = vi.fn().mockReturnValue(
    'https://accounts.google.com/o/oauth2/v2/auth?mock=1&state=teststate'
  );

  return {
    OAuth2Client: vi.fn().mockImplementation(function() {
      return {
        generateAuthUrl: mockGenerateAuthUrl,
        getToken: mockGetToken,
        verifyIdToken: mockVerifyIdToken,
      };
    })
  };
});

describe('Google OAuth Sign-In (COM-24)', () => {
  let testUser: import('@prisma/client').User;

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = 'test_client_id';
    process.env.GOOGLE_CLIENT_SECRET = 'test_client_secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    process.env.OAUTH_STATE_COOKIE_SECRET = 'test_cookie_secret';
    process.env.SESSION_SECRET = 'test_session_secret';
  });

  afterAll(async () => {
    if (testUser) {
      await prisma.user.deleteMany({ where: { id: testUser.id } });
    }
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany({ where: { email: 'auth_test_user@gmail.com' } });
  });

  it('GET /api/auth/connect redirects to Google and sets state cookie', async () => {
    const res = await request(app).get('/api/auth/connect');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('accounts.google.com');

    const setCookieHeader = res.headers['set-cookie'] as unknown as string[] | string | undefined;
    const cookieStr = Array.isArray(setCookieHeader)
      ? setCookieHeader.join('; ')
      : (setCookieHeader ?? '');

    expect(cookieStr).toContain('google_login_state');
  });

  it('GET /api/auth/callback creates a user and a session', async () => {
    // 1. First get the state from connect
    const connectRes = await request(app).get('/api/auth/connect');
    const cookies = connectRes.headers['set-cookie'] as unknown as string[];
    const stateCookie = cookies.find(c => c.startsWith('google_login_state='))!.split(';')[0];

    const stateMatch = /s%3A([^.]+)/.exec(stateCookie);
    const rawState = stateMatch ? stateMatch[1] : '';

    // 2. Call callback with state
    const callbackRes = await request(app)
      .get(`/api/auth/callback?code=mock_code&state=${rawState}`)
      .set('Cookie', stateCookie);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain('/');

    const ccSessionCookie = (callbackRes.headers['set-cookie'] as unknown as string[])
      .find(c => c.startsWith('cc_session='))!;

    // 3. User should be created
    testUser = (await prisma.user.findUnique({ where: { googleId: 'mock_google_id_123' } }))!;
    expect(testUser).toBeDefined();
    expect(testUser.email).toBe('auth_test_user@gmail.com');

    // 4. Test /api/auth/me
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', ccSessionCookie);

    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe('auth_test_user@gmail.com');
  });

  it('returns 401 for protected endpoints without session', async () => {
    // /api/gmail/status requires auth
    const res = await request(app).get('/api/gmail/status');
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/logout invalidates session', async () => {
    // 1. Get connect state
    const connectRes = await request(app).get('/api/auth/connect');
    const cookies = connectRes.headers['set-cookie'] as unknown as string[];
    const stateCookie = cookies.find(c => c.startsWith('google_login_state='))!.split(';')[0];
    const rawState = /s%3A([^.]+)/.exec(stateCookie)![1];

    // 2. Login
    const callbackRes = await request(app)
      .get(`/api/auth/callback?code=mock_code&state=${rawState}`)
      .set('Cookie', stateCookie);

    const sessionCookie = (callbackRes.headers['set-cookie'] as unknown as string[])
      .find(c => c.startsWith('cc_session='))!.split(';')[0];

    // 3. Verify logged in
    let meRes = await request(app).get('/api/auth/me').set('Cookie', sessionCookie);
    expect(meRes.status).toBe(200);

    // 4. Logout
    const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', sessionCookie);
    expect(logoutRes.status).toBe(200);

    // 5. Verify logged out
    meRes = await request(app).get('/api/auth/me').set('Cookie', sessionCookie);
    expect(meRes.status).toBe(401);
  });

  it('handles returning Google login and updates name if needed', async () => {
    // Create the user manually first
    await prisma.user.create({
      data: {
        googleId: 'mock_google_id_123',
        email: 'auth_test_user@gmail.com',
        name: null
      }
    });

    const connectRes = await request(app).get('/api/auth/connect');
    const cookies = connectRes.headers['set-cookie'] as unknown as string[];
    const stateCookie = cookies.find(c => c.startsWith('google_login_state='))!.split(';')[0];
    const rawState = /s%3A([^.]+)/.exec(stateCookie)![1];

    await request(app)
      .get(`/api/auth/callback?code=mock_code&state=${rawState}`)
      .set('Cookie', stateCookie);

    const user = await prisma.user.findUnique({ where: { googleId: 'mock_google_id_123' } });
    expect(user!.name).toBe('Auth Test User');
  });

  describe('Development Authentication', () => {
    let devUser: import('@prisma/client').User;

    beforeAll(async () => {
      devUser = await prisma.user.create({
        data: {
          email: 'dev@career-companion.local',
          name: 'Dev User'
        }
      });
    });

    afterAll(async () => {
      if (devUser) {
        await prisma.user.delete({ where: { id: devUser.id } });
      }
    });

    it('returns 200 for /api/auth/me when development auth is enabled and header is present', async () => {
      process.env.ENABLE_DEV_AUTH = 'true';
      const res = await request(app)
        .get('/api/auth/me')
        .set('X-Development-User', 'dev@career-companion.local');
      
      expect(res.status).toBe(200);
      expect(res.body.email).toBe('dev@career-companion.local');
    });

    it('returns 401 for /api/auth/me when development auth is disabled', async () => {
      process.env.ENABLE_DEV_AUTH = 'false';
      const res = await request(app)
        .get('/api/auth/me')
        .set('X-Development-User', 'dev@career-companion.local');
      
      expect(res.status).toBe(401);
    });

    it('returns 401 for /api/auth/me when unauthenticated without headers or session', async () => {
      process.env.ENABLE_DEV_AUTH = 'true';
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });
  });
});
