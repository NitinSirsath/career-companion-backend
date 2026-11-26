import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import {
  ConversationDetailSchema,
  ConversationSummarySchema,
  DashboardResponseSchema,
  ListConversationsResponseSchema,
} from '../contracts';
import { JobExtractionV6Schema } from '../services/ai/contracts';
import { processEmail } from '../services/ai/pipeline';
import { createProviderClient } from '../services/ai/providers';
import { askRules, isAutoReply } from '../services/emailRequest';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { matchEmailToApplication } from '../services/matcher';
import { tidyAllRequests } from '../services/requestUpkeep';
import { configureAI } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

const OWNER = 'owner@stale-requests.test';
let owner: string;
let counter = 0;
let server: Server;

const as = { 'X-Development-User': OWNER };
/** A moment in November 2026 (UTC). */
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour));

type Stored = {
  category?: 'RECRUITER' | 'INTERVIEW' | 'REJECTION' | 'FOLLOW_UP' | 'CAREER_CONTACT';
  companyName?: string;
  actionRequired?: boolean;
  requestedAction?: string;
  actionDeadline?: string;
  followUpRequired?: boolean;
  followUpDate?: string;
  askKind?: 'REPLY_BY_MAIL' | 'OUTSIDE_MAIL';
};
type Mail = { thread: string; at: Date; subject: string; sender: string };

/** A job mail with the AI read saved as it stands: what an older version of the app left. */
const storedMail = (mail: Mail, read: Stored) =>
  prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: `stale-${++counter}`,
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
          contractVersion: 'extraction/v8',
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          ...read,
        },
      },
    },
  });

/** Links a stored mail to the user's application at its company, as the reader did. */
async function linked(mail: Mail, read: Stored) {
  const row = await storedMail(mail, read);
  await matchEmailToApplication(row.id);
  return row;
}

const application = (companyName: string) =>
  prisma.application.create({ data: { userId: owner, companyName, aiStatus: 'APPLIED' } });

const conversations = async (query: string) => {
  const res = await request(server).get(`/api/conversations${query}`).set(as);
  expect(res.status).toBe(200);
  return ListConversationsResponseSchema.parse(res.body).items;
};
const keys = async (query: string) => (await conversations(query)).map((item) => item.key);
const conversation = async (key: string) => {
  const res = await request(server).get(`/api/conversations/${key}`).set(as);
  expect(res.status).toBe(200);
  return ConversationDetailSchema.parse(res.body).conversation;
};
const toDo = async (id: string) =>
  (await request(server).get(`/api/applications/${id}`).set(as)).body.pendingActionCount;
const reopen = (key: string, emailId: string) =>
  request(server)
    .patch(`/api/conversations/${key}/request`)
    .set(as)
    .send({ emailId, state: 'OPEN' });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(26, 12));
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  await configureAI(owner);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
});
beforeEach(async () => {
  vi.setSystemTime(at(26, 12));
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.outgoingEmail.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
  vi.mocked(fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: 'Hi' });
  vi.mocked(fetchMessageBody).mockResolvedValue('Synthetic mail body');
});
afterAll(async () => {
  vi.useRealTimers();
  await new Promise((resolve) => server.close(resolve));
  await prisma.user.deleteMany({ where: { id: owner } });
});

const SURVEY: Stored = {
  category: 'INTERVIEW',
  companyName: 'Globex',
  actionRequired: true,
  requestedAction: 'Fill the availability survey',
  actionDeadline: '2026-11-17 05:30:00 GMT',
  askKind: 'OUTSIDE_MAIL',
};
const surveyMail = (thread: string, day: number, subject = 'Interview Availability'): Mail => ({
  thread,
  at: at(day),
  subject,
  sender: 'Globex Hiring <hiring@globex.example>',
});

/**
 * The shape of the owner's real account on 26 Nov 2026, with made-up names: seven requests that
 * nothing ever closed, of which one still needs them.
 */
