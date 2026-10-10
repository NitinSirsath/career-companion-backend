import { emailJobOptions } from '../jobs/emailProcessingJob';
import { EMAIL_PROCESSING_STUCK_MS } from '../services/email';
import { STALE_PROCESSING_MS } from '../services/ai/heldOperations';
import { GmailStatusResponseSchema } from '../contracts/gmail';
import { syncUser } from '../services/gmailSync';
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration tests for Gmail OAuth routes (COM-19).
 *
 * Tests cover:
 * - GET /api/gmail/status (no connection, connected, disconnected)
 * - GET /api/gmail/connect (redirect shape, state cookie)
 * - GET /api/gmail/callback (CSRF validation)
 * - POST /api/gmail/disconnect (token clearing, status update)
 *
 * Real Google API calls are NOT made. The googleapis library is mocked.
 * Token encryption uses a test-fixture key — NOT a real production key.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { encryptToken } from '../utils/gmailTokenEncryption';
import { configureAI } from './helpers/aiAccess';

vi.mock('../jobs/emailProcessingJob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jobs/emailProcessingJob')>()),
  enqueueEmailProcessingJob: vi.fn().mockResolvedValue(undefined),
}));

// ─── Test encryption key ───────────────────────────────────────────────────
const TEST_ENCRYPTION_KEY = 'b'.repeat(64);
const TEST_COOKIE_SECRET = 'test-cookie-secret-for-vitest';

// ─── Mock googleapis ────────────────────────────────────────────────────────
// We do NOT make real Google API calls in tests. The mock simulates successful
// token exchange and profile fetch.
vi.mock('googleapis', () => {
  const mockGetToken = vi.fn().mockResolvedValue({
    tokens: {
      access_token: 'mock_access_token_from_google',
      refresh_token: 'mock_refresh_token_from_google',
    },
  });

  const mockGetProfile = vi.fn().mockResolvedValue({
    data: { emailAddress: 'testuser@gmail.com', historyId: '1000' },
  });

  const mockRevokeToken = vi.fn().mockResolvedValue({});

  const mockGenerateAuthUrl = vi
    .fn()
    .mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock=1&state=teststate');

  const mockSetCredentials = vi.fn();

  // Must use function (not arrow) to be newable via `new google.auth.OAuth2(...)`.
  function MockOAuth2(this: unknown) {
    return {
      generateAuthUrl: mockGenerateAuthUrl,
      getToken: mockGetToken,
      setCredentials: mockSetCredentials,
      revokeToken: mockRevokeToken,
    };
  }

  const mockMessagesList = vi.fn().mockResolvedValue({
    data: {
      messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
      nextPageToken: undefined,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockMessagesGet = vi.fn().mockImplementation((args: any) => {
    return Promise.resolve({
      data: {
        id: args.id,
        threadId: `thread-${args.id}`,
        historyId: '1000',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'Subject', value: `Subject for ${args.id}` },
            { name: 'From', value: 'sender@example.com' },
            { name: 'Date', value: 'Wed, 12 Sep 2026 10:00:00 +0000' },
          ],
        },
      },
    });
  });

  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      gmail: vi.fn().mockReturnValue({
        users: {
          getProfile: mockGetProfile,
          history: {
            list: vi.fn().mockResolvedValue({ data: { historyId: '1001', history: [] } }),
          },
          messages: {
            list: mockMessagesList,
            get: mockMessagesGet,
          },
        },
      }),
    },
  };
});

// ─── Test setup ─────────────────────────────────────────────────────────────

