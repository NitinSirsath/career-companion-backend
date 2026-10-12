import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { enqueueNotificationJob } from '../services/enqueue';
import type { Conversation } from '../contracts';
import {
  ConversationDetailSchema,
  LinkConversationResponseSchema,
  ListConversationsResponseSchema,
} from '../contracts';

const OWNER = 'owner@conversation.test';
const OTHER = 'other@conversation.test';
let owner: string;
let other: string;
let counter = 0;

const as = (user: string) => ({ 'X-Development-User': user });
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 9, day, hour));

type Analysis = {
  category?: 'RECRUITER' | 'INTERVIEW' | 'ASSESSMENT' | 'OFFER' | 'REJECTION' | 'FOLLOW_UP';
  companyName?: string | null;
  jobTitle?: string | null;
  actionRequired?: boolean;
  requestedAction?: string;
  actionDeadline?: string;
  followUpRequired?: boolean;
  interviewDate?: string;
  interviewTime?: string;
};

/** A processed job email as the pipeline leaves it before any application exists. */
async function jobMail(
  threadId: string | null,
  receivedAt: Date,
  analysis: Analysis = {},
  extra: { userId?: string; subject?: string; sender?: string; seen?: boolean } = {},
) {
  return prisma.email.create({
    data: {
      userId: extra.userId ?? owner,
      gmailMessageId: `conversation-${++counter}`,
      threadId,
      subject: extra.subject ?? 'Your application',
      sender: extra.sender ?? 'Recruiter <recruiter@example.com>',
      receivedAt,
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      seenAt: extra.seen ? new Date() : null,
      aiProcessingResult: {
        create: {
          provider: 'gemini',
          model: 'test-model',
          contractVersion: 'extraction/v2',
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          companyName: 'Acme',
          jobTitle: 'Engineer',
          ...analysis,
        },
      },
    },
  });
}

const sent = (threadId: string, sentAt: Date, userId = owner) =>
  prisma.outgoingEmail.create({
    data: { userId, gmailMessageId: `sent-${++counter}`, threadId, sentAt },
  });

async function list(query = '', user = OWNER): Promise<Conversation[]> {
  const res = await request(app).get(`/api/conversations${query}`).set(as(user));
  expect(res.status).toBe(200);
  return ListConversationsResponseSchema.parse(res.body).items;
}
const detail = (key: string, user = OWNER) =>
  request(app).get(`/api/conversations/${key}`).set(as(user));
const answer = (key: string, body: object) =>
  request(app).patch(`/api/conversations/${key}/request`).set(as(OWNER)).send(body);
const link = (key: string, body: object = {}, user = OWNER) =>
  request(app).post(`/api/conversations/${key}/application`).set(as(user)).send(body);
const keys = (items: Conversation[]) => items.map((item) => item.key);

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [OWNER, OTHER] } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  vi.mocked(enqueueNotificationJob).mockClear();
  await prisma.email.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.outgoingEmail.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.application.deleteMany({ where: { userId: { in: [owner, other] } } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});

