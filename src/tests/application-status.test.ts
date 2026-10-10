import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AIProcessingResult, Prisma } from '@prisma/client';
import { app } from '../index';
import { prisma } from '../db/prisma';
import {
  ApplicationResponseSchema,
  ApplicationStatus,
  ApplicationStatusSchema,
  ListApplicationsResponseSchema,
  deriveStatus,
} from '../contracts';
import { MatcherService } from '../services/matcher';
import { GmailFetcherService } from '../services/gmailFetcher';
import { createProviderClient } from '../services/ai/providers';
import { enqueueNotificationJob } from '../jobs/notificationJob';
import { getQueue } from '../services/queue';

vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../jobs/notificationJob', () => ({ enqueueNotificationJob: vi.fn() }));
// Real queue, observed: any job send during a correction would go through getQueue().
vi.mock('../services/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/queue')>();
  return { ...actual, getQueue: vi.fn(actual.getQueue) };
});

const OWNER = 'status-owner@s6.test';
const OTHER = 'status-other@s6.test';
const STATUSES = [...ApplicationStatusSchema.options, null] as (ApplicationStatus | null)[];
let ownerId: string;
let otherId: string;

const as = (email: string) => ({ 'X-Development-User': email });
const patch = (id: string, body: unknown, user = OWNER) =>
  request(app)
    .patch(`/api/applications/${id}/status`)
    .set(as(user))
    .send(body as object);
const getOne = (id: string) => request(app).get(`/api/applications/${id}`).set(as(OWNER));
const row = (id: string) => prisma.application.findUniqueOrThrow({ where: { id } });

