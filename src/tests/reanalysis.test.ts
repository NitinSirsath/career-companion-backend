import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
  enqueueReplyReading: vi.fn(),
  enqueueReanalysis: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { ConversationDetailSchema, ReanalysisRunSchema } from '../contracts';
import { closeDueDeclines } from '../services/applicationDecline';
import { FAKE_OFFER_NEXT_STEP } from '../services/emailRequest';
import { enqueueNotificationJob } from '../services/enqueue';
import { runReanalysis } from '../services/reanalysis';
import { configureAI } from './helpers/aiAccess';
import {
  fakeAI,
  fakeGmail,
  gmailError,
  jobMail as mailOf,
  mailbox,
  sentReply as replyOf,
  toDo,
  type MailOptions,
} from './helpers/reanalysisFixtures';

const OWNER = 'owner@reanalysis.test';
const HEADERS = { 'X-Development-User': OWNER };
const DAY = 24 * 60 * 60 * 1000;
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour));
let owner: string;

const jobMail = (threadId: string, receivedAt: Date, o: MailOptions = {}) =>
  mailOf(owner, threadId, receivedAt, o);
const sentReply = (threadId: string, sentAt: Date, o: Parameters<typeof replyOf>[3] = {}) =>
  replyOf(owner, threadId, sentAt, o);
const job = (data: Record<string, unknown> = {}) =>
  prisma.application.create({
    data: { userId: owner, companyName: 'Brightwave', jobTitle: 'Frontend Engineer', ...data },
  });
const mailNow = (id: string) => prisma.email.findUniqueOrThrow({ where: { id } });
const resultOf = (emailId: string) =>
  prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId } });

/** Starts a Reanalyze from the mail page and runs its job now. */
async function reanalyze(key: string) {
  const res = await request(app).post(`/api/conversations/${key}/reanalyze`).set(HEADERS).send({});
  expect(res.status).toBe(202);
  const run = ReanalysisRunSchema.parse(res.body);
  await runReanalysis(owner, run.id);
  return prisma.reanalysisRun.findUniqueOrThrow({ where: { id: run.id } });
}

const conversation = async (key: string) => {
  const res = await request(app).get(`/api/conversations/${key}`).set(HEADERS);
  expect(res.status).toBe(200);
  return ConversationDetailSchema.parse(res.body).conversation;
};

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  await prisma.gmailConnection.create({
    data: { userId: owner, gmailEmail: OWNER, status: 'CONNECTED', accessToken: 'x' },
  });
});
beforeEach(async () => {
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  delete process.env.AGENDA_EXTRACTION_V3_ENABLED;
  await configureAI(owner);
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.outgoingEmail.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
  await prisma.reanalysisRun.deleteMany({ where: { userId: owner } });
  await prisma.aIUsageDay.deleteMany({ where: { userId: owner } });
  await prisma.aIModelPause.deleteMany({ where: { userId: owner } });
  vi.mocked(enqueueNotificationJob).mockClear();
  fakeGmail();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
});

