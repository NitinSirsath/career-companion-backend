import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma';
import { snoozeAction, updateActionStatus } from '../services/action';
import { archiveApplication } from '../services/archive';
import { listApplications } from '../services/application';
import { readWorkspaceActions } from '../services/workspace';
import { readAgenda, updateAgenda } from '../services/agenda';
import { AgendaQuerySchema } from '../contracts/agenda';
import { correctEmailMatch, matchEmailToApplication } from '../services/matcher';
import { recordSubmission } from '../services/externalSubmission';
import { candidateEnvelope } from '../services/ai/temporal';
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));
let owner: string, foreign: string, appId: string, otherApp: string;
const now = new Date('2026-10-03T06:30:00.000Z');
const query = { bucket: 'all' as const, timeZone: 'Asia/Kolkata', limit: 20, offset: 0 };
/**
 * A follow-up the user added by hand before the app stopped taking new ones (owner, 26 Oct
 * 2026). Saved ones stay, and can still be completed, snoozed and dismissed.
 */
const savedFollowUp = () =>
  prisma.action.create({
    data: {
      applicationId: appId,
      origin: 'USER',
      type: 'USER_FOLLOW_UP',
      description: 'Follow up with recruiter',
      deadline: new Date('2026-10-02T00:00:00.000Z'),
      deadlinePrecision: 'DATE',
      clientRequestId: randomUUID(),
      creationPayloadHash: 'fixture',
    },
  });
beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: `follow-${randomUUID()}@fixture.test` } })).id;
  foreign = (await prisma.user.create({ data: { email: `follow-${randomUUID()}@fixture.test` } }))
    .id;
});
beforeEach(async () => {
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.externalSubmission.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
  appId = (
    await prisma.application.create({
      data: {
        userId: owner,
        companyName: 'Follow Through',
        jobTitle: 'Engineer',
        userStatus: 'OFFER',
        userStatusRevision: 4,
      },
    })
  ).id;
  otherApp = (await prisma.application.create({ data: { userId: owner, companyName: 'Other' } }))
    .id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, foreign] } } });
  vi.unstubAllEnvs();
});
it('requires frozen revisions for personal work and preserves email evidence', async () => {
  const a = await savedFollowUp();
  await expect(updateActionStatus(owner, a.id, 'COMPLETED')).rejects.toMatchObject({
    code: 'REVISION_REQUIRED',
  });
  await updateActionStatus(owner, a.id, 'COMPLETED', 0);
  await expect(updateActionStatus(owner, a.id, 'COMPLETED', 0)).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
  const legacy = await prisma.action.create({
    data: { applicationId: appId, type: 'ACTION_REQUIRED', description: 'Source text' },
  });
  expect(await updateActionStatus(owner, legacy.id, 'DISMISSED')).toMatchObject({
    actionRevision: 1,
  });
});
it('snooze partitions full counts, retains deadline, wakes on read and suppresses notifications durably', async () => {
  const rows = await Promise.all(Array.from({ length: 25 }, () => savedFollowUp()));
  const until = '2026-10-03T07:00:00.000Z';
  await Promise.all(
    rows.map((a) =>
      snoozeAction(owner, a.id, { expectedActionRevision: 0, snoozedUntil: until }, now),
    ),
  );
  const visible = await readWorkspaceActions(owner, query, now),
    snoozed = await readWorkspaceActions(owner, { ...query, bucket: 'snoozed' }, now);
  expect(visible.items).toHaveLength(0);
  expect(visible.counts).toEqual({
    overdue: 0,
    today: 0,
    later: 0,
    undated: 0,
    snoozed: 25,
    totalPending: 25,
  });
  expect(visible.nextTransitionAt).toBe(until);
  expect(snoozed.items).toHaveLength(20);
  expect(
    (await readWorkspaceActions(owner, { ...query, bucket: 'snoozed', offset: 20 }, now)).items,
  ).toHaveLength(5);
  const awake = await readWorkspaceActions(owner, query, new Date(until));
  expect(awake.counts.overdue).toBe(25);
  expect(awake.counts.snoozed).toBe(0);
  expect(awake.items[0].deadline).toBe('2026-10-02T00:00:00.000Z');
  expect(
    await prisma.notificationDelivery.count({
      where: {
        actionId: { in: rows.map((a) => a.id) },
        status: 'FAILED_PERMANENT',
        errorDetails: 'USER_SUPPRESSED',
      },
    }),
  ).toBe(25);
  await updateActionStatus(owner, rows[0].id, 'COMPLETED', 1);
  expect(
    (await prisma.action.findUniqueOrThrow({ where: { id: rows[0].id } })).snoozedUntil,
  ).toBeNull();
  await expect(
    snoozeAction(
      owner,
      rows[1].id,
      { expectedActionRevision: 1, snoozedUntil: now.toISOString() },
      now,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_SNOOZE' });
  await expect(
    snoozeAction(
      owner,
      rows[1].id,
      { expectedActionRevision: 1, snoozedUntil: '2028-01-01T00:00:00Z' },
      now,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_SNOOZE' });
});
async function mail(applicationId = appId) {
  const email = await prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: randomUUID(),
      threadId: 'follow-thread',
      applicationId,
      matchState: 'MATCHED',
    },
  });
  await prisma.aIProcessingResult.create({
    data: {
      emailId: email.id,
      provider: 'fixture',
      model: 'fixture',
      contractVersion: 'extraction/v3',
      processingStatus: 'COMPLETED',
      relevanceDecision: 'RELEVANT',
      companyName: 'Follow Through',
      jobTitle: 'Engineer',
      actionRequired: true,
      requestedAction: 'Source action',
      scheduleCandidates: candidateEnvelope([
        {
          kind: 'INTERVIEW',
          change: 'SCHEDULED',
          date: '2026-10-04',
          time: null,
          sourceTimeZone: null,
          rawWhen: '2026-10-04',
          evidence: null,
        },
      ]),
    },
  });
  await matchEmailToApplication(email.id);
  return email;
}
it('archive/restore preserves independent status, agenda, linked mail and receipts', async () => {
  vi.stubEnv('AGENDA_EXTRACTION_V3_ENABLED', 'true');
  const a = await savedFollowUp();
  const e = await mail();
  const agenda = await prisma.agendaItem.findFirstOrThrow({ where: { emailId: e.id } });
  await updateAgenda(owner, agenda.id, { expectedRevision: 0, state: 'CONFIRMED' });
  const before = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
  const archived = await archiveApplication(owner, appId, {
    archived: true,
    expectedArchiveRevision: 0,
  });
  expect(archived).toMatchObject({
    archiveRevision: 1,
    userStatusRevision: 4,
    userStatus: 'OFFER',
  });
  expect((await listApplications(owner)).some((a) => a.id === appId)).toBe(false);
  expect((await listApplications(owner, 20, 0, { archive: 'archived' }))[0].id).toBe(appId);
  expect((await readWorkspaceActions(owner, query, now)).counts.totalPending).toBe(0);
  expect(
    (await readAgenda(owner, AgendaQuerySchema.parse({ view: 'upcoming' }), 20, 0, now)).items,
  ).toHaveLength(0);
  expect(
    (
      await readAgenda(
        owner,
        AgendaQuerySchema.parse({ view: 'history', archive: 'archived' }),
        20,
        0,
        now,
      )
    ).items,
  ).toHaveLength(1);
  await expect(updateActionStatus(owner, a.id, 'COMPLETED', 0)).rejects.toMatchObject({
    code: 'APPLICATION_ARCHIVED',
  });
  await expect(
    updateAgenda(owner, agenda.id, { expectedRevision: 1, state: 'CANCELLED' }),
  ).rejects.toMatchObject({ code: 'APPLICATION_ARCHIVED' });
  await expect(
    archiveApplication(owner, appId, { archived: false, expectedArchiveRevision: 0 }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(
    archiveApplication(foreign, appId, { archived: false, expectedArchiveRevision: 1 }),
  ).rejects.toMatchObject({ status: 404 });
  const next = await prisma.email.create({
    data: { userId: owner, gmailMessageId: randomUUID(), threadId: 'follow-thread' },
  });
  const source = await prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId: e.id } });
  await prisma.aIProcessingResult.create({
    data: {
      emailId: next.id,
      provider: 'fixture',
      model: 'fixture',
      contractVersion: 'extraction/v2',
      processingStatus: 'COMPLETED',
      companyName: source.companyName,
      jobTitle: source.jobTitle,
    },
  });
  await matchEmailToApplication(next.id);
  expect((await prisma.email.findUniqueOrThrow({ where: { id: next.id } })).applicationId).toBe(
    appId,
  );
  await archiveApplication(owner, appId, { archived: false, expectedArchiveRevision: 1 });
  const restored = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
  expect(restored).toMatchObject({
    userStatus: before.userStatus,
    userStatusRevision: before.userStatusRevision,
    archiveRevision: 2,
    archivedAt: null,
  });
  expect((await prisma.agendaItem.findUniqueOrThrow({ where: { id: agenda.id } })).state).toBe(
    'CONFIRMED',
  );
  expect(
    await prisma.action.findUnique({ where: { clientRequestId: a.clientRequestId! } }),
  ).toMatchObject({ id: a.id });
});
it('correction carries snooze and increments revisions without moving personal work', async () => {
  const personal = await savedFollowUp();
  const e = await mail();
  const action = await prisma.action.findFirstOrThrow({ where: { emailId: e.id } });
  await snoozeAction(
    owner,
    action.id,
    { expectedActionRevision: 0, snoozedUntil: '2026-10-03T07:00:00Z' },
    now,
  );
  await correctEmailMatch(owner, e.id, {
    expectedMatchState: 'MATCHED',
    expectedApplicationId: appId,
    applicationId: otherApp,
  });
  expect(await prisma.action.findUnique({ where: { id: personal.id } })).toMatchObject({
    applicationId: appId,
    retiredAt: null,
  });
  expect(await prisma.action.findUnique({ where: { id: action.id } })).toMatchObject({
    actionRevision: 2,
    retiredReason: 'EMAIL_MOVED',
  });
  expect(
    await prisma.action.findFirst({ where: { emailId: e.id, applicationId: otherApp } }),
  ).toMatchObject({ status: 'PENDING', snoozedUntil: new Date('2026-10-03T07:00:00Z') });
});
it('archived-only MCP candidate becomes reviewable while existing receipt replay keeps identity', async () => {
  const raw = {
    sourceRecordRef: '2026-10-03/10:00:00',
    platform: 'linkedin',
    company: 'Follow Through',
    jobTitle: 'Engineer',
    submittedAt: '2026-10-03T04:30:00Z',
  };
  const first = await recordSubmission(owner, null, raw, now);
  await archiveApplication(owner, appId, { archived: true, expectedArchiveRevision: 0 });
  expect(await recordSubmission(owner, null, raw, now)).toMatchObject({
    result: 'already_recorded',
    recordId: first.recordId,
  });
  const second = await recordSubmission(
    owner,
    null,
    { ...raw, sourceRecordRef: '2026-10-03/10:00:01' },
    now,
  );
  expect(
    await prisma.externalSubmission.findUnique({ where: { id: second.recordId } }),
  ).toMatchObject({ matchState: 'NEEDS_REVIEW', applicationId: null });
  expect(
    await prisma.application.count({ where: { userId: owner, companyName: 'Follow Through' } }),
  ).toBe(1);
  expect(
    await prisma.externalSubmission.findUnique({ where: { id: first.recordId } }),
  ).toMatchObject({ applicationId: appId });
});
it('MCP intake waits on an observed archive row lock and routes the stale candidate to review', async () => {
  let locked!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      locked = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM applications WHERE id=${appId}::uuid FOR UPDATE`;
      await tx.application.update({
        where: { id: appId },
        data: { archivedAt: now, archiveRevision: 1 },
      });
      locked();
      await gate;
    },
    { timeout: 15000 },
  );
  await ready;
  const raw = {
    sourceRecordRef: '2026-10-03/10:00:02',
    platform: 'linkedin',
    company: 'Follow Through',
    jobTitle: 'Engineer',
    submittedAt: '2026-10-03T04:30:00Z',
  };
  const recording = recordSubmission(owner, null, raw, now);
  try {
    await vi.waitFor(async () => {
      const rows = await prisma.$queryRaw<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id, "archivedAt" FROM applications%'`;
      expect(rows[0].n).toBeGreaterThan(0);
    });
    release();
    await holder;
    const result = await recording;
    expect(
      await prisma.externalSubmission.findUnique({ where: { id: result.recordId } }),
    ).toMatchObject({ matchState: 'NEEDS_REVIEW', applicationId: null });
    expect(
      await prisma.application.count({ where: { userId: owner, companyName: 'Follow Through' } }),
    ).toBe(1);
  } finally {
    release();
    await holder;
  }
});
it('competing archive and completing a personal step serialize without changing archived work', async () => {
  const a = await savedFollowUp();
  const outcomes = await Promise.allSettled([
    archiveApplication(owner, appId, { archived: true, expectedArchiveRevision: 0 }),
    updateActionStatus(owner, a.id, 'COMPLETED', 0),
  ]);
  expect(outcomes[0].status).toBe('fulfilled');
  if (outcomes[1].status === 'rejected')
    expect(outcomes[1].reason).toMatchObject({ code: 'APPLICATION_ARCHIVED' });
  else
    expect((await prisma.action.findUniqueOrThrow({ where: { id: a.id } })).actionRevision).toBe(1);
  await expect(updateActionStatus(owner, a.id, 'PENDING', 1)).rejects.toMatchObject({
    code: 'APPLICATION_ARCHIVED',
  });
});
