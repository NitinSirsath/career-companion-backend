import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { prisma } from '../db/prisma';
import { app } from '../index';
import { readWorkspaceActions, readWorkspaceReview } from '../services/workspace';
import { listApplications, updateUserStatus } from '../services/application';
import { getAmbiguousMatches, getUnmatchedEmails } from '../services/matcher';
import { listPendingSubmissions } from '../services/externalSubmission';

vi.mock('../jobs/notificationJob', () => ({
  enqueueNotificationJob: vi.fn(() => {
    throw new Error('Unexpected notification');
  }),
}));
const address = 'workspace@fixture.test';
let owner: string;
let foreign: string;
let applicationId: string;
const at = new Date('2026-10-03T06:30:00.000Z'); // noon Kolkata
const query = { bucket: 'all' as const, timeZone: 'Asia/Kolkata', limit: 20, offset: 0 };
beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: address } })).id;
  foreign = (await prisma.user.create({ data: { email: 'foreign-workspace@fixture.test' } })).id;
});
beforeEach(async () => {
  await prisma.email.deleteMany({ where: { userId: { in: [owner, foreign] } } });
  await prisma.application.deleteMany({ where: { userId: { in: [owner, foreign] } } });
  applicationId = (
    await prisma.application.create({
      data: { userId: owner, companyName: 'Workspace', userStatus: 'CLOSED' },
    })
  ).id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, foreign] } } });
});
const action = (deadline: string | null, precision: 'DATE' | 'DATETIME' | null = null) => ({
  applicationId,
  type: 'FOLLOW_UP_REQUIRED',
  description: 'Fixture action',
  status: 'PENDING',
  deadline: deadline ? new Date(deadline) : null,
  deadlinePrecision: precision,
});

describe('daily workspace against PostgreSQL', () => {
  it('counts all 47 owned active pending actions before paging and excludes retired/handled/foreign rows', async () => {
    await prisma.action.createMany({
      data: [
        ...Array.from({ length: 25 }, () => action('2026-10-02T00:00:00Z', 'DATE')),
        ...Array.from({ length: 7 }, () => action('2026-10-03T00:00:00Z', 'DATE')),
        ...Array.from({ length: 8 }, () => action('2026-10-04T00:00:00Z', 'DATE')),
        ...Array.from({ length: 7 }, () => action(null)),
        { ...action(null), status: 'COMPLETED' },
        { ...action(null), status: 'DISMISSED' },
        { ...action(null), retiredAt: at, retiredReason: 'EMAIL_UNLINKED' },
      ],
    });
    const other = await prisma.application.create({
      data: { userId: foreign, companyName: 'Foreign' },
    });
    await prisma.action.create({ data: { ...action(null), applicationId: other.id } });
    const first = await readWorkspaceActions(owner, { ...query, bucket: 'overdue' }, at);
    expect(first.counts).toEqual({
      snoozed: 0,
      overdue: 25,
      today: 7,
      later: 8,
      undated: 7,
      totalPending: 47,
    });
    expect(first.items).toHaveLength(20);
    expect(first.metadata.nextOffset).toBe(20);
    const second = await readWorkspaceActions(
      owner,
      { ...query, bucket: 'overdue', offset: 20 },
      at,
    );
    expect(second.items).toHaveLength(5);
    expect(second.metadata.nextOffset).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(25);
    expect(second.counts).toEqual(first.counts);
    expect(
      (await readWorkspaceActions(owner, { ...query, bucket: 'later' }, at)).items,
    ).toHaveLength(8);
    expect(await prisma.aIOperation.count({ where: { email: { userId: owner } } })).toBe(0);
  });

  it('keeps DATE local-day semantics and legacy timestamp semantics; refresh boundary includes unseen work', async () => {
    await prisma.action.createMany({
      data: [
        action('2026-10-03T00:00:00Z', 'DATE'),
        action('2026-10-03T06:00:00Z', 'DATETIME'),
        action('2026-10-03T06:00:00Z'),
        action('2026-10-03T07:00:00Z', 'DATETIME'),
        action(null),
      ],
    });
    const result = await readWorkspaceActions(owner, { ...query, bucket: 'undated' }, at);
    expect(result.items).toHaveLength(1);
    expect(result.counts).toEqual({
      snoozed: 0,
      overdue: 2,
      today: 2,
      later: 0,
      undated: 1,
      totalPending: 5,
    });
    expect(result.nextTransitionAt).toBe('2026-10-03T07:00:00.001Z');
    const later = await readWorkspaceActions(owner, query, new Date(result.nextTransitionAt!));
    expect(later.counts.overdue).toBe(3);
    expect(later.nextTransitionAt).toBe('2026-10-03T18:30:00.000Z');
    const midnight = await readWorkspaceActions(owner, query, new Date(later.nextTransitionAt!));
    expect(midnight.counts.overdue).toBe(4);
  });

  it.each([
    ['2026-03-08T08:30:00Z', '2026-03-08T00:00:00Z', '2026-03-09T07:00:00.000Z'],
    ['2026-11-01T07:30:00Z', '2026-11-01T00:00:00Z', '2026-11-02T08:00:00.000Z'],
  ])('uses DST-aware next midnight in Los Angeles at %s', async (now, date, next) => {
    await prisma.action.create({ data: action(date, 'DATE') });
    const response = await readWorkspaceActions(
      owner,
      { ...query, timeZone: 'America/Los_Angeles' },
      new Date(now),
    );
    expect(response.counts.today).toBe(1);
    expect(response.nextTransitionAt).toBe(next);
  });

  it('keeps counts and rows in one snapshot while an action is retired between their reads', async () => {
    const row = await prisma.action.create({ data: action(null) });
    const original = prisma.$transaction.bind(prisma) as (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ) => Promise<unknown>;
    const intercept = (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ) =>
      original(async (tx) => {
        const proxy = new Proxy(tx, {
          get(target, key) {
            if (key === 'action')
              return new Proxy(tx.action, {
                get(delegate, method) {
                  if (method === 'findMany')
                    return async (args: Prisma.ActionFindManyArgs) => {
                      await prisma.action.update({
                        where: { id: row.id },
                        data: { retiredAt: at, retiredReason: 'EMAIL_UNLINKED' },
                      });
                      return tx.action.findMany(args);
                    };
                  return Reflect.get(delegate, method);
                },
              });
            return Reflect.get(target, key);
          },
        });
        return fn(proxy);
      }, options);
    const spy = vi
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(intercept as typeof prisma.$transaction);
    try {
      const during = await readWorkspaceActions(owner, query, at);
      expect(during.counts.totalPending).toBe(1);
      expect(during.items.map((item) => item.id)).toEqual([row.id]);
    } finally {
      spy.mockRestore();
    }
    const after = await readWorkspaceActions(owner, query, at);
    expect(after.counts.totalPending).toBe(0);
    expect(after.items).toEqual([]);
  });

  it('returns a null transition and zero counts for no dated work', async () => {
    expect((await readWorkspaceActions(owner, query, at)).nextTransitionAt).toBeNull();
    await prisma.action.create({ data: action(null) });
    expect((await readWorkspaceActions(owner, query, at)).nextTransitionAt).toBeNull();
  });

  it('matches review-queue eligibility without counting irrelevant unmatched mail or another owner', async () => {
    await prisma.email.createMany({
      data: [
        {
          userId: owner,
          gmailMessageId: randomUUID(),
          relevanceState: 'RELEVANT',
          matchState: 'UNMATCHED',
        },
        {
          userId: owner,
          gmailMessageId: randomUUID(),
          relevanceState: 'IRRELEVANT',
          matchState: 'UNMATCHED',
        },
        {
          userId: owner,
          gmailMessageId: randomUUID(),
          relevanceState: 'UNPROCESSED',
          matchState: 'AMBIGUOUS',
        },
        {
          userId: foreign,
          gmailMessageId: randomUUID(),
          relevanceState: 'RELEVANT',
          matchState: 'UNMATCHED',
        },
      ],
    });
    const counts = await readWorkspaceReview(owner, at);
    expect(counts.unmatched).toBe((await getUnmatchedEmails(owner)).length);
    expect(counts.ambiguous).toBe((await getAmbiguousMatches(owner)).length);
    expect(counts.pendingSubmissions).toBe((await listPendingSubmissions(owner, 20, 0)).length);
    expect(counts).toMatchObject({ unmatched: 1, ambiguous: 1, pendingSubmissions: 0 });
  });

  it('authenticates reads and rejects invalid parameters instead of returning zeros', async () => {
    expect((await request(app).get('/api/workspace/actions')).status).toBe(401);
    for (const suffix of [
      'timeZone=Nope/Zone',
      'bucket=unknown',
      'offset=-1',
      'offset=1.5',
      'limit=0',
      'bucket=all&bucket=today',
      'timeZone=UTC%27%3BDROP',
    ]) {
      expect(
        (
          await request(app)
            .get(`/api/workspace/actions?${suffix}`)
            .set('X-Development-User', address)
        ).status,
      ).toBe(400);
    }
    const response = await request(app)
      .get('/api/workspace/actions?limit=100')
      .set('X-Development-User', address);
    expect(response.status).toBe(200);
    expect(response.body.metadata.limit).toBe(20);
  });
});

