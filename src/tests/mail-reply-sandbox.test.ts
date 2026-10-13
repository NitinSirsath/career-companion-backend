/**
 * A reply sent from the mail details page, in dev mode: the same code as prod, with the sandbox
 * mailbox standing in for Gmail. Building any Google client here is a failure.
 */
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const google = vi.hoisted(() => ({ built: vi.fn() }));
vi.mock('googleapis', () => {
  const refuse = () => {
    google.built();
    throw new Error('A Google client was built');
  };
  return {
    google: {
      auth: {
        OAuth2: class {
          constructor() {
            refuse();
          }
        },
      },
      gmail: refuse,
    },
  };
});
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueEmailProcessingJob: vi.fn(async () => 'email-job'),
  enqueueRelevanceTriage: vi.fn(async () => 'triage-job'),
  enqueueNotificationJob: vi.fn(),
}));

import { app } from '../index';
import {
  ConversationDetailSchema,
  MailThreadSchema,
  SendMailReplyResponseSchema,
} from '../contracts';
import { SandboxThreadDetailSchema } from '../contracts/sandbox';
import { prisma } from '../db/prisma';
import { syncUser } from '../services/gmailSync';

const OWNER = 'owner@mail-reply.test';
const OTHER = 'other@mail-reply.test';
const PRIYA = 'Priya Raman <priya.raman@northwind.example>';
const DANIEL = 'Daniel Okafor <daniel.okafor@northwind.example>';
const LENA = 'Lena Fischer <lena.fischer@northwind.example>';
const TEXT = 'REPLYSENTINEL Thursday at 3 pm works for me.';
let owner: string;
let other: string;

const as = (user = OWNER) => ({ 'X-Development-User': user });
const connect = (user = OWNER) => request(app).get('/api/gmail/connect').set(as(user));
const compose = (more: object = {}, user = OWNER) =>
  request(app)
    .post('/api/sandbox/messages')
    .set(as(user))
    .send({
      from: PRIYA,
      subject: 'Opportunity at Northwind Robotics',
      body: 'Hi Alex,\n\nWould you have 20 minutes this week?',
      ...more,
    });
const receive = async (user = OWNER, more: object = {}) =>
  (await compose(more, user)).body as { id: string; threadId: string };
const sendReply = (threadId: string, body: object, user = OWNER) =>
  request(app).post(`/api/mailbox/threads/${threadId}/replies`).set(as(user)).send(body);
const reply = (threadId: string, text = TEXT, replyId = randomUUID()) =>
  sendReply(threadId, { replyId, text });
const sandboxThread = async (threadId: string) =>
  SandboxThreadDetailSchema.parse(
    (await request(app).get(`/api/sandbox/threads/${threadId}`).set(as())).body,
  );
const mailThread = async (threadId: string) =>
  MailThreadSchema.parse(
    (await request(app).get(`/api/mailbox/threads/${threadId}`).set(as())).body,
  );
