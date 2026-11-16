/**
 * The first run (owner, 15 Nov 2026): connecting Gmail with the free AI agreement on the button
 * turns on NorthList's free AI for a user who has no AI yet, starts the first sync at once, and
 * a new connection's first sync reads 7 days.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueGmailSync: vi.fn().mockResolvedValue('sync-job'),
  enqueueEmailProcessingJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/googleOAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/googleOAuth')>()),
  exchangeGmailCode: vi.fn(),
}));

import { app } from '../index';
import { getCatalogProvider } from '../contracts/aiCatalog';
import { GmailStatusResponseSchema } from '../contracts/gmail';
import { prisma } from '../db/prisma';
import { enqueueGmailSync } from '../services/enqueue';
import { exchangeGmailCode } from '../services/googleOAuth';

const NEW_USER = 'new.user@first-run.test';
const MAILBOX = 'new.user.mailbox@gmail.example';
const FRONTEND = process.env.FRONTEND_URL;
const FREE_AI = 'career-companion';
const AGREED = getCatalogProvider(FREE_AI)!.disclosure.version;
const as = { 'X-Development-User': NEW_USER };
let userId: string;

const config = () => prisma.aIConfiguration.findUnique({ where: { userId } });
const connection = () => prisma.gmailConnection.findUniqueOrThrow({ where: { userId } });
const status = async () =>
  GmailStatusResponseSchema.parse((await request(app).get('/api/gmail/status').set(as)).body);

/** Dev mode: the sandbox mailbox is connected at once, as the button does. */
const connectSandbox = (query: Record<string, string> = {}) => {
  vi.stubEnv('APP_MODE', 'dev');
  return request(app).get('/api/gmail/connect').query(query).set(as);
};

/** Production: starts the Google flow and comes back from Google, as a browser would. */
async function connectThroughGoogle(query: Record<string, string> = {}) {
  vi.mocked(exchangeGmailCode).mockResolvedValue({
    gmailEmail: MAILBOX,
    grant: {
      accessToken: 'fixture-access-token',
      refreshToken: null,
      expiryDate: null,
      canSend: true,
    },
  });
  const agent = request.agent(app);
  const started = await agent.get('/api/gmail/connect').query(query).set(as);
  const state = new URL(started.headers.location).searchParams.get('state');
  return agent.get('/api/gmail/callback').query({ code: 'fixture-code', state }).set(as);
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: NEW_USER } });
  userId = (await prisma.user.create({ data: { email: NEW_USER } })).id;
});
beforeEach(async () => {
  vi.stubEnv('FREE_AI_OPENROUTER_KEY', 'fixture-free-ai-key');
  vi.stubEnv('FREE_AI_ENABLED', '');
  vi.mocked(enqueueGmailSync).mockClear();
  vi.mocked(exchangeGmailCode).mockReset();
  await prisma.gmailConnection.deleteMany({ where: { userId } });
  await prisma.aIConfiguration.deleteMany({ where: { userId } });
  await prisma.aISavedProvider.deleteMany({ where: { userId } });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe('the free AI on the Connect Gmail button', () => {
  it('turns on the free AI for a new user who agreed, and returns to the Dashboard', async () => {
    const back = await connectSandbox({ returnTo: '/dashboard', freeAI: AGREED });
    expect(back.headers.location).toBe(`${FRONTEND}/dashboard`);
    expect(await config()).toMatchObject({ provider: FREE_AI, consentDisclosure: AGREED });
  });

  it('turns on nothing without the agreement', async () => {
    await connectSandbox({ returnTo: '/dashboard' });
    expect(await config()).toBeNull();
  });

  it('turns on nothing for an agreement to an older text', async () => {
    await connectSandbox({ freeAI: 'career-companion-free-2020-01-01' });
    expect(await config()).toBeNull();
  });

  it('turns on nothing while the free AI cannot run', async () => {
    vi.stubEnv('FREE_AI_OPENROUTER_KEY', '');
    await connectSandbox({ freeAI: AGREED });
    expect(await config()).toBeNull();
  });

  it('never replaces a provider the user chose before', async () => {
    const now = new Date();
    await prisma.aIConfiguration.create({
      data: {
        userId,
        provider: 'openrouter',
        encryptedApiKey: 'v1:fixture-encrypted-key',
        consentDisclosure: 'fixture',
        consentedAt: now,
      },
    });
    await connectSandbox({ freeAI: AGREED });
    expect(await config()).toMatchObject({ provider: 'openrouter' });
    expect(await prisma.aISavedProvider.count({ where: { userId } })).toBe(0);
  });

  it('carries the agreement through Google and back', async () => {
    const back = await connectThroughGoogle({ returnTo: '/dashboard', freeAI: AGREED });
    expect(back.headers.location).toBe(`${FRONTEND}/dashboard`);
    expect(await config()).toMatchObject({ provider: FREE_AI });
  });

  it('forgets the agreement of an earlier try', async () => {
    const agent = request.agent(app);
    await agent.get('/api/gmail/connect').query({ freeAI: AGREED }).set(as);
    vi.mocked(exchangeGmailCode).mockResolvedValue({
      gmailEmail: MAILBOX,
      grant: {
        accessToken: 'fixture-access-token',
        refreshToken: null,
        expiryDate: null,
        canSend: false,
      },
    });
    const started = await agent.get('/api/gmail/connect').set(as);
    const state = new URL(started.headers.location).searchParams.get('state');
    await agent.get('/api/gmail/callback').query({ code: 'c', state }).set(as);
    expect(await config()).toBeNull();
  });

  it.each(['/dashboard/x', '/dashboards', '/ai'])(
    'returns to the Gmail page for any other page (%s)',
    async (returnTo) => {
      const back = await connectThroughGoogle({ returnTo });
      expect(back.headers.location).toBe(`${FRONTEND}/gmail`);
    },
  );
});

describe('the first sync after connecting', () => {
  it('starts at once in dev mode', async () => {
    await connectSandbox();
    expect(enqueueGmailSync).toHaveBeenCalledWith(
      expect.objectContaining({ userId, trigger: 'manual' }),
    );
    expect((await connection()).syncStatus).toBe('SYNCING');
  });

  it('starts at once after Google', async () => {
    await connectThroughGoogle();
    expect(enqueueGmailSync).toHaveBeenCalledWith(expect.objectContaining({ userId }));
    expect((await connection()).syncStatus).toBe('SYNCING');
  });

  it('still connects when the sync cannot be queued', async () => {
    vi.mocked(enqueueGmailSync).mockResolvedValueOnce(null);
    const back = await connectSandbox({ returnTo: '/dashboard', freeAI: AGREED });
    expect(back.headers.location).toBe(`${FRONTEND}/dashboard`);
    expect(await status()).toMatchObject({ connected: true });
    expect(await config()).toMatchObject({ provider: FREE_AI });
  });

  it('reads 7 days on a new connection, and keeps a saved choice', async () => {
    expect(await status()).toMatchObject({ connected: false, syncLookbackDays: 7 });
    await connectSandbox();
    expect((await connection()).syncLookbackDays).toBe(7);
    await prisma.gmailConnection.update({ where: { userId }, data: { syncLookbackDays: 1 } });
    await connectSandbox();
    expect((await connection()).syncLookbackDays).toBe(1);
  });
});
