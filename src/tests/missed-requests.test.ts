import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

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
  type Conversation,
} from '../contracts';
import { matchEmailToApplication } from '../services/matcher';
import { missedSince, type RequestClock } from '../services/missedRequests';
import { deliverActionNotification } from '../services/notifications/delivery';

const OWNER = 'owner@missed.test';
let owner: string;
let counter = 0;
let server: Server;

const as = { 'X-Development-User': OWNER };
/** A moment in November 2026 (UTC). */
const at = (day: number, hour = 9, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute));
const DAY = 24 * 60 * 60 * 1000;

type Analysis = {
  companyName?: string;
  actionRequired?: boolean;
  requestedAction?: string;
  actionDeadline?: string;
  askKind?: 'REPLY_BY_MAIL' | 'OUTSIDE_MAIL';
};
const ask = (requestedAction: string, actionDeadline?: string): Analysis => ({
  actionRequired: true,
  requestedAction,
  ...(actionDeadline ? { actionDeadline } : {}),
});

/** A job mail as the pipeline leaves it before any application exists. */
const jobMail = (threadId: string, receivedAt: Date, analysis: Analysis = {}) =>
  prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: `missed-${++counter}`,
      threadId,
      subject: 'About your application',
      sender: 'Recruiter <recruiter@example.com>',
      receivedAt,
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      aiProcessingResult: {
        create: {
          provider: 'fixture',
          model: 'fixture',
          contractVersion: 'extraction/v8',
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          category: 'RECRUITER',
          companyName: 'Acme',
          ...analysis,
        },
      },
    },
  });

/** The user's own message in a thread; `read`: what the AI made of it. */
const sent = (threadId: string, sentAt: Date, read: 'READ' | 'NOT_READ' | null = null) =>
  prisma.outgoingEmail.create({
    data: {
      userId: owner,
      gmailMessageId: `missed-sent-${++counter}`,
      threadId,
      sentAt,
      replyReadState: read,
    },
  });

async function list(query = ''): Promise<Conversation[]> {
  const res = await request(server).get(`/api/conversations${query}`).set(as);
  expect(res.status).toBe(200);
  return ListConversationsResponseSchema.parse(res.body).items;
}
const keys = async (query: string) => (await list(query)).map((item) => item.key);
async function summary() {
  const res = await request(server).get('/api/conversations/summary').set(as);
  return ConversationSummarySchema.parse(res.body);
}
const stillOpen = (key: string, emailId: string) =>
  request(server)
    .patch(`/api/conversations/${key}/request`)
    .set(as)
    .send({ emailId, state: 'OPEN' });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(1));
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
});
beforeEach(async () => {
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.outgoingEmail.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
  await prisma.notSubmittedJob.deleteMany({ where: { userId: owner } });
});
afterAll(async () => {
  vi.useRealTimers();
  await new Promise((resolve) => server.close(resolve));
  await prisma.user.deleteMany({ where: { id: owner } });
});

