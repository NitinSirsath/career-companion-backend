/**
 * The cap on replies sent from NorthList (MAIL_DAILY_REPLY_LIMIT), in dev mode with the sandbox
 * mailbox standing in for Gmail: the same send path as prod.
 */
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/google', () => {
  const refuse = () => {
    throw new Error('A Google client was built');
  };
  return { google: { auth: { OAuth2: refuse }, gmail: refuse } };
});
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueEmailProcessingJob: vi.fn(async () => 'email-job'),
  enqueueRelevanceTriage: vi.fn(async () => 'triage-job'),
  enqueueNotificationJob: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';

const OWNER = 'owner@mail-reply-limit.test';
let owner: string;

const as = { 'X-Development-User': OWNER };
const receive = async () =>
  (
    await request(app).post('/api/sandbox/messages').set(as).send({
      from: 'Priya Raman <priya.raman@northwind.example>',
      subject: 'Opportunity at Northwind Robotics',
      body: 'Would you have 20 minutes this week?',
    })
  ).body as { threadId: string };
const reply = (threadId: string, replyId = randomUUID()) =>
  request(app)
    .post(`/api/mailbox/threads/${threadId}/replies`)
    .set(as)
    .send({ replyId, text: 'Thursday at 3 pm works for me.' });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER, name: 'Alex Tester' } })).id;
});
beforeEach(async () => {
  vi.stubEnv('ENABLE_DEV_AUTH', 'true');
  vi.stubEnv('APP_MODE', 'dev');
  vi.stubEnv('MAIL_DAILY_REPLY_LIMIT', '2');
  await prisma.mailReply.deleteMany({ where: { userId: owner } });
  await prisma.sandboxMessage.deleteMany({ where: { userId: owner } });
  await prisma.gmailConnection.deleteMany({ where: { userId: owner } });
  await request(app).get('/api/gmail/connect').set(as);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: owner } });
});

describe('the cap on replies sent from NorthList', () => {
  it('sends up to the cap in 24 hours, then refuses with a clear message and sends nothing', async () => {
    const { threadId } = await receive();
    expect((await reply(threadId)).status).toBe(200);
    const second = randomUUID();
    expect((await reply(threadId, second)).status).toBe(200);
    const refused = await reply(threadId);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toEqual({
      code: 'MAIL_DAILY_LIMIT',
      message:
        'You sent 2 mails from NorthList in the last 24 hours. Send more from Gmail, or try again later.',
      details: { limit: 2 },
    });
    expect(await prisma.mailReply.count({ where: { userId: owner } })).toBe(2);
    // A repeat of a reply that was sent is not a new mail: it still gets its earlier answer.
    expect((await reply(threadId, second)).status).toBe(200);
  });

  it('counts only the last 24 hours', async () => {
    vi.stubEnv('MAIL_DAILY_REPLY_LIMIT', '1');
    const { threadId } = await receive();
    expect((await reply(threadId)).status).toBe(200);
    await prisma.mailReply.updateMany({
      where: { userId: owner },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    expect((await reply(threadId)).status).toBe(200);
  });

  it('turns sending from the app off at 0', async () => {
    vi.stubEnv('MAIL_DAILY_REPLY_LIMIT', '0');
    const { threadId } = await receive();
    const refused = await reply(threadId);
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toBe(
      'Sending from NorthList is turned off. Send your reply from Gmail.',
    );
  });
});