async function sevenOpenRequests() {
  const globex = await application('Globex');
  const initech = await application('Initech');
  // 1. A new recruiter ask: the only one that still needs the user.
  await storedMail(
    {
      thread: 't-interest',
      at: at(25),
      subject: 'A role you may like',
      sender: 'Mara <mara@northwind-talent.example>',
    },
    {
      category: 'RECRUITER',
      companyName: 'Northwind Talent',
      actionRequired: true,
      requestedAction: 'Fill the interest form',
      askKind: 'OUTSIDE_MAIL',
    },
  );
  // 2. A plain confirmation the AI flagged "follow up", with no text and no date. The company
  //    said no the next day, in a mail of its own.
  const confirmation = {
    thread: 't-confirmation',
    at: at(22),
    subject: 'Application to Lumen Labs submitted',
    sender: 'Jobboard <no-reply@jobboard.example>',
  };
  await storedMail(confirmation, {
    category: 'FOLLOW_UP',
    companyName: 'Lumen Labs',
    followUpRequired: true,
  });
  await storedMail(
    { ...confirmation, thread: 't-lumen-no', at: at(23), subject: 'Update on your application' },
    { category: 'REJECTION', companyName: 'Lumen Labs' },
  );
  // 3 and 4. The same survey asked twice, in two threads, due 9 days ago.
  const first = await linked(surveyMail('t-survey-1', 11), SURVEY);
  const again = await linked(surveyMail('t-survey-2', 12), SURVEY);
  // 5. An automatic reply read as a request.
  const autoReply = await linked(
    surveyMail('t-auto', 15, 'Automatic reply: Interview Availability'),
    {
      category: 'INTERVIEW',
      companyName: 'Globex',
      actionRequired: true,
      requestedAction: 'Raise a ticket for any queries',
      askKind: 'OUTSIDE_MAIL',
    },
  );
  // 6. A career-contact ask the user replied to; the AI read the reply as not settling it.
  await storedMail(
    {
      thread: 't-listing',
      at: at(14),
      subject: 'Listly x you',
      sender: 'Dana <dana@listly.example>',
    },
    {
      category: 'CAREER_CONTACT',
      companyName: 'Listly',
      actionRequired: true,
      requestedAction: 'List your tool on Listly',
      askKind: 'REPLY_BY_MAIL',
    },
  );
  await prisma.outgoingEmail.create({
    data: {
      userId: owner,
      gmailMessageId: 'stale-sent',
      threadId: 't-listing',
      sentAt: at(15),
      replyReadState: 'READ',
    },
  });
  // 7. An ask on an application whose company said no the day after.
  const account = await linked(
    {
      thread: 't-account',
      at: at(6),
      subject: 'Next step for your application',
      sender: 'Initech Careers <careers@initech.example>',
    },
    {
      category: 'RECRUITER',
      companyName: 'Initech',
      actionRequired: true,
      requestedAction: 'Create a candidate account',
      askKind: 'OUTSIDE_MAIL',
    },
  );
  const rejection = await linked(
    {
      thread: 't-initech-no',
      at: at(7),
      subject: 'Your application at Initech',
      sender: 'Initech Careers <careers@initech.example>',
    },
    { category: 'REJECTION', companyName: 'Initech' },
  );
  // The deadline reader of that time read none of these deadlines.
  await prisma.action.updateMany({
    where: { application: { userId: owner } },
    data: { deadline: null, deadlinePrecision: null },
  });
  return { globex, initech, first, again, autoReply, account, rejection };
}

/** Requests in storage that nothing closed: what every list counted before these rules. */
const neverClosed = () =>
  prisma.email.count({
    where: {
      userId: owner,
      requestClosedReason: null,
      aiProcessingResult: { OR: [{ actionRequired: true }, { followUpRequired: true }] },
    },
  });

