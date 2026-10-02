import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { recordSubmission } from '../services/externalSubmission';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { MatcherService } from '../services/matcher';
import { ApplicationService } from '../services/application';
import { ActionService } from '../services/action';
import { enqueueNotificationJob } from '../jobs/notificationJob';
vi.mock('../jobs/notificationJob', () => ({ enqueueNotificationJob: vi.fn() }));
let owner: string;
let foreign: string;
let a: string;
let b: string;
const address = 'correction@fixture.test';
beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: address } })).id;
  foreign = (await prisma.user.create({ data: { email: 'foreign-correction@fixture.test' } })).id;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
  a = (
    await prisma.application.create({
      data: { userId: owner, companyName: 'A', userStatus: 'OFFER', userStatusRevision: 7 },
    })
  ).id;
  b = (await prisma.application.create({ data: { userId: owner, companyName: 'B' } })).id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, foreign] } } });
});
async function mail(category: 'INTERVIEW' | 'RECRUITER' = 'INTERVIEW', applicationId = a) {
  const email = await prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: randomUUID(),
      threadId: randomUUID(),
      relevanceState: 'RELEVANT',
      receivedAt: new Date(),
    },
  });
  const result = await prisma.aIProcessingResult.create({
    data: {
      emailId: email.id,
      provider: 'fixture',
      model: 'fixture',
      contractVersion: 'fixture',
      category,
      processingStatus: 'COMPLETED',
      actionRequired: true,
      requestedAction: 'Reply',
      companyName: 'A',
    },
  });
  await MatcherService.applyMatch(email.id, applicationId, result, 'AI_AUTO');
  return email.id;
}
const change = (emailId: string, target: string | null, expected = a) =>
  MatcherService.correctEmailMatch(owner, emailId, {
    applicationId: target,
    expectedApplicationId: expected,
    expectedMatchState: 'MATCHED',
  });
const patch = (id: string, body: object) =>
  request(app).patch(`/api/emails/${id}/match`).set('X-Development-User', address).send(body);
