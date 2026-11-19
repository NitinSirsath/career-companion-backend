import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
  enqueueReplyReading: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { ApplicationResponseSchema, ConversationDetailSchema } from '../contracts';
import { createProviderClient } from '../services/ai/providers';
import { fetchMessageBody } from '../services/gmailFetcher';
import { closeDueDeclines } from '../services/applicationDecline';
import { noteSentForReading, readSentReply } from '../services/replyReading';
import { enqueueReplyReading } from '../services/enqueue';
import { configureAI } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

const OWNER = 'owner@reply-read-v2.test';
const HEADERS = { 'X-Development-User': OWNER };
let owner: string;
let counter = 0;
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour));
const DAY = 24 * 60 * 60 * 1000;

/** An application with one mail that asks to confirm the interview, linked to it. */
async function interviewThread(threadId: string) {
  const application = await prisma.application.create({
    data: { userId: owner, companyName: 'XYZ Technologies', aiStatus: 'INTERVIEW' },
  });
  const ask = await receivedMail(threadId, at(14), {
    applicationId: application.id,
    actionRequired: true,
    requestedAction: 'Reply to confirm availability for the scheduled interview',
  });
  await prisma.action.create({
    data: {
      applicationId: application.id,
      emailId: ask.id,
      type: 'ACTION_REQUIRED',
      description: 'Reply to confirm availability for the scheduled interview',
    },
  });
  return { application, ask };
}

async function receivedMail(
  threadId: string,
  receivedAt: Date,
  options: {
    applicationId?: string;
    actionRequired?: boolean;
    requestedAction?: string;
    notJobMail?: boolean;
  } = {},
) {
  return prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: `v2-${++counter}`,
      threadId,
      subject: 'Interview',
      sender: 'Priya <priya@xyz.example>',
      receivedAt,
      relevanceState: options.notJobMail ? 'IRRELEVANT' : 'RELEVANT',
      processingState: 'COMPLETED',
      matchState: options.applicationId ? 'MATCHED' : 'UNMATCHED',
      applicationId: options.applicationId ?? null,
      aiProcessingResult: {
        create: {
          provider: 'gemini',
          model: 'test-model',
          contractVersion: 'extraction/v8',
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          actionRequired: options.actionRequired ?? false,
          requestedAction: options.requestedAction ?? null,
          askKind: options.actionRequired ? 'REPLY_BY_MAIL' : null,
        },
      },
    },
  });
}

/** The user's reply, read by the fake AI with this answer for the asking mail. */
async function replyRead(
  threadId: string,
  sentAt: Date,
  answer: (askIds: string[]) => { asks: { id: string; outcome: string }[]; leavesJob: boolean },
) {
  const sent = await prisma.outgoingEmail.create({
    data: { userId: owner, gmailMessageId: `sent-${++counter}`, threadId, sentAt },
  });
  await noteSentForReading(owner, sent.id);
  vi.mocked(createProviderClient).mockReturnValue(
    fakeProviderClient({
      extraction: (input: string) =>
        answer((JSON.parse(input) as { openAsks: { id: string }[] }).openAsks.map((a) => a.id)),
    }),
  );
  expect(await readSentReply(owner, sent.id)).toBeNull();
  return sent;
}

const conversation = async (key: string) => {
  const res = await request(app).get(`/api/conversations/${key}`).set(HEADERS);
  expect(res.status).toBe(200);
  return ConversationDetailSchema.parse(res.body).conversation;
};
const application = async (id: string) => {
  const res = await request(app).get(`/api/applications/${id}`).set(HEADERS);
  expect(res.status).toBe(200);
  return ApplicationResponseSchema.parse(res.body);
};
const answer = (id: string, value: 'CLOSE' | 'KEEP_OPEN') =>
  request(app).post(`/api/applications/${id}/decline`).set(HEADERS).send({ answer: value });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
});
beforeEach(async () => {
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  await configureAI(owner);
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.outgoingEmail.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
  await prisma.aIModelPause.deleteMany({ where: { userId: owner } });
  vi.mocked(fetchMessageBody).mockResolvedValue("I'm writing to decline the interview invitation.");
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
});

