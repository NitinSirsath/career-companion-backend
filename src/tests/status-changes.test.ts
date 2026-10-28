import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { EmailCategory } from '@prisma/client';
import { prisma } from '../db/prisma';
import { applyMatch, correctEmailMatch } from '../services/matcher';
import { updateUserStatus } from '../services/application';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));

let owner: string;
let a: string;
let b: string;

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: 'status-changes@fixture.test' } })).id;
});
beforeEach(async () => {
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
  a = (await prisma.application.create({ data: { userId: owner, companyName: 'A' } })).id;
  b = (await prisma.application.create({ data: { userId: owner, companyName: 'B' } })).id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: owner } });
});

async function mail(category: EmailCategory, receivedAt: Date, applicationId = a) {
  const email = await prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: randomUUID(),
      threadId: randomUUID(),
      relevanceState: 'RELEVANT',
      receivedAt,
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
      companyName: 'A',
    },
  });
  await applyMatch(email.id, applicationId, result, 'AI_AUTO');
  return email.id;
}

const changes = (applicationId = a) =>
  prisma.statusChange.findMany({
    where: { applicationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

const setStatus = async (userStatus: 'APPLIED' | 'REJECTED' | null) => {
  const app = await prisma.application.findUniqueOrThrow({ where: { id: a } });
  return updateUserStatus(owner, a, {
    userStatus,
    expectedUserStatusRevision: app.userStatusRevision,
  });
};

it('keeps each AI step with the time the mail arrived', async () => {
  const day1 = new Date('2026-10-01T10:00:00Z');
  const day5 = new Date('2026-10-05T10:00:00Z');
  const recruiter = await mail('RECRUITER', day1);
  const interview = await mail('INTERVIEW', day5);
  expect(await changes()).toMatchObject([
    {
      source: 'AI',
      fromStatus: null,
      toStatus: 'RECRUITER_CONTACT',
      changedAt: day1,
      emailId: recruiter,
    },
    {
      source: 'AI',
      fromStatus: 'RECRUITER_CONTACT',
      toStatus: 'INTERVIEW',
      changedAt: day5,
      emailId: interview,
    },
  ]);
});

it('writes no row when a mail does not move the status', async () => {
  await mail('INTERVIEW', new Date('2026-10-05T10:00:00Z'));
  await mail('RECRUITER', new Date('2026-10-06T10:00:00Z'));
  expect(await changes()).toHaveLength(1);
});

it('a rejected job keeps the steps it reached before', async () => {
  await mail('INTERVIEW', new Date('2026-10-05T10:00:00Z'));
  await mail('REJECTION', new Date('2026-10-09T10:00:00Z'));
  expect((await changes()).map((c) => c.toStatus)).toEqual(['INTERVIEW', 'REJECTED']);
});

it("records the user's own status when they set and clear it", async () => {
  await mail('RECRUITER', new Date('2026-10-01T10:00:00Z'));
  await setStatus('REJECTED');
  await setStatus(null);
  expect(await changes()).toMatchObject([
    { source: 'AI', toStatus: 'RECRUITER_CONTACT' },
    { source: 'USER', fromStatus: 'RECRUITER_CONTACT', toStatus: 'REJECTED', emailId: null },
    { source: 'USER', fromStatus: 'REJECTED', toStatus: 'RECRUITER_CONTACT' },
  ]);
});

it("an AI change hidden by the user's own status writes no row", async () => {
  await setStatus('APPLIED');
  await mail('INTERVIEW', new Date('2026-10-05T10:00:00Z'));
  expect((await changes()).map((c) => [c.source, c.toStatus])).toEqual([['USER', 'APPLIED']]);
});

it('a mail moved away takes its steps along and the status is worked out again', async () => {
  await mail('RECRUITER', new Date('2026-10-01T10:00:00Z'));
  const interview = await mail('INTERVIEW', new Date('2026-10-05T10:00:00Z'));
  await correctEmailMatch(owner, interview, {
    applicationId: b,
    expectedApplicationId: a,
    expectedMatchState: 'MATCHED',
  });
  const onA = await changes();
  expect(onA.find((c) => c.emailId === interview)?.retiredAt).toBeInstanceOf(Date);
  expect(onA.at(-1)).toMatchObject({
    source: 'AI',
    fromStatus: 'INTERVIEW',
    toStatus: 'RECRUITER_CONTACT',
    emailId: null,
    retiredAt: null,
  });
  expect(await changes(b)).toMatchObject([
    { source: 'AI', fromStatus: null, toStatus: 'INTERVIEW', emailId: interview, retiredAt: null },
  ]);
});

it('the log goes with its application', async () => {
  await mail('RECRUITER', new Date('2026-10-01T10:00:00Z'));
  await prisma.application.delete({ where: { id: a } });
  expect(await prisma.statusChange.count({ where: { applicationId: a } })).toBe(0);
});

it('the one-time fill writes the same rows as the live code', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../../prisma/migrations/20261027100000_status_changes/migration.sql'),
    'utf8',
  );
  const fill = sql
    .slice(sql.indexOf('WITH step AS'))
    .split(/;\s*\n/)
    .filter((s) => s.trim());
  const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T09:00:00Z`);
  await mail('FOLLOW_UP', at(1));
  await mail('INTERVIEW', at(7));
  await mail('RECRUITER', at(3));
  await mail('REJECTION', at(10));
  await mail('NEWSLETTER', at(11));
  await mail('RECRUITER', at(2), b);
  const app = await prisma.application.findUniqueOrThrow({ where: { id: b } });
  await updateUserStatus(owner, b, {
    userStatus: 'CLOSED',
    expectedUserStatusRevision: app.userStatusRevision,
  });
  const shape = async () =>
    (await prisma.statusChange.findMany({ where: { applicationId: { in: [a, b] } } }))
      .map((c) => [c.applicationId, c.emailId, c.source, c.fromStatus, c.toStatus].join(' '))
      .sort();
  const live = await shape();
  await prisma.statusChange.deleteMany({ where: { applicationId: { in: [a, b] } } });
  for (const statement of fill) await prisma.$executeRawUnsafe(statement);
  const filled = await shape();
  expect(filled.filter((r) => r.startsWith(b))).toEqual(live.filter((r) => r.startsWith(b)));
  // Mails read out of order: the live rows follow reading, the fill follows arrival.
  const rowsA = await prisma.statusChange.findMany({
    where: { applicationId: a },
    orderBy: { changedAt: 'asc' },
  });
  expect(rowsA.map((c) => [c.fromStatus, c.toStatus, c.changedAt])).toEqual([
    [null, 'APPLIED', at(1)],
    ['APPLIED', 'RECRUITER_CONTACT', at(3)],
    ['RECRUITER_CONTACT', 'INTERVIEW', at(7)],
    ['INTERVIEW', 'REJECTED', at(10)],
  ]);
});