describe('the Missed rule', () => {
  const clock = (fields: Partial<RequestClock>): RequestClock => ({
    receivedAt: at(1),
    deadline: null,
    deadlinePrecision: null,
    keptOpenAt: null,
    lastMailAt: at(1),
    lastSentAt: null,
    ...fields,
  });

  it('is one day after a deadline: after its time, or after the end of a date-only day', () => {
    expect(
      missedSince(
        clock({ deadline: new Date('2026-11-17T05:30:00Z'), deadlinePrecision: 'DATETIME' }),
      ),
    ).toEqual({ reason: 'DEADLINE_PASSED', since: new Date('2026-11-18T05:30:00Z') });
    expect(
      missedSince(clock({ deadline: new Date('2026-11-17T00:00:00Z'), deadlinePrecision: 'DATE' })),
    ).toEqual({ reason: 'DEADLINE_PASSED', since: new Date('2026-11-19T00:00:00Z') });
  });

  it('with a deadline, nothing in the thread moves it; only "Still open" after it does', () => {
    const due = { deadline: new Date('2026-11-17T00:00:00Z'), deadlinePrecision: 'DATE' as const };
    expect(missedSince(clock({ ...due, lastMailAt: at(25), lastSentAt: at(26) }))?.reason).toBe(
      'DEADLINE_PASSED',
    );
    // Opened again before the deadline: the deadline still counts.
    expect(missedSince(clock({ ...due, keptOpenAt: at(10) }))?.reason).toBe('DEADLINE_PASSED');
    expect(missedSince(clock({ ...due, keptOpenAt: at(20) }))).toEqual({
      reason: 'QUIET',
      since: new Date(at(20).getTime() + 7 * DAY),
    });
  });

  it('with no deadline, is 7 days after the last thing in the thread', () => {
    expect(missedSince(clock({}))).toEqual({ reason: 'QUIET', since: at(8) });
    expect(missedSince(clock({ lastMailAt: at(5) }))).toEqual({ reason: 'QUIET', since: at(12) });
    expect(missedSince(clock({ keptOpenAt: at(8), lastSentAt: at(3) }))).toEqual({
      reason: 'QUIET',
      since: at(15),
    });
  });

  it('with no deadline, is 7 days after the user’s own reply when nothing came after it', () => {
    expect(missedSince(clock({ lastSentAt: at(6) }))).toEqual({
      reason: 'NO_ANSWER',
      since: at(13),
    });
    expect(missedSince(clock({ lastSentAt: at(6), lastMailAt: at(7) }))).toEqual({
      reason: 'QUIET',
      since: at(14),
    });
  });

  it('never misses a request with no date at all', () => {
    expect(missedSince(clock({ receivedAt: null, lastMailAt: null }))).toBeNull();
  });
});