describe('the real case of 26 Nov 2026: seven requests that never left Needs action', () => {
  it('ends as 1 needs action, 2 missed and 2 done, and every count agrees', async () => {
    const { globex, initech, first, again, autoReply, account, rejection } =
      await sevenOpenRequests();
    expect(await neverClosed()).toBe(7);
    expect(await prisma.action.count({ where: { status: 'PENDING' } })).toBe(4);

    expect(await tidyAllRequests()).toEqual({ dropped: 2, deadlines: 2, closed: 2 });

    expect(await keys('?request=open')).toEqual(['t-interest']);
    expect(await keys('?request=missed')).toEqual(['t-listing', 't-survey-2']);
    expect(await keys('?request=done')).toEqual(['t-survey-1', 't-account']);
    const summary = await request(server).get('/api/conversations/summary').set(as);
    expect(ConversationSummarySchema.parse(summary.body)).toEqual({
      needsAction: 1,
      pastDue: 0,
      missed: 2,
    });
    const dashboard = await request(server).get('/api/dashboard?period=30d&timeZone=UTC').set(as);
    expect(DashboardResponseSchema.parse(dashboard.body).now.needsAction).toMatchObject({
      count: 1,
      missed: 2,
    });
    expect(await toDo(globex.id)).toBe(0);
    expect(await toDo(initech.id)).toBe(0);

    // Each one left for a reason the user can read.
    expect((await conversation('t-survey-2')).request).toMatchObject({
      state: 'OPEN',
      deadline: '2026-11-17T05:30:00.000Z',
      missed: { reason: 'DEADLINE_PASSED', since: '2026-11-18T05:30:00.000Z' },
    });
    expect((await conversation('t-listing')).request).toMatchObject({
      state: 'OPEN',
      replyRead: 'NOT_ANSWERED',
      missed: { reason: 'NO_ANSWER', since: at(22).toISOString() },
    });
    expect((await conversation('t-survey-1')).request).toMatchObject({
      state: 'DONE',
      closedReason: 'REPLACED_BY_MAIL',
      closedByMessageId: again.gmailMessageId,
    });
    expect((await conversation('t-account')).request).toMatchObject({
      state: 'DONE',
      closedReason: 'APPLICATION_CLOSED',
      closedByMessageId: rejection.gmailMessageId,
    });
    expect((await conversation('t-auto')).request).toBeNull();
    expect((await conversation('t-confirmation')).request).toBeNull();

    // The stored steps follow: the survey has its date now, the automatic reply's step is gone.
    const steps = await prisma.action.findMany({ where: { application: { userId: owner } } });
    const stepOf = (emailId: string) => steps.find((step) => step.emailId === emailId);
    expect(stepOf(again.id)).toMatchObject({
      status: 'PENDING',
      deadline: new Date('2026-11-17T05:30:00Z'),
      deadlinePrecision: 'DATETIME',
    });
    expect(stepOf(first.id)?.status).toBe('COMPLETED');
    expect(stepOf(account.id)?.status).toBe('COMPLETED');
    expect(stepOf(autoReply.id)).toMatchObject({ status: 'PENDING', retiredReason: 'REANALYZED' });
    expect(stepOf(autoReply.id)?.retiredAt).not.toBeNull();

    // Safe to run again: the next hour finds nothing to do.
    expect(await tidyAllRequests()).toEqual({ dropped: 0, deadlines: 0, closed: 0 });
  });

  it('Reopen still works: what the user opens again is never closed a second time', async () => {
    const { first, account } = await sevenOpenRequests();
    await tidyAllRequests();
    expect((await reopen('t-account', account.id)).body.request).toMatchObject({ state: 'OPEN' });
    expect((await reopen('t-survey-1', first.id)).status).toBe(200);

    expect(await tidyAllRequests()).toEqual({ dropped: 0, deadlines: 0, closed: 0 });
    expect(await keys('?request=open')).toEqual(['t-interest', 't-survey-1', 't-account']);
    // The survey's deadline is long past, but the user said it is still open: 7 more days.
    expect((await conversation('t-survey-1')).request).toMatchObject({
      state: 'OPEN',
      missed: null,
    });
  });
});

