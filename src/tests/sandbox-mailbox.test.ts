import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueEmailProcessingJob: vi.fn(async () => 'email-job'),
  enqueueRelevanceTriage: vi.fn(async () => 'triage-job'),
}));

import { app } from '../index';
import {
  ListSandboxThreadsResponseSchema,
  SandboxThreadDetailSchema,
  parseSandboxAddress,
} from '../contracts/sandbox';
import { prisma } from '../db/prisma';
import { enqueueEmailProcessingJob, enqueueRelevanceTriage } from '../services/enqueue';
import { connectSandboxMailbox } from '../services/gmailConnection';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { sandboxGmail } from '../services/sandbox/gmail';
import { configureAI, setPause } from './helpers/aiAccess';

const OWNER = 'owner@sandbox-mailbox.test';
const OTHER = 'other@sandbox-mailbox.test';
const PRIYA = 'Priya Raman <priya.raman@northwind.example>';
let owner: string;
let other: string;

const as = (user: string) => ({ 'X-Development-User': user });
const send = (body: object, user = OWNER) =>
  request(app).post('/api/sandbox/messages').set(as(user)).send(body);
const reply = (threadId: string, body: object, user = OWNER) =>
  request(app).post(`/api/sandbox/threads/${threadId}/replies`).set(as(user)).send(body);
const list = (query = '', user = OWNER) =>
  request(app).get(`/api/sandbox/threads${query}`).set(as(user));
const read = (threadId: string, user = OWNER) =>
  request(app).get(`/api/sandbox/threads/${threadId}`).set(as(user));
