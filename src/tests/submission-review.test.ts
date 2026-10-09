// MCP-05: review API for automation submissions that need a person (ADR-0002 decision 7).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { ListPendingSubmissionsResponseSchema } from '../contracts';
import { recordSubmission } from '../services/externalSubmission';

const DOMAIN = '@mcp-review.test';
const OWNER = `owner${DOMAIN}`;
const OTHER = `other${DOMAIN}`;
let owner: string;
let other: string;

const as = (email: string) => ({ 'X-Development-User': email });
const resolve = (id: string, body: unknown, email = OWNER) =>
  request(app)
    .post(`/api/submissions/${id}/resolve`)
    .set(as(email))
    .send(body as object);

/** A NEEDS_REVIEW submission: the owner already has an application at Acme with another title. */
async function pending(
  ref = '2026-10-01/10:00:00',
  overrides: Record<string, unknown> = {},
  userId = owner,
) {
  if (
    !(await prisma.application.count({
      where: { userId, companyName: 'Acme', jobTitle: 'Designer' },
    }))
  )
    await prisma.application.create({
      data: { userId, companyName: 'Acme', jobTitle: 'Designer' },
    });
  const outcome = await recordSubmission(userId, null, {
    sourceRecordRef: ref,
    platform: 'workday',
    company: 'Acme Inc.',
    jobTitle: 'Backend Engineer',
    submittedAt: '2026-10-01T10:00:00Z',
    location: 'Remote',
    confirmationText: 'Thanks for applying',
    ...overrides,
  });
  expect(outcome.result).toBe('needs_review');
  return outcome.recordId;
}