describe('a missed request in the Mails lists', () => {
  it('leaves Needs action a day after its deadline, and is listed under Missed', async () => {
    const mail = await jobMail('survey', at(11), ask('Fill the survey', '2026-11-17 05:30:00 GMT'));
    await jobMail('quiet', at(16));

    vi.setSystemTime(at(17, 12));
    expect(await keys('?request=open')).toEqual(['survey']);
    expect(await summary()).toEqual({ needsAction: 1, pastDue: 1, missed: 0 });
    expect(await keys('')).toEqual(['survey', 'quiet']);

    vi.setSystemTime(at(18, 6));
    expect(await keys('?request=open')).toEqual([]);
    expect(await keys('?request=missed')).toEqual(['survey']);
    expect(await summary()).toEqual({ needsAction: 0, pastDue: 0, missed: 1 });
    // Not first any more: a missed request is not what needs the user.
    expect(await keys('')).toEqual(['quiet', 'survey']);
    const [row] = await list('?request=missed');
    expect(row.request).toMatchObject({
      emailId: mail.id,
      state: 'OPEN',
      deadline: '2026-11-17T05:30:00.000Z',
      deadlinePrecision: 'DATETIME',
      missed: { reason: 'DEADLINE_PASSED', since: '2026-11-18T05:30:00.000Z' },
    });
    const detail = await request(server).get('/api/conversations/survey').set(as);
    expect(ConversationDetailSchema.parse(detail.body).conversation.request?.missed).toEqual({
      reason: 'DEADLINE_PASSED',
      since: '2026-11-18T05:30:00.000Z',
    });
  });

  it('gives each mail its deadline as a date, and only the words when they are unclear', async () => {
    await jobMail(
      'dated',
      at(11),
      ask('Fill the survey', 'Tuesday, Nov 17, 2026 05:30:00 AM +0000 GMT'),
    );
    await jobMail('dated', at(12), ask('Fill the survey', 'End of day, 20 Nov 2026'));
    await jobMail('dated', at(13), ask('Fill the survey', 'as soon as you can'));
    const detail = await request(server).get('/api/conversations/dated').set(as);
    const mails = ConversationDetailSchema.parse(detail.body).mails;
    expect(mails.map((mail) => [mail.actionDeadline, mail.actionDue, mail.followUpDue])).toEqual([
      [
        'Tuesday, Nov 17, 2026 05:30:00 AM +0000 GMT',
        { at: '2026-11-17T05:30:00.000Z', precision: 'DATETIME' },
        null,
      ],
      ['End of day, 20 Nov 2026', { at: '2026-11-20T00:00:00.000Z', precision: 'DATE' }, null],
      ['as soon as you can', null, null],
    ]);
  });

  it('with no deadline, leaves after 7 quiet days; a new mail in the thread starts them again', async () => {
    await jobMail('form', at(1), ask('Fill the form'));
    vi.setSystemTime(at(8, 8, 59));
    expect(await keys('?request=open')).toEqual(['form']);
    vi.setSystemTime(at(8, 9, 1));
    expect(await keys('?request=missed')).toEqual(['form']);
    expect((await list('?request=missed'))[0].request?.missed?.reason).toBe('QUIET');

    await jobMail('form', at(8, 9, 2));
    expect(await keys('?request=open')).toEqual(['form']);
    vi.setSystemTime(at(15, 9, 3));
    expect(await keys('?request=missed')).toEqual(['form']);
  });

  it('leaves 7 days after the user’s reply when they did not answer it', async () => {
    await jobMail('listing', at(14), ask('List your tool on our site'));
    await sent('listing', at(15), 'READ');
    vi.setSystemTime(at(22, 8));
    const [open] = await list('?request=open');
    expect(open.request).toMatchObject({ state: 'OPEN', replyRead: 'NOT_ANSWERED', missed: null });

    vi.setSystemTime(at(22, 10));
    const [missed] = await list('?request=missed');
    expect(missed.request).toMatchObject({
      state: 'OPEN',
      replyRead: 'NOT_ANSWERED',
      missed: { reason: 'NO_ANSWER', since: at(22).toISOString() },
    });
    expect(await summary()).toMatchObject({ needsAction: 0, missed: 1 });
  });

  it('keeps Replied and Done as they are, however old', async () => {
    await jobMail('replied', at(1), ask('Send your CV'));
    await sent('replied', at(2));
    const done = await jobMail('done', at(1), ask('Fill the form', '2026-11-03'));
    await prisma.email.update({
      where: { id: done.id },
      data: { requestUserState: 'DONE', requestClosedReason: 'YOU_SAID_DONE' },
    });
    vi.setSystemTime(at(28));
    expect(await keys('?request=replied')).toEqual(['replied']);
    expect(await keys('?request=done')).toEqual(['done']);
    expect(await summary()).toEqual({ needsAction: 0, pastDue: 0, missed: 0 });
  });

  it('"Still open" brings it back for 7 days, and each new mail starts them again', async () => {
    const mail = await jobMail('survey', at(1), ask('Fill the survey', '7 Nov 2026'));
    vi.setSystemTime(at(20));
    expect(await keys('?request=missed')).toEqual(['survey']);

    const res = await stillOpen('survey', mail.id);
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ state: 'OPEN', missed: null });
    expect(await summary()).toEqual({ needsAction: 1, pastDue: 1, missed: 0 });

    vi.setSystemTime(new Date(at(20).getTime() + 7 * DAY - 60_000));
    expect(await keys('?request=open')).toEqual(['survey']);
    vi.setSystemTime(new Date(at(20).getTime() + 7 * DAY + 60_000));
    expect((await list('?request=missed'))[0].request?.missed?.reason).toBe('QUIET');
  });
});