describe('conversation list', () => {
  it('shows one row per thread with the newest email and what it asks for', async () => {
    await jobMail('thread-a', at(1), { category: 'FOLLOW_UP' }, { subject: 'We got it' });
    await jobMail(
      'thread-a',
      at(3),
      {
        category: 'INTERVIEW',
        actionRequired: true,
        requestedAction: 'Send your available dates',
        actionDeadline: '2026-10-09',
      },
      { subject: 'Interview: first round' },
    );

    const [row, ...rest] = await list();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      key: 'thread-a',
      subject: 'Interview: first round',
      mailCount: 2,
      sentCount: 0,
      isNew: true,
      category: 'INTERVIEW',
      company: 'Acme',
      role: 'Engineer',
      link: 'UNLINKED',
      application: null,
      analyzedBy: { provider: 'gemini', model: 'test-model' },
    });
    expect(row.request).toMatchObject({
      state: 'OPEN',
      kind: 'ACTION',
      text: 'Send your available dates',
      deadline: '2026-10-09T00:00:00.000Z',
      deadlinePrecision: 'DATE',
      repliedAt: null,
    });
  });

  it('shows a request without any application, and no request when nothing is asked', async () => {
    await jobMail('asks', at(2), { actionRequired: true, requestedAction: 'Send resume' });
    await jobMail('informs', at(1), { category: 'REJECTION' });
    const rows = await list();
    expect(rows.find((row) => row.key === 'asks')?.request?.text).toBe('Send resume');
    expect(rows.find((row) => row.key === 'informs')?.request).toBeNull();
  });

  it('marks a request as replied once the user sent a later message in the thread', async () => {
    await jobMail('thread-r', at(2), { actionRequired: true, requestedAction: 'Send dates' });
    await sent('thread-r', at(1)); // sent before the request: not a reply to it
    expect((await list())[0].request?.state).toBe('OPEN');

    await sent('thread-r', at(3));
    const [row] = await list();
    expect(row.request).toMatchObject({ state: 'REPLIED', repliedAt: at(3).toISOString() });
    expect(row.sentCount).toBe(2);
  });

  it('asks again when a newer email makes a new request after the reply', async () => {
    await jobMail('thread-n', at(1), { actionRequired: true, requestedAction: 'Send dates' });
    await sent('thread-n', at(2));
    const newer = await jobMail('thread-n', at(3), {
      actionRequired: true,
      requestedAction: 'Confirm the slot',
    });
    const [row] = await list();
    expect(row.request).toMatchObject({
      emailId: newer.id,
      state: 'OPEN',
      text: 'Confirm the slot',
    });
  });

  it('lists open requests first, then newest first; `newest` ignores requests', async () => {
    await jobMail('old-open', at(1), { actionRequired: true, requestedAction: 'Send dates' });
    await jobMail('new-quiet', at(5));
    await jobMail('mid-quiet', at(3));
    expect(keys(await list())).toEqual(['old-open', 'new-quiet', 'mid-quiet']);
    expect(keys(await list('?sort=newest'))).toEqual(['new-quiet', 'mid-quiet', 'old-open']);
  });

  it('filters by request state, category, application, new mail and search text', async () => {
    await jobMail('open', at(5), { actionRequired: true, requestedAction: 'Send dates' });
    await jobMail('replied', at(4), { actionRequired: true, requestedAction: 'Send resume' });
    await sent('replied', at(6));
    await jobMail(
      'offer',
      at(3),
      { category: 'OFFER', companyName: 'Globex', jobTitle: 'Designer' },
      { seen: true, subject: 'Offer letter', sender: 'HR <hr@globex.example>' },
    );

    expect(keys(await list('?request=open'))).toEqual(['open']);
    expect(keys(await list('?request=replied'))).toEqual(['replied']);
    expect(keys(await list('?request=none'))).toEqual(['offer']);
    expect(keys(await list('?category=OFFER'))).toEqual(['offer']);
    expect(keys(await list('?unseen=true'))).toEqual(['open', 'replied']);
    expect(keys(await list('?application=none'))).toHaveLength(3);
    expect(keys(await list('?application=any'))).toHaveLength(0);
    expect(keys(await list('?q=globex'))).toEqual(['offer']);
    expect(keys(await list('?q=offer%20letter'))).toEqual(['offer']);
    expect(keys(await list('?q=designer'))).toEqual(['offer']);
    // % and _ are plain characters in a search, never wildcards.
    expect(keys(await list('?q=%25'))).toEqual([]);
    expect(keys(await list('?q=_'))).toEqual([]);
  });

  it('pages with the shared envelope', async () => {
    for (let day = 1; day <= 22; day++) await jobMail(`page-${day}`, at(day));
    const first = await request(app).get('/api/conversations').set(as(OWNER));
    expect(first.body.items).toHaveLength(20);
    expect(first.body.metadata).toEqual({ nextOffset: 20, limit: 20, offset: 0 });
    const second = await request(app).get('/api/conversations?offset=20').set(as(OWNER));
    expect(second.body.items).toHaveLength(2);
    expect(second.body.metadata.nextOffset).toBeNull();
  });

  it('leaves out irrelevant and unprocessed email, and other users', async () => {
    await jobMail('mine', at(1));
    await jobMail('theirs', at(2), {}, { userId: other });
    await prisma.email.create({
      data: {
        userId: owner,
        gmailMessageId: 'noise',
        threadId: 'noise',
        relevanceState: 'IRRELEVANT',
      },
    });
    await prisma.email.create({
      data: { userId: owner, gmailMessageId: 'waiting', threadId: 'waiting' },
    });
    expect(keys(await list())).toEqual(['mine']);
    expect(keys(await list('', OTHER))).toEqual(['theirs']);
  });

  it('treats an email without a Gmail thread as its own conversation', async () => {
    const lone = await jobMail(null, at(1));
    expect(keys(await list())).toEqual([lone.id]);
    expect((await detail(lone.id)).status).toBe(200);
  });

  it('rejects an unknown filter value and requires a session', async () => {
    expect((await request(app).get('/api/conversations?request=later').set(as(OWNER))).status).toBe(
      400,
    );
    expect((await request(app).get('/api/conversations')).status).toBe(401);
  });
});

