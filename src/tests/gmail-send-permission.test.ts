import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/googleOAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/googleOAuth')>()),
  exchangeGmailCode: vi.fn(),
}));

import { app } from '../index';
import { GmailStatusResponseSchema } from '../contracts/gmail';
import { prisma } from '../db/prisma';
import { clearGmailConnection, maySend, saveGmailGrant } from '../services/gmailConnection';
import { exchangeGmailCode, gmailConsentUrl, grantsSending } from '../services/googleOAuth';

const OWNER = 'owner@send-permission.test';
const MAILBOX = 'owner.mailbox@gmail.example';
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const FRONTEND = process.env.FRONTEND_URL;
let owner: string;

const as = { 'X-Development-User': OWNER };
const status = async () =>
  GmailStatusResponseSchema.parse((await request(app).get('/api/gmail/status').set(as)).body);
const connection = () => prisma.gmailConnection.findUniqueOrThrow({ where: { userId: owner } });
const grant = (canSend?: boolean) => ({ accessToken: 'fixture-access-token', canSend });
/** What the code exchange hands over: the mailbox and the grant with what Google allowed. */
const fromGoogle = (canSend: boolean) => ({
  gmailEmail: MAILBOX,
  grant: { accessToken: 'fixture-access-token', refreshToken: null, expiryDate: null, canSend },
});

/** Starts the Google flow and comes back from Google with the code, as a browser would. */
async function connectThroughGoogle(returnTo?: string) {
  const agent = request.agent(app);
  const started = await agent
    .get('/api/gmail/connect')
    .query(returnTo === undefined ? {} : { returnTo })
    .set(as);
  const state = new URL(started.headers.location).searchParams.get('state');
  return agent.get('/api/gmail/callback').query({ code: 'fixture-code', state }).set(as);
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
});
beforeEach(async () => {
  await prisma.gmailConnection.deleteMany({ where: { userId: owner } });
  vi.mocked(exchangeGmailCode).mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: owner } });
});

describe('asking Google for the send permission', () => {
  it('asks for reading and sending together', () => {
    const scope = new URL(gmailConsentUrl('state')).searchParams.get('scope');
    expect(scope?.split(' ').sort()).toEqual([READ, SEND].sort());
  });

  it('believes only the scopes Google lists with the tokens', () => {
    expect(grantsSending(`${READ} ${SEND}`)).toBe(true);
    expect(grantsSending(`${SEND}\n${READ}`)).toBe(true);
    // The user can untick "send" on Google's screen.
    expect(grantsSending(READ)).toBe(false);
    expect(grantsSending(`${READ} ${SEND}.extra`)).toBe(false);
    expect(grantsSending('')).toBe(false);
    expect(grantsSending(undefined)).toBe(false);
    expect(grantsSending(null)).toBe(false);
  });
});

describe('remembering for each connection whether it may send', () => {
  it('starts every connection as read-only, like every connection made before this change', async () => {
    await saveGmailGrant(owner, MAILBOX, grant());
    expect((await connection()).canSend).toBe(false);
    expect(await status()).toMatchObject({ connected: true, canSend: false });
  });

  it('may send after a grant that covers sending, and says so in the status', async () => {
    await saveGmailGrant(owner, MAILBOX, grant(true));
    expect(await status()).toMatchObject({ connected: true, canSend: true });
  });

  it('follows the newest grant: allowing later turns it on, a read-only grant turns it off', async () => {
    await saveGmailGrant(owner, MAILBOX, grant(false));
    await prisma.gmailConnection.update({
      where: { userId: owner },
      data: { lastHistoryId: '42', lastSyncedAt: new Date('2026-10-01T00:00:00Z') },
    });
    await saveGmailGrant(owner, MAILBOX, grant(true));
    // Allowing sending keeps the mailbox, its sync position and everything read so far.
    expect(await connection()).toMatchObject({ canSend: true, lastHistoryId: '42' });
    await saveGmailGrant(owner, MAILBOX, grant(false));
    expect((await connection()).canSend).toBe(false);
  });

  it('may not send once the connection is revoked or cleared', async () => {
    await saveGmailGrant(owner, MAILBOX, grant(true));
    await prisma.gmailConnection.update({ where: { userId: owner }, data: { status: 'REVOKED' } });
    expect((await status()).canSend).toBe(false);
    await clearGmailConnection(owner);
    expect(await connection()).toMatchObject({ status: 'NOT_CONNECTED', canSend: false });
  });

  it('says false for a user with no connection', async () => {
    expect(await status()).toMatchObject({ connected: false, canSend: false });
  });

  it('lets the sandbox mailbox always send, and only there', () => {
    const readOnly = { status: 'CONNECTED', canSend: false };
    expect(maySend(readOnly, false)).toBe(false);
    expect(maySend(readOnly, true)).toBe(true);
    expect(maySend({ status: 'NOT_CONNECTED', canSend: false }, true)).toBe(false);
  });
});

describe('coming back from Google', () => {
  beforeEach(() => {
    vi.mocked(exchangeGmailCode).mockResolvedValue(fromGoogle(true));
  });

  it('saves what Google granted and returns to the Gmail page', async () => {
    const back = await connectThroughGoogle();
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe(`${FRONTEND}/gmail`);
    expect((await connection()).canSend).toBe(true);
  });

  it.each(['/mails/18c2f0a1b2c3d4e5', '/mails/gmail/18c2f0a1b2c3d4e5'])(
    'returns to the mail the user came from (%s)',
    async (mail) => {
      const back = await connectThroughGoogle(mail);
      expect(back.headers.location).toBe(`${FRONTEND}${mail}`);
    },
  );

  it.each([
    'https://evil.example/mails/1',
    '//evil.example/mails/1',
    '/mails/1/../../ai',
    '/mails/1?next=https://evil.example',
    '/ai',
    '/mails/',
    `/mails/${'a'.repeat(129)}`,
  ])('never leaves the app or goes to another page (%s)', async (returnTo) => {
    const back = await connectThroughGoogle(returnTo);
    expect(back.headers.location).toBe(`${FRONTEND}/gmail`);
  });

  it('forgets the mail of an earlier try', async () => {
    const agent = request.agent(app);
    await agent.get('/api/gmail/connect').query({ returnTo: '/mails/18c2f0a1b2c3d4e5' }).set(as);
    const started = await agent.get('/api/gmail/connect').set(as);
    const state = new URL(started.headers.location).searchParams.get('state');
    const back = await agent.get('/api/gmail/callback').query({ code: 'c', state }).set(as);
    expect(back.headers.location).toBe(`${FRONTEND}/gmail`);
  });

  it('keeps a read-only connection read-only when the user unticks sending', async () => {
    vi.mocked(exchangeGmailCode).mockResolvedValue(fromGoogle(false));
    await connectThroughGoogle('/mails/18c2f0a1b2c3d4e5');
    expect(await status()).toMatchObject({ connected: true, canSend: false });
  });

  it('in dev mode connects the sandbox at once and returns to the mail', async () => {
    vi.stubEnv('APP_MODE', 'dev');
    const back = await request(app)
      .get('/api/gmail/connect')
      .query({ returnTo: '/mails/18c2f0a1b2c3d4e5' })
      .set(as);
    expect(back.headers.location).toBe(`${FRONTEND}/mails/18c2f0a1b2c3d4e5`);
    expect(exchangeGmailCode).not.toHaveBeenCalled();
    expect(await status()).toMatchObject({ connected: true, canSend: true });
  });
});
