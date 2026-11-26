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
