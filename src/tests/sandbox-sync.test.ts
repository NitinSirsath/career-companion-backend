import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Dev mode has no Google account. Building any Google client here is a failure.
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
  ListMailboxThreadsResponseSchema,
  MailThreadSchema,
} from '../contracts';
import { SandboxThreadDetailSchema } from '../contracts/sandbox';
import { prisma } from '../db/prisma';
import { enqueueEmailProcessingJob, enqueueRelevanceTriage } from '../services/enqueue';
import { fetchMessageMetadata } from '../services/gmailFetcher';
import { syncUser } from '../services/gmailSync';
import { configureAI } from './helpers/aiAccess';
import { FAKE_OFFER_NEXT_STEP } from '../services/emailRequest';

const OWNER = 'owner@sandbox-sync.test';
const PRIYA = 'Priya Raman <priya.raman@northwind.example>';
let owner: string;

const as = { 'X-Development-User': OWNER };
const connect = () => request(app).get('/api/gmail/connect').set(as);
const send = async (overrides: object = {}) =>
  (
    await request(app)
      .post('/api/sandbox/messages')
      .set(as)
      .send({
        from: PRIYA,
        subject: 'Opportunity at Northwind Robotics',
        body: 'Hi Alex,\n\nWould you have 20 minutes this week? Please reply with a time.',
        ...overrides,
      })
  ).body as { id: string; threadId: string };
const reply = async (threadId: string, who: 'me' | 'them', body: string) =>
  (
    await request(app)
      .post(`/api/sandbox/threads/${threadId}/replies`)
      .set(as)
      .send({ as: who, body })
  ).body as { id: string; threadId: string };
const states = async (threadId: string) =>
  SandboxThreadDetailSchema.parse(
    (await request(app).get(`/api/sandbox/threads/${threadId}`).set(as)).body,
  ).messages.map((message) => message.result.state);
const queued = () =>
  vi.mocked(enqueueEmailProcessingJob).mock.calls.length +
  vi.mocked(enqueueRelevanceTriage).mock.calls.length;
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
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER, name: 'Alex Tester' } })).id;
});
beforeEach(async () => {
  vi.stubEnv('ENABLE_DEV_AUTH', 'true');
  vi.stubEnv('APP_MODE', 'dev');
  const mine = { userId: owner };
  await prisma.sandboxMessage.deleteMany({ where: mine });
  await prisma.email.deleteMany({ where: mine });
  await prisma.outgoingEmail.deleteMany({ where: mine });
  await prisma.application.deleteMany({ where: mine });
  await prisma.aIConfiguration.deleteMany({ where: mine });
  await prisma.gmailConnection.deleteMany({ where: mine });
  vi.mocked(enqueueEmailProcessingJob).mockClear();
  vi.mocked(enqueueRelevanceTriage).mockClear();
  google.built.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: owner } });
});

describe('connecting Gmail in dev mode', () => {
  it('connects the sandbox mailbox at once, with no Google screen', async () => {
    const res = await connect();
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/gmail');
    const status = await request(app).get('/api/gmail/status').set(as);
    expect(status.body).toMatchObject({ connected: true, gmailEmail: OWNER, lastSyncedAt: null });
    expect((await request(app).get('/api/gmail/callback?code=x&state=y').set(as)).status).toBe(404);
    expect(google.built).not.toHaveBeenCalled();
  });

  it('disconnects without calling Google, and can connect again', async () => {
    await connect();
    const res = await request(app).post('/api/gmail/disconnect').set(as);
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/gmail/status').set(as)).body.connected).toBe(false);
    await connect();
    expect((await request(app).get('/api/gmail/status').set(as)).body.connected).toBe(true);
    expect(google.built).not.toHaveBeenCalled();
  });
});