describe('the same ask again', () => {
  it('is not taken for another ask: another deadline, subject, sender or application stays', async () => {
    await application('Globex');
    await application('Initech');
    await linked(surveyMail('t-1', 20), { ...SURVEY, actionDeadline: '2026-12-01' });
    await linked(surveyMail('t-2', 21), { ...SURVEY, actionDeadline: '2026-12-08' });
    await linked(surveyMail('t-3', 22, 'Your interview slot'), {
      ...SURVEY,
      actionDeadline: '2026-12-01',
    });
    await linked(
      { ...surveyMail('t-4', 23), sender: 'Globex People <people@globex.example>' },
      { ...SURVEY, actionDeadline: '2026-12-01' },
    );
    await linked(surveyMail('t-5', 24), {
      ...SURVEY,
      companyName: 'Initech',
      actionDeadline: '2026-12-01',
    });
    expect(await tidyAllRequests()).toEqual({ dropped: 0, deadlines: 0, closed: 0 });
    expect(await keys('?request=open')).toHaveLength(5);
  });

  it('reads "Reminder:" and "Re:" before the subject as the same subject', async () => {
    await application('Globex');
    await linked(surveyMail('t-1', 20), { ...SURVEY, actionDeadline: '2026-12-01' });
    const reminder = await linked(surveyMail('t-2', 23, 'Reminder: Interview availability'), {
      ...SURVEY,
      actionDeadline: '2026-12-01',
    });
    expect((await tidyAllRequests()).closed).toBe(1);
    expect((await conversation('t-1')).request).toMatchObject({
      state: 'DONE',
      closedReason: 'REPLACED_BY_MAIL',
      closedByMessageId: reminder.gmailMessageId,
    });
    expect(await keys('?request=open')).toEqual(['t-2']);
  });
});

describe('the rules on what a mail asks', () => {
  it.each([
    'Automatic reply: Interview Availability',
    'automatic reply',
    'Auto-Reply: thank you',
    'Autoreply: out until Monday',
    'Auto response from HR',
    'Out of Office: back on 3 Dec',
    'Out of the office',
  ])('reads %s as an automatic reply', (subject) => expect(isAutoReply(subject)).toBe(true));

  it.each(['Automation engineer role', 'Re: your reply', 'Out of curiosity', 'Interview', null])(
    'does not read %s as an automatic reply',
    (subject) => expect(isAutoReply(subject)).toBe(false),
  );

  it('keeps a follow-up only with a date the app can read', () => {
    const mail = { subject: 'We got your application', receivedAt: at(20) };
    const followUp = { actionRequired: false, followUpRequired: true };
    expect(askRules({ ...followUp, followUpDate: null }, mail)).toEqual({
      followUpRequired: false,
    });
    expect(askRules({ ...followUp, followUpDate: 'in 1-2 weeks' }, mail)).toEqual({
      followUpRequired: false,
    });
    expect(askRules({ ...followUp, followUpDate: '3 Dec 2026' }, mail)).toEqual({});
    expect(
      askRules({ actionRequired: true, followUpRequired: true, followUpDate: null }, mail),
    ).toEqual({});
  });
});