/** What the AI workers would save for a job mail; this file does not run them. */
const readAsJobMail = (gmailMessageId: string) =>
  prisma.email.update({
    where: { userId_gmailMessageId: { userId: owner, gmailMessageId } },
    data: {
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      aiProcessingResult: {
        create: {
          provider: 'gemini',
          model: 'test-model',
          contractVersion: 'extraction/v2',
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          category: 'RECRUITER',
          companyName: 'Northwind Robotics',
          jobTitle: 'Senior Platform Engineer',
          actionRequired: true,
          requestedAction: 'Reply with a time for a call',
        },
      },
    },
  });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [OWNER, OTHER] } } });
  owner = (await prisma.user.create({ data: { email: OWNER, name: 'Alex Tester' } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  vi.stubEnv('ENABLE_DEV_AUTH', 'true');
  vi.stubEnv('APP_MODE', 'dev');
  const mine = { userId: { in: [owner, other] } };
  await prisma.sandboxMessage.deleteMany({ where: mine });
  await prisma.email.deleteMany({ where: mine });
  await prisma.outgoingEmail.deleteMany({ where: mine });
  await prisma.mailReply.deleteMany({ where: mine });
  await prisma.gmailConnection.deleteMany({ where: mine });
  google.built.mockClear();
  await connect();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});

describe('replying from the mail details page in dev mode', () => {
  it('says who a reply goes to when the conversation is read', async () => {
    const mail = await receive();
    expect((await mailThread(mail.threadId)).replyTo).toBe(PRIYA);
  });

  it('sends the reply into the same conversation of the sandbox, with the answered mail quoted', async () => {
    const mail = await receive();
    const res = await reply(mail.threadId);
    expect(res.status).toBe(200);
    const sent = SendMailReplyResponseSchema.parse(res.body);
    expect(sent.threadId).toBe(mail.threadId);

    const { messages } = await sandboxThread(mail.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: sent.id,
      sentByUser: true,
      from: 'Alex Tester <owner@mail-reply.test>',
      to: PRIYA,
    });
    expect(messages[1].text).toMatch(
      /^REPLYSENTINEL Thursday at 3 pm works for me\.\n\nOn .+ GMT, Priya Raman <priya\.raman@northwind\.example> wrote:\n> Hi Alex,\n> \n> Would you have 20 minutes this week\?$/,
    );
    // The app reads its own reply back as part of the conversation, like any sent mail.
    const read = await mailThread(mail.threadId);
    expect(read.messages.map((message) => message.sentByUser)).toEqual([false, true]);
    expect(read.messages[1].subject).toBe('Re: Opportunity at Northwind Robotics');
    expect(read.replyTo).toBe(PRIYA);
    expect(google.built).not.toHaveBeenCalled();
  });

  it('shows the conversation as Replied at once, and the next sync notes nothing twice', async () => {
    const mail = await receive();
    await syncUser(owner);
    await readAsJobMail(mail.id);

    const sent = SendMailReplyResponseSchema.parse((await reply(mail.threadId)).body);
    const detail = async () =>
      ConversationDetailSchema.parse(
        (await request(app).get(`/api/conversations/${mail.threadId}`).set(as())).body,
      ).conversation;
    // No sync since the reply.
    expect(await detail()).toMatchObject({ sentCount: 1, request: { state: 'REPLIED' } });
    const noted = await prisma.outgoingEmail.findMany({ where: { userId: owner } });
    expect(noted).toHaveLength(1);
    expect(noted[0]).toMatchObject({ gmailMessageId: sent.id, threadId: mail.threadId });

    await syncUser(owner);
    expect(await prisma.outgoingEmail.count({ where: { userId: owner } })).toBe(1);
    // The reply is never read as mail of its own.
    expect(await prisma.email.count({ where: { userId: owner } })).toBe(1);
    expect((await detail()).sentCount).toBe(1);
  });

  it('sends one mail for one reply ID, however often the request arrives', async () => {
    const mail = await receive();
    const replyId = randomUUID();
    const first = await reply(mail.threadId, TEXT, replyId);
    const again = await reply(mail.threadId, TEXT, replyId);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect((await sandboxThread(mail.threadId)).messages).toHaveLength(2);
    // A new reply ID is a new reply.
    expect((await reply(mail.threadId, 'One more thing.')).status).toBe(200);
    expect((await sandboxThread(mail.threadId)).messages).toHaveLength(3);
  });

  it('sends a reply in a conversation the app has not synced, and notes it only in its send list', async () => {
    const mail = await receive();
    expect((await reply(mail.threadId)).status).toBe(200);
    expect(await prisma.outgoingEmail.count({ where: { userId: owner } })).toBe(0);
    expect(await prisma.mailReply.findMany({ where: { userId: owner } })).toMatchObject([
      { threadId: mail.threadId, gmailMessageId: expect.any(String), sentAt: expect.any(Date) },
    ]);
  });

  it("refuses another user's conversation and an unknown one, and sends nothing", async () => {
    await connect(OTHER);
    const theirs = await receive(OTHER);
    for (const threadId of [theirs.threadId, 'ffffffffffffffff']) {
      const res = await reply(threadId);
      expect(res.status).toBe(404);
    }
    expect(await prisma.sandboxMessage.count({ where: { userId: other } })).toBe(1);
    // Nothing was sent, so no reply ID stays taken.
    expect(await prisma.mailReply.count()).toBe(0);
  });

  it.each([
    ['no text', { replyId: randomUUID(), text: '   ' }],
    ['a text over the limit', { replyId: randomUUID(), text: 'x'.repeat(20_001) }],
    ['no reply ID', { text: TEXT }],
    ['a reply ID that is not a UUID', { replyId: 'reply-1', text: TEXT }],
    ['an address of its own', { replyId: randomUUID(), text: TEXT, to: 'someone@else.example' }],
  ])('refuses a request with %s', async (_label, body) => {
    const mail = await receive();
    expect((await sendReply(mail.threadId, body)).status).toBe(400);
    expect((await sandboxThread(mail.threadId)).messages).toHaveLength(1);
  });

  it('needs a session and a connected mailbox', async () => {
    const mail = await receive();
    const body = { replyId: randomUUID(), text: TEXT };
    expect(
      (await request(app).post(`/api/mailbox/threads/${mail.threadId}/replies`).send(body)).status,
    ).toBe(401);
    await prisma.gmailConnection.update({
      where: { userId: owner },
      data: { status: 'NOT_CONNECTED' },
    });
    const res = await sendReply(mail.threadId, body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GMAIL_NOT_CONNECTED');
  });

  it('keeps the text of a reply out of the app: only the sandbox mailbox holds it', async () => {
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    const mail = await receive();
    await syncUser(owner);
    const res = await reply(mail.threadId);
    vi.restoreAllMocks();

    expect(JSON.stringify(res.body)).not.toContain('REPLYSENTINEL');
    expect(logs.join('\n')).not.toContain('REPLYSENTINEL');
    const tables = await prisma.$queryRaw<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'sandbox_messages')`;
    for (const { name } of tables) {
      const rows = await prisma.$queryRawUnsafe<{ row: string }[]>(
        `SELECT row_to_json(t)::text AS row FROM "${name}" t`,
      );
      expect(JSON.stringify(rows), name).not.toContain('REPLYSENTINEL');
    }
    // The dev stand-in for Gmail holds the mail, as Gmail would.
    expect(
      await prisma.sandboxMessage.count({ where: { body: { contains: 'REPLYSENTINEL' } } }),
    ).toBe(1);
  });
});
describe('a reply to all in dev mode', () => {
  const copied = { cc: `${DANIEL},  ${LENA}` };

  it('keeps the people in Cc of a sandbox mail, and says who a reply to all reaches', async () => {
    // The user's own address in Cc is kept on the mail, and left out of a reply to all.
    const mail = await receive(OWNER, { cc: `${DANIEL}, ${LENA}, owner@MAIL-reply.test` });
    const stored = (await sandboxThread(mail.threadId)).messages[0];
    expect(stored.cc).toBe(`${DANIEL}, ${LENA}, owner@MAIL-reply.test`);

    const read = await mailThread(mail.threadId);
    expect(read.messages[0].cc).toBe(stored.cc);
    expect(read.replyTo).toBe(PRIYA);
    expect(read.replyCc).toEqual([DANIEL, LENA]);
  });

  it('sends a reply to all with the same people in Cc, and a reply to the sender with nobody', async () => {
    const mail = await receive(OWNER, copied);
    expect(
      (await sendReply(mail.threadId, { replyId: randomUUID(), text: TEXT, toAll: true })).status,
    ).toBe(200);
    expect((await reply(mail.threadId, 'Only for you.')).status).toBe(200);

    const { messages } = await sandboxThread(mail.threadId);
    expect(messages.map((message) => [message.sentByUser, message.to, message.cc])).toEqual([
      [false, 'Alex Tester <owner@mail-reply.test>', `${DANIEL}, ${LENA}`],
      [true, PRIYA, `${DANIEL}, ${LENA}`],
      [true, PRIYA, null],
    ]);
    // The app reads the reply back with its Cc line, as it reads any sent mail.
    expect((await mailThread(mail.threadId)).messages[1].cc).toBe(`${DANIEL}, ${LENA}`);
    expect(google.built).not.toHaveBeenCalled();
  });

  it('has nobody else to reach on a mail to the user alone, also when asked to reply to all', async () => {
    const mail = await receive();
    expect((await mailThread(mail.threadId)).replyCc).toEqual([]);
    expect(
      (await sendReply(mail.threadId, { replyId: randomUUID(), text: TEXT, toAll: true })).status,
    ).toBe(200);
    expect((await sandboxThread(mail.threadId)).messages[1]).toMatchObject({ to: PRIYA, cc: null });
  });

  it('keeps the people on the conversation when the other person writes again', async () => {
    const mail = await receive(OWNER, copied);
    const write = (as_: 'me' | 'them') =>
      request(app)
        .post(`/api/sandbox/threads/${mail.threadId}/replies`)
        .set(as())
        .send({ as: as_, body: 'One more thing.' });
    expect((await write('me')).status).toBe(201);
    expect((await write('them')).status).toBe(201);
    const { messages } = await sandboxThread(mail.threadId);
    expect(messages.map((message) => message.cc)).toEqual([
      `${DANIEL}, ${LENA}`,
      null,
      `${DANIEL}, ${LENA}`,
    ]);
    expect((await mailThread(mail.threadId)).replyCc).toEqual([DANIEL, LENA]);
  });

  it.each([
    ['a word that is not an address', 'the hiring team'],
    ['one part that is not an address', `${DANIEL}, lena`],
    [
      'more than ten addresses',
      Array.from({ length: 11 }, (_, n) => `p${n}@northwind.example`).join(', '),
    ],
  ])('refuses a Cc line with %s', async (_label, cc) => {
    expect((await compose({ cc })).status).toBe(400);
    expect(await prisma.sandboxMessage.count({ where: { userId: owner } })).toBe(0);
  });

  it('takes an empty Cc line as nobody', async () => {
    const res = await compose({ cc: '  ' });
    expect(res.status).toBe(201);
    expect((await sandboxThread(res.body.threadId)).messages[0].cc).toBeNull();
  });
});
