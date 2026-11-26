/**
 * Senders a reply cannot reach (owner, 26 Nov 2026): a no-reply or system address, and an address
 * whose own mail says that nobody reads replies. The app offers them no reply box, no reply
 * choices and no "then tell them you did". Every company, person and tenant here is made up.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  threadsGet: vi.fn(),
  labelsList: vi.fn(),
  credentials: {} as { access_token?: string; refresh_token?: string },
}));
vi.mock('../services/google', () => ({
  google: {
    auth: {
      OAuth2: class {
        get credentials() {
          return mocks.credentials;
        }
        setCredentials(credentials: typeof mocks.credentials) {
          mocks.credentials = { ...credentials };
        }
      },
    },
    gmail: () => ({
      users: { threads: { get: mocks.threadsGet }, labels: { list: mocks.labelsList } },
    }),
  },
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { ConversationDetailSchema, MailThreadSchema } from '../contracts';
import { requestOf } from '../services/emailRequest';
import {
  SYSTEM_SENDER_DOMAINS,
  canReplyTo,
  noReplySenders,
  saysNoReply,
} from '../services/mailSender';
import { matchEmailToApplication } from '../services/matcher';
import { tidyAllRequests } from '../services/requestUpkeep';
import { encryptToken } from '../utils/gmailTokenEncryption';

const OWNER = 'owner@reply-reach.test';
const OTHER = 'other@reply-reach.test';
let owner: string;
let other: string;
let counter = 0;

const as = { 'X-Development-User': OWNER };
/** A moment in November 2026 (UTC). */
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour));

const WORKDAY = 'Zenith Labs <zenithlabs@myworkday.com>';
const MAILBOX = 'Lumen Works Hiring <hiring@lumen-works.example>';
const PERSON = 'Meera Rao <meera@lumen-works.example>';
const PORTAL_ASK = {
  category: 'FOLLOW_UP' as const,
  actionRequired: true,
  requestedAction: 'Create your candidate account.',
  askKind: 'OUTSIDE_MAIL' as const,
  replyChoices: ['I have done it', 'I need more time'],
};

type Mail = { thread: string; subject: string; sender: string; at: Date; userId?: string };
/** A job mail with its AI read saved as it stands. */
const jobMail = (mail: Mail, read: Record<string, unknown> = {}) =>
  prisma.email.create({
    data: {
      userId: mail.userId ?? owner,
      gmailMessageId: `reach-${++counter}`,
      threadId: mail.thread,
      subject: mail.subject,
      sender: mail.sender,
      receivedAt: mail.at,
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      aiProcessingResult: {
        create: {
          provider: 'fixture',
          model: 'fixture',
          contractVersion: 'extraction/v10',
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          ...read,
        },
      },
    },
  });
// As such a mailbox really writes it: with a word between "not" and "monitored".
const NOT_READ = 'Thank you for your email. This mailbox is not actively monitored.';
/** The mailbox answered by itself, and its text said that nobody reads it. */
const notReadReply = (thread: string, sender = MAILBOX, userId = owner) =>
  jobMail(
    { thread, subject: 'Automatic reply: Candidate account', sender, at: at(22), userId },
    { saysNoReply: true },
  );
const detail = async (key: string) => {
  const res = await request(app).get(`/api/conversations/${key}`).set(as);
  expect(res.status).toBe(200);
  return ConversationDetailSchema.parse(res.body);
};

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [OWNER, OTHER] } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('GMAIL_TOKEN_ENCRYPTION_KEY', 'b'.repeat(64));
  await prisma.email.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.application.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.gmailConnection.deleteMany({ where: { userId: owner } });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});