describe('a reply that declines (owner, 17 Nov 2026)', () => {
  it('closes the ask as "You declined" and asks to close the application', async () => {
    const { application: job, ask } = await interviewThread('t-decline');
    const sent = await replyRead('t-decline', at(15), (ids) => ({
      asks: ids.map((id) => ({ id, outcome: 'DECLINED' })),
      leavesJob: true,
    }));
    expect(await prisma.email.findUniqueOrThrow({ where: { id: ask.id } })).toMatchObject({
      requestClosedReason: 'YOU_DECLINED',
      requestClosedByMessageId: sent.gmailMessageId,
    });
    const convo = await conversation('t-decline');
    expect(convo.request).toMatchObject({ state: 'DONE', closedReason: 'YOU_DECLINED' });
    const question = {
      repliedAt: at(15).toISOString(),
      closesAt: new Date(at(15).getTime() + 3 * DAY).toISOString(),
    };
    expect(convo.application).toMatchObject({ decline: question, closedAfterDeclineAt: null });
    expect(await application(job.id)).toMatchObject({
      effectiveStatus: 'INTERVIEW',
      decline: question,
    });
  });

  it('closes only the step when the reply says no to a small ask', async () => {
    const { application: job } = await interviewThread('t-small-no');
    await replyRead('t-small-no', at(15), (ids) => ({
      asks: ids.map((id) => ({ id, outcome: 'DECLINED' })),
      leavesJob: false,
    }));
    expect((await conversation('t-small-no')).request?.closedReason).toBe('YOU_DECLINED');
    expect((await application(job.id)).decline).toBeNull();
  });

  it('Keep open hides the question and keeps the status', async () => {
    const { application: job } = await interviewThread('t-keep');
    await replyRead('t-keep', at(15), (ids) => ({
      asks: ids.map((id) => ({ id, outcome: 'DECLINED' })),
      leavesJob: true,
    }));
    const res = await answer(job.id, 'KEEP_OPEN');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ effectiveStatus: 'INTERVIEW', decline: null });
    expect((await answer(job.id, 'CLOSE')).status).toBe(409);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at(15).getTime() + 4 * DAY));
    expect(await closeDueDeclines()).toBe(0);
  });

  it('Close it sets Closed as the user, closes the open steps and says why', async () => {
    const { application: job } = await interviewThread('t-close');
    // The application's other open step, from an earlier mail.
    await prisma.action.create({
      data: { applicationId: job.id, type: 'ACTION_REQUIRED', description: 'Bring your ID' },
    });
    await replyRead('t-close', at(15), (ids) => ({
      asks: ids.map((id) => ({ id, outcome: 'NOT_ANSWERED' })),
      leavesJob: true,
    }));
    const res = await answer(job.id, 'CLOSE');
    expect(res.status).toBe(200);
    const closed = ApplicationResponseSchema.parse(res.body);
    expect(closed).toMatchObject({
      userStatus: 'CLOSED',
      statusSource: 'USER',
      decline: null,
    });
    expect(closed.closedAfterDeclineAt).not.toBeNull();
    expect((await conversation('t-close')).request).toMatchObject({
      state: 'DONE',
      closedReason: 'APPLICATION_CLOSED',
    });
    // A later change by hand wins: the line goes.
    const changed = await request(app)
      .patch(`/api/applications/${job.id}/status`)
      .set(HEADERS)
      .send({ userStatus: 'INTERVIEW', expectedUserStatusRevision: closed.userStatusRevision });
    expect(changed.body).toMatchObject({
      effectiveStatus: 'INTERVIEW',
      closedAfterDeclineAt: null,
    });
  });

  it('closes by itself three days after the reply, unless the company wrote again', async () => {
    const quiet = await interviewThread('t-quiet');
    const busy = await interviewThread('t-busy');
    for (const threadId of ['t-quiet', 't-busy'])
      await replyRead(threadId, at(15), (ids) => ({
        asks: ids.map((id) => ({ id, outcome: 'DECLINED' })),
        leavesJob: true,
      }));
    // "Would you reconsider?" two days later.
    await receivedMail('t-busy', at(17), { applicationId: busy.application.id });
    expect((await application(busy.application.id)).decline).toEqual({
      repliedAt: at(15).toISOString(),
      closesAt: null,
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at(15).getTime() + 3 * DAY - 60_000));
    expect(await closeDueDeclines()).toBe(0);
    vi.setSystemTime(new Date(at(15).getTime() + 3 * DAY + 60_000));
    expect(await closeDueDeclines()).toBe(1);
    expect(await application(quiet.application.id)).toMatchObject({
      effectiveStatus: 'CLOSED',
      statusSource: 'USER',
      decline: null,
    });
    expect((await application(quiet.application.id)).closedAfterDeclineAt).not.toBeNull();
    expect(await application(busy.application.id)).toMatchObject({
      effectiveStatus: 'INTERVIEW',
      decline: { closesAt: null },
    });
    // Run again: nothing more.
    expect(await closeDueDeclines()).toBe(0);
  });

  it('never asks for an application already Rejected or Closed', async () => {
    const { application: job } = await interviewThread('t-rejected');
    await prisma.application.update({ where: { id: job.id }, data: { aiStatus: 'REJECTED' } });
    await replyRead('t-rejected', at(15), (ids) => ({
      asks: ids.map((id) => ({ id, outcome: 'DECLINED' })),
      leavesJob: true,
    }));
    expect(
      (await prisma.application.findUniqueOrThrow({ where: { id: job.id } })).declinedAt,
    ).toBeNull();
  });
});

