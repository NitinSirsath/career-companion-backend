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
import { ConversationDetailSchema } from '../contracts';
import { JobExtractionV6Schema } from '../services/ai/contracts';
import { processEmail } from '../services/ai/pipeline';
import { createProviderClient } from '../services/ai/providers';
import { canReplyTo, requestOf } from '../services/emailRequest';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { askId } from '../services/threadAsks';
import { configureAI } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

const OWNER = 'owner@thread-asks.test';
let owner: string;
let counter = 0;
const as = () => ({ 'X-Development-User': OWNER });
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 9, day, hour));

const empty = Object.fromEntries(
  Object.keys(JobExtractionV6Schema.shape).map((key) => [key, null]),
);
type Read = Partial<Record<keyof typeof JobExtractionV6Schema.shape, unknown>>;
const read = (fields: Read) => ({
  ...empty,
  companyName: 'Northwind',
  jobTitle: 'Engineer',
  ...fields,
});
const relevant = {
  decision: 'RELEVANT',
  category: 'INTERVIEW',
  confidence: 0.95,
  reasoning: 'job',
};

/** A new mail as sync stores it, before the AI read it. */
const newMail = (threadId: string, receivedAt: Date, sender = 'Priya <priya@northwind.example>') =>
  prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: `thread-asks-${++counter}`,
      threadId,
      subject: 'Interview',
      sender,
      receivedAt,
    },
  });

/** Reads one mail with the given AI answer; returns what the provider was sent. */
async function readMail(emailId: string, answer: Read) {
  const provider = fakeProviderClient({ classification: relevant, extraction: read(answer) });
  vi.mocked(createProviderClient).mockReturnValue(provider);
  await processEmail(owner, emailId);
  const [call] = provider.calls('job_extraction_v6');
  return call ? JSON.parse(call[0].input) : null;
}

const email = (id: string) =>
  prisma.email.findUniqueOrThrow({ where: { id }, include: { aiProcessingResult: true } });
const conversation = async (key: string) => {
  const res = await request(app).get(`/api/conversations/${key}`).set(as());
  expect(res.status).toBe(200);
  return ConversationDetailSchema.parse(res.body).conversation;
};
const answerRequest = (key: string, body: object) =>
  request(app).patch(`/api/conversations/${key}/request`).set(as()).send(body);

const TIMES = {
  actionRequired: true,
  requestedAction: 'Send your free times',
  askKind: 'REPLY_BY_MAIL',
};
const SURVEY = {
  actionRequired: true,
  requestedAction: 'Fill in the survey.',
  askKind: 'OUTSIDE_MAIL',
};

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  await configureAI(owner);
  await prisma.application.create({
    data: { userId: owner, companyName: 'Northwind', jobTitle: 'Engineer' },
  });
});
beforeEach(async () => {
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.action.deleteMany({ where: { application: { userId: owner } } });
  vi.mocked(fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: 'Hi' });
  vi.mocked(fetchMessageBody).mockResolvedValue('Synthetic mail body');
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
});