async function sideEffectCounts() {
  const queued = (
    await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job`
  )[0].n;
  return {
    queued,
    operations: await prisma.aIOperation.count(),
    budgets: await prisma.aICallBudget.findMany(),
    events: await prisma.applicationEvent.count(),
    actions: await prisma.action.findMany({ select: { id: true, status: true } }),
    deliveries: await prisma.notificationDelivery.count(),
  };
}

beforeAll(async () => {
  process.env.ENABLE_DEV_AUTH = 'true';
  await prisma.user.deleteMany({ where: { email: { endsWith: '@s6.test' } } });
  ownerId = (await prisma.user.create({ data: { email: OWNER } })).id;
  otherId = (await prisma.user.create({ data: { email: OTHER } })).id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@s6.test' } } });
  const { stopQueue } = await import('../services/queue');
  await stopQueue();
});

describe('canonical status (64 combinations)', () => {
  it('derives effective status, source and conflict for every AI/user pair', () => {
    for (const ai of STATUSES)
      for (const user of STATUSES) {
        const derived = deriveStatus(ai, user);
        expect(derived.effectiveStatus).toBe(user ?? ai);
        expect(derived.statusSource).toBe(user ? 'USER' : ai ? 'AI' : 'UNKNOWN');
        expect(derived.hasStatusConflict).toBe(user !== null && ai !== null && user !== ai);
      }
  });

  it('serves the same canonical fields from list and detail for all 64 pairs', async () => {
    await prisma.application.deleteMany({ where: { userId: ownerId } });
    const expected = new Map<string, ReturnType<typeof deriveStatus>>();
    for (const ai of STATUSES)
      for (const user of STATUSES) {
        const created = await prisma.application.create({
          data: { userId: ownerId, companyName: `${ai}/${user}`, aiStatus: ai, userStatus: user },
        });
        expected.set(created.id, deriveStatus(ai, user));
      }
    const listed = new Map<string, unknown>();
    let offset: number | null = 0;
    while (offset !== null) {
      const res = await request(app).get(`/api/applications?offset=${offset}`).set(as(OWNER));
      const page = ListApplicationsResponseSchema.parse(res.body);
      for (const item of page.items) listed.set(item.id, item);
      offset = page.metadata.nextOffset;
    }
    expect(listed.size).toBe(64);
    for (const [id, derived] of expected) {
      const detail = ApplicationResponseSchema.parse((await getOne(id)).body);
      expect(detail).toMatchObject(derived);
      expect(listed.get(id)).toMatchObject({ ...derived, userStatusRevision: 0 });
    }
  });

  it('rejects responses with missing or inconsistent canonical fields', () => {
    const valid = {
      archivedAt: null,
      archiveRevision: 0,
      id: 'a',
      companyName: 'C',
      jobTitle: null,
      location: null,
      aiStatus: 'OFFER',
      userStatus: null,
      userStatusSetAt: null,
      userStatusRevision: 0,
      effectiveStatus: 'OFFER',
      statusSource: 'AI',
      hasStatusConflict: false,
      appliedAt: null,
      createdAt: 'x',
      updatedAt: 'x',
      recentEvent: null,
      pendingActionCount: 0,
      submittedVia: null,
    };
    expect(ApplicationResponseSchema.safeParse(valid).success).toBe(true);
    const missing: Partial<typeof valid> = { ...valid };
    delete missing.userStatusRevision;
    expect(ApplicationResponseSchema.safeParse(missing).success).toBe(false);
    expect(
      ApplicationResponseSchema.safeParse({ ...valid, effectiveStatus: 'APPLIED' }).success,
    ).toBe(false);
    expect(ApplicationResponseSchema.safeParse({ ...valid, statusSource: 'USER' }).success).toBe(
      false,
    );
    expect(ApplicationResponseSchema.safeParse({ ...valid, userStatusRevision: -1 }).success).toBe(
      false,
    );
  });

  it('returns revision 0 and canonical fields from create', async () => {
    const res = await request(app)
      .post('/api/applications')
      .set(as(OWNER))
      .send({ companyName: 'Fresh' });
    expect(res.status).toBe(201);
    expect(ApplicationResponseSchema.parse(res.body)).toMatchObject({
      userStatusRevision: 0,
      effectiveStatus: null,
      statusSource: 'UNKNOWN',
      hasStatusConflict: false,
    });
  });
});

describe('PATCH /api/applications/:id/status', () => {
  let id: string;
  beforeEach(async () => {
    await prisma.application.deleteMany({ where: { userId: { in: [ownerId, otherId] } } });
    id = (
      await prisma.application.create({
        data: { userId: ownerId, companyName: 'Acme', aiStatus: 'INTERVIEW' },
      })
    ).id;
  });

  it('sets, changes and clears with one revision increment each', async () => {
    const set = await patch(id, { userStatus: 'OFFER', expectedUserStatusRevision: 0 });
    expect(set.status).toBe(200);
    expect(ApplicationResponseSchema.parse(set.body)).toMatchObject({
      userStatus: 'OFFER',
      userStatusRevision: 1,
      effectiveStatus: 'OFFER',
      statusSource: 'USER',
      hasStatusConflict: true,
      aiStatus: 'INTERVIEW',
    });
    expect(set.body.userStatusSetAt).not.toBeNull();

    const change = await patch(id, { userStatus: 'REJECTED', expectedUserStatusRevision: 1 });
    expect(change.body).toMatchObject({ userStatus: 'REJECTED', userStatusRevision: 2 });

    const clear = await patch(id, { userStatus: null, expectedUserStatusRevision: 2 });
    expect(clear.body).toMatchObject({
      userStatus: null,
      userStatusSetAt: null,
      userStatusRevision: 3,
      effectiveStatus: 'INTERVIEW',
      statusSource: 'AI',
      hasStatusConflict: false,
    });

    const repeatedClear = await patch(id, { userStatus: null, expectedUserStatusRevision: 3 });
    expect(repeatedClear.status).toBe(200);
    expect(repeatedClear.body.userStatusRevision).toBe(3);
  });

  it('accepts every supported status', async () => {
    let revision = 0;
    for (const status of ApplicationStatusSchema.options) {
      const res = await patch(id, { userStatus: status, expectedUserStatusRevision: revision });
      expect(res.status).toBe(200);
      expect(res.body.effectiveStatus).toBe(status);
      revision = res.body.userStatusRevision;
    }
    expect(revision).toBe(7);
  });

  it('keeps revision, confirmation time and updatedAt for a current same-value request', async () => {
    const first = await patch(id, { userStatus: 'OFFER', expectedUserStatusRevision: 0 });
    const before = await row(id);
    const again = await patch(id, { userStatus: 'OFFER', expectedUserStatusRevision: 1 });
    expect(again.status).toBe(200);
    const after = await row(id);
    expect(after.userStatusRevision).toBe(1);
    expect(after.userStatusSetAt).toEqual(before.userStatusSetAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(again.body.userStatusSetAt).toBe(first.body.userStatusSetAt);
  });

  it('compares revision before detecting a no-op', async () => {
    await patch(id, { userStatus: 'OFFER', expectedUserStatusRevision: 0 });
    const stale = await patch(id, { userStatus: 'OFFER', expectedUserStatusRevision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STATUS_CONFLICT');
  });

  it('rejects a lost-acknowledgement replay with its original revision without another change', async () => {
    await patch(id, { userStatus: 'ASSESSMENT', expectedUserStatusRevision: 0 });
    const before = await row(id);
    const replay = await patch(id, { userStatus: 'ASSESSMENT', expectedUserStatusRevision: 0 });
    expect(replay.status).toBe(409);
    expect(await row(id)).toEqual(before);
  });

  it('lets exactly one of two competing changes win', async () => {
    const results = await Promise.all([
      patch(id, { userStatus: 'OFFER', expectedUserStatusRevision: 0 }),
      patch(id, { userStatus: 'REJECTED', expectedUserStatusRevision: 0 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    const stored = await row(id);
    expect(stored.userStatus).toBe(winner.body.userStatus);
    expect(stored.userStatusRevision).toBe(1);
  });

  it('rolls back when the transaction fails after the write', async () => {
    type Work = (tx: Prisma.TransactionClient) => Promise<unknown>;
    const original = prisma.$transaction.bind(prisma) as (work: Work) => Promise<unknown>;
    const failAfterWork = (work: Work) =>
      original(async (tx) => {
        await work(tx);
        throw new Error('boom');
      });
    const spy = vi
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(failAfterWork as typeof prisma.$transaction);
    const res = await patch(id, { userStatus: 'OFFER', expectedUserStatusRevision: 0 });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    spy.mockRestore();
    expect(await row(id)).toMatchObject({
      userStatus: null,
      userStatusSetAt: null,
      userStatusRevision: 0,
    });
  });

  it.each([
    [{ userStatus: 'OFFER' }],
    [{ expectedUserStatusRevision: 0 }],
    [{ userStatus: 'HIRED', expectedUserStatusRevision: 0 }],
    [{ userStatus: 'OFFER', expectedUserStatusRevision: -1 }],
    [{ userStatus: 'OFFER', expectedUserStatusRevision: 1.5 }],
    [{ userStatus: 'OFFER', expectedUserStatusRevision: '0' }],
    [{ userStatus: 'OFFER', expectedUserStatusRevision: 0, userId: 'x' }],
    [{ userStatus: 'OFFER', expectedUserStatusRevision: 0, aiStatus: 'OFFER' }],
    [
      {
        userStatus: 'OFFER',
        expectedUserStatusRevision: 0,
        userStatusSetAt: '2026-01-01T00:00:00Z',
      },
    ],
  ])('rejects invalid payload %j with 400 and no change', async (body) => {
    const res = await patch(id, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await row(id)).userStatusRevision).toBe(0);
  });

  it('rejects a malformed path ID', async () => {
    const res = await patch('not-a-uuid', { userStatus: 'OFFER', expectedUserStatusRevision: 0 });
    expect(res.status).toBe(400);
  });

  it('returns an identical 404 for missing and foreign applications', async () => {
    const foreign = await prisma.application.create({
      data: { userId: otherId, companyName: 'Theirs' },
    });
    const body = { userStatus: 'OFFER', expectedUserStatusRevision: 0 };
    const a = await patch(foreign.id, body);
    const b = await patch('00000000-0000-4000-8000-000000000000', body);
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(a.body).toEqual(b.body);
    expect((await row(foreign.id)).userStatus).toBeNull();
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .patch(`/api/applications/${id}/status`)
      .send({ userStatus: 'OFFER', expectedUserStatusRevision: 0 });
    expect(res.status).toBe(401);
  });

  it('keeps an unknown legacy confirmation time unknown', async () => {
    await prisma.application.update({
      where: { id },
      data: { userStatus: 'OFFER', userStatusSetAt: null },
    });
    const res = await getOne(id);
    expect(res.body).toMatchObject({
      userStatus: 'OFFER',
      userStatusSetAt: null,
      statusSource: 'USER',
    });
    const same = await patch(id, { userStatus: 'OFFER', expectedUserStatusRevision: 0 });
    expect(same.body.userStatusSetAt).toBeNull(); // a no-op never invents a confirmation time
  });

  it('makes no provider call, job, AI-ledger, event, action or notification change', async () => {
    await getQueue(); // the pgboss schema exists, so a zero job delta is meaningful
    vi.mocked(getQueue).mockClear();
    vi.mocked(enqueueNotificationJob).mockClear();
    const metadata = vi.spyOn(GmailFetcherService, 'fetchMessageMetadata');
    const body = vi.spyOn(GmailFetcherService, 'fetchMessageBody');
    const gemini = vi.mocked(createProviderClient);
    gemini.mockClear();
    const before = await sideEffectCounts();
    expect((await patch(id, { userStatus: 'OFFER', expectedUserStatusRevision: 0 })).status).toBe(
      200,
    );
    expect((await patch(id, { userStatus: null, expectedUserStatusRevision: 1 })).status).toBe(200);
    expect(await sideEffectCounts()).toEqual(before);
    expect(getQueue).not.toHaveBeenCalled();
    expect(enqueueNotificationJob).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    expect(gemini).not.toHaveBeenCalled();
    expect((await row(id)).aiStatus).toBe('INTERVIEW');
  });
});

describe('AI and manual state stay separate', () => {
  it('AI matching never changes manual fields, and clearing reveals the persisted AI state', async () => {
    const application = await prisma.application.create({
      data: { userId: ownerId, companyName: 'Sep Co', aiStatus: 'APPLIED' },
    });
    const set = await patch(application.id, {
      userStatus: 'REJECTED',
      expectedUserStatusRevision: 0,
    });
    const email = await prisma.email.create({
      data: { userId: ownerId, gmailMessageId: `sep-${Date.now()}` },
    });
    const result = await prisma.aIProcessingResult.create({
      data: {
        emailId: email.id,
        provider: 't',
        model: 't',
        contractVersion: 't',
        category: 'OFFER',
        offerInfo: 'Offer',
      },
    });
    await MatcherService.applyMatch(
      email.id,
      application.id,
      result as AIProcessingResult,
      'AI_AUTO',
    );
    const after = await row(application.id);
    expect(after.aiStatus).toBe('OFFER');
    expect(after.userStatus).toBe('REJECTED');
    expect(after.userStatusRevision).toBe(1);
    expect(after.userStatusSetAt?.toISOString()).toBe(set.body.userStatusSetAt);
    const clear = await patch(application.id, { userStatus: null, expectedUserStatusRevision: 1 });
    expect(clear.body).toMatchObject({ effectiveStatus: 'OFFER', statusSource: 'AI' });
  });

  it('serializes a manual write against an AI write holding the application lock', async () => {
    const application = await prisma.application.create({
      data: { userId: ownerId, companyName: 'Lock Co', aiStatus: 'APPLIED' },
    });
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const gate = new Promise<void>((r) => (release = r));
    const ai = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM applications WHERE id = ${application.id}::uuid FOR UPDATE`;
      locked();
      await gate;
      await tx.application.update({
        where: { id: application.id },
        data: { aiStatus: 'INTERVIEW' },
      });
    });
    await held;
    const manual = patch(application.id, { userStatus: 'OFFER', expectedUserStatusRevision: 0 });
    await new Promise((r) => setTimeout(r, 150));
    release();
    await ai;
    const res = await manual;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      aiStatus: 'INTERVIEW',
      userStatus: 'OFFER',
      userStatusRevision: 1,
    });
  });
});
