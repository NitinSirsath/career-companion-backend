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
import { ReanalysisRunSchema, ReanalysisStatusSchema } from '../contracts';
import { candidateEnvelope } from '../services/ai/temporal';
import { runReanalysis } from '../services/reanalysis';
import { stopInterruptedRuns } from '../services/reanalysisRuns';
import { configureAI } from './helpers/aiAccess';
import {
  fakeAI,
  fakeGmail,
  jobMail as mailOf,
  sentReply as replyOf,
  toDo,
  type MailOptions,
} from './helpers/reanalysisFixtures';

const OWNER = 'owner@reanalysis-checks.test';
const HEADERS = { 'X-Development-User': OWNER };
const MINUTE = 60_000;
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour));
let owner: string;

const jobMail = (threadId: string, receivedAt: Date, o: MailOptions = {}) =>
  mailOf(owner, threadId, receivedAt, o);
const sentReply = (threadId: string, sentAt: Date, o: Parameters<typeof replyOf>[3] = {}) =>
  replyOf(owner, threadId, sentAt, o);
const job = (data: Record<string, unknown> = {}) =>
  prisma.application.create({ data: { userId: owner, companyName: 'Brightwave', ...data } });

const status = async (path: string) => {
  const res = await request(app).get(`/api/${path}/reanalyze?preview=1`).set(HEADERS);
  expect(res.status).toBe(200);
  return ReanalysisStatusSchema.parse(res.body);
};
const start = (path: string) => request(app).post(`/api/${path}/reanalyze`).set(HEADERS).send({});
async function runFrom(path: string) {
  const res = await start(path);
  expect(res.status).toBe(202);
  const run = ReanalysisRunSchema.parse(res.body);
  await runReanalysis(owner, run.id);
  return prisma.reanalysisRun.findUniqueOrThrow({ where: { id: run.id } });
}

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
  await prisma.gmailConnection.update({ where: { userId: owner }, data: { status: 'CONNECTED' } });
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.outgoingEmail.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
  await prisma.reanalysisRun.deleteMany({ where: { userId: owner } });
  await prisma.aIUsageDay.deleteMany({ where: { userId: owner } });
  fakeGmail();
  fakeAI({});
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  delete process.env.AGENDA_EXTRACTION_V3_ENABLED;
  await prisma.user.deleteMany({ where: { email: OWNER } });
});