describe('Gmail OAuth Routes (COM-19)', () => {
  let testUser: import('@prisma/client').User;

  beforeAll(async () => {
    // Set env vars for tests
    process.env.ENABLE_DEV_AUTH = 'true';
    process.env.GMAIL_TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.OAUTH_STATE_COOKIE_SECRET = TEST_COOKIE_SECRET;
    process.env.GMAIL_CLIENT_ID = 'test_client_id';
    process.env.GMAIL_CLIENT_SECRET = 'test_client_secret';
    process.env.GMAIL_REDIRECT_URI = 'http://localhost:3000/api/gmail/callback';
    process.env.FRONTEND_URL = 'http://localhost:3000';

    // Delete just the user we are about to create, if it exists
    const existing = await prisma.user.findUnique({ where: { email: 'gmail-test@test.local' } });
    if (existing) {
      await prisma.user.delete({ where: { id: existing.id } });
    }

    testUser = await prisma.user.create({
      data: { email: 'gmail-test@test.local' },
    });
    // Sync re-offers waiting emails only to users whose own AI access is ready (ADR-0001).
    await configureAI(testUser.id);
  });

  afterAll(async () => {
    if (testUser) {
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }
  });

  beforeEach(async () => {
    // Clean any GmailConnection and Emails before each test for isolation
    await prisma.email.deleteMany({ where: { userId: testUser.id } });
    await prisma.gmailConnection.deleteMany({ where: { userId: testUser.id } });
  });

  // ─── Authentication ───────────────────────────────────────────────────────

  describe('Authentication guard', () => {
    it('GET /api/gmail/status without dev auth returns 401', async () => {
      process.env.ENABLE_DEV_AUTH = 'false';
      const res = await request(app).get('/api/gmail/status');
      expect(res.status).toBe(401);
      process.env.ENABLE_DEV_AUTH = 'true';
    });

    it('POST /api/gmail/disconnect without dev auth returns 401', async () => {
      process.env.ENABLE_DEV_AUTH = 'false';
      const res = await request(app).post('/api/gmail/disconnect');
      expect(res.status).toBe(401);
      process.env.ENABLE_DEV_AUTH = 'true';
    });
  });

  // ─── GET /api/gmail/status ────────────────────────────────────────────────

  describe('GET /api/gmail/status', () => {
    it('exposes only the owned capped-gap dates through the status contract', async () => {
      const from = new Date('2026-01-01T00:00:00Z'),
        until = new Date('2026-01-15T00:00:00Z');
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          accessToken: encryptToken('secret'),
          unscannedFrom: from,
          unscannedUntil: until,
        },
      });
      const res = await request(app)
        .get('/api/gmail/status')
        .set('X-Development-User', testUser.email);
      expect(res.status).toBe(200);
      expect(GmailStatusResponseSchema.parse(res.body).unscannedGap).toEqual({
        from: from.toISOString(),
        until: until.toISOString(),
      });
      expect(JSON.stringify(res.body)).not.toContain('secret');
    });

    it('returns connected=false when no GmailConnection exists', async () => {
      const res = await request(app)
        .get('/api/gmail/status')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.unscannedGap).toBeNull();
      expect(GmailStatusResponseSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.gmailEmail).toBeNull();
      expect(res.body.status).toBeNull();
      expect(res.body.syncStatus).toBeNull();
    });

    it('returns connected=true when CONNECTED GmailConnection exists', async () => {
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          syncStatus: 'IDLE',
          accessToken: encryptToken('fake_access_token'),
        },
      });

      const res = await request(app)
        .get('/api/gmail/status')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.gmailEmail).toBe('testuser@gmail.com');
      expect(res.body.status).toBe('CONNECTED');
    });

    it('does NOT return accessToken or refreshToken in response', async () => {
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          syncStatus: 'IDLE',
          accessToken: encryptToken('super_secret_access_token'),
          refreshToken: encryptToken('super_secret_refresh_token'),
        },
      });

      const res = await request(app)
        .get('/api/gmail/status')
        .set('X-Development-User', testUser.email);

      expect(res.body).not.toHaveProperty('accessToken');
      expect(res.body).not.toHaveProperty('refreshToken');
      // Verify the actual token values are not buried anywhere in the body
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('super_secret');
    });

    it('returns connected=false when status is NOT_CONNECTED', async () => {
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'NOT_CONNECTED',
          syncStatus: 'IDLE',
          accessToken: '',
        },
      });

      const res = await request(app)
        .get('/api/gmail/status')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.status).toBe('NOT_CONNECTED');
    });
  });

  // ─── GET /api/gmail/connect ───────────────────────────────────────────────

  describe('GET /api/gmail/connect', () => {
    it('redirects to Google OAuth URL', async () => {
      const res = await request(app)
        .get('/api/gmail/connect')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('accounts.google.com');
    });

    it('sets a state cookie', async () => {
      const res = await request(app)
        .get('/api/gmail/connect')
        .set('X-Development-User', testUser.email);

      const setCookieHeader = res.headers['set-cookie'] as string[] | string | undefined;
      const cookieStr = Array.isArray(setCookieHeader)
        ? setCookieHeader.join('; ')
        : (setCookieHeader ?? '');

      expect(cookieStr).toContain('gmail_oauth_state');
      expect(cookieStr.toLowerCase()).toContain('httponly');
    });

    it('returns 500 when GMAIL_TOKEN_ENCRYPTION_KEY is missing', async () => {
      const original = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
      delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;

      const res = await request(app)
        .get('/api/gmail/connect')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(500);
      // Restore
      process.env.GMAIL_TOKEN_ENCRYPTION_KEY = original;
    });
  });

  // ─── GET /api/gmail/callback ─────────────────────────────────────────────

  describe('GET /api/gmail/callback', () => {
    it('returns 400 with CSRF_INVALID when no state cookie is present', async () => {
      const res = await request(app)
        .get('/api/gmail/callback?code=fake_code&state=some_state')
        .set('X-Development-User', testUser.email);
      // No cookie set — state cannot match
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CSRF_INVALID');
    });

    it('returns 400 with CSRF_INVALID when state param does not match cookie', async () => {
      // Manually craft a signed cookie and send a mismatched state param.
      // supertest + cookie-parser signed cookies require the secret; we simulate
      // a mismatch by sending a different state value in the query.
      const res = await request(app)
        .get('/api/gmail/callback?code=fake_code&state=wrong_state')
        .set('X-Development-User', testUser.email)
        .set('Cookie', 'gmail_oauth_state=s%3Acorrect_state.invalid_signature');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CSRF_INVALID');
    });

    it('redirects to frontend with gmailError=denied when error=access_denied', async () => {
      const res = await request(app)
        .get('/api/gmail/callback?error=access_denied')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('gmailError=denied');
    });
  });

  // ─── POST /api/gmail/disconnect ──────────────────────────────────────────

  describe('POST /api/gmail/disconnect', () => {
    it('returns { disconnected: true } when no connection exists', async () => {
      const res = await request(app)
        .post('/api/gmail/disconnect')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);
    });

    it('clears tokens and sets status to NOT_CONNECTED', async () => {
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          syncStatus: 'IDLE',
          accessToken: encryptToken('ya29.access_token_to_be_cleared'),
          refreshToken: encryptToken('1//refresh_token_to_be_cleared'),
        },
      });

      const res = await request(app)
        .post('/api/gmail/disconnect')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);

      // Verify DB state
      const connection = await prisma.gmailConnection.findUnique({
        where: { userId: testUser.id },
      });
      expect(connection?.status).toBe('NOT_CONNECTED');
      expect(connection?.refreshToken).toBeNull();
      // accessToken should be empty (cleared sentinel), not the original encrypted value
      expect(connection?.accessToken).toBe('');
    });

    it('GET /api/gmail/status returns connected=false after disconnect', async () => {
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          syncStatus: 'IDLE',
          accessToken: encryptToken('access_token'),
        },
      });

      await request(app).post('/api/gmail/disconnect').set('X-Development-User', testUser.email);

      const statusRes = await request(app)
        .get('/api/gmail/status')
        .set('X-Development-User', testUser.email);

      expect(statusRes.body.connected).toBe(false);
    });
  });

  describe('PATCH /api/gmail/settings', () => {
    it('rejects an invalid syncLookbackDays value', async () => {
      const res = await request(app)
        .patch('/api/gmail/settings')
        .set('X-Development-User', testUser.email)
        .send({ syncLookbackDays: 15 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: { code: 'INVALID_LOOKBACK', message: 'syncLookbackDays must be 1, 7, 14, or 30' },
      });
    });

    it('returns 400 when syncLookbackDays is omitted', async () => {
      const res = await request(app)
        .patch('/api/gmail/settings')
        .set('X-Development-User', testUser.email)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: { code: 'INVALID_LOOKBACK', message: 'syncLookbackDays must be 1, 7, 14, or 30' },
      });
    });

    it('updates syncLookbackDays for an existing Gmail connection', async () => {
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          syncStatus: 'IDLE',
          accessToken: encryptToken('fake_access_token'),
        },
      });

      const res = await request(app)
        .patch('/api/gmail/settings')
        .set('X-Development-User', testUser.email)
        .send({ syncLookbackDays: 14 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, syncLookbackDays: 14 });

      const connection = await prisma.gmailConnection.findUnique({
        where: { userId: testUser.id },
      });
      expect(connection?.syncLookbackDays).toBe(14);
    });
  });

  // ─── Token security ────────────────────────────────────────────────────────

  describe('Token security (tokens never appear in responses)', () => {
    it('status response body does not contain accessToken or refreshToken fields', async () => {
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          syncStatus: 'IDLE',
          accessToken: encryptToken('real_access_token'),
          refreshToken: encryptToken('real_refresh_token'),
        },
      });

      const res = await request(app)
        .get('/api/gmail/status')
        .set('X-Development-User', testUser.email);

      const keys = Object.keys(res.body);
      expect(keys).not.toContain('accessToken');
      expect(keys).not.toContain('refreshToken');
    });
  });
  // ─── POST /api/gmail/sync ──────────────────────────────────────────────────

  describe('POST /api/gmail/sync (COM-20)', () => {
    it('returns 400 when user is not connected', async () => {
      const res = await request(app)
        .post('/api/gmail/sync')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('GMAIL_NOT_CONNECTED');
    });

    it('returns 409 when user is already syncing', async () => {
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          syncStatus: 'SYNCING',
          syncLeaseUntil: new Date(Date.now() + 300000),
          accessToken: encryptToken('real_access_token'),
        },
      });

      const res = await request(app)
        .post('/api/gmail/sync')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SYNC_IN_PROGRESS');
    });

    it('syncs user messages successfully (COM-20)', async () => {
      // Setup connected user
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          syncStatus: 'IDLE',
          accessToken: encryptToken('real_access_token'),
        },
      });

      const res = await request(app)
        .post('/api/gmail/sync')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(true);
      const queued = await prisma.gmailConnection.findUniqueOrThrow({
        where: { userId: testUser.id },
      });
      const result = await syncUser(testUser.id, queued.syncClaim!);
      expect(result.synced).toBe(true);
      expect(result.messagesIngested).toBe(2);
      expect(result.messagesSkipped).toBe(0);

      // Verify DB updates
      const emails = await prisma.email.findMany({ where: { userId: testUser.id } });
      expect(emails).toHaveLength(2);

      const email1 = emails.find((e) => e.gmailMessageId === 'msg-1');
      expect(email1?.subject).toBe('Subject for msg-1');
      expect(email1?.relevanceState).toBe('UNPROCESSED');
      expect(email1?.matchState).toBe('UNMATCHED');

      const connection = await prisma.gmailConnection.findUnique({
        where: { userId: testUser.id },
      });
      expect(connection?.syncStatus).toBe('IDLE');
      expect(connection?.lastHistoryId).toBe('1000');
    });

    it('sync is idempotent (does not duplicate emails)', async () => {
      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          syncStatus: 'IDLE',
          accessToken: encryptToken('real_access_token'),
        },
      });

      // First sync
      await syncUser(testUser.id);

      // Second sync
      const res2 = await syncUser(testUser.id);
      expect(res2.messagesIngested).toBe(0);
      expect(res2.messagesSkipped).toBe(0);

      const count = await prisma.email.count({ where: { userId: testUser.id } });
      expect(count).toBe(2);
    });

    it('records an auth failure when the Gmail background operation is rejected', async () => {
      // Simulate expired/invalid access token by making messages.list reject with
      // a GaxiosError status 401 — the exact failure observed in backend.log.
      const { GaxiosError } = await import('gaxios');
      const { google } = await import('googleapis');

      const mockGmail = vi.mocked(google.gmail);
      const original = mockGmail.getMockImplementation();

      mockGmail.mockReturnValueOnce({
        users: {
          getProfile: vi.fn().mockResolvedValue({ data: { historyId: '1000' } }),
          messages: {
            list: vi.fn().mockRejectedValueOnce(
              new GaxiosError(
                'Request had invalid authentication credentials',
                { headers: new Headers(), url: new URL('https://test.com') },
                {
                  status: 401,
                  statusText: 'Unauthorized',
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  data: { error: { code: 401, message: 'Invalid Credentials' } } as any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  headers: {} as any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  config: {} as any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  request: {} as any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
              ),
            ),
            get: vi.fn(),
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await prisma.gmailConnection.create({
        data: {
          userId: testUser.id,
          gmailEmail: 'testuser@gmail.com',
          status: 'CONNECTED',
          syncStatus: 'IDLE',
          accessToken: encryptToken('expired_access_token'),
          refreshToken: null, // no refresh token — cannot auto-refresh
        },
      });

      await expect(syncUser(testUser.id)).rejects.toThrow('Gmail authorization expired');

      // Connection should be marked FAILED
      const connection = await prisma.gmailConnection.findUnique({
        where: { userId: testUser.id },
      });
      expect(connection?.syncStatus).toBe('FAILED');

      // Restore original mock for subsequent tests
      if (original) mockGmail.mockImplementation(original);
    });
  });

  // ─── GET /api/gmail/messages ───────────────────────────────────────────────

  describe('GET /api/gmail/messages (COM-20)', () => {
    it('returns empty list for user with no messages', async () => {
      const res = await request(app)
        .get('/api/gmail/messages')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(0);
      expect(res.body.items).toEqual([]);
    });

    it('keeps the stuck threshold beyond job retry and uncertain-call bounds', () => {
      const options = emailJobOptions('user', 'email');
      expect(EMAIL_PROCESSING_STUCK_MS).toBe(20 * 60000);
      expect(EMAIL_PROCESSING_STUCK_MS).toBeGreaterThan(
        (options.expireInSeconds + 120 + options.retryDelay * 2 ** options.retryLimit) * 1000,
      );
      expect(EMAIL_PROCESSING_STUCK_MS).toBeGreaterThanOrEqual(STALE_PROCESSING_MS + 5 * 60000);
    });

    it('computes stuck state from row inactivity without exposing its timestamp', async () => {
      const old = new Date(Date.now() - 21 * 60000);
      const data = [
        { gmailMessageId: 'stuck', processingState: 'PROCESSING' as const, updatedAt: old },
        { gmailMessageId: 'live', processingState: 'PROCESSING' as const, updatedAt: new Date() },
        { gmailMessageId: 'pending', processingState: 'PENDING' as const, updatedAt: old },
        { gmailMessageId: 'done', processingState: 'COMPLETED' as const, updatedAt: old },
      ];
      await prisma.email.createMany({ data: data.map((row) => ({ ...row, userId: testUser.id })) });
      const res = await request(app)
        .get('/api/gmail/messages')
        .set('X-Development-User', testUser.email);
      expect(res.status).toBe(200);
      expect(
        Object.fromEntries(
          res.body.items.map((row: { gmailMessageId: string; processingStuck: boolean }) => [
            row.gmailMessageId,
            row.processingStuck,
          ]),
        ),
      ).toEqual({ stuck: true, live: false, pending: false, done: false });
      expect(res.body.items.every((row: object) => !('updatedAt' in row))).toBe(true);
      await prisma.email.updateMany({
        where: { userId: testUser.id, gmailMessageId: 'stuck' },
        data: { processingState: 'PROCESSING' },
      });
      expect(
        (
          await prisma.email.findUniqueOrThrow({
            where: { userId_gmailMessageId: { userId: testUser.id, gmailMessageId: 'stuck' } },
          })
        ).updatedAt.getTime(),
      ).toBeGreaterThan(old.getTime());
    });

    it('returns messages matching the strict contract shape', async () => {
      await prisma.email.create({
        data: {
          userId: testUser.id,
          gmailMessageId: 'msg-contract-1',
          subject: 'Contract Test',
          sender: 'test@contract.com',
          relevanceState: 'UNPROCESSED',
          matchState: 'UNMATCHED',
        },
      });

      const res = await request(app)
        .get('/api/gmail/messages')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(1);

      const msg = res.body.items[0];
      const keys = Object.keys(msg).sort();
      // Should strictly match EmailMessageSchema
      expect(keys).toEqual([
        'aiProcessingResult', // provenance only: { provider, model } or null (ADR-0001)
        'application',
        'applicationId',
        'gmailMessageId',
        'id',
        'matchConfirmedBy',
        'matchState',
        'processingErrorCategory',
        'processingErrorDetails',
        'processingErrorStage',
        'processingFailedAt',
        'processingRetryable',
        'processingState',
        'processingStuck',
        'receivedAt',
        'relevanceState',
        'sender',
        'subject',
        'threadId',
      ]);
      expect(keys).not.toContain('createdAt');
      expect(keys).not.toContain('updatedAt');
      expect(keys).not.toContain('userId');
      expect(msg.applicationId).toBeNull();
      expect(msg.application).toBeNull();
      expect(msg.matchConfirmedBy).toBeNull();
      expect(
        msg.aiProcessingResult === null ||
          Object.keys(msg.aiProcessingResult).sort().join() === 'model,provider',
      ).toBe(true);
    });

    it('isolates messages between users', async () => {
      // Create another user
      await prisma.user.deleteMany({ where: { email: 'other@test.local' } });
      const otherUser = await prisma.user.create({
        data: { email: 'other@test.local' },
      });

      // Insert message for other user
      await prisma.email.create({
        data: {
          userId: otherUser.id,
          gmailMessageId: 'msg-123',
          subject: 'Other User Email',
          sender: 'foo@bar.com',
          relevanceState: 'UNPROCESSED',
          matchState: 'UNMATCHED',
        },
      });

      const res = await request(app)
        .get('/api/gmail/messages')
        .set('X-Development-User', testUser.email);

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(0);
      expect(res.body.items).toEqual([]); // Should not see otherUser's emails

      // cleanup
      await prisma.email.deleteMany();
      await prisma.user.delete({ where: { id: otherUser.id } });
    });
  });
});