describe('conversation detail', () => {
  it('returns each email oldest first with what the AI read, and the reply times', async () => {
    await jobMail('thread-d', at(1), { category: 'FOLLOW_UP' }, { subject: 'First' });
    await jobMail(
      'thread-d',
      at(4),
      { category: 'INTERVIEW', interviewDate: '2026-10-12', interviewTime: '15:00' },
      { subject: 'Second' },
    );
    await sent('thread-d', at(2));

    const res = await detail('thread-d');
    expect(res.status).toBe(200);
    const body = ConversationDetailSchema.parse(res.body);
    expect(body.mails.map((mail) => mail.subject)).toEqual(['First', 'Second']);
    expect(body.mails[1]).toMatchObject({ interviewDate: '2026-10-12', interviewTime: '15:00' });
    expect(body.sentAt).toEqual([at(2).toISOString()]);
    expect(body.conversation.interview).toEqual({ date: '2026-10-12', time: '15:00' });
    // No email text is part of the response.
    expect(JSON.stringify(res.body)).not.toMatch(/"(body|text|html|snippet)"/);
  });

  it('opens a conversation by the ID of one of its emails', async () => {
    const mail = await jobMail('thread-by-mail', at(1));
    const res = await detail(mail.id);
    expect(res.status).toBe(200);
    expect(res.body.conversation.key).toBe('thread-by-mail');
    expect((await detail(mail.id, OTHER)).status).toBe(404);
  });

  it('answers 404 for an unknown conversation or another user’s', async () => {
    await jobMail('private', at(1));
    expect((await detail('missing')).status).toBe(404);
    expect((await detail('private', OTHER)).status).toBe(404);
  });

  it('ends the new mark when the conversation is opened, for that conversation only', async () => {
    await jobMail('opened', at(1));
    await jobMail('opened', at(2));
    await jobMail('untouched', at(3));
    const res = await request(app).post('/api/conversations/opened/seen').set(as(OWNER)).send({});
    expect(res.body).toEqual({ seen: true });
    const rows = await list();
    expect(rows.find((row) => row.key === 'opened')?.isNew).toBe(false);
    expect(rows.find((row) => row.key === 'untouched')?.isNew).toBe(true);
    // Another user cannot clear it.
    await request(app).post('/api/conversations/untouched/seen').set(as(OTHER)).send({});
    expect((await list()).find((row) => row.key === 'untouched')?.isNew).toBe(true);
  });
});