describe('a newer mail closes older asks (COM-237)', () => {
  it('sends the open asks with the mail and closes the one it replaces', async () => {
    const first = await newMail('t-replace', at(1));
    expect(await readMail(first.id, TIMES)).toMatchObject({ senderCanReply: true, openAsks: [] });
    const second = await newMail('t-replace', at(3));
    const sent = await readMail(second.id, {
      interviewDate: '2026-11-03',
      closedAsks: [{ id: askId(first.id), reason: 'REPLACED' }],
    });
    expect(sent.openAsks).toEqual([
      {
        id: askId(first.id),
        ask: 'Send your free times',
        kind: 'REPLY_BY_MAIL',
        askedAt: at(1).toISOString(),
      },
    ]);
    expect(await email(first.id)).toMatchObject({
      requestClosedReason: 'REPLACED_BY_MAIL',
      requestClosedByMessageId: second.gmailMessageId,
    });
    expect(await prisma.action.findFirstOrThrow({ where: { emailId: first.id } })).toMatchObject({
      status: 'COMPLETED',
    });
    // The second mail asks nothing, so the conversation's request is the closed one.
    expect((await conversation('t-replace')).request).toMatchObject({
      emailId: first.id,
      state: 'DONE',
      closedReason: 'REPLACED_BY_MAIL',
      closedByMessageId: second.gmailMessageId,
    });
  });

  it('closes an ask a newer mail confirms, and nothing when the mail names no open ask', async () => {
    const survey = await newMail('t-confirm', at(1));
    await readMail(survey.id, SURVEY);
    const note = await newMail('t-confirm', at(2));
    await readMail(note.id, { closedAsks: [{ id: 'ask-madeup1', reason: 'REPLACED' }] });
    expect((await email(survey.id)).requestClosedReason).toBeNull();
    const thanks = await newMail('t-confirm', at(3));
    await readMail(thanks.id, { closedAsks: [{ id: askId(survey.id), reason: 'CONFIRMED_DONE' }] });
    expect((await email(survey.id)).requestClosedReason).toBe('CONFIRMED_BY_MAIL');
    // Reading the mail again closes nothing more and keeps the first reason.
    await processEmail(owner, thanks.id);
    expect((await email(survey.id)).requestClosedReason).toBe('CONFIRMED_BY_MAIL');
  });

  it('keeps an ask open when the newer mail closes nothing ("see attached")', async () => {
    const ask = await newMail('t-keep', at(1));
    await readMail(ask.id, TIMES);
    const attached = await newMail('t-keep', at(2));
    await readMail(attached.id, { closedAsks: [] });
    expect((await conversation('t-keep')).request).toMatchObject({
      emailId: ask.id,
      state: 'OPEN',
    });
  });

  it('stores how the ask is done and the reply choices, none for a no-reply sender', async () => {
    const ask = await newMail('t-choices', at(1));
    await readMail(ask.id, {
      ...TIMES,
      replyChoices: [' Send my free times ', 'Decline', 'Decline'],
    });
    expect((await email(ask.id)).aiProcessingResult).toMatchObject({
      askKind: 'REPLY_BY_MAIL',
      replyChoices: ['Send my free times', 'Decline'],
    });
    const test = await newMail('t-noreply', at(1), 'Zenith <no-reply@hackerrank.example>');
    expect(await readMail(test.id, { ...SURVEY, replyChoices: ['Thanks'] })).toMatchObject({
      senderCanReply: false,
    });
    expect((await email(test.id)).aiProcessingResult).toMatchObject({
      askKind: 'OUTSIDE_MAIL',
      replyChoices: [],
    });
  });
});

describe('the request in words', () => {
  const result = (fields: object) =>
    ({
      ...empty,
      actionRequired: true,
      requestedAction: 'Fill in the survey.',
      ...fields,
    }) as never;

  it('tells the user to say so for an outside-mail ask from a sender who can get a reply', () => {
    const sender = 'Talent <talent@infosys.example>';
    expect(requestOf(result({ askKind: 'OUTSIDE_MAIL' }), null, sender)?.text).toBe(
      'Fill in the survey, then tell them you did',
    );
    expect(requestOf(result({ askKind: 'REPLY_BY_MAIL' }), null, sender)?.text).toBe(
      'Fill in the survey.',
    );
    expect(
      requestOf(result({ askKind: 'OUTSIDE_MAIL' }), null, 'no-reply@hackerrank.example')?.text,
    ).toBe('Fill in the survey.');
  });

  it('knows a no-reply sender by its address', () => {
    for (const sender of [
      'no-reply@x.example',
      'Zenith <noreply@x.example>',
      'donotreply@x.example',
      'do-not-reply.jobs@x.example',
    ])
      expect(canReplyTo(sender)).toBe(false);
    for (const sender of ['Priya <priya@x.example>', 'replies@x.example', 'nora.reply@x.example'])
      expect(canReplyTo(sender)).toBe(true);
    expect(canReplyTo(null)).toBe(false);
  });
});