describe('a missed step of an application', () => {
  async function linkedAsk() {
    const application = await prisma.application.create({
      data: { userId: owner, companyName: 'Acme', aiStatus: 'INTERVIEW' },
    });
    const mail = await jobMail('survey', at(11), {
      ...ask('Fill the survey', '2026-11-17'),
      askKind: 'OUTSIDE_MAIL',
    });
    await matchEmailToApplication(mail.id);
    const step = await prisma.action.findFirstOrThrow({ where: { emailId: mail.id } });
    return { application, mail, step };
  }
  const toDo = async (id: string) =>
    (await request(server).get(`/api/applications/${id}`).set(as)).body.pendingActionCount;

  it('is not in the to-do count, and every list of steps says it is missed', async () => {
    const { application, step } = await linkedAsk();
    vi.setSystemTime(at(18));
    expect(await toDo(application.id)).toBe(1);

    vi.setSystemTime(at(19, 1));
    expect(await toDo(application.id)).toBe(0);
    const apps = await request(server).get('/api/applications').set(as);
    expect(apps.body.items[0].pendingActionCount).toBe(0);
    const missed = { reason: 'DEADLINE_PASSED', since: '2026-11-19T00:00:00.000Z' };
    for (const path of [
      '/api/actions?status=PENDING',
      `/api/applications/${application.id}/actions`,
    ]) {
      const res = await request(server).get(path).set(as);
      expect(res.body.items).toMatchObject([{ id: step.id, status: 'PENDING', missed }]);
    }
  });

  it('"Still open" on the step brings the step and its mail back', async () => {
    const { application, step } = await linkedAsk();
    vi.setSystemTime(at(25));
    const res = await request(server)
      .patch(`/api/actions/${step.id}`)
      .set(as)
      .send({ status: 'PENDING' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PENDING', missed: null });
    expect(await toDo(application.id)).toBe(1);
    expect(await keys('?request=open')).toEqual(['survey']);
  });

  it('sends no alert, while a step that still needs action does', async () => {
    const { step, application } = await linkedAsk();
    const fresh = await jobMail('fresh', at(18), ask('Send your CV'));
    await matchEmailToApplication(fresh.id);
    const open = await prisma.action.findFirstOrThrow({ where: { emailId: fresh.id } });
    expect(open.applicationId).toBe(application.id);
    process.env.DISCORD_USER_ID = owner;
    const provider = { send: vi.fn().mockResolvedValue({ success: true, retryable: false }) };
    vi.setSystemTime(at(19, 1));

    await deliverActionNotification(step.id, provider);
    expect(provider.send).not.toHaveBeenCalled();
    await deliverActionNotification(open.id, provider);
    expect(provider.send).toHaveBeenCalledTimes(1);
    delete process.env.DISCORD_USER_ID;
  });
});

describe('Missed on the Dashboard', () => {
  const dashboard = async () => {
    const res = await request(server).get('/api/dashboard?period=30d&timeZone=UTC').set(as);
    expect(res.status).toBe(200);
    return DashboardResponseSchema.parse(res.body);
  };

  it('counts missed requests apart from Needs action', async () => {
    await jobMail('survey', at(11), ask('Fill the survey', '2026-11-17'));
    await jobMail('form', at(25), ask('Fill the interest form'));
    vi.setSystemTime(at(26));
    expect((await dashboard()).now.needsAction).toMatchObject({ count: 1, missed: 1 });
    expect(await summary()).toMatchObject({ needsAction: 1, missed: 1 });
  });

  it('a job NorthList Apply left for the user is missed after 7 days', async () => {
    const left = (ref: string, loggedAt: Date, outcome: 'NEEDS_USER' | 'SKIPPED') =>
      prisma.notSubmittedJob.create({
        data: {
          userId: owner,
          source: 'AUTOMATION',
          sourceRecordRef: ref,
          outcome,
          platform: 'linkedin',
          company: 'Acme',
          jobTitle: 'Engineer',
          reason: 'The form asks a question with no saved answer.',
          loggedAt,
        },
      });
    // Eight days ago: missed under the 7-day limit.
    await left('2026-11-18/10:00:00', at(18), 'NEEDS_USER');
    await left('2026-11-24/10:00:00', at(24), 'NEEDS_USER');
    await left('2026-11-05/10:00:00', at(5), 'SKIPPED');
    vi.setSystemTime(at(26));

    const jobs = await request(server).get('/api/submissions/not-submitted').set(as);
    expect(
      jobs.body.items.map((job: { outcome: string; missed: boolean }) => [job.outcome, job.missed]),
    ).toEqual([
      ['NEEDS_USER', false],
      ['NEEDS_USER', true],
      ['SKIPPED', false],
    ]);
    expect((await dashboard()).automation).toMatchObject({
      lookedAt: 3,
      skipped: 1,
      needsYou: 1,
      missed: 1,
    });
  });
});