describe('who can get a reply', () => {
  it('knows a no-reply word anywhere before the @, and delivery mailboxes', () => {
    for (const sender of [
      'JobBoard <jobs-noreply@jobboard.example>',
      'notifications-noreply@jobboard.example',
      'no_reply@zenith-labs.example',
      'careers.do-not-reply@zenith-labs.example',
      'Mail Delivery Subsystem <mailer-daemon@mail.example>',
      'postmaster@zenith-labs.example',
    ])
      expect(canReplyTo(sender), sender).toBe(false);
    for (const sender of [PERSON, MAILBOX, 'inmail-hit-reply@jobboard.example', 'nora@x.example'])
      expect(canReplyTo(sender), sender).toBe(true);
  });

  it("knows an applicant-tracking system's own address, subdomains included", () => {
    expect([...SYSTEM_SENDER_DOMAINS]).toEqual(['myworkday.com']);
    expect(canReplyTo(WORKDAY)).toBe(false);
    expect(canReplyTo('zenithlabs@wd5.myworkday.com')).toBe(false);
    // A company's own domain is never a system, whatever it is called.
    expect(canReplyTo('meera@notmyworkday.com')).toBe(true);
    expect(canReplyTo('meera@myworkday.com.zenith-labs.example')).toBe(true);
  });

  it('reads from a mail that nobody reads replies to it', () => {
    for (const text of [
      NOT_READ,
      'Please do not reply to this email. To contact us, use the candidate portal.',
      "Don't respond to this message: it was sent from a notification address.",
      'This is a system-generated email, please do not reply.',
      'This is an auto generated mail. Please do not reply.',
      'This email address is no longer monitored.',
      'Note:\nthis   mailbox is not\nbeing monitored',
      'You received this from an unmonitored mailbox.',
      'Replies to this email are not monitored.',
      'Replies to this address will not be read.',
      // The same with a word or two in between, and the short forms.
      'This mailbox is not monitored.',
      'Please note that this mailbox is not being actively monitored.',
      'This email address is no longer regularly checked.',
      "This inbox isn't monitored.",
      'Replies to this email are not actively monitored.',
      "Replies to this message won't be read.",
      'Please do not reply to this automated email.',
      'This mailbox is unmonitored.',
      'This is not a monitored mailbox.',
      'This is not an actively monitored inbox.',
    ])
      expect(saysNoReply(text), text).toBe(true);
    for (const text of [
      // An out-of-office note: the person reads the reply later.
      'I am out of the office until Monday with limited access to email.',
      'I am on leave and my mailbox is not actively monitored during this time.',
      // The opposite meaning with nearly the same words.
      'This mailbox is not only monitored by our team, it is answered within a day.',
      'This mailbox is actively monitored.',
      'Replies to this email are read by the hiring team.',
      'Do not reply to this if the email was not meant for you.',
      // An automatic "we got it": that mailbox is read.
      'This is an automatic reply. We received your email and will answer within two days.',
      'Please reply to this email with your available times.',
      'Do not reply all: answer only to me.',
      // Only the earlier mail it quotes says so.
      'Sure, Tuesday works.\n\nOn Mon, Nov 16, 2026 at 9:00 AM Zenith wrote:\n> Do not reply to this email.',
      'Thanks!\n> This mailbox is not monitored.',
      // A friend passes a job mail on: the words are the first sender's.
      'Saw this, thought of you.\n\n---------- Forwarded message ---------\nPlease do not reply to this email.',
    ])
      expect(saysNoReply(text), text).toBe(false);
  });

  it('knows an address whose mail said so, for this user only', async () => {
    await notReadReply('t-auto');
    // An out-of-office note changes nothing: the read keeps no mark for it.
    await jobMail({ thread: 't-ooo', subject: 'Automatic reply', sender: PERSON, at: at(22) });
    await notReadReply('t-theirs', 'Globex <jobs@globex.example>', other);
    const known = await noReplySenders(prisma, owner);
    expect([...known]).toEqual(['hiring@lumen-works.example']);
    expect(canReplyTo(MAILBOX, known)).toBe(false);
    expect(canReplyTo('HIRING@Lumen-Works.example', known)).toBe(false);
    expect(canReplyTo(PERSON, known)).toBe(true);
    expect(canReplyTo('Someone else <talent@lumen-works.example>', known)).toBe(true);
  });

  it('says "then tell them you did" only to a sender who can get the reply', () => {
    const ask = { ...PORTAL_ASK, followUpRequired: null, actionDeadline: null, followUpDate: null };
    const text = (sender: string, known?: Set<string>) =>
      requestOf({ ...ask, fakeOfferWarning: null }, null, sender, known)?.text;
    expect(text(PERSON)).toBe('Create your candidate account, then tell them you did');
    expect(text(WORKDAY)).toBe('Create your candidate account.');
    expect(text(MAILBOX)).toBe('Create your candidate account, then tell them you did');
    expect(text(MAILBOX, new Set(['hiring@lumen-works.example']))).toBe(
      'Create your candidate account.',
    );
  });
});

