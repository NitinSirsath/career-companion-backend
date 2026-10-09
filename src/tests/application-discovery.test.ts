import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { ApplicationFilters, ListApplicationsResponseSchema } from '../contracts';
import { recordSubmission, resolveSubmission } from '../services/externalSubmission';

const address = 'owner@app-discovery.test';
let owner: string;
let foreign: string;
const application = (data: Partial<Prisma.ApplicationUncheckedCreateInput> = {}) =>
  prisma.application.create({ data: { userId: owner, companyName: 'Discovery', ...data } });
async function list(
  filters: ApplicationFilters & { offset?: number; limit?: number } = {},
  email = address,
) {
  const result = await request(app)
    .get('/api/applications')
    .query(filters)
    .set('X-Development-User', email);
  expect(result.status).toBe(200);
  return ListApplicationsResponseSchema.parse(result.body);
}
const ids = (page: Awaited<ReturnType<typeof list>>) => page.items.map((row) => row.id);

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: address } })).id;
  foreign = (await prisma.user.create({ data: { email: 'foreign@app-discovery.test' } })).id;
});
beforeEach(async () => {
  await prisma.externalSubmission.deleteMany({ where: { userId: { in: [owner, foreign] } } });
  await prisma.application.deleteMany({ where: { userId: { in: [owner, foreign] } } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, foreign] } } });
});