describe('a new mail, as it is read', () => {
  const empty = Object.fromEntries(
    Object.keys(JobExtractionV6Schema.shape).map((key) => [key, null]),
  );
  type Read = Partial<Record<keyof typeof JobExtractionV6Schema.shape, unknown>>;

  /** A new mail as sync stores it, read by the AI with the given answer. */
  async function readMail(mail: Mail, category: Stored['category'], answer: Read) {
    const row = await prisma.email.create({
      data: {
        userId: owner,
        gmailMessageId: `stale-new-${++counter}`,
        threadId: mail.thread,
        subject: mail.subject,
        sender: mail.sender,
        receivedAt: mail.at,
      },
    });
    vi.mocked(createProviderClient).mockReturnValue(
      fakeProviderClient({
        classification: { decision: 'RELEVANT', category, confidence: 0.95, reasoning: 'job' },
        extraction: { ...empty, companyName: 'Globex', ...answer },
      }),
    );
    await processEmail(owner, row.id);
    return prisma.email.findUniqueOrThrow({
      where: { id: row.id },
      include: { aiProcessingResult: true, actions: true },
    });
  }
  const asked = {
    actionRequired: true,
    requestedAction: 'Fill the availability survey',
    askKind: 'OUTSIDE_MAIL',
  };

  it('an automatic reply never makes a request or a step', async () => {
    await application('Globex');
    const mail = await readMail(
      surveyMail('t-auto', 25, 'Automatic reply: Interview Availability'),
      'INTERVIEW',
      {
        actionRequired: true,
        requestedAction: 'Raise a ticket for any queries',
        askKind: 'REPLY_BY_MAIL',
        replyChoices: ['Thanks'],
      },
    );
    expect(mail.aiProcessingResult).toMatchObject({
      actionRequired: false,
      requestedAction: null,
      askKind: null,
      replyChoices: [],
    });
    expect(mail.matchState).toBe('MATCHED');
    expect(mail.actions).toEqual([]);
    expect((await conversation('t-auto')).request).toBeNull();
  });

  it('a "follow up" with no date makes no request; one with a date does', async () => {
    await application('Globex');
    const plain = await readMail(surveyMail('t-plain', 24, 'We got it'), 'FOLLOW_UP', {
      followUpRequired: true,
    });
    expect(plain.aiProcessingResult?.followUpRequired).toBe(false);
    expect(plain.actions).toEqual([]);
    expect((await conversation('t-plain')).request).toBeNull();

    await readMail(surveyMail('t-dated', 25, 'Checking in'), 'FOLLOW_UP', {
      followUpRequired: true,
      followUpDate: '3 Dec 2026',
    });
    expect((await conversation('t-dated')).request).toMatchObject({
      kind: 'FOLLOW_UP',
      state: 'OPEN',
      deadline: '2026-12-03T00:00:00.000Z',
    });
  });

  it('a rejection the AI reads closes the open asks of its application at once', async () => {
    const globex = await application('Globex');
    await readMail(surveyMail('t-ask', 20), 'INTERVIEW', asked);
    expect(await toDo(globex.id)).toBe(1);

    const no = await readMail(surveyMail('t-no', 24, 'Your application at Globex'), 'REJECTION', {
      rejectionInfo: 'Not moving forward.',
    });
    expect((await conversation('t-ask')).request).toMatchObject({
      state: 'DONE',
      closedReason: 'APPLICATION_CLOSED',
      closedByMessageId: no.gmailMessageId,
    });
    expect(await toDo(globex.id)).toBe(0);

    // An ask that arrives after the rejection is a new one: it stays open.
    await readMail(surveyMail('t-later', 25, 'One more thing'), 'INTERVIEW', asked);
    expect(await keys('?request=open')).toEqual(['t-later']);
  });

  it('the same ask in a new thread closes the older one at once', async () => {
    const globex = await application('Globex');
    await readMail(surveyMail('t-first', 20), 'INTERVIEW', asked);
    const again = await readMail(surveyMail('t-again', 22), 'INTERVIEW', asked);
    expect((await conversation('t-first')).request).toMatchObject({
      state: 'DONE',
      closedReason: 'REPLACED_BY_MAIL',
      closedByMessageId: again.gmailMessageId,
    });
    expect(await keys('?request=open')).toEqual(['t-again']);
    expect(await toDo(globex.id)).toBe(1);
  });
});