describe('what the confirm shows, before any AI read', () => {
  it('counts the mails and replies, the most reads, the reads left and the reserve', async () => {
    await jobMail('c-count', at(10));
    await sentReply('c-count', at(11));
    const { run, preview } = await status('conversations/c-count');
    expect(run).toBeNull();
    expect(preview).toMatchObject({
      conversations: 1,
      mails: 1,
      replies: 1,
      maxReads: 3,
      readsLeft: 100,
      reserve: 20,
      reader: { provider: 'gemini' },
      leftOut: 0,
      unfinishedMails: 0,
      blocked: null,
    });
  });

  it('gives only the run without ?preview=1, so a page load does no checks', async () => {
    await jobMail('c-light', at(10));
    const res = await request(app).get('/api/conversations/c-light/reanalyze').set(HEADERS);
    expect(res.status).toBe(200);
    expect(ReanalysisStatusSchema.parse(res.body)).toEqual({ run: null, preview: null });
  });

  it.each([
    ['STILL_READING', async () => sentReply('c-block', at(11), { state: 'WAITING' })],
    [
      'APPLICATION_ARCHIVED',
      async () => {
        const archived = await job({ archivedAt: at(12) });
        await jobMail('c-block', at(11), { applicationId: archived.id });
      },
    ],
    [
      'TOO_LONG',
      async () => {
        for (let i = 0; i < 20; i++)
          await sentReply('c-block', new Date(at(11).getTime() + i * MINUTE));
      },
    ],
    [
      'GMAIL_DISCONNECTED',
      async () =>
        prisma.gmailConnection.update({ where: { userId: owner }, data: { status: 'REVOKED' } }),
    ],
    ['AI_UNAVAILABLE', async () => prisma.aIConfiguration.deleteMany({ where: { userId: owner } })],
    [
      'AI_RESERVE',
      async () => {
        process.env.AI_USER_DAILY_CALL_LIMIT = '10';
        await prisma.aIUsageDay.create({
          data: { userId: owner, day: new Date().toISOString().slice(0, 10), calls: 7 },
        });
        await sentReply('c-block', at(11));
      },
    ],
  ])('refuses %s with the same code on start', async (code, setUp) => {
    await jobMail('c-block', at(10));
    await setUp();
    expect((await status('conversations/c-block')).preview?.blocked).toBe(code);
    const res = await start('conversations/c-block');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(code);
    expect(await prisma.reanalysisRun.count({ where: { userId: owner } })).toBe(0);
  });

  it('refuses a conversation with no job mail the AI finished, and counts the unfinished one', async () => {
    await prisma.email.create({
      data: {
        userId: owner,
        gmailMessageId: 'c-failed-1',
        threadId: 'c-failed',
        relevanceState: 'RELEVANT',
        processingState: 'FAILED',
        receivedAt: at(10),
      },
    });
    expect((await status('conversations/c-failed')).preview).toMatchObject({
      blocked: 'NOTHING_TO_READ',
      unfinishedMails: 1,
    });
  });

  it('allows one run at a time, and the same conversation once in 10 minutes', async () => {
    await jobMail('c-once', at(10));
    const first = await runFrom('conversations/c-once');
    expect(first).toMatchObject({ state: 'SAVED' });
    const again = await status('conversations/c-once');
    expect(again.run).toMatchObject({ id: first.id, state: 'SAVED', saved: 1 });
    expect(again.preview?.blocked).toBe('REANALYZED_RECENTLY');
    expect(again.preview?.retryAt).toBe(
      new Date(first.finishedAt!.getTime() + 10 * MINUTE).toISOString(),
    );
    await prisma.reanalysisRun.create({ data: { userId: owner, keys: ['other'] } });
    const res = await start('conversations/c-once');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RUN_OPEN');
  });

  it('shows a run a restart left open as stopped, and it blocks nothing', async () => {
    await jobMail('c-restart', at(10));
    const running = await prisma.reanalysisRun.create({
      data: { userId: owner, keys: ['c-restart'], state: 'RUNNING', startedAt: new Date() },
    });
    await stopInterruptedRuns();
    expect(
      await prisma.reanalysisRun.findUniqueOrThrow({ where: { id: running.id } }),
    ).toMatchObject({ state: 'STOPPED', stopReason: 'INTERRUPTED' });
    await prisma.reanalysisRun.create({
      data: { userId: owner, keys: ['c-restart'], createdAt: new Date(Date.now() - 30 * MINUTE) },
    });
    const shown = await status('conversations/c-restart');
    expect(shown.run).toMatchObject({ state: 'STOPPED', stopReason: 'INTERRUPTED' });
    expect(shown.preview?.blocked).toBeNull();
  });

  it('refuses "Read my reply again" while a run is open', async () => {
    await jobMail('c-guard', at(10), { ask: 'Confirm a time' });
    await sentReply('c-guard', at(11), { state: 'READ' });
    await prisma.reanalysisRun.create({ data: { userId: owner, keys: ['c-guard'] } });
    const res = await request(app)
      .post('/api/conversations/c-guard/read-reply-again')
      .set(HEADERS)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RUN_OPEN');
  });
});