const mail = (overrides: object = {}) => ({
  from: PRIYA,
  subject: 'Opportunity at Northwind Robotics',
  body: 'Hi Alex,\n\nWould you have 20 minutes this week?\n\nPriya',
  ...overrides,
});
const decode = (data: string | null | undefined) =>
  Buffer.from(data ?? '', 'base64url').toString('utf8');

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [OWNER, OTHER] } } });
  owner = (await prisma.user.create({ data: { email: OWNER, name: 'Alex Tester' } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  vi.stubEnv('ENABLE_DEV_AUTH', 'true');
  vi.stubEnv('APP_MODE', 'dev');
  const users = { userId: { in: [owner, other] } };
  await prisma.sandboxMessage.deleteMany({ where: users });
  await prisma.email.deleteMany({ where: users });
  await prisma.outgoingEmail.deleteMany({ where: users });
  await prisma.application.deleteMany({ where: users });
  await prisma.gmailConnection.deleteMany({ where: users });
  vi.mocked(enqueueEmailProcessingJob).mockClear();
  vi.mocked(enqueueRelevanceTriage).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});

describe('mail sandbox switch', () => {
  it('does not exist in prod mode: every path answers 404 before login', async () => {
    vi.stubEnv('APP_MODE', '');
    const id = '0123456789abcdef';
    expect((await request(app).get('/api/sandbox/threads')).status).toBe(404);
    expect((await list()).status).toBe(404);
    expect((await read(id)).status).toBe(404);
    expect((await send(mail())).status).toBe(404);
    expect((await reply(id, { as: 'me', body: 'x' })).status).toBe(404);
    expect((await request(app).get('/api/sandbox/senders').set(as(OWNER))).status).toBe(404);
    const reset = await request(app)
      .post('/api/sandbox/reset')
      .set(as(OWNER))
      .send({ confirm: 'RESET' });
    expect(reset.status).toBe(404);
    expect(await prisma.sandboxMessage.count({ where: { userId: owner } })).toBe(0);
  });

  it('needs a signed-in user in dev mode', async () => {
    expect((await request(app).get('/api/sandbox/threads')).status).toBe(401);
    expect((await request(app).post('/api/sandbox/messages').send(mail())).status).toBe(401);
  });
});

describe('sending a sandbox mail', () => {
  it('puts a new mail from any address in the inbox, and nowhere in the app', async () => {
    const res = await send(mail());
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^[0-9a-f]{16}$/);
    expect(res.body.threadId).toBe(res.body.id);

    const stored = await prisma.sandboxMessage.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored).toMatchObject({
      userId: owner,
      labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
      sender: PRIYA,
      recipient: `Alex Tester <${OWNER}>`,
      historyId: 1,
    });
    // The mail waits in the sandbox: the app knows nothing of it until a sync.
    expect(await prisma.email.count({ where: { userId: owner } })).toBe(0);
    expect(enqueueEmailProcessingJob).not.toHaveBeenCalled();
    expect(enqueueRelevanceTriage).not.toHaveBeenCalled();
  });

  it('takes an address with or without a name, and refuses what is not an address', async () => {
    expect(parseSandboxAddress(PRIYA)).toEqual({
      name: 'Priya Raman',
      email: 'priya.raman@northwind.example',
    });
    expect(parseSandboxAddress(' hr@initech.example ')).toEqual({
      name: null,
      email: 'hr@initech.example',
    });
    expect(parseSandboxAddress('"Careers at Acme" <careers@acme.example>')?.name).toBe(
      'Careers at Acme',
    );
    expect((await send(mail({ from: 'hr@initech.example' }))).status).toBe(201);
    expect((await send(mail({ from: 'jobs@linkedin.com' }))).status).toBe(201);
    for (const from of ['Priya Raman', 'priya@', 'a@b', 'Priya <not-an-address>', ''])
      expect((await send(mail({ from }))).status).toBe(400);
    expect((await send(mail({ body: '   ' }))).status).toBe(400);
    expect((await send({ ...mail(), to: 'someone@else.example' })).status).toBe(400);
  });

  it('numbers the mailbox history without gaps, also when mails are sent at once', async () => {
    await Promise.all([1, 2, 3, 4, 5].map((n) => send(mail({ subject: `Mail ${n}` }))));
    const history = await prisma.sandboxMessage.findMany({
      where: { userId: owner },
      orderBy: { historyId: 'asc' },
      select: { historyId: true },
    });
    expect(history.map((message) => message.historyId)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('a conversation with both sides', () => {
  it('keeps every mail with its text, in order, and quotes the answered mail', async () => {
    const first = (await send(mail())).body;
    const mine = await reply(first.threadId, { as: 'me', body: 'Thursday at 3 pm works.' });
    expect(mine.status).toBe(201);
    expect(mine.body.threadId).toBe(first.threadId);
    const theirs = await reply(first.threadId, { as: 'them', body: 'Great, see you then.' });
    expect(theirs.status).toBe(201);

    const res = await read(first.threadId);
    expect(res.status).toBe(200);
    const thread = SandboxThreadDetailSchema.parse(res.body);
    expect(thread.subject).toBe('Opportunity at Northwind Robotics');
    expect(thread.party).toBe(PRIYA);
    expect(thread.messages.map((m) => [m.sentByUser, m.from, m.to])).toEqual([
      [false, PRIYA, `Alex Tester <${OWNER}>`],
      [true, `Alex Tester <${OWNER}>`, PRIYA],
      [false, PRIYA, `Alex Tester <${OWNER}>`],
    ]);
    expect(thread.messages[1].text).toMatch(
      /^Thursday at 3 pm works\.\n\nOn .* GMT, Priya Raman <priya\.raman@northwind\.example> wrote:\n> Hi Alex,\n> \n> Would you have 20 minutes this week\?/,
    );
    expect(thread.messages[2].text).toContain('> Thursday at 3 pm works.');
    expect(thread.messages.every((m) => m.result.state === 'NOT_SYNCED')).toBe(true);

    const stored = await prisma.sandboxMessage.findMany({
      where: { userId: owner },
      orderBy: { historyId: 'asc' },
    });
    expect(stored.map((m) => m.labelIds)).toEqual([
      ['INBOX', 'CATEGORY_PERSONAL'],
      ['SENT'],
      ['INBOX', 'CATEGORY_PERSONAL'],
    ]);
    expect(stored.map((m) => m.subject)).toEqual([
      'Opportunity at Northwind Robotics',
      'Re: Opportunity at Northwind Robotics',
      'Re: Opportunity at Northwind Robotics',
    ]);
    expect(stored[1].inReplyTo).toBe(stored[0].messageId);
    expect(stored[2].inReplyTo).toBe(stored[1].messageId);
    expect(stored[2].referenceIds).toBe(`${stored[0].messageId} ${stored[1].messageId}`);
  });

  it("answers 404 for a conversation that is not the user's", async () => {
    const first = (await send(mail())).body;
    expect((await read(first.threadId, OTHER)).status).toBe(404);
    expect((await reply(first.threadId, { as: 'me', body: 'hi' }, OTHER)).status).toBe(404);
    expect((await read('0123456789abcdef')).status).toBe(404);
    expect((await read('not-an-id')).status).toBe(400);
    expect((await reply(first.threadId, { as: 'someone', body: 'hi' })).status).toBe(400);
  });
});

describe('a sandbox mail has the shape of a Gmail message', () => {
  it('carries headers, a plain part and an HTML part, as Gmail encodes them', async () => {
    const body = 'Hi Alex,\n\nIs 5 < 6 & "ok"?\n\nPriya';
    const first = (await send(mail({ body }))).body;
    const answer = (await reply(first.threadId, { as: 'me', body: 'Yes.' })).body;
    const gmail = sandboxGmail(owner);

    const full = (await gmail.users.messages.get({ userId: 'me', id: first.id, format: 'full' }))
      .data;
    expect(full).toMatchObject({
      id: first.id,
      threadId: first.threadId,
      labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
      historyId: '1',
      snippet: 'Hi Alex, Is 5 < 6 & "ok"? Priya',
    });
    expect(Number(full.internalDate)).toBeGreaterThan(Date.now() - 60_000);
    const header = (name: string) =>
      full.payload?.headers?.find((h) => h.name === name)?.value ?? null;
    expect(header('From')).toBe(PRIYA);
    expect(header('To')).toBe(`Alex Tester <${OWNER}>`);
    expect(header('Subject')).toBe('Opportunity at Northwind Robotics');
    expect(new Date(header('Date') ?? '').getTime()).not.toBeNaN();
    expect(header('Message-ID')).toMatch(/^<[0-9a-f-]{36}@sandbox\.mail>$/);
    expect(full.payload?.mimeType).toBe('multipart/alternative');
    const [plain, html] = full.payload?.parts ?? [];
    expect(plain.mimeType).toBe('text/plain');
    expect(decode(plain.body?.data)).toBe(body);
    expect(html.mimeType).toBe('text/html');
    expect(decode(html.body?.data)).toBe(
      '<div dir="ltr">Hi Alex,<br><br>Is 5 &lt; 6 &amp; &quot;ok&quot;?<br><br>Priya</div>',
    );

    const metadata = (
      await gmail.users.messages.get({
        userId: 'me',
        id: answer.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      })
    ).data;
    expect(metadata.labelIds).toEqual(['SENT']);
    expect(metadata.payload?.parts).toBeUndefined();
    expect(metadata.payload?.headers?.map((h) => h.name).sort()).toEqual([
      'Date',
      'From',
      'Subject',
    ]);
  });

  it("passes through the app's own Gmail readers and gives back the typed text", async () => {
    const body = 'Hi Alex,\n\nPlease send your resume by Friday.\n\nDana';
    const first = (await send(mail({ body }))).body;
    await connectSandboxMailbox(owner);
    expect(await fetchMessageBody(owner, first.id)).toBe(body);
    expect(await fetchMessageMetadata(owner, first.id)).toEqual({
      labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
      snippet: 'Hi Alex, Please send your resume by Friday. Dana',
    });
  });
});

describe('reading the sandbox mailbox', () => {
  it('lists conversations per folder, newest first, with the other person and counts', async () => {
    const a = (await send(mail({ subject: 'First' }))).body;
    const b = (await send(mail({ from: 'hr@initech.example', subject: 'Second' }))).body;
    await reply(a.threadId, { as: 'me', body: 'My answer.' });

    const inbox = ListSandboxThreadsResponseSchema.parse((await list()).body);
    expect(inbox.mailbox).toBe(OWNER);
    expect(inbox.items.map((t) => [t.threadId, t.subject, t.party, t.messageCount])).toEqual([
      [b.threadId, 'Second', 'hr@initech.example', 1],
      [a.threadId, 'First', PRIYA, 2],
    ]);
    expect(inbox.items[1].snippet).toBe('Hi Alex, Would you have 20 minutes this week? Priya');
    expect(inbox.items.map((t) => [t.notSynced, t.state])).toEqual([
      [1, 'NOT_SYNCED'],
      [2, 'NOT_SYNCED'],
    ]);
    expect(inbox.notSyncedTotal).toBe(3);
    expect(inbox.counts).toEqual({ inbox: 2, sent: 1 });
    expect(inbox.nextPageToken).toBeNull();

    const sent = ListSandboxThreadsResponseSchema.parse((await list('?folder=sent')).body);
    expect(sent.items.map((t) => t.threadId)).toEqual([a.threadId]);
    expect(sent.items[0].snippet).toMatch(/^My answer\. On /);

    expect((await list('?folder=spam')).status).toBe(400);
    expect(ListSandboxThreadsResponseSchema.parse((await list('', OTHER)).body).items).toEqual([]);
  });

  it('pages a long inbox', async () => {
    for (let n = 1; n <= 27; n++) await send(mail({ subject: `Mail ${n}` }));
    const first = ListSandboxThreadsResponseSchema.parse((await list()).body);
    expect(first.items).toHaveLength(25);
    expect(first.items[0].subject).toBe('Mail 27');
    expect(first.nextPageToken).toBe('25');
    const second = ListSandboxThreadsResponseSchema.parse(
      (await list(`?pageToken=${first.nextPageToken}`)).body,
    );
    expect(second.items.map((t) => t.subject)).toEqual(['Mail 2', 'Mail 1']);
    expect(second.nextPageToken).toBeNull();
  });

  it('lists the sender addresses used before, each once, newest first', async () => {
    await send(mail());
    await send(mail({ from: 'hr@initech.example' }));
    await send(mail({ from: 'Priya R. <PRIYA.RAMAN@northwind.example>' }));
    const res = await request(app).get('/api/sandbox/senders').set(as(OWNER));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      senders: ['Priya R. <PRIYA.RAMAN@northwind.example>', 'hr@initech.example'],
    });
    const none = await request(app).get('/api/sandbox/senders').set(as(OTHER));
    expect(none.body).toEqual({ senders: [] });
  });
});

describe('resetting the sandbox', () => {
  const reset = (body: object = { confirm: 'RESET' }, user = OWNER) =>
    request(app).post('/api/sandbox/reset').set(as(user)).send(body);

  it('empties the mailbox and what the app made from it, and keeps the connection', async () => {
    const first = (await send(mail())).body;
    await send(mail({ subject: 'Other user' }), OTHER);
    await connectSandboxMailbox(owner);
    await prisma.gmailConnection.update({
      where: { userId: owner },
      data: { lastHistoryId: '1', lastSyncedAt: new Date() },
    });
    await prisma.email.create({
      data: { userId: owner, gmailMessageId: first.id, threadId: first.threadId },
    });
    await prisma.application.create({ data: { userId: owner, companyName: 'Northwind' } });

    expect((await reset({})).status).toBe(400);
    const res = await reset();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletedMessages: 1, deletedEmails: 1, deletedApplications: 1 });
    expect(await prisma.sandboxMessage.count({ where: { userId: owner } })).toBe(0);
    expect(await prisma.sandboxMessage.count({ where: { userId: other } })).toBe(1);
    const connection = await prisma.gmailConnection.findUniqueOrThrow({ where: { userId: owner } });
    expect(connection).toMatchObject({
      status: 'CONNECTED',
      lastHistoryId: null,
      lastSyncedAt: null,
    });
    expect(await prisma.user.count({ where: { id: owner } })).toBe(1);

    // A fresh mailbox starts its history again.
    const again = (await send(mail())).body;
    const stored = await prisma.sandboxMessage.findUniqueOrThrow({ where: { id: again.id } });
    expect(stored.historyId).toBe(1);
  });

  it("clears every AI model's pause and keeps the AI settings", async () => {
    const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    for (const user of [owner, other]) {
      await configureAI(user);
      await setPause(user, 'gemini-3.8-flash', { resumesAt: soon(25), consecutiveFailures: 6 });
    }
    await setPause(owner, 'gemini-3.5-flash-lite', { reason: 'RATE_LIMITED', resumesAt: soon(1) });
    expect((await reset()).status).toBe(200);
    expect(await prisma.aIModelPause.count({ where: { userId: owner } })).toBe(0);
    expect(await prisma.aIModelPause.count({ where: { userId: other } })).toBe(1);
    expect(await prisma.aIConfiguration.count({ where: { userId: owner } })).toBe(1);
  });
});