describe('closing by hand (owner, 24 Oct 2026)', () => {
  it('refuses "I did this" on a reply-by-mail ask and allows it on an outside-mail one', async () => {
    const times = await newMail('t-hand-1', at(1));
    await readMail(times.id, TIMES);
    const refused = await answerRequest('t-hand-1', { emailId: times.id, state: 'DONE' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CLOSES_BY_ITSELF');

    const survey = await newMail('t-hand-2', at(1));
    await readMail(survey.id, SURVEY);
    const done = await answerRequest('t-hand-2', { emailId: survey.id, state: 'DONE' });
    expect(done.status).toBe(200);
    expect(done.body.request).toMatchObject({ state: 'DONE', closedReason: 'YOU_SAID_DONE' });
    expect(await prisma.action.findFirstOrThrow({ where: { emailId: survey.id } })).toMatchObject({
      status: 'COMPLETED',
    });

    const reopened = await answerRequest('t-hand-2', { emailId: survey.id, state: 'OPEN' });
    expect(reopened.body.request).toMatchObject({ state: 'OPEN', closedReason: null });
    expect(await email(survey.id)).toMatchObject({
      requestClosedReason: null,
      requestClosedAt: null,
    });
    expect(await prisma.action.findFirstOrThrow({ where: { emailId: survey.id } })).toMatchObject({
      status: 'PENDING',
    });
  });

  it('follows the same rule on the application page, and keeps Dismiss', async () => {
    const times = await newMail('t-page', at(1));
    await readMail(times.id, TIMES);
    const action = await prisma.action.findFirstOrThrow({ where: { emailId: times.id } });
    const patch = (status: string, revision: number) =>
      request(app)
        .patch(`/api/actions/${action.id}`)
        .set(as())
        .send({ status, expectedActionRevision: revision });
    const refused = await patch('COMPLETED', action.actionRevision);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CLOSES_BY_ITSELF');
    expect((await patch('DISMISSED', action.actionRevision)).status).toBe(200);
    expect((await conversation('t-page')).request?.state).toBe('DONE');

    const survey = await newMail('t-page-2', at(1));
    await readMail(survey.id, SURVEY);
    const step = await prisma.action.findFirstOrThrow({ where: { emailId: survey.id } });
    const done = await request(app)
      .patch(`/api/actions/${step.id}`)
      .set(as())
      .send({ status: 'COMPLETED', expectedActionRevision: step.actionRevision });
    expect(done.status).toBe(200);
    expect((await email(survey.id)).requestClosedReason).toBe('YOU_SAID_DONE');
  });

  it('closes open asks when the application is set to Rejected, lists why, and reopens', async () => {
    const times = await newMail('t-closed', at(1));
    await readMail(times.id, TIMES);
    const app_ = await prisma.application.findFirstOrThrow({ where: { userId: owner } });
    const res = await request(app)
      .patch(`/api/applications/${app_.id}/status`)
      .set(as())
      .send({ userStatus: 'REJECTED', expectedUserStatusRevision: app_.userStatusRevision });
    expect(res.status).toBe(200);
    expect((await conversation('t-closed')).request).toMatchObject({
      state: 'DONE',
      closedReason: 'APPLICATION_CLOSED',
    });
    const steps = await request(app).get(`/api/applications/${app_.id}/actions`).set(as());
    expect(steps.body.items).toEqual([
      expect.objectContaining({
        status: 'COMPLETED',
        askKind: 'REPLY_BY_MAIL',
        closedReason: 'APPLICATION_CLOSED',
      }),
    ]);
    const reopened = await answerRequest('t-closed', { emailId: times.id, state: 'OPEN' });
    expect(reopened.body.request).toMatchObject({ state: 'OPEN', closedReason: null });
    await prisma.application.update({
      where: { id: app_.id },
      data: { userStatus: null, userStatusRevision: { increment: 1 } },
    });
  });
});