describe("the AI reads again with today's rules (traps 1-6)", () => {
  it('calls the AI instead of reusing the saved answer, and keeps one ledger row with its times', async () => {
    const offer = await job({ aiStatus: 'OFFER' });
    const mail = await jobMail('t-read', at(10), {
      applicationId: offer.id,
      category: 'OFFER',
      offerInfo: 'An offer letter',
    });
    await prisma.statusChange.create({
      data: {
        applicationId: offer.id,
        emailId: mail.id,
        source: 'AI',
        toStatus: 'OFFER',
        changedAt: at(10),
      },
    });
    const ai = fakeAI({ type: () => 'INTERVIEW', read: () => ({ interviewDate: '2026-11-18' }) });

    const run = await reanalyze('t-read');

    expect(run).toMatchObject({ state: 'SAVED', savedKeys: ['t-read'], stopReason: null });
    expect(ai).toHaveBeenCalledTimes(2);
    expect(await resultOf(mail.id)).toMatchObject({
      contractVersion: 'extraction/v8',
      category: 'INTERVIEW',
      offerInfo: null,
      interviewDate: '2026-11-18',
    });
    const ledger = await prisma.aIOperation.findMany({
      where: { emailId: mail.id, operation: 'extraction' },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      version: 'extraction/v8',
      status: 'COMPLETED',
      startedAt: at(10),
    });
    expect(ledger[0].completedAt).toEqual(at(10));
    // The status may go down: the old "Offer" read is gone from the Dashboard history too.
    expect((await prisma.application.findUniqueOrThrow({ where: { id: offer.id } })).aiStatus).toBe(
      'INTERVIEW',
    );
    const history = await prisma.statusChange.findMany({
      where: { applicationId: offer.id, retiredAt: null },
    });
    expect(history).toEqual([
      expect.objectContaining({ toStatus: 'INTERVIEW', changedAt: at(10), emailId: mail.id }),
    ]);
  });

  it("keeps a job mail a job mail, and its type, when today's first check would drop it", async () => {
    const mail = await jobMail('t-keep', at(10), { category: 'RECRUITER' });
    fakeAI({ type: () => 'NOT_JOB' });
    expect(await reanalyze('t-keep')).toMatchObject({ state: 'SAVED' });
    expect(await mailNow(mail.id)).toMatchObject({ relevanceState: 'RELEVANT' });
    expect(await resultOf(mail.id)).toMatchObject({ category: 'RECRUITER' });
  });

  it('saves nothing when one read fails, and leaves no held mail', async () => {
    const first = await jobMail('t-fail', at(10), { ask: 'Send your portfolio', text: 'first' });
    const second = await jobMail('t-fail', at(11), { text: 'second' });
    const before = await resultOf(first.id);
    fakeAI({
      read: ({ body }) =>
        body === 'second' ? { askKind: 'NOT_A_KIND' } : { companyName: 'Changed' },
    });

    const run = await reanalyze('t-fail');

    expect(run).toMatchObject({ state: 'STOPPED', stopReason: 'FAILED', savedKeys: [] });
    expect(await resultOf(first.id)).toEqual(before);
    expect(await resultOf(second.id)).toMatchObject({ contractVersion: 'extraction/v6' });
    expect(
      await prisma.aIOperation.count({
        where: { emailId: { in: [first.id, second.id] }, status: { not: 'COMPLETED' } },
      }),
    ).toBe(0);
  });
});