beforeAll(async () => {
  process.env.ENABLE_DEV_AUTH = 'true';
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  await prisma.externalSubmission.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.application.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.integrationToken.deleteMany({ where: { userId: { in: [owner, other] } } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('GET /api/submissions/pending', () => {
  it('lists only the owner’s NEEDS_REVIEW submissions, newest first, without the token', async () => {
    await prisma.integrationToken.create({
      data: {
        userId: owner,
        name: 't',
        tokenHash: 'b'.repeat(64),
        displayPrefix: 'ccmcp_bbbbbb',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const older = await pending('2026-10-01/10:00:00');
    await prisma.externalSubmission.update({
      where: { id: older },
      data: { receivedAt: new Date(Date.now() - 60_000) },
    });
    const newer = await pending('2026-10-01/10:05:00');
    await pending('2026-10-01/10:00:00', {}, other);
    await recordSubmission(owner, null, {
      sourceRecordRef: '2026-10-01/10:10:00',
      platform: 'indeed',
      company: 'Brand New',
      jobTitle: 'Dev',
      submittedAt: '2026-10-01T10:00:00Z',
    }); // CREATED, not pending

    const res = await request(app).get('/api/submissions/pending').set(as(OWNER));
    expect(res.status).toBe(200);
    const body = ListPendingSubmissionsResponseSchema.parse(res.body);
    expect(body.items.map((i) => i.id)).toEqual([newer, older]);
    expect(body.items[0]).toMatchObject({
      sourceRecordRef: '2026-10-01/10:05:00',
      platform: 'workday',
      company: 'Acme Inc.',
      jobTitle: 'Backend Engineer',
      submittedAt: '2026-10-01T10:00:00.000Z',
      location: 'Remote',
      confirmationText: 'Thanks for applying',
      jobUrl: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/tokenId|matchState|userId/);
  });

  it('paginates with the existing offset envelope', async () => {
    for (const t of ['10:00:01', '10:00:02', '10:00:03']) await pending(`2026-10-01/${t}`);
    const page = await request(app).get('/api/submissions/pending?limit=2').set(as(OWNER));
    expect(page.body.items).toHaveLength(2);
    expect(page.body.metadata).toEqual({ limit: 2, offset: 0, nextOffset: 2 });
  });

  it('requires a session', async () => {
    expect((await request(app).get('/api/submissions/pending')).status).toBe(401);
  });
});

describe('POST /api/submissions/:id/resolve', () => {
  it('link: LINKED by USER, event added, appliedAt set only if empty, statuses untouched', async () => {
    const id = await pending();
    const target = await prisma.application.create({
      data: {
        userId: owner,
        companyName: 'Acme',
        jobTitle: 'Platform',
        aiStatus: 'INTERVIEW',
        userStatus: 'OFFER',
        userStatusRevision: 2,
      },
    });
    const res = await resolve(id, { action: 'link', applicationId: target.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, matchState: 'LINKED', applicationId: target.id });
    const record = await prisma.externalSubmission.findUniqueOrThrow({ where: { id } });
    expect(record).toMatchObject({
      matchState: 'LINKED',
      resolvedBy: 'USER',
      applicationId: target.id,
    });
    expect(record.resolvedAt).not.toBeNull();
    expect(await prisma.applicationEvent.findMany({ where: { externalSubmissionId: id } })).toEqual(
      [
        expect.objectContaining({
          applicationId: target.id,
          type: 'AUTOMATION_SUBMITTED',
          emailId: null,
          description: null,
        }),
      ],
    );
    expect(await prisma.application.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      appliedAt: new Date('2026-10-01T10:00:00Z'),
      aiStatus: 'INTERVIEW',
      userStatus: 'OFFER',
      userStatusRevision: 2,
    });
  });

  it('link keeps an existing appliedAt', async () => {
    const id = await pending();
    const target = await prisma.application.create({
      data: { userId: owner, companyName: 'Acme', appliedAt: new Date('2026-09-01T00:00:00Z') },
    });
    await resolve(id, { action: 'link', applicationId: target.id }).expect(200);
    expect(
      (await prisma.application.findUniqueOrThrow({ where: { id: target.id } })).appliedAt,
    ).toEqual(new Date('2026-09-01T00:00:00Z'));
  });

  it('create: CREATED by USER, built exactly as the automatic path does', async () => {
    const id = await pending();
    const res = await resolve(id, { action: 'create' });
    expect(res.status).toBe(200);
    const app = await prisma.application.findUniqueOrThrow({
      where: { id: res.body.applicationId },
    });
    expect(app).toMatchObject({
      userId: owner,
      companyName: 'Acme Inc.',
      jobTitle: 'Backend Engineer',
      location: 'Remote',
      appliedAt: new Date('2026-10-01T10:00:00Z'),
      aiStatus: null,
      userStatus: null,
    });
    expect(await prisma.externalSubmission.findUniqueOrThrow({ where: { id } })).toMatchObject({
      matchState: 'CREATED',
      resolvedBy: 'USER',
    });
    expect(await prisma.applicationEvent.count({ where: { externalSubmissionId: id } })).toBe(1);
  });

  it('ignore: IGNORED by USER, no application and no event', async () => {
    const id = await pending();
    const before = await prisma.application.count({ where: { userId: owner } });
    const res = await resolve(id, { action: 'ignore' });
    expect(res.body).toEqual({ id, matchState: 'IGNORED', applicationId: null });
    expect(await prisma.externalSubmission.findUniqueOrThrow({ where: { id } })).toMatchObject({
      matchState: 'IGNORED',
      resolvedBy: 'USER',
    });
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(before);
    expect(await prisma.applicationEvent.count({ where: { externalSubmissionId: id } })).toBe(0);
  });

  it('resolution is final: a second resolve and an automatically settled submission get 400', async () => {
    const id = await pending();
    await resolve(id, { action: 'ignore' }).expect(200);
    const again = await resolve(id, { action: 'create' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('BAD_REQUEST');
    const auto = await recordSubmission(owner, null, {
      sourceRecordRef: '2026-10-01/12:00:00',
      platform: 'indeed',
      company: 'Solo',
      jobTitle: 'Dev',
      submittedAt: '2026-10-01T10:00:00Z',
    });
    expect((await resolve(auto.recordId, { action: 'ignore' })).status).toBe(400);
  });

  it('404 for unknown and foreign submissions, 403 for foreign or absent applications', async () => {
    const foreign = await pending('2026-10-01/10:00:00', {}, other);
    expect((await resolve(foreign, { action: 'ignore' })).status).toBe(404);
    expect((await resolve(crypto.randomUUID(), { action: 'ignore' })).body.error.code).toBe(
      'NOT_FOUND',
    );
    expect(
      (await prisma.externalSubmission.findUniqueOrThrow({ where: { id: foreign } })).matchState,
    ).toBe('NEEDS_REVIEW');

    const id = await pending();
    const foreignApp = await prisma.application.create({
      data: { userId: other, companyName: 'Acme' },
    });
    const res = await resolve(id, { action: 'link', applicationId: foreignApp.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await resolve(id, { action: 'link', applicationId: crypto.randomUUID() })).status).toBe(
      403,
    );
    expect((await prisma.externalSubmission.findUniqueOrThrow({ where: { id } })).matchState).toBe(
      'NEEDS_REVIEW',
    );
  });

  it.each([
    [{ action: 'link' }],
    [{ action: 'link', applicationId: 'not-a-uuid' }],
    [{ action: 'unlink' }],
    [{ action: 'ignore', applicationId: crypto.randomUUID() }],
    [{}],
  ])('400 VALIDATION_ERROR for %j', async (body) => {
    const id = await pending();
    const res = await resolve(id, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a concurrent double resolve gives exactly one outcome', async () => {
    const id = await pending();
    const target = await prisma.application.create({
      data: { userId: owner, companyName: 'Acme', jobTitle: 'Other' },
    });
    const before = await prisma.application.count({ where: { userId: owner } });
    const results = await Promise.all([
      resolve(id, { action: 'link', applicationId: target.id }),
      resolve(id, { action: 'create' }),
      resolve(id, { action: 'ignore' }),
      resolve(id, { action: 'create' }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    const winner = results.find((r) => r.status === 200)!.body;
    const record = await prisma.externalSubmission.findUniqueOrThrow({ where: { id } });
    expect(record.matchState).toBe(winner.matchState);
    expect(await prisma.applicationEvent.count({ where: { externalSubmissionId: id } })).toBe(
      winner.matchState === 'IGNORED' ? 0 : 1,
    );
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(
      before + (winner.matchState === 'CREATED' ? 1 : 0),
    );
  });
});