describe('application discovery', () => {
  it('filters before pagination and uses manual-over-AI status with literal search', async () => {
    const target = await prisma.application.create({
      data: {
        userId: owner,
        companyName: 'A%_\\ Team',
        jobTitle: 'Senior Engineer',
        aiStatus: 'INTERVIEW',
        userStatus: 'REJECTED',
        createdAt: new Date('2020-01-01'),
      },
    });
    await prisma.application.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        userId: owner,
        companyName: `Recent ${i}`,
        aiStatus: 'INTERVIEW' as const,
      })),
    });
    await prisma.application.create({
      data: { userId: foreign, companyName: target.companyName, userStatus: 'REJECTED' },
    });
    for (const q of ['a%_\\', 'senior engineer']) {
      expect(
        (
          await listApplications(owner, 20, 0, {
            q,
            effectiveStatus: 'REJECTED',
          })
        ).map((row) => row.id),
      ).toEqual([target.id]);
      expect(
        await listApplications(owner, 20, 0, {
          q,
          effectiveStatus: 'INTERVIEW',
        }),
      ).toHaveLength(0);
    }
    await updateUserStatus(owner, target.id, {
      userStatus: null,
      expectedUserStatusRevision: 0,
    });
    expect(
      (
        await listApplications(owner, 20, 0, {
          q: 'a%_\\',
          effectiveStatus: 'INTERVIEW',
        })
      )[0].id,
    ).toBe(target.id);
  });

  it('validates filters and keeps empty-query defaults', async () => {
    for (const suffix of ['effectiveStatus=INVALID', `q=${'x'.repeat(101)}`, 'q=a&q=b']) {
      expect(
        (await request(app).get(`/api/applications?${suffix}`).set('X-Development-User', address))
          .status,
      ).toBe(400);
    }
    const response = await request(app)
      .get('/api/applications?q=%20%20')
      .set('X-Development-User', address);
    expect(response.status).toBe(200);
    expect(response.body.items[0].id).toBe(applicationId);
  });
});