describe('answering a request', () => {
  it('marks a request done and reopens it, with no application involved', async () => {
    const mail = await jobMail('thread-x', at(1), {
      actionRequired: true,
      requestedAction: 'Send dates',
    });
    const done = await answer('thread-x', { emailId: mail.id, state: 'DONE' });
    expect(done.status).toBe(200);
    expect(done.body.request.state).toBe('DONE');
    expect(keys(await list('?request=done'))).toEqual(['thread-x']);

    const open = await answer('thread-x', { emailId: mail.id, state: 'OPEN' });
    expect(open.body.request.state).toBe('OPEN');
  });

  it('lets the user reopen a replied request until they reply again', async () => {
    const mail = await jobMail('thread-y', at(1), {
      actionRequired: true,
      requestedAction: 'Send dates',
    });
    await sent('thread-y', at(2));
    expect((await list())[0].request?.state).toBe('REPLIED');

    await answer('thread-y', { emailId: mail.id, state: 'OPEN' });
    expect((await list())[0].request?.state).toBe('OPEN');

    await sent('thread-y', new Date(Date.now() + 60_000));
    expect((await list())[0].request?.state).toBe('REPLIED');
  });

  it('refuses an answer to a request that a newer email replaced', async () => {
    const old = await jobMail('thread-z', at(1), { actionRequired: true });
    await jobMail('thread-z', at(2), { actionRequired: true });
    const res = await answer('thread-z', { emailId: old.id, state: 'DONE' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REQUEST_CHANGED');
  });

  it('finishes and reopens the application action of a linked email', async () => {
    const mail = await jobMail('thread-l', at(1), {
      actionRequired: true,
      requestedAction: 'Send dates',
    });
    await link('thread-l');
    const action = () => prisma.action.findFirstOrThrow({ where: { emailId: mail.id } });
    expect((await action()).status).toBe('PENDING');

    await answer('thread-l', { emailId: mail.id, state: 'DONE' });
    expect((await action()).status).toBe('COMPLETED');
    expect((await list())[0].request?.state).toBe('DONE');

    await answer('thread-l', { emailId: mail.id, state: 'OPEN' });
    expect((await action()).status).toBe('PENDING');
    expect((await list())[0].request?.state).toBe('OPEN');
  });

  it('follows an action finished elsewhere', async () => {
    const mail = await jobMail('thread-e', at(1), { actionRequired: true });
    await link('thread-e');
    await prisma.action.updateMany({ where: { emailId: mail.id }, data: { status: 'COMPLETED' } });
    expect((await list())[0].request?.state).toBe('DONE');
  });
});

describe('creating the application of a conversation', () => {
  it('creates it from what the AI read and links every email of the thread', async () => {
    const first = await jobMail('thread-c', at(1), { category: 'FOLLOW_UP' });
    const second = await jobMail('thread-c', at(2), {
      category: 'INTERVIEW',
      actionRequired: true,
      requestedAction: 'Send dates',
    });

    const res = await link('thread-c');
    expect(res.status).toBe(200);
    const body = LinkConversationResponseSchema.parse(res.body);
    expect(body.created).toBe(true);
    expect(body.application).toMatchObject({
      companyName: 'Acme',
      jobTitle: 'Engineer',
      effectiveStatus: 'INTERVIEW',
    });
    // The first email is a confirmation: it arrived the day the user applied.
    expect(new Date(body.application.appliedAt as string).toISOString()).toBe(at(1).toISOString());
    expect(body.conversation).toMatchObject({
      link: 'LINKED',
      application: { id: body.application.id, effectiveStatus: 'INTERVIEW', archived: false },
    });

    const linked = await prisma.email.findMany({ where: { id: { in: [first.id, second.id] } } });
    expect(linked.every((mail) => mail.applicationId === body.application.id)).toBe(true);
    expect(linked.every((mail) => mail.matchConfirmedBy === 'USER_CONFIRMED')).toBe(true);
    expect(
      await prisma.applicationEvent.count({ where: { applicationId: body.application.id } }),
    ).toBe(2);
    expect(await prisma.action.count({ where: { applicationId: body.application.id } })).toBe(1);
  });

  it('shows a confirmation email as Applied, not as an unknown status', async () => {
    await jobMail('thread-s', at(1), { category: 'FOLLOW_UP' });
    const res = await link('thread-s');
    expect(res.body.application).toMatchObject({ aiStatus: 'APPLIED', effectiveStatus: 'APPLIED' });
  });

  it('brings the company’s other waiting conversations into the new application', async () => {
    await jobMail('portal', at(1), { category: 'FOLLOW_UP', companyName: 'Acme Inc.' });
    await jobMail('recruiter', at(2), { category: 'RECRUITER', companyName: 'ACME inc' });
    await jobMail('elsewhere', at(3), { companyName: 'Globex' });

    const res = await link('portal');
    const rows = await list();
    const applicationOf = (key: string) => rows.find((row) => row.key === key)?.application?.id;
    expect(applicationOf('recruiter')).toBe(res.body.application.id);
    expect(applicationOf('elsewhere')).toBeUndefined();
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(1);
    const swept = await prisma.email.findFirstOrThrow({ where: { threadId: 'recruiter' } });
    expect(swept.matchConfirmedBy).toBe('AI_AUTO');
  });

  it('joins the application the user already has for that company and role', async () => {
    const existing = await prisma.application.create({
      data: { userId: owner, companyName: 'acme', jobTitle: 'Engineer' },
    });
    await jobMail('thread-j', at(1));
    const res = await link('thread-j');
    expect(res.body).toMatchObject({ created: false, application: { id: existing.id } });
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(1);
  });

  it('asks the user to choose when several applications fit, and links the chosen one', async () => {
    const [one, two] = await Promise.all(
      ['Engineer I', 'Engineer II'].map((jobTitle) =>
        prisma.application.create({ data: { userId: owner, companyName: 'Acme', jobTitle } }),
      ),
    );
    await jobMail('thread-m', at(1), { jobTitle: null });
    const res = await link('thread-m');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPLICATION_CHOICE_REQUIRED');
    expect(res.body.error.details.candidates.map((c: { id: string }) => c.id).sort()).toEqual(
      [one.id, two.id].sort(),
    );

    const chosen = await link('thread-m', { applicationId: two.id });
    expect(chosen.body).toMatchObject({ created: false, application: { id: two.id } });
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(2);
  });

  it('needs a company name when the AI read none, and takes the one the user gives', async () => {
    await jobMail('thread-u', at(1), { companyName: null, jobTitle: null });
    const refused = await link('thread-u');
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('COMPANY_REQUIRED');
    const res = await link('thread-u', { companyName: '  Initech  ', jobTitle: 'Analyst' });
    expect(res.body.application).toMatchObject({ companyName: 'Initech', jobTitle: 'Analyst' });
  });

  it('refuses a second application for a linked conversation', async () => {
    await jobMail('thread-t', at(1));
    expect((await link('thread-t')).status).toBe(200);
    const again = await link('thread-t');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONVERSATION_LINKED');
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(1);
  });

  it('creates one application when the button is pressed twice at once', async () => {
    await jobMail('thread-w', at(1));
    const results = await Promise.all([link('thread-w'), link('thread-w')]);
    expect(results.filter((res) => res.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(1);
  });

  it('never links another user’s conversation or application', async () => {
    await jobMail('thread-o', at(1));
    expect((await link('thread-o', {}, OTHER)).status).toBe(404);
    const foreign = await prisma.application.create({
      data: { userId: other, companyName: 'Acme' },
    });
    const res = await link('thread-o', { applicationId: foreign.id });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('APPLICATION_NOT_FOUND');
  });

  it('refuses an archived application and an unknown field', async () => {
    const archived = await prisma.application.create({
      data: { userId: owner, companyName: 'Old', archivedAt: new Date() },
    });
    await jobMail('thread-v', at(1));
    expect((await link('thread-v', { applicationId: archived.id })).body.error.code).toBe(
      'APPLICATION_ARCHIVED',
    );
    expect((await link('thread-v', { location: 'Pune' })).status).toBe(400);
  });

  it('keeps a request the user already finished as finished, and sends no reminder for it', async () => {
    const mail = await jobMail('thread-k', at(1), {
      actionRequired: true,
      requestedAction: 'Send dates',
    });
    await answer('thread-k', { emailId: mail.id, state: 'DONE' });
    await link('thread-k');
    const action = await prisma.action.findFirstOrThrow({ where: { emailId: mail.id } });
    expect(action.status).toBe('COMPLETED');
    expect(enqueueNotificationJob).not.toHaveBeenCalled();
    expect((await list())[0].request?.state).toBe('DONE');
  });
});
