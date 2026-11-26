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