describe('the conversation says when a reply would reach nobody', () => {
  it("for an applicant-tracking system's address: no tell-them, no reply choices", async () => {
    await jobMail(
      { thread: 't-ats', subject: 'Next step', sender: WORKDAY, at: at(20) },
      PORTAL_ASK,
    );
    const { conversation, replyChoices } = await detail('t-ats');
    expect(conversation.request).toMatchObject({
      canReply: false,
      text: 'Create your candidate account.',
      askKind: 'OUTSIDE_MAIL',
    });
    expect(replyChoices).toEqual([]);
  });

  it('for a mailbox once its mail said nobody reads it, in every conversation', async () => {
    const ask = { thread: 't-ask', subject: 'Candidate account', sender: MAILBOX, at: at(20) };
    await jobMail(ask, PORTAL_ASK);
    await jobMail({ ...ask, thread: 't-second', subject: 'Documents' }, PORTAL_ASK);
    await jobMail({ ...ask, thread: 't-person', sender: PERSON }, PORTAL_ASK);
    const before = await detail('t-ask');
    expect(before.conversation.request).toMatchObject({
      canReply: true,
      text: 'Create your candidate account, then tell them you did',
    });
    expect(before.replyChoices).toEqual(PORTAL_ASK.replyChoices);

    // The user told them, and the mailbox answered by itself that nobody reads it.
    await notReadReply('t-ask');
    for (const key of ['t-ask', 't-second']) {
      const after = await detail(key);
      expect(after.conversation.request, key).toMatchObject({
        canReply: false,
        text: 'Create your candidate account.',
      });
      expect(after.replyChoices, key).toEqual([]);
    }
    const list = await request(app).get('/api/conversations?request=open').set(as);
    const row = (list.body.items as { key: string; request: { canReply: boolean } }[]).find(
      (item) => item.key === 't-second',
    );
    expect(row?.request.canReply).toBe(false);
    // A person at the same company still gets replies.
    expect((await detail('t-person')).conversation.request).toMatchObject({ canReply: true });
  });

  it('writes the to-do of an application again once its sender is known to be a mailbox', async () => {
    const app = await prisma.application.create({
      data: { userId: owner, companyName: 'Lumen Works' },
    });
    const ask = await jobMail(
      { thread: 't-step', subject: 'Candidate account', sender: MAILBOX, at: at(20) },
      { ...PORTAL_ASK, companyName: 'Lumen Works' },
    );
    await matchEmailToApplication(ask.id);
    const step = () => prisma.action.findFirstOrThrow({ where: { applicationId: app.id } });
    expect((await step()).description).toBe(
      'Create your candidate account, then tell them you did',
    );
    await tidyAllRequests();
    expect((await step()).description).toBe(
      'Create your candidate account, then tell them you did',
    );

    await notReadReply('t-step');
    await tidyAllRequests();
    expect(await step()).toMatchObject({
      description: 'Create your candidate account.',
      status: 'PENDING',
    });
    // A step made after that mail never says it.
    const later = await jobMail(
      { thread: 't-later', subject: 'Documents', sender: MAILBOX, at: at(23) },
      { ...PORTAL_ASK, requestedAction: 'Upload your documents.', companyName: 'Lumen Works' },
    );
    await matchEmailToApplication(later.id);
    expect(
      (await prisma.action.findFirstOrThrow({ where: { emailId: later.id } })).description,
    ).toBe('Upload your documents.');
  });
});