it('moves without deleting evidence or changing user status, and recomputes the source', async () => {
  const interview = await mail();
  await mail('RECRUITER');
  const action = await prisma.action.findFirstOrThrow({ where: { emailId: interview } });
  await prisma.action.update({ where: { id: action.id }, data: { status: 'DISMISSED' } });
  vi.mocked(enqueueNotificationJob).mockClear();
  const result = await change(interview, b);
  expect(result.email).toMatchObject({
    applicationId: b,
    matchState: 'MATCHED',
    matchConfirmedBy: 'USER_CONFIRMED',
  });
  expect(await prisma.application.findUniqueOrThrow({ where: { id: a } })).toMatchObject({
    aiStatus: 'RECRUITER_CONTACT',
    userStatus: 'OFFER',
    userStatusRevision: 7,
  });
  expect(await prisma.action.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
    status: 'DISMISSED',
    retiredReason: 'EMAIL_MOVED',
  });
  expect(
    await prisma.action.findFirstOrThrow({ where: { emailId: interview, applicationId: b } }),
  ).toMatchObject({ status: 'DISMISSED', retiredAt: null });
  expect(enqueueNotificationJob).not.toHaveBeenCalled();
  expect(await prisma.aIOperation.count({ where: { email: { userId: owner } } })).toBe(0);
  const timeline = await ApplicationService.getApplicationEvents(owner, a);
  expect(timeline!.find((e) => e.emailId === interview)).toMatchObject({
    retiredReason: 'EMAIL_MOVED',
    retiredAt: expect.any(String),
  });
});
it('unlinks, hides retired actions and excludes retired events from recent evidence', async () => {
  const id = await mail();
  const action = await prisma.action.findFirstOrThrow({ where: { emailId: id } });
  await change(id, null);
  expect(await prisma.email.findUniqueOrThrow({ where: { id } })).toMatchObject({
    matchState: 'IGNORED',
    applicationId: null,
    matchConfirmedBy: 'USER_CONFIRMED',
  });
  expect(await ActionService.getUserActions(owner)).toEqual([]);
  expect(await ApplicationService.getApplicationActions(owner, a)).toEqual([]);
  expect(await ApplicationService.getApplication(owner, a)).toMatchObject({
    aiStatus: null,
    pendingActionCount: 0,
    recentEvent: null,
    userStatus: 'OFFER',
  });
  const response = await request(app)
    .patch(`/api/actions/${action.id}`)
    .set('X-Development-User', address)
    .send({ status: 'COMPLETED' });
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('ACTION_RETIRED');
  expect((await prisma.action.findUniqueOrThrow({ where: { id: action.id } })).status).toBe(
    'PENDING',
  );
});
it('reactivates old rows when moved back without reopening handled actions', async () => {
  const id = await mail();
  const old = await prisma.action.findFirstOrThrow({ where: { emailId: id } });
  await prisma.action.update({ where: { id: old.id }, data: { status: 'COMPLETED' } });
  await change(id, b);
  await change(id, a, b);
  expect(await prisma.action.count({ where: { emailId: id } })).toBe(2);
  expect(await prisma.applicationEvent.count({ where: { emailId: id } })).toBe(2);
  expect(await prisma.action.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
    status: 'COMPLETED',
    retiredAt: null,
  });
  const before = await prisma.applicationEvent.findMany({ where: { emailId: id } });
  await MatcherService.matchEmailToApplication(id);
  expect(await prisma.applicationEvent.findMany({ where: { emailId: id } })).toEqual(before);
});
it('links an ignored email and rejects stale or foreign requests identically', async () => {
  const id = await mail();
  await change(id, null);
  const body = { applicationId: b, expectedApplicationId: null, expectedMatchState: 'IGNORED' };
  expect((await patch(id, body)).status).toBe(200);
  expect((await patch(id, body)).body.error.code).toBe('MATCH_CONFLICT');
  expect((await patch(randomUUID(), body)).body.error.code).toBe('NOT_FOUND');
  const foreignEmail = await prisma.email.create({
    data: { userId: foreign, gmailMessageId: randomUUID() },
  });
  expect((await patch(foreignEmail.id, body)).body.error.code).toBe('NOT_FOUND');
  const foreignApp = await prisma.application.create({
    data: { userId: foreign, companyName: 'Foreign' },
  });
  const current = { expectedMatchState: 'MATCHED', expectedApplicationId: b };
  expect((await patch(id, { ...current, applicationId: foreignApp.id })).body.error.code).toBe(
    'APPLICATION_NOT_FOUND',
  );
  expect((await patch(id, { ...current, applicationId: b })).status).toBe(400);
  expect((await patch(id, { ...current, applicationId: a, extra: true })).status).toBe(400);
});
it('serializes identical corrections and opposite moves without deadlocks', async () => {
  const one = await mail();
  const results = await Promise.allSettled([change(one, b), change(one, b)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const two = await mail();
  await Promise.all([change(one, a, b), change(two, b)]);
  expect((await prisma.email.findUniqueOrThrow({ where: { id: two } })).applicationId).toBe(b);
});
it('rechecks a stale thread decision after correction and stops after unlink', async () => {
  const id = await mail();
  const threadId = (await prisma.email.findUniqueOrThrow({ where: { id } })).threadId;
  const later = await prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: randomUUID(),
      threadId,
      relevanceState: 'RELEVANT',
      receivedAt: new Date(),
    },
  });
  await prisma.aIProcessingResult.create({
    data: {
      emailId: later.id,
      provider: 'fixture',
      model: 'fixture',
      contractVersion: 'fixture',
      category: 'RECRUITER',
      companyName: 'A',
      processingStatus: 'COMPLETED',
    },
  });
  const original = prisma.email.findFirst.bind(prisma.email);
  let paused = false;
  let reached!: () => void;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  // Prisma's fluent relation methods are irrelevant to this awaited test barrier.
  // @ts-expect-error plain promise intentionally replaces the fluent client in this test
  vi.spyOn(prisma.email, 'findFirst').mockImplementation(async (args) => {
    const row = await original(args);
    if (!paused && row?.id === id) {
      paused = true;
      reached();
      await gate;
    }
    return row;
  });
  const pending = MatcherService.matchEmailToApplication(later.id);
  try {
    await entered;
    await change(id, b);
  } finally {
    release();
  }
  await pending;
  expect((await prisma.email.findUniqueOrThrow({ where: { id: later.id } })).applicationId).toBe(b);
  await change(id, null, b);
  const future = await prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: randomUUID(),
      threadId,
      relevanceState: 'RELEVANT',
    },
  });
  await prisma.aIProcessingResult.create({
    data: {
      emailId: future.id,
      provider: 'fixture',
      model: 'fixture',
      contractVersion: 'fixture',
      companyName: 'A',
      processingStatus: 'COMPLETED',
    },
  });
  await MatcherService.matchEmailToApplication(future.id);
  expect((await prisma.email.findUniqueOrThrow({ where: { id: future.id } })).matchState).toBe(
    'UNMATCHED',
  );
});