describe('steps, replies and their order (traps 7-13)', () => {
  it('reads a decline in an old reply: the step closes and "Close the application?" gets 3 days from now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(19, 12));
    const interview = await job({ aiStatus: 'INTERVIEW' });
    const ask = await jobMail('t-decline', at(13), {
      applicationId: interview.id,
      ask: 'Confirm one of the interview times',
    });
    const todo = await toDo(interview.id, ask.id, 'Confirm one of the interview times');
    const sent = await sentReply('t-decline', at(15), {
      text: 'I have accepted another offer, so I withdraw from the process.',
    });
    fakeAI({
      read: () => ({
        actionRequired: true,
        requestedAction: 'Confirm one of the interview times',
        askKind: 'REPLY_BY_MAIL',
      }),
      reply: ({ openAsks }) => ({
        asks: openAsks.map((open) => ({ id: open.id, outcome: 'DECLINED' as const })),
        leavesJob: true,
      }),
    });

    await reanalyze('t-decline');

    expect(await mailNow(ask.id)).toMatchObject({
      requestClosedReason: 'YOU_DECLINED',
      requestClosedByMessageId: sent.gmailMessageId,
      requestClosedAt: at(15),
    });
    expect(await prisma.action.findUniqueOrThrow({ where: { id: todo.id } })).toMatchObject({
      status: 'COMPLETED',
      actionRevision: 1,
    });
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: interview.id } }),
    ).toMatchObject({
      declinedAt: at(15),
      declineNotedAt: at(19, 12),
      declineAnswer: null,
    });
    expect((await conversation('t-decline')).application?.decline).toEqual({
      repliedAt: at(15).toISOString(),
      closesAt: new Date(at(19, 12).getTime() + 3 * DAY).toISOString(),
    });
    expect(await closeDueDeclines()).toBe(0);
    vi.setSystemTime(at(22, 13));
    expect(await closeDueDeclines()).toBe(1);
  });

  it("opens again a step a mail closed when today's read no longer closes it, with no alert", async () => {
    const work = await job();
    const ask = await jobMail('t-reopen', at(10), {
      applicationId: work.id,
      ask: 'Send your portfolio',
      askKind: 'OUTSIDE_MAIL',
      text: 'asks',
    });
    const later = await jobMail('t-reopen', at(12), { applicationId: work.id, text: 'later' });
    await prisma.email.update({
      where: { id: ask.id },
      data: {
        requestClosedReason: 'REPLACED_BY_MAIL',
        requestClosedAt: at(12),
        requestClosedByMessageId: later.gmailMessageId,
      },
    });
    const todo = await toDo(
      work.id,
      ask.id,
      'Send your portfolio, then tell them you did',
      'COMPLETED',
    );
    fakeAI({
      read: ({ body }) =>
        body === 'asks'
          ? {
              actionRequired: true,
              requestedAction: 'Send your portfolio',
              askKind: 'OUTSIDE_MAIL',
            }
          : {},
    });

    await reanalyze('t-reopen');

    expect(await mailNow(ask.id)).toMatchObject({
      requestClosedReason: null,
      requestClosedByMessageId: null,
    });
    expect(await prisma.action.findUniqueOrThrow({ where: { id: todo.id } })).toMatchObject({
      status: 'PENDING',
      actionRevision: 1,
    });
    expect(
      await prisma.notificationDelivery.count({
        where: { actionId: todo.id, errorDetails: 'USER_SUPPRESSED' },
      }),
    ).toBeGreaterThan(0);
    expect(enqueueNotificationJob).not.toHaveBeenCalled();
    expect((await conversation('t-reopen')).request).toMatchObject({ state: 'OPEN' });
  });

  it('gives each read the steps open at its time: a reply sees the ask a later mail closed', async () => {
    const ask = await jobMail('t-order', at(10), {
      ask: 'Reply with your free times',
      text: 'asks',
    });
    const sent = await sentReply('t-order', at(11), { state: 'READ', text: 'Monday 10:00 works.' });
    const later = await jobMail('t-order', at(12), { text: 'later' });
    const seen: number[] = [];
    fakeAI({
      read: ({ body, openAsks }) => {
        if (body === 'later')
          return { closedAsks: openAsks.map((a) => ({ id: a.id, reason: 'REPLACED' as const })) };
        return {
          actionRequired: true,
          requestedAction: 'Reply with your free times',
          askKind: 'REPLY_BY_MAIL',
        };
      },
      reply: ({ openAsks }) => {
        seen.push(openAsks.length);
        return {
          asks: openAsks.map((a) => ({ id: a.id, outcome: 'ANSWERED' as const })),
          leavesJob: false,
        };
      },
    });

    await reanalyze('t-order');

    expect(seen).toEqual([1]);
    expect(await mailNow(ask.id)).toMatchObject({
      requestClosedReason: 'YOUR_REPLY',
      requestClosedByMessageId: sent.gmailMessageId,
    });
    expect(later.id).toBeTruthy();
  });

  it('keeps what the user did: "I did this", a reopen after a mail, and their own status', async () => {
    const work = await job({
      userStatus: 'ASSESSMENT',
      userStatusSetAt: at(9),
      userStatusRevision: 1,
    });
    const done = await jobMail('t-user', at(10), {
      applicationId: work.id,
      ask: 'Fill in the form',
      askKind: 'OUTSIDE_MAIL',
      text: 'form',
      requestUserState: 'DONE',
      requestUserStateAt: at(11),
      closed: { reason: 'YOU_SAID_DONE', by: null, at: at(11) },
    });
    const reopened = await jobMail('t-user', at(12), {
      applicationId: work.id,
      ask: 'Pick a time',
      text: 'pick',
      requestUserState: 'OPEN',
      requestUserStateAt: at(14),
    });
    await jobMail('t-user', at(13), { applicationId: work.id, text: 'closer' });
    fakeAI({
      read: ({ body, openAsks }) => {
        if (body === 'closer')
          return { closedAsks: openAsks.map((a) => ({ id: a.id, reason: 'REPLACED' as const })) };
        return body === 'form'
          ? { actionRequired: true, requestedAction: 'Fill in the form', askKind: 'OUTSIDE_MAIL' }
          : { actionRequired: true, requestedAction: 'Pick a time', askKind: 'REPLY_BY_MAIL' };
      },
    });

    await reanalyze('t-user');

    expect(await mailNow(done.id)).toMatchObject({
      requestClosedReason: 'YOU_SAID_DONE',
      requestUserState: 'DONE',
    });
    expect(await mailNow(reopened.id)).toMatchObject({
      requestClosedReason: null,
      requestUserState: 'OPEN',
    });
    expect(await prisma.application.findUniqueOrThrow({ where: { id: work.id } })).toMatchObject({
      userStatus: 'ASSESSMENT',
      userStatusRevision: 1,
    });
  });

  it("closes, as the application closed, a new step from a mail older than the user's Rejected", async () => {
    const rejected = await job({
      userStatus: 'REJECTED',
      userStatusSetAt: at(16),
      userStatusRevision: 1,
    });
    const mail = await jobMail('t-closed', at(10), { applicationId: rejected.id });
    fakeAI({
      read: () => ({
        actionRequired: true,
        requestedAction: 'Send references',
        askKind: 'OUTSIDE_MAIL',
      }),
    });

    await reanalyze('t-closed');

    expect(await mailNow(mail.id)).toMatchObject({
      requestClosedReason: 'APPLICATION_CLOSED',
      requestClosedAt: at(16),
    });
    expect(await prisma.action.findFirstOrThrow({ where: { emailId: mail.id } })).toMatchObject({
      status: 'COMPLETED',
      description: 'Send references, then tell them you did',
    });
    expect((await conversation('t-closed')).request).toMatchObject({ state: 'DONE' });
  });
});

