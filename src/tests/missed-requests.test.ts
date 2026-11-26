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