it('retires legacy split effects, keeps automation history and carries the most resolved status', async () => {
  const id = await mail();
  const other = await prisma.application.create({
    data: { userId: owner, companyName: 'Legacy source', aiStatus: 'INTERVIEW' },
  });
  const split = await prisma.action.create({
    data: { applicationId: other.id, emailId: id, type: 'ACTION_REQUIRED', status: 'COMPLETED' },
  });
  await prisma.applicationEvent.create({
    data: { applicationId: other.id, emailId: id, type: 'EMAIL_PROCESSED' },
  });
  const automation = await prisma.applicationEvent.create({
    data: {
      applicationId: a,
      type: 'AUTOMATION_SUBMITTED',
      description: 'Legacy automation evidence',
    },
  });
  const response = await change(id, b);
  expect(response.affectedApplicationIds.sort()).toEqual([a, b, other.id].sort());
  expect((await prisma.action.findUniqueOrThrow({ where: { id: split.id } })).retiredReason).toBe(
    'EMAIL_MOVED',
  );
  expect(
    (await prisma.action.findFirstOrThrow({ where: { emailId: id, applicationId: b } })).status,
  ).toBe('COMPLETED');
  expect(
    (await prisma.application.findUniqueOrThrow({ where: { id: other.id } })).aiStatus,
  ).toBeNull();
  expect(await prisma.applicationEvent.findUniqueOrThrow({ where: { id: automation.id } })).toEqual(
    automation,
  );
});
it('refuses a move without stored AI but still permits unlink', async () => {
  const id = await mail();
  await prisma.aIProcessingResult.deleteMany({ where: { emailId: id } });
  await expect(change(id, b)).rejects.toMatchObject({ code: 'MATCH_NOT_CORRECTABLE' });
  await change(id, null);
});
it('does not automatically move a matched email when company evidence changes', async () => {
  const id = await mail();
  await prisma.aIProcessingResult.update({ where: { emailId: id }, data: { companyName: 'B' } });
  await MatcherService.matchEmailToApplication(id);
  expect((await prisma.email.findUniqueOrThrow({ where: { id } })).applicationId).toBe(a);
  expect(await prisma.applicationEvent.count({ where: { emailId: id, applicationId: b } })).toBe(0);
});

// Pause a real correction after its application row locks are held. Observe the
// competing transaction in PostgreSQL, rather than inferring a wait from a delay.
it.each(['status', 'submission'] as const)(
  'serializes correction with a concurrent %s write',
  async (kind) => {
    const id = await mail();
    await prisma.application.update({ where: { id: a }, data: { jobTitle: 'Engineer' } });
    let entered!: (pid: number) => void;
    let release!: () => void;
    const reached = new Promise<number>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = prisma.$transaction.bind(prisma);
    // The production call uses the callback overload, not Prisma's array overload.
    vi.spyOn(prisma, '$transaction').mockImplementationOnce(
      (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        transaction(async (tx) =>
          callback(
            new Proxy(tx, {
              get(target, prop) {
                if (prop !== '$queryRaw') return Reflect.get(target, prop);
                return async (strings: TemplateStringsArray, ...values: unknown[]) => {
                  const result = await tx.$queryRaw(strings, ...values);
                  if (
                    strings.join('').includes('FROM applications') &&
                    strings.join('').includes('FOR UPDATE')
                  ) {
                    const [row] = await tx.$queryRaw<
                      { pid: number }[]
                    >`SELECT pg_backend_pid() AS pid`;
                    entered(row.pid);
                    await gate;
                  }
                  return result;
                };
              },
            }),
          ),
        ),
    );
    const correction = change(id, b);
    const pid = await reached;
    const competing =
      kind === 'status'
        ? ApplicationService.updateUserStatus(owner, a, {
            userStatus: 'REJECTED',
            expectedUserStatusRevision: 7,
          })
        : recordSubmission(owner, null, {
            sourceRecordRef: '2026-10-03/09:15:00',
            platform: 'linkedin',
            company: 'A',
            jobTitle: 'Engineer',
            submittedAt: new Date().toISOString(),
          });
    try {
      await vi.waitFor(
        async () => {
          const rows = await prisma.$queryRaw<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS waiting`;
          expect(rows[0].waiting).toBe(true);
        },
        { timeout: 2000, interval: 10 },
      );
    } finally {
      release();
    }
    await Promise.all([correction, competing]);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: a } })).aiStatus).toBeNull();
    if (kind === 'status')
      expect(await prisma.application.findUniqueOrThrow({ where: { id: a } })).toMatchObject({
        userStatus: 'REJECTED',
        userStatusRevision: 8,
      });
    else
      expect(
        await prisma.applicationEvent.findMany({
          where: { applicationId: a, type: 'AUTOMATION_SUBMITTED' },
        }),
      ).toEqual([expect.objectContaining({ retiredAt: null, retiredReason: null })]);
  },
);