describe('to-dos, links and alerts (traps 14-17)', () => {
  it('updates an open to-do, leaves a finished one, and retires the to-do of a mail now flagged fake', async () => {
    const work = await job();
    const asks = await jobMail('t-todo', at(10), {
      applicationId: work.id,
      ask: 'Reply with times',
      text: 'asks',
    });
    const open = await toDo(work.id, asks.id, 'Reply with times');
    const fee = await jobMail('t-todo', at(11), {
      applicationId: work.id,
      ask: 'Pay the registration fee',
      text: 'fee',
    });
    const pay = await toDo(work.id, fee.id, 'Pay the registration fee');
    fakeAI({
      read: ({ body }) =>
        body === 'asks'
          ? {
              actionRequired: true,
              requestedAction: 'Reply with your free times by Friday',
              actionDeadline: '2026-11-21',
              askKind: 'REPLY_BY_MAIL',
            }
          : {
              actionRequired: true,
              requestedAction: 'Pay the registration fee',
              fakeOfferWarning: 'Asks for a fee',
              askKind: 'OUTSIDE_MAIL',
            },
    });

    await reanalyze('t-todo');

    const updated = await prisma.action.findUniqueOrThrow({ where: { id: open.id } });
    expect(updated).toMatchObject({
      status: 'PENDING',
      description: 'Reply with your free times by Friday',
      actionRevision: 1,
    });
    expect(updated.deadline).not.toBeNull();
    expect(await prisma.action.findUniqueOrThrow({ where: { id: pay.id } })).toMatchObject({
      retiredReason: 'REANALYZED',
      actionRevision: 1,
    });
    const convo = await conversation('t-todo');
    expect(convo.fakeOfferWarning).toBe('Asks for a fee');
    expect(convo.request?.text).toBe(FAKE_OFFER_NEXT_STEP);
  });

  it('never links a mail that was not linked, even when its company now matches', async () => {
    await job({ companyName: 'Northwind' });
    const mail = await jobMail('t-link', at(10), { companyName: 'Unknown' });
    fakeAI({ read: () => ({ companyName: 'Northwind' }) });
    await reanalyze('t-link');
    expect(await mailNow(mail.id)).toMatchObject({ matchState: 'UNMATCHED', applicationId: null });
  });

  it('makes a to-do for a new step without an alert', async () => {
    const work = await job();
    const mail = await jobMail('t-new', at(10), { applicationId: work.id });
    fakeAI({
      read: () => ({
        actionRequired: true,
        requestedAction: 'Book a slot',
        askKind: 'OUTSIDE_MAIL',
      }),
    });
    await reanalyze('t-new');
    const todo = await prisma.action.findFirstOrThrow({ where: { emailId: mail.id } });
    expect(todo).toMatchObject({
      status: 'PENDING',
      description: 'Book a slot, then tell them you did',
    });
    expect(
      await prisma.notificationDelivery.count({ where: { actionId: todo.id } }),
    ).toBeGreaterThan(0);
    expect(enqueueNotificationJob).not.toHaveBeenCalled();
  });
});

