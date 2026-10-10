import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer, ServerResponse } from 'node:http';
import request from 'supertest';
import { prisma } from '../db/prisma';
import { encryptToken, decryptToken } from '../utils/gmailTokenEncryption';
import { withGmail } from '../services/gmailClient';
import {
  gmailCallOptions,
  createGoogleOAuthClient,
  GOOGLE_OAUTH_TIMEOUT_MS,
} from '../services/googleTransport';
import { syncUser } from '../services/gmailSync';
import { handleGmailSyncJobs } from '../jobs/gmailSyncJob';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { app } from '../index';
import type { JobWithMetadata } from 'pg-boss';
import type { GmailSyncJobData } from '../jobs/gmailSyncJob';

const transport = vi.hoisted(() => ({ root: '', dataBound: 200, budget: 350 }));
vi.mock('googleapis', async (importOriginal) => {
  const real = await importOriginal<typeof import('googleapis')>();
  class LocalOAuth extends real.google.auth.OAuth2 {
    constructor(options: ConstructorParameters<typeof real.google.auth.OAuth2>[0]) {
      if (typeof options !== 'object') throw new Error('Expected options-object OAuth client');
      super({
        ...options,
        endpoints: {
          oauth2TokenUrl: transport.root + 'token',
          oauth2RevokeUrl: transport.root + 'revoke',
          oauth2FederatedSignonPemCertsUrl: transport.root + 'certs',
        },
      });
    }
  }
  return {
    ...real,
    google: {
      ...real.google,
      auth: { ...real.google.auth, OAuth2: LocalOAuth },
      gmail: (options: object) =>
        real.google.gmail({ ...options, version: 'v1', rootUrl: transport.root }),
    },
  };
});
vi.mock('../services/googleTransport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/googleTransport')>();
  return {
    ...real,
    GOOGLE_OAUTH_TIMEOUT_MS: 200,
    GOOGLE_REVOKE_TIMEOUT_MS: 150,
    get SYNC_ATTEMPT_BUDGET_MS() {
      return transport.budget;
    },
    gmailCallOptions: (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return { timeout: transport.dataBound, retryConfig: { retry: 0 }, signal };
    },
  };
});
vi.mock('../jobs/emailProcessingJob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jobs/emailProcessingJob')>()),
  enqueueEmailProcessingJob: vi.fn(),
}));
let userId: string;
const address = 'transport@fixture.test';
const hits = new Map<string, number>();
const handlers = new Map<string, (res: ServerResponse, hit: number) => void>();
const send = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const server = createServer((req, res) => {
  const path = new URL(req.url!, transport.root).pathname;
  const hit = (hits.get(path) ?? 0) + 1;
  hits.set(path, hit);
  if (handlers.has(path)) return handlers.get(path)!(res, hit);
  if (path === '/token')
    return send(res, {
      access_token: 'fake-refreshed',
      refresh_token: 'fake-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  if (path === '/revoke') return send(res, {});
  if (path.endsWith('/profile')) return send(res, { emailAddress: address, historyId: '100' });
  if (path.endsWith('/messages')) return send(res, { messages: [] });
  return send(res, {
    id: 'fixture',
    labelIds: ['INBOX'],
    snippet: 'fixture',
    payload: {
      mimeType: 'text/plain',
      body: { data: Buffer.from('fixture body').toString('base64') },
    },
  });
});
const messagePath = '/gmail/v1/users/me/messages/fixture';
const listPath = '/gmail/v1/users/me/messages';
const profilePath = '/gmail/v1/users/me/profile';
const row = () => prisma.gmailConnection.findUniqueOrThrow({ where: { userId } });
const call = (signal?: AbortSignal) =>
  withGmail(
    userId,
    (gmail) => gmail.users.messages.get({ userId: 'me', id: 'fixture' }, gmailCallOptions(signal)),
    { signal },
  );
const fail =
  (status: number, reason = 'forbidden') =>
  (res: ServerResponse) =>
    send(
      res,
      { error: { code: status, message: 'PRIVATE GOOGLE TEXT fake-access', errors: [{ reason }] } },
      status,
    );
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  transport.root = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  userId = (await prisma.user.create({ data: { email: address } })).id;
});
beforeEach(async () => {
  hits.clear();
  handlers.clear();
  transport.dataBound = 200;
  transport.budget = 350;
  vi.restoreAllMocks();
  const data = {
    status: 'CONNECTED' as const,
    accessToken: encryptToken('fake-access'),
    refreshToken: encryptToken('fake-refresh'),
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    syncStatus: 'IDLE' as const,
    syncClaim: null,
    syncLeaseUntil: null,
    lastSyncedAt: null,
    lastHistoryId: null,
  };
  await prisma.gmailConnection.upsert({
    where: { userId },
    create: { userId, gmailEmail: address, ...data },
    update: data,
  });
});
afterEach(() => {
  server.closeAllConnections();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.user.delete({ where: { id: userId } });
});
it.each([500, 503, 429])('does not retry data status %s', async (status) => {
  handlers.set(messagePath, fail(status));
  const start = performance.now();
  await expect(call()).rejects.toMatchObject({ status });
  expect(performance.now() - start).toBeLessThan(1000);
  expect(hits.get(messagePath)).toBe(1);
});
it('times out one hung data request without leaking provider text', async () => {
  handlers.set(messagePath, () => undefined);
  const start = performance.now();
  const err = await call().catch((e) => e);
  expect(err).toMatchObject({ message: 'Gmail request failed', reason: 'timeout' });
  expect(performance.now() - start).toBeLessThan(1000);
  expect(hits.get(messagePath)).toBe(1);
  expect(Object.keys(err).sort()).toEqual(['reason', 'status']);
});
it('reactively refreshes a legacy 401 once and persists token plus expiry', async () => {
  await prisma.gmailConnection.update({ where: { userId }, data: { accessTokenExpiresAt: null } });
  handlers.set(messagePath, (res, hit) => (hit === 1 ? fail(401)(res) : send(res, {})));
  await call();
  expect(hits.get(messagePath)).toBe(2);
  expect(hits.get('/token')).toBe(1);
  expect(decryptToken((await row()).accessToken)).toBe('fake-refreshed');
  expect((await row()).accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
});
it.each(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'])(
  'does not refresh or revoke an unexpired quota 403: %s',
  async (reason) => {
    const before = await row();
    handlers.set(messagePath, fail(403, reason));
    await expect(call()).rejects.toMatchObject({ status: 403, reason: 'rate_limit' });
    expect(hits.get(messagePath)).toBe(1);
    expect(hits.get('/token')).toBeUndefined();
    expect(await row()).toMatchObject({ status: 'CONNECTED', accessToken: before.accessToken });
  },
);
it('revokes a known-expiry 401 without token refresh', async () => {
  handlers.set(messagePath, fail(401));
  await expect(call()).rejects.toMatchObject({ status: 401 });
  expect(hits.get(messagePath)).toBe(1);
  expect(hits.get('/token')).toBeUndefined();
  expect((await row()).status).toBe('REVOKED');
});
it('refreshes before data when expiry is near', async () => {
  await prisma.gmailConnection.update({
    where: { userId },
    data: { accessTokenExpiresAt: new Date(Date.now() + 1000) },
  });
  handlers.set('/token', (res) => {
    expect(hits.get(messagePath)).toBeUndefined();
    send(res, { access_token: 'fake-refreshed', expires_in: 3600 });
  });
  await call();
  expect(hits.get('/token')).toBe(1);
  expect(hits.get(messagePath)).toBe(1);
});
it.each(['hang', 'invalid_grant', '503'])('bounds OAuth refresh and handles %s', async (mode) => {
  await prisma.gmailConnection.update({
    where: { userId },
    data: { accessTokenExpiresAt: new Date(Date.now() - 1000) },
  });
  handlers.set('/token', (res) => {
    if (mode === 'invalid_grant')
      send(res, { error: 'invalid_grant', error_description: 'PRIVATE fake-refresh' }, 400);
    if (mode === '503') fail(503)(res);
  });
  const start = performance.now();
  const error = await call().catch((e) => e);
  expect(error).toMatchObject({ message: 'Gmail request failed' });
  if (mode === 'hang') expect(error.reason).toBe('timeout');
  expect(performance.now() - start).toBeLessThan(1000);
  expect(hits.get('/token')).toBe(1);
  expect(hits.get(messagePath)).toBeUndefined();
  expect((await row()).status).toBe(mode === 'invalid_grant' ? 'REVOKED' : 'CONNECTED');
});
it('aborts an in-flight request and sends nothing for an already-aborted signal', async () => {
  const controller = new AbortController();
  handlers.set(messagePath, () => controller.abort());
  const start = performance.now();
  await expect(call(controller.signal)).rejects.toThrow();
  expect(performance.now() - start).toBeLessThan(1000);
  expect(hits.get(messagePath)).toBe(1);
  hits.clear();
  await expect(call(controller.signal)).rejects.toThrow();
  expect(hits.size).toBe(0);
});
it('does not start an SDK-internal refresh after cancellation of a legacy 401', async () => {
  const controller = new AbortController();
  await prisma.gmailConnection.update({ where: { userId }, data: { accessTokenExpiresAt: null } });
  handlers.set(messagePath, (res) => {
    controller.abort();
    fail(401)(res);
  });
  await expect(call(controller.signal)).rejects.toThrow();
  expect(hits.get('/token')).toBeUndefined();
});
it('passes signals through both email fetches', async () => {
  const controller = new AbortController();
  handlers.set(messagePath, () => controller.abort());
  await expect(
    fetchMessageMetadata(userId, 'fixture', { signal: controller.signal }),
  ).rejects.toThrow();
  hits.clear();
  await expect(
    fetchMessageBody(userId, 'fixture', { signal: controller.signal }),
  ).rejects.toThrow();
  expect(hits.size).toBe(0);
});
it.each(['deadline', 'cancel', 'timeout', 'quota', 'forbidden', 'network'] as const)(
  'ends a sync with safe %s category and unchanged checkpoint',
  async (mode) => {
    const previous = new Date(Date.now() - 2 * 86400_000);
    await prisma.gmailConnection.update({
      where: { userId },
      data: { lastHistoryId: 'old', lastSyncedAt: previous },
    });
    const controller = new AbortController();
    if (mode === 'deadline') transport.dataBound = 2000;
    handlers.set(listPath, (res) => {
      if (mode === 'cancel') controller.abort();
      if (mode === 'quota') fail(403, 'userRateLimitExceeded')(res);
      if (mode === 'forbidden') fail(403)(res);
      if (mode === 'network') res.destroy();
    });
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const categories = {
      deadline: 'DEADLINE_EXCEEDED',
      cancel: 'CANCELLED',
      timeout: 'REQUEST_TIMEOUT',
      quota: 'RATE_LIMIT',
      forbidden: 'FORBIDDEN',
      network: 'NETWORK_ERROR',
    };
    const start = performance.now();
    const error = await handleGmailSyncJobs([
      {
        id: 'fixture-job',
        data: { userId },
        retryCount: 0,
        retryLimit: 3,
        signal: controller.signal,
      } as JobWithMetadata<GmailSyncJobData>,
    ]).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    if (mode === 'deadline') expect(error.name).toBe('SyncDeadlineError');
    if (mode === 'cancel') expect(error.name).toBe('SyncCancelledError');
    expect(performance.now() - start).toBeLessThan(1200);
    expect(hits.get(listPath)).toBe(1);
    expect(await row()).toMatchObject({
      lastHistoryId: 'old',
      lastSyncedAt: previous,
      syncStatus: 'FAILED',
      syncError: 'SYNC_FAILED',
    });
    expect(
      logs.mock.calls.map((c) => JSON.parse(c[0])).find((e) => e.event === 'gmail_sync_failed'),
    ).toMatchObject({ category: categories[mode], checkpointCommitted: false });
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE|fake-access|fake-refresh/);
  },
);
it('makes no Google call for a pre-cancelled sync delivery', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(syncUser(userId, undefined, { signal: controller.signal })).rejects.toMatchObject({
    name: 'SyncCancelledError',
  });
  expect(hits.size).toBe(0);
});
it.each(['token', 'profile'])(
  'bounds Gmail callback %s and keeps a generic redirect',
  async (path) => {
    handlers.set(path === 'token' ? '/token' : profilePath, () => undefined);
    const agent = request.agent(app);
    const connect = await agent.get('/api/gmail/connect').set('X-Development-User', address);
    const state = new URL(connect.headers.location).searchParams.get('state')!;
    const start = performance.now();
    const response = await agent
      .get('/api/gmail/callback')
      .query({ code: 'fake-code', state })
      .set('X-Development-User', address);
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('gmailError=server_error');
    expect(performance.now() - start).toBeLessThan(1200);
    expect(hits.get(path === 'token' ? '/token' : profilePath)).toBe(1);
  },
);
it('bounds sign-in token exchange and cert fetch', async () => {
  handlers.set('/token', () => undefined);
  handlers.set('/certs', () => undefined);
  const agent = request.agent(app);
  const connect = await agent.get('/api/auth/connect');
  const state = new URL(connect.headers.location).searchParams.get('state')!;
  const response = await agent.get('/api/auth/callback').query({ code: 'fake-code', state });
  expect(response.status).toBe(302);
  expect(response.headers.location).toContain('error=server_error');
  expect(hits.get('/token')).toBe(1);
  const client = createGoogleOAuthClient({
    clientId: 'fixture',
    timeoutMs: GOOGLE_OAUTH_TIMEOUT_MS,
  });
  const start = performance.now();
  await expect(client.getFederatedSignonCertsAsync()).rejects.toThrow();
  expect(performance.now() - start).toBeLessThan(1000);
  expect(hits.get('/certs')).toBe(1);
});
it('clears tokens and expiry despite a hung revoke', async () => {
  handlers.set('/revoke', () => undefined);
  const start = performance.now();
  const response = await request(app)
    .post('/api/gmail/disconnect')
    .set('X-Development-User', address);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ disconnected: true });
  expect(performance.now() - start).toBeLessThan(1000);
  expect(await row()).toMatchObject({
    status: 'NOT_CONNECTED',
    accessToken: '',
    refreshToken: null,
    accessTokenExpiresAt: null,
  });
  expect(hits.get('/revoke')).toBe(1);
});
it('stores expiry from a successful callback', async () => {
  const agent = request.agent(app);
  const connect = await agent.get('/api/gmail/connect').set('X-Development-User', address);
  const state = new URL(connect.headers.location).searchParams.get('state')!;
  const response = await agent
    .get('/api/gmail/callback')
    .query({ code: 'fake-code', state })
    .set('X-Development-User', address);
  expect(response.status).toBe(302);
  expect(response.headers.location).not.toContain('Error');
  expect((await row()).accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 3000_000);
});