describe('the real sync on sandbox mail', () => {
  beforeEach(async () => {
    await connect();
  });
  afterEach(() => {
    expect(google.built).not.toHaveBeenCalled();
  });

  it('a sent mail is not in the app until a sync runs; then it is queued like new Gmail mail', async () => {
    const mail = await send();
    expect(await prisma.email.count({ where: { userId: owner } })).toBe(0);
    expect(queued()).toBe(0);
    expect(await states(mail.threadId)).toEqual(['NOT_SYNCED']);

    const result = await syncUser(owner);
    expect(result).toMatchObject({ synced: true, messagesIngested: 1, messagesSkipped: 0 });
    const stored = await prisma.sandboxMessage.findUniqueOrThrow({ where: { id: mail.id } });
    const email = await prisma.email.findUniqueOrThrow({
      where: { userId_gmailMessageId: { userId: owner, gmailMessageId: mail.id } },
    });
    expect(email).toMatchObject({
      threadId: mail.threadId,
      sender: PRIYA,
      subject: 'Opportunity at Northwind Robotics',
      processingState: 'PENDING',
      relevanceState: 'UNPROCESSED',
    });
    expect(email.receivedAt?.getTime()).toBe(stored.internalDate.getTime());
    expect(queued()).toBe(1);
    const connection = await prisma.gmailConnection.findUniqueOrThrow({ where: { userId: owner } });
    expect(connection).toMatchObject({ syncStatus: 'IDLE', lastHistoryId: '1' });
    expect(connection.lastSyncedAt).not.toBeNull();
  });

  it('a second sync brings only the mails sent since the first one', async () => {
    await send({ subject: 'One' });
    await send({ subject: 'Two' });
    expect(await syncUser(owner)).toMatchObject({ messagesIngested: 2 });

    await send({ subject: 'Three' });
    const second = await syncUser(owner);
    // A full scan would count the two older mails as skipped: only the new one was looked at.
    expect(second).toMatchObject({
      messagesIngested: 1,
      messagesSkipped: 0,
      checkpointAdvanced: true,
    });
    expect(await prisma.email.count({ where: { userId: owner } })).toBe(3);

    const third = await syncUser(owner);
    expect(third).toMatchObject({
      messagesIngested: 0,
      messagesSkipped: 0,
      checkpointAdvanced: false,
    });
    expect(
      (await prisma.gmailConnection.findUniqueOrThrow({ where: { userId: owner } })).lastHistoryId,
    ).toBe('3');
  });

  it("notes the user's reply as a reply and never reads it as mail", async () => {
    const mail = await send();
    await syncUser(owner);
    await readAsJobMail(mail.id);

    const mine = await reply(mail.threadId, 'me', 'Thursday at 3 pm works for me.');
    expect(await states(mail.threadId)).toEqual(['JOB_MAIL', 'NOT_SYNCED']);
    await syncUser(owner);

    expect(await prisma.email.count({ where: { userId: owner } })).toBe(1);
    const noted = await prisma.outgoingEmail.findMany({ where: { userId: owner } });
    expect(noted).toHaveLength(1);
    expect(noted[0]).toMatchObject({ gmailMessageId: mine.id, threadId: mail.threadId });
    expect(await states(mail.threadId)).toEqual(['JOB_MAIL', 'REPLY_RECORDED']);
    // Only the answered mail was ever offered to AI.
    expect(queued()).toBe(1);

    const detail = ConversationDetailSchema.parse(
      (await request(app).get(`/api/conversations/${mail.threadId}`).set(as)).body,
    );
    expect(detail.conversation.sentCount).toBe(1);
    expect(detail.conversation.request).toMatchObject({
      state: 'REPLIED',
      text: 'Reply with a time for a call',
    });
  });

  it('a first sync also notes a reply sent before it, and takes the next mail of the other side', async () => {
    const mail = await send();
    const mine = await reply(mail.threadId, 'me', 'Thursday works.');
    const theirs = await reply(mail.threadId, 'them', 'Great, see you on Thursday.');
    expect(await syncUser(owner)).toMatchObject({ messagesIngested: 2 });
    const emails = await prisma.email.findMany({ where: { userId: owner } });
    expect(emails.map((email) => email.gmailMessageId).sort()).toEqual([mail.id, theirs.id].sort());
    expect(new Set(emails.map((email) => email.threadId))).toEqual(new Set([mail.threadId]));
    const noted = await prisma.outgoingEmail.findMany({ where: { userId: owner } });
    expect(noted.map((sent) => sent.gmailMessageId)).toEqual([mine.id]);
  });

  it('leaves out mail that is older than the sync window', async () => {
    await prisma.sandboxMessage.create({
      data: {
        id: '00000000000000aa',
        userId: owner,
        threadId: '00000000000000aa',
        historyId: 1,
        labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
        sender: PRIYA,
        recipient: OWNER,
        subject: 'Three days old',
        messageId: '<old@sandbox.mail>',
        body: 'Old mail.',
        internalDate: new Date(Date.now() - 3 * 86_400_000),
      },
    });
    const fresh = await send({ subject: 'Fresh' });
    expect(await syncUser(owner)).toMatchObject({ messagesIngested: 1 });
    const emails = await prisma.email.findMany({ where: { userId: owner } });
    expect(emails.map((email) => email.gmailMessageId)).toEqual([fresh.id]);
  });

  it('says why a synced mail is not read yet, and what the app made of a read one', async () => {
    const job = await send();
    const other = await send({ from: 'Weekly Digest <news@digest.example>', subject: 'Digest' });
    const broken = await send({ subject: 'Broken' });
    await syncUser(owner);
    expect(await states(job.threadId)).toEqual(['AI_KEY_MISSING']);

    await configureAI(owner);
    expect(await states(job.threadId)).toEqual(['WAITING_FOR_AI']);

    await readAsJobMail(job.id);
    const application = await prisma.application.create({
      data: {
        userId: owner,
        companyName: 'Northwind Robotics',
        jobTitle: 'Senior Platform Engineer',
      },
    });
    const where = (gmailMessageId: string) => ({
      userId_gmailMessageId: { userId: owner, gmailMessageId },
    });
    await prisma.email.update({
      where: where(job.id),
      data: { applicationId: application.id, matchState: 'MATCHED' },
    });
    await prisma.email.update({
      where: where(other.id),
      data: { relevanceState: 'IRRELEVANT', processingState: 'COMPLETED' },
    });
    await prisma.email.update({
      where: where(broken.id),
      data: { processingState: 'FAILED', processingErrorCategory: 'KEY_REJECTED' },
    });

    const read = async (threadId: string) =>
      SandboxThreadDetailSchema.parse(
        (await request(app).get(`/api/sandbox/threads/${threadId}`).set(as)).body,
      ).messages[0].result;
    expect(await read(job.threadId)).toEqual({
      state: 'JOB_MAIL',
      failure: null,
      aiStatus: null,
      job: {
        category: 'RECRUITER',
        company: 'Northwind Robotics',
        role: 'Senior Platform Engineer',
        requestedAction: 'Reply with a time for a call',
        fakeOfferWarning: null,
        conversationKey: job.threadId,
        application: {
          id: application.id,
          companyName: 'Northwind Robotics',
          jobTitle: 'Senior Platform Engineer',
        },
      },
    });
    expect(await read(other.threadId)).toEqual({
      state: 'NOT_JOB_MAIL',
      failure: null,
      aiStatus: null,
      job: null,
    });
    // This mail has no AI step held and its stored category is not a kind the status knows, so
    // the reason is a plain one and Manual Retry sends it again.
    expect(await read(broken.threadId)).toEqual({
      state: 'AI_FAILED',
      failure: 'KEY_REJECTED',
      aiStatus: expect.objectContaining({ reason: 'INTERNAL_ERROR', nextStep: 'MANUAL_RETRY' }),
      job: null,
    });
  });

  it('shows the warning and the safe next step for a mail that asks for money', async () => {
    const mail = await send({
      from: 'Google HR Department <hr.google.careers@gmail.example.com>',
      subject: 'Congratulations! Offer of employment - Google India',
      body: 'You are selected. Pay a refundable laptop security fee of Rs 8,500 within 24 hours.',
    });
    await syncUser(owner);
    await configureAI(owner);
    await readAsJobMail(mail.id);
    const warning = 'It asks for a fee of Rs 8,500 within 24 hours from a free-mail address.';
    await prisma.aIProcessingResult.updateMany({
      where: { email: { userId: owner, gmailMessageId: mail.id } },
      data: { category: 'OFFER', requestedAction: 'Pay the fee', fakeOfferWarning: warning },
    });
    const [message] = SandboxThreadDetailSchema.parse(
      (await request(app).get(`/api/sandbox/threads/${mail.threadId}`).set(as)).body,
    ).messages;
    expect(message.result).toMatchObject({
      state: 'JOB_MAIL',
      job: {
        category: 'OFFER',
        requestedAction: FAKE_OFFER_NEXT_STEP,
        fakeOfferWarning: warning,
      },
    });
  });

  it('shows sandbox conversations on the Gmail tab and the mail details page', async () => {
    const mail = await send();
    await reply(mail.threadId, 'me', 'Thursday at 3 pm works for me.');

    const inbox = ListMailboxThreadsResponseSchema.parse(
      (await request(app).get('/api/mailbox/threads').set(as)).body,
    );
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      threadId: mail.threadId,
      subject: 'Opportunity at Northwind Robotics',
      messageCount: 2,
      unread: false,
      conversationKey: null,
    });
    expect(inbox.items[0].snippet).toMatch(/^Thursday at 3 pm works for me\./);

    const thread = MailThreadSchema.parse(
      (await request(app).get(`/api/mailbox/threads/${mail.threadId}`).set(as)).body,
    );
    expect(thread.messages.map((m) => [m.sentByUser, m.from, m.labels])).toEqual([
      [false, PRIYA, ['Inbox']],
      [true, `Alex Tester <${OWNER}>`, ['Sent']],
    ]);
    expect(thread.messages[0].text).toBe(
      'Hi Alex,\n\nWould you have 20 minutes this week? Please reply with a time.',
    );
    expect(thread.messages[0].html).toContain('Hi Alex,<br><br>Would you have 20 minutes');
    expect(thread.messages[1].text).toMatch(/^Thursday at 3 pm works for me\.\n\nOn /);
    expect(thread.messages.every((m) => m.attachments.length === 0)).toBe(true);
  });
});

describe('prod mode', () => {
  it('never reads the sandbox: the same call goes to Google', async () => {
    await connect();
    const mail = await send();
    vi.stubEnv('APP_MODE', '');
    await expect(fetchMessageMetadata(owner, mail.id)).rejects.toThrow('A Google client was built');
    expect(google.built).toHaveBeenCalled();
  });
});