describe('Gmail and changes during a run (traps 23-28)', () => {
  it('keeps the old read, and what it closed, of a mail Gmail no longer has', async () => {
    const ask = await jobMail('t-gone', at(10), {
      ask: 'Send your portfolio',
      askKind: 'OUTSIDE_MAIL',
      text: 'asks',
    });
    const gone = await jobMail('t-gone', at(11), { text: 'gone' });
    await prisma.email.update({
      where: { id: ask.id },
      data: {
        requestClosedReason: 'CONFIRMED_BY_MAIL',
        requestClosedAt: at(11),
        requestClosedByMessageId: gone.gmailMessageId,
      },
    });
    mailbox.set(gone.gmailMessageId, gmailError(404));
    fakeAI({
      read: () => ({
        actionRequired: true,
        requestedAction: 'Send your portfolio',
        askKind: 'OUTSIDE_MAIL',
      }),
    });

    const run = await reanalyze('t-gone');

    expect(run).toMatchObject({ state: 'SAVED', gone: 1 });
    expect(await mailNow(ask.id)).toMatchObject({ requestClosedReason: 'CONFIRMED_BY_MAIL' });
    expect(await resultOf(gone.id)).toMatchObject({ contractVersion: 'extraction/v6' });
    expect(await resultOf(ask.id)).toMatchObject({ contractVersion: 'extraction/v8' });
  });

  it('stops before any AI read when Gmail is disconnected', async () => {
    const mail = await jobMail('t-gmail', at(10));
    mailbox.set(mail.gmailMessageId, gmailError(401));
    const ai = fakeAI({});
    const run = await reanalyze('t-gmail');
    expect(run).toMatchObject({ state: 'STOPPED', stopReason: 'GMAIL_DISCONNECTED' });
    expect(ai).not.toHaveBeenCalled();
  });

  it('saves nothing when a new mail comes in while it reads', async () => {
    const mail = await jobMail('t-new-mail', at(10));
    let added = false;
    fakeAI({
      read: async () => {
        if (!added) {
          added = true;
          await prisma.email.create({
            data: {
              userId: owner,
              gmailMessageId: 'ra-arrived',
              threadId: 't-new-mail',
              receivedAt: at(12),
            },
          });
        }
        return { companyName: 'Changed' };
      },
    });
    const run = await reanalyze('t-new-mail');
    expect(run).toMatchObject({ state: 'STOPPED', stopReason: 'NEW_ACTIVITY', savedKeys: [] });
    expect(await resultOf(mail.id)).toMatchObject({
      companyName: 'Brightwave',
      contractVersion: 'extraction/v6',
    });
  });

  it('saves nothing when the conversation is deleted while it reads', async () => {
    const mail = await jobMail('t-deleted', at(10));
    fakeAI({
      read: async () => {
        await prisma.email.update({
          where: { id: mail.id },
          data: { relevanceState: 'IRRELEVANT' },
        });
        return { companyName: 'Changed' };
      },
    });
    const run = await reanalyze('t-deleted');
    expect(run).toMatchObject({ state: 'STOPPED', stopReason: 'NEW_ACTIVITY' });
    expect(await resultOf(mail.id)).toMatchObject({ companyName: 'Brightwave' });
  });
});