describe('the live conversation offers no reply box when a reply reaches nobody', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
  type Extra = { sent?: boolean; text?: string };
  const message = (id: string, day: number, headers: Record<string, string>, o: Extra = {}) => ({
    id,
    internalDate: String(at(day).getTime()),
    labelIds: [o.sent ? 'SENT' : 'INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: { data: b64(o.text ?? 'Synthetic mail text') },
    },
  });
  const read = async (messages: ReturnType<typeof message>[]) => {
    mocks.threadsGet.mockResolvedValue({ data: { id: 't-live', messages } });
    const res = await request(app).get('/api/mailbox/threads/t-live').set(as);
    expect(res.status).toBe(200);
    return MailThreadSchema.parse(res.body);
  };
  const mine = (day: number) =>
    message(`sent-${day}`, day, { From: OWNER, Subject: 'Re: Candidate account' }, { sent: true });

  beforeEach(async () => {
    await prisma.gmailConnection.create({
      data: {
        userId: owner,
        gmailEmail: OWNER,
        status: 'CONNECTED',
        accessToken: encryptToken('access'),
        refreshToken: encryptToken('refresh'),
      },
    });
    mocks.labelsList.mockResolvedValue({ data: { labels: [] } });
  });

  it('for a person: a reply box as before', async () => {
    const thread = await read([message('m-1', 20, { From: PERSON, Subject: 'Interview' })]);
    expect(thread).toMatchObject({ replyTo: PERSON, canReply: true });
  });

  it("for an applicant-tracking system's own address: none", async () => {
    const thread = await read([message('m-1', 20, { From: WORKDAY, Subject: 'Next step' })]);
    expect(thread).toMatchObject({ replyTo: WORKDAY, canReply: false });
  });

  it('for a system mail that names a person to reply to: a reply box', async () => {
    const thread = await read([
      message('m-1', 20, { From: WORKDAY, 'Reply-To': PERSON, Subject: 'Next step' }),
    ]);
    expect(thread).toMatchObject({ replyTo: PERSON, canReply: true });
  });

  it('for a mailbox whose mail in this conversation says nobody reads it: none', async () => {
    const ask = message('m-1', 20, { From: MAILBOX, Subject: 'Candidate account' });
    expect(await read([ask])).toMatchObject({ canReply: true });
    const auto = { From: MAILBOX, Subject: 'Automatic reply: Candidate account' };
    expect(await read([ask, mine(21), message('m-2', 22, auto, { text: NOT_READ })])).toMatchObject(
      { replyTo: MAILBOX, canReply: false },
    );
    // A person who writes after it gets a reply box again.
    const person = message('m-4', 23, { From: PERSON, Subject: 'Re: Candidate account' });
    expect(
      await read([ask, mine(21), message('m-2', 22, auto, { text: NOT_READ }), person]),
    ).toMatchObject({ replyTo: PERSON, canReply: true });
  });

  it('for a person who is out of office: a reply box as before', async () => {
    const thread = await read([
      message('m-1', 20, { From: PERSON, Subject: 'Interview' }),
      mine(21),
      message(
        'm-2',
        22,
        { From: PERSON, Subject: 'Automatic reply: Interview' },
        { text: 'I am out of the office until Monday and will answer then.' },
      ),
    ]);
    expect(thread).toMatchObject({ replyTo: PERSON, canReply: true });
  });

  it('for a notification that says "do not reply" in its own text: none', async () => {
    const thread = await read([
      message(
        'm-1',
        20,
        { From: 'Lumen Works <updates@lumen-works.example>', Subject: 'Next step' },
        { text: 'Complete your profile in the portal.\n\nPlease do not reply to this email.' },
      ),
    ]);
    expect(thread.canReply).toBe(false);
  });

  it('for a mailbox whose earlier job mail said so: none', async () => {
    await notReadReply('t-elsewhere');
    const thread = await read([message('m-1', 23, { From: MAILBOX, Subject: 'Documents' })]);
    expect(thread).toMatchObject({ replyTo: MAILBOX, canReply: false });
  });

  it('says nothing new when nobody else wrote', async () => {
    expect(await read([mine(20)])).toMatchObject({ replyTo: null, canReply: true });
  });
});