describe('from the application page', () => {
  it('reads its conversations newest first and leaves out one saved minutes ago', async () => {
    const work = await job();
    await jobMail('c-app-old', at(10), { applicationId: work.id });
    await jobMail('c-app-new', at(12), { applicationId: work.id });
    await prisma.reanalysisRun.create({
      data: {
        userId: owner,
        keys: ['c-app-old'],
        savedKeys: ['c-app-old'],
        state: 'SAVED',
        finishedAt: new Date(),
      },
    });
    expect((await status(`applications/${work.id}`)).preview).toMatchObject({
      conversations: 1,
      leftOut: 1,
      blocked: null,
    });
    const run = await runFrom(`applications/${work.id}`);
    expect(run).toMatchObject({ applicationId: work.id, keys: ['c-app-new'], state: 'SAVED' });
    expect((await status(`applications/${work.id}`)).run).toMatchObject({
      state: 'SAVED',
      saved: 1,
    });
  });

  it('refuses an archived application', async () => {
    const archived = await job({ archivedAt: at(12) });
    await jobMail('c-app-archived', at(10), { applicationId: archived.id });
    const res = await start(`applications/${archived.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPLICATION_ARCHIVED');
  });
});

describe('replies, the decline question and to-dos', () => {
  it('keeps a reply that asked them a question waiting for their answer, and reads one with nothing open as not read', async () => {
    await jobMail('c-asked', at(10), { ask: 'Pick a time', text: 'asks' });
    const asked = await sentReply('c-asked', at(11), {
      state: 'READ',
      text: 'Is Monday possible?',
    });
    fakeAI({
      read: () => ({
        actionRequired: true,
        requestedAction: 'Pick a time',
        askKind: 'REPLY_BY_MAIL',
      }),
      reply: ({ openAsks }) => ({
        asks: openAsks.map((a) => ({ id: a.id, outcome: 'ASKED_BACK' as const })),
        leavesJob: false,
      }),
    });
    await runFrom('conversations/c-asked');
    expect(await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: asked.id } })).toMatchObject(
      {
        replyReadState: 'ASKED_BACK',
        replyReadVersion: 'reply-read/v2',
      },
    );

    await jobMail('c-none', at(10), { text: 'plain' });
    const plain = await sentReply('c-none', at(11), { state: 'READ' });
    fakeAI({});
    await runFrom('conversations/c-none');
    expect(await prisma.outgoingEmail.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject(
      {
        replyReadState: null,
      },
    );
  });

  it('takes away a decline question no reply asks any more, unless the user answered it', async () => {
    const asked = await job({ aiStatus: 'INTERVIEW', declinedAt: at(11) });
    await jobMail('c-undecline', at(10), { applicationId: asked.id, ask: 'Confirm a time' });
    await sentReply('c-undecline', at(11), { state: 'READ' });
    fakeAI({
      read: () => ({
        actionRequired: true,
        requestedAction: 'Confirm a time',
        askKind: 'REPLY_BY_MAIL',
      }),
      reply: ({ openAsks }) => ({
        asks: openAsks.map((a) => ({ id: a.id, outcome: 'ANSWERED' as const })),
        leavesJob: false,
      }),
    });
    await runFrom('conversations/c-undecline');
    expect(await prisma.application.findUniqueOrThrow({ where: { id: asked.id } })).toMatchObject({
      declinedAt: null,
      declineNotedAt: null,
    });

    const answered = await job({
      declinedAt: at(11),
      declineAnswer: 'KEPT_OPEN',
      declineAnsweredAt: at(12),
    });
    await jobMail('c-kept', at(10), { applicationId: answered.id, ask: 'Confirm a time' });
    await sentReply('c-kept', at(11), { state: 'READ' });
    await runFrom('conversations/c-kept');
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: answered.id } }),
    ).toMatchObject({
      declinedAt: at(11),
      declineAnswer: 'KEPT_OPEN',
    });
  });

  it('swaps an open to-do for one of the new kind, bringing back a retired one of that kind', async () => {
    const work = await job();
    const mail = await jobMail('c-kind', at(10), { applicationId: work.id, ask: 'Confirm a time' });
    const action = await toDo(work.id, mail.id, 'Confirm a time');
    const earlier = await prisma.action.create({
      data: {
        applicationId: work.id,
        emailId: mail.id,
        origin: 'EMAIL',
        type: 'FOLLOW_UP_REQUIRED',
        description: 'Follow up required',
        retiredAt: at(9),
        retiredReason: 'EMAIL_MOVED',
      },
    });
    fakeAI({ read: () => ({ followUpRequired: true, followUpDate: '2026-11-25' }) });
    expect(await runFrom('conversations/c-kind')).toMatchObject({ state: 'SAVED' });
    expect(await prisma.action.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
      retiredReason: 'REANALYZED',
    });
    expect(await prisma.action.findUniqueOrThrow({ where: { id: earlier.id } })).toMatchObject({
      retiredAt: null,
      status: 'PENDING',
      type: 'FOLLOW_UP_REQUIRED',
    });
  });
});

describe('agenda dates', () => {
  const candidate = (kind: 'INTERVIEW' | 'ASSESSMENT_DUE', date: string) => ({
    date,
    time: null,
    sourceTimeZone: null,
    kind,
    change: 'SCHEDULED' as const,
    rawWhen: date,
    evidence: null,
  });

  /** A mail read with dates (v7), and its agenda: two dates for review and one the user confirmed. */
  async function datedMail(threadId: string) {
    const work = await job();
    const mail = await jobMail(threadId, at(10), {
      applicationId: work.id,
      version: 'extraction/v7',
    });
    const envelope = candidateEnvelope([
      candidate('INTERVIEW', '2026-11-05'),
      candidate('ASSESSMENT_DUE', '2026-11-10'),
      candidate('INTERVIEW', '2026-11-01'),
    ]);
    await prisma.aIProcessingResult.update({
      where: { emailId: mail.id },
      data: { scheduleCandidates: envelope },
    });
    for (const [index, entry] of envelope.candidates.entries())
      await prisma.agendaItem.create({
        data: {
          userId: owner,
          applicationId: work.id,
          emailId: mail.id,
          candidateKey: entry.key,
          extractionVersion: 'extraction/v7',
          suggestion: entry,
          state: index === 2 ? 'CONFIRMED' : 'TENTATIVE',
          precision: entry.temporal.precision,
          date: entry.temporal.date,
        },
      });
    return mail;
  }

  it('matches dates by kind and time: keeps what it finds again, retires what it no longer finds, keeps what the user confirmed', async () => {
    process.env.AGENDA_EXTRACTION_V3_ENABLED = 'true';
    const mail = await datedMail('c-dates');
    fakeAI({
      read: () => ({
        scheduleCandidates: [
          candidate('ASSESSMENT_DUE', '2026-11-10'),
          candidate('INTERVIEW', '2026-11-07'),
        ],
      }),
    });
    expect(await runFrom('conversations/c-dates')).toMatchObject({ state: 'SAVED' });
    const rows = await prisma.agendaItem.findMany({
      where: { emailId: mail.id },
      orderBy: { createdAt: 'asc' },
    });
    const byKey = new Map(rows.map((row) => [row.candidateKey, row]));
    expect(byKey.get('v3:0')).toMatchObject({ retiredReason: 'REANALYZED' });
    expect(byKey.get('v3:1')).toMatchObject({ retiredAt: null, date: '2026-11-10' });
    expect(byKey.get('v3:2')).toMatchObject({ retiredAt: null, state: 'CONFIRMED' });
    const added = rows.find((row) => row.date === '2026-11-07');
    expect(added).toMatchObject({
      state: 'TENTATIVE',
      retiredAt: null,
      extractionVersion: 'extraction/v9',
    });
    const saved = await prisma.aIProcessingResult.findUniqueOrThrow({
      where: { emailId: mail.id },
    });
    const keys = (saved.scheduleCandidates as { candidates: { key: string }[] }).candidates.map(
      (c) => c.key,
    );
    expect(keys).toEqual(['v3:1', added!.candidateKey, 'v3:2']);
  });

  it('leaves the dates alone while the agenda switch is off', async () => {
    const mail = await datedMail('c-dates-off');
    const before = await prisma.agendaItem.findMany({ where: { emailId: mail.id } });
    const result = await prisma.aIProcessingResult.findUniqueOrThrow({
      where: { emailId: mail.id },
    });
    fakeAI({});
    expect(await runFrom('conversations/c-dates-off')).toMatchObject({ state: 'SAVED' });
    expect(await prisma.agendaItem.findMany({ where: { emailId: mail.id } })).toEqual(before);
    expect(
      (await prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId: mail.id } }))
        .scheduleCandidates,
    ).toEqual(result.scheduleCandidates);
  });
});