describe('normal API application discovery', () => {
  it.each(['added_desc', 'applied_desc', 'applied_asc', 'company_asc'] as const)(
    'sorts %s before pagination with deterministic ties and null dates last',
    async (sort) => {
      // Identical dates/names straddle a page boundary; id must decide their order.
      const tied = await Promise.all(
        Array.from({ length: 23 }, () =>
          application({
            companyName: 'Middle',
            createdAt: new Date('2025-06-01'),
            appliedAt: new Date('2025-06-01'),
          }),
        ),
      );
      const first = await application({
        companyName: 'Alpha',
        createdAt: new Date('2025-01-01'),
        appliedAt: new Date('2025-01-01'),
      });
      const last = await application({
        companyName: 'Zulu',
        createdAt: new Date('2025-12-01'),
        appliedAt: new Date('2025-12-01'),
      });
      const unknown = await application({
        companyName: 'ZZZ unknown',
        createdAt: new Date('2026-01-01'),
      });
      await application({
        userId: foreign,
        companyName: 'Foreign',
        appliedAt: new Date('2026-02-01'),
      });
      await application({
        archivedAt: new Date(),
        companyName: 'Archived',
        appliedAt: new Date('2026-02-01'),
      });
      const middle = tied
        .map((row) => row.id)
        .sort()
        .reverse();
      const expected =
        sort === 'added_desc'
          ? [unknown.id, last.id, ...middle, first.id]
          : sort === 'applied_desc'
            ? [last.id, ...middle, first.id, unknown.id]
            : [first.id, ...middle, last.id, unknown.id];
      const page1 = await list({ sort });
      const page2 = await list({ sort, offset: page1.metadata.nextOffset! });
      expect(page1.metadata.nextOffset).toBe(20);
      expect(page2.metadata.nextOffset).toBeNull();
      expect([...ids(page1), ...ids(page2)]).toEqual(expected);
      expect(ids(await list({ sort }))).toEqual(ids(page1));
      if (sort === 'added_desc') expect(ids(await list())).toEqual(ids(page1));
    },
  );

  it('combines source, canonical/unknown status, literal search and archive without duplicate rows', async () => {
    const receipt = {
      sourceRecordRef: '2026-10-01/09:00:00',
      platform: 'linkedin',
      company: 'A%_ Discovery',
      jobTitle: 'Engineer',
      submittedAt: '2026-10-01T09:00:00+05:30',
    };
    const created = await recordSubmission(owner, null, receipt);
    const linked = await recordSubmission(owner, null, {
      ...receipt,
      sourceRecordRef: '2026-10-01/10:00:00',
    });
    expect(created.result).toBe('created');
    expect(linked.result).toBe('linked');
    const target = await prisma.application.findFirstOrThrow({ where: { userId: owner } });
    await application({ companyName: receipt.company }); // same search, no submission
    await recordSubmission(foreign, null, receipt);
    await prisma.application.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({ userId: owner, companyName: 'Recent ' + i })),
    });
    const filters = { q: 'a%_', submittedVia: 'AUTOMATION', sort: 'applied_desc' } as const;
    expect(ids(await list({ ...filters, effectiveStatus: 'UNKNOWN' }))).toEqual([target.id]);
    expect(ids(await list({ ...filters, effectiveStatus: 'APPLIED' }))).toEqual([]);
    await prisma.application.update({
      where: { id: target.id },
      data: { aiStatus: 'INTERVIEW', userStatus: 'REJECTED' },
    });
    expect(ids(await list({ ...filters, effectiveStatus: 'UNKNOWN' }))).toEqual([]);
    expect(ids(await list({ ...filters, effectiveStatus: 'INTERVIEW' }))).toEqual([]);
    expect(ids(await list({ ...filters, effectiveStatus: 'REJECTED' }))).toEqual([target.id]);
    await prisma.application.update({ where: { id: target.id }, data: { archivedAt: new Date() } });
    expect(ids(await list(filters))).toEqual([]);
    expect(ids(await list({ ...filters, archive: 'archived' }))).toEqual([target.id]);
    expect(ids(await list({ ...filters, archive: 'all' }))).toEqual([target.id]);
  });

  it('does not turn review or ignored receipts into applications/source membership', async () => {
    await application({ companyName: 'Review Company', jobTitle: null });
    const receipt = {
      platform: 'linkedin',
      company: 'Review Company',
      jobTitle: 'Engineer',
      submittedAt: '2026-10-01T09:00:00+05:30',
    };
    const review = await recordSubmission(owner, null, {
      ...receipt,
      sourceRecordRef: '2026-10-01/09:00:00',
    });
    const ignored = await recordSubmission(owner, null, {
      ...receipt,
      sourceRecordRef: '2026-10-01/10:00:00',
    });
    expect(review.result).toBe('needs_review');
    await resolveSubmission(owner, ignored.recordId, { action: 'ignore' });
    expect(ids(await list({ submittedVia: 'AUTOMATION' }))).toEqual([]);
    expect((await list()).items).toHaveLength(1);
  });

  it('keeps retired history out of list summaries and counts', async () => {
    const target = await application();
    await prisma.applicationEvent.createMany({
      data: [
        { applicationId: target.id, type: 'NOTE_ADDED', createdAt: new Date('2020-01-01') },
        {
          applicationId: target.id,
          type: 'EMAIL_PROCESSED',
          retiredAt: new Date(),
          retiredReason: 'EMAIL_UNLINKED',
        },
      ],
    });
    await prisma.action.create({
      data: {
        applicationId: target.id,
        type: 'FOLLOW_UP_REQUIRED',
        status: 'PENDING',
        retiredAt: new Date(),
        retiredReason: 'EMAIL_UNLINKED',
      },
    });
    const page = await list({ sort: 'applied_desc', effectiveStatus: 'UNKNOWN' });
    expect(page.items[0]).toMatchObject({
      recentEvent: { type: 'NOTE_ADDED' },
      pendingActionCount: 0,
    });
  });

  it('requires authentication and rejects malformed discovery filters', async () => {
    expect((await request(app).get('/api/applications?sort=applied_desc')).status).toBe(401);
    for (const query of [
      'sort=invalid',
      'sort=added_desc&sort=applied_desc',
      'submittedVia=EMAIL',
      'submittedVia=AUTOMATION&submittedVia=AUTOMATION',
      'effectiveStatus=unknown',
    ]) {
      expect(
        (
          await request(app)
            .get('/api/applications?' + query)
            .set('X-Development-User', address)
        ).status,
      ).toBe(400);
    }
  });
});