describe('a reply that asks them a question (owner, 17 Nov 2026)', () => {
  it('waits for their reply, then the step needs action again', async () => {
    const { ask } = await interviewThread('t-asked');
    vi.mocked(fetchMessageBody).mockResolvedValue('Before I confirm: is the interview remote?');
    const sent = await replyRead('t-asked', at(15), (ids) => ({
      asks: ids.map((id) => ({ id, outcome: 'ASKED_BACK' })),
      leavesJob: false,
    }));
    expect(
      (await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: sent.id } })).replyReadState,
    ).toBe('ASKED_BACK');
    expect((await conversation('t-asked')).request).toMatchObject({
      emailId: ask.id,
      state: 'REPLIED',
      replyRead: 'ASKED_BACK',
      repliedAt: at(15).toISOString(),
    });
    // Not under Needs action.
    const open = await request(app).get('/api/conversations?request=open').set(HEADERS);
    expect(open.body.items.map((c: { key: string }) => c.key)).not.toContain('t-asked');

    // Their answer asks nothing new: the first ask stands again.
    await receivedMail('t-asked', at(16));
    expect((await conversation('t-asked')).request).toMatchObject({
      emailId: ask.id,
      state: 'OPEN',
      replyRead: 'THEY_ANSWERED',
      theyAnsweredAt: at(16).toISOString(),
    });
    const again = await request(app).get('/api/conversations?request=open').set(HEADERS);
    expect(again.body.items.map((c: { key: string }) => c.key)).toContain('t-asked');
  });

  it('counts their answer even when the AI sorted it out of Job mails', async () => {
    await interviewThread('t-short');
    await replyRead('t-short', at(15), (ids) => ({
      asks: ids.map((id) => ({ id, outcome: 'ASKED_BACK' })),
      leavesJob: false,
    }));
    await receivedMail('t-short', at(16), { notJobMail: true });
    expect((await conversation('t-short')).request).toMatchObject({
      state: 'OPEN',
      replyRead: 'THEY_ANSWERED',
      theyAnsweredAt: at(16).toISOString(),
    });
  });

  it('shows the application step as replied until their answer', async () => {
    const { application: job } = await interviewThread('t-asked-app');
    await replyRead('t-asked-app', at(15), (ids) => ({
      asks: ids.map((id) => ({ id, outcome: 'ASKED_BACK' })),
      leavesJob: false,
    }));
    const steps = async () =>
      (await request(app).get(`/api/applications/${job.id}/actions`).set(HEADERS)).body.items;
    expect((await steps())[0]).toMatchObject({ repliedAt: at(15).toISOString() });
    await receivedMail('t-asked-app', at(16), { applicationId: job.id });
    expect((await steps())[0]).toMatchObject({ repliedAt: null });
  });

  it('a new ask in their answer becomes the step', async () => {
    await interviewThread('t-new-ask');
    await replyRead('t-new-ask', at(15), (ids) => ({
      asks: ids.map((id) => ({ id, outcome: 'ASKED_BACK' })),
      leavesJob: false,
    }));
    const next = await receivedMail('t-new-ask', at(16), {
      actionRequired: true,
      requestedAction: 'Send the link to your portfolio',
    });
    expect((await conversation('t-new-ask')).request).toMatchObject({
      emailId: next.id,
      state: 'OPEN',
      replyRead: null,
    });
  });
});

describe('Read my reply again (owner, 19 Nov 2026)', () => {
  const readAgain = (key: string) =>
    request(app).post(`/api/conversations/${key}/read-reply-again`).set(HEADERS).send({});

  it('reads a reply that older rules read as "does not answer" with today\'s rules', async () => {
    const { ask } = await interviewThread('t-again');
    // Read before reply-read/v2: read, and the ask stayed open.
    const sent = await prisma.outgoingEmail.create({
      data: {
        userId: owner,
        gmailMessageId: `sent-${++counter}`,
        threadId: 't-again',
        sentAt: at(15),
        replyReadState: 'READ',
        replyReadVersion: 'reply-read/v1',
        replyReadTries: 2,
      },
    });
    expect((await conversation('t-again')).request).toMatchObject({
      state: 'OPEN',
      replyRead: 'NOT_ANSWERED',
    });

    const res = await readAgain('t-again');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reading: true });
    expect(await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({
      replyReadState: 'WAITING',
      replyReadTries: 0,
    });
    expect(vi.mocked(enqueueReplyReading)).toHaveBeenCalledWith(owner, sent.id);
    expect((await conversation('t-again')).request).toMatchObject({ replyRead: 'WAITING' });

    vi.mocked(fetchMessageBody).mockResolvedValue('Before I confirm: is the interview remote?');
    vi.mocked(createProviderClient).mockReturnValue(
      fakeProviderClient({
        extraction: (input: string) => ({
          asks: (JSON.parse(input) as { openAsks: { id: string }[] }).openAsks.map((a) => ({
            id: a.id,
            outcome: 'ASKED_BACK',
          })),
          leavesJob: false,
        }),
      }),
    );
    expect(await readSentReply(owner, sent.id)).toBeNull();
    expect((await conversation('t-again')).request).toMatchObject({
      emailId: ask.id,
      state: 'REPLIED',
      replyRead: 'ASKED_BACK',
    });
  });

  it("says there is nothing to read without a reply, or once it is read with today's rules", async () => {
    await interviewThread('t-none');
    const none = await readAgain('t-none');
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NOTHING_TO_READ');

    vi.mocked(fetchMessageBody).mockResolvedValue('Is the interview remote?');
    await replyRead('t-none', at(15), (ids) => ({
      asks: ids.map((id) => ({ id, outcome: 'ASKED_BACK' })),
      leavesJob: false,
    }));
    const queued = vi.mocked(enqueueReplyReading).mock.calls.length;
    expect((await readAgain('t-none')).status).toBe(409);
    expect(vi.mocked(enqueueReplyReading).mock.calls.length).toBe(queued);
  });
});
