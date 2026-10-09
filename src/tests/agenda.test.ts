import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma';
import { resolveTemporal } from '../contracts/temporal';
import { AgendaQuerySchema } from '../contracts/agenda';
import { candidateEnvelope, verifiedCandidates } from '../services/ai/temporal';
import { readAgenda, updateAgenda } from '../services/agenda';
import { selectExtractionContract, EmailAIPipeline } from '../services/ai/pipeline';
import { MatcherService } from '../services/matcher';
import { GmailFetcherService } from '../services/gmailFetcher';
vi.mock('../jobs/notificationJob', () => ({
  enqueueNotificationJob: vi.fn(() => {
    throw Error('Unexpected notification');
  }),
}));
const candidate = {
  kind: 'INTERVIEW' as const,
  change: 'SCHEDULED' as const,
  rawWhen: '2026-10-04',
  evidence: 'Interview on 2026-10-04',
  date: '2026-10-04',
  time: null,
  sourceTimeZone: null,
};
const now = new Date('2026-10-03T12:00:00Z');
let userId: string, foreign: string, appId: string, target: string, emailId: string;
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `agenda-${randomUUID()}@fixture.test` } }))
    .id;
  foreign = (await prisma.user.create({ data: { email: `agenda-${randomUUID()}@fixture.test` } }))
    .id;
});
beforeEach(async () => {
  vi.stubEnv('AGENDA_EXTRACTION_V3_ENABLED', 'true');
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.application.deleteMany({ where: { userId } });
  appId = (
    await prisma.application.create({
      data: { userId, companyName: 'Agenda fixture', userStatus: 'CLOSED', userStatusRevision: 4 },
    })
  ).id;
  target = (await prisma.application.create({ data: { userId, companyName: 'Target fixture' } }))
    .id;
  emailId = (
    await prisma.email.create({
      data: {
        userId,
        gmailMessageId: randomUUID(),
        applicationId: appId,
        matchState: 'MATCHED',
        receivedAt: now,
      },
    })
  ).id;
  await prisma.aIProcessingResult.create({
    data: {
      emailId,
      provider: 'fixture',
      model: 'fixture',
      contractVersion: 'extraction/v3',
      processingStatus: 'COMPLETED',
      relevanceDecision: 'RELEVANT',
      scheduleCandidates: candidateEnvelope([candidate]),
    },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.user.deleteMany({ where: { id: { in: [userId, foreign] } } });
});
async function project() {
  await MatcherService.matchEmailToApplication(emailId);
  return prisma.agendaItem.findFirstOrThrow({ where: { emailId, applicationId: appId } });
}
const query = (view: 'review' | 'upcoming' | 'past' | 'history') =>
  AgendaQuerySchema.parse({ view, timeZone: 'Asia/Kolkata' });
it.each([
  [{ date: '2026-10-04', time: null, sourceTimeZone: null }, 'DATE', null],
  [
    { date: '2026-10-04', time: '14:30', sourceTimeZone: '+05:30' },
    'DATETIME',
    '2026-10-04T09:00:00.000Z',
  ],
  [
    { date: '2026-10-04', time: '14:30', sourceTimeZone: 'Asia/Kolkata' },
    'DATETIME',
    '2026-10-04T09:00:00.000Z',
  ],
  [
    { date: '2026-03-08', time: '02:30', sourceTimeZone: 'America/Los_Angeles' },
    'UNRESOLVED',
    null,
  ],
  [
    { date: '2026-11-01', time: '01:30', sourceTimeZone: 'America/Los_Angeles' },
    'UNRESOLVED',
    null,
  ],
  [{ date: '2026-10-04', time: '14:30', sourceTimeZone: 'IST' }, 'UNRESOLVED', null],
  [{ date: '2026-10-04', time: '14:30', sourceTimeZone: null }, 'UNRESOLVED', null],
  [{ date: '2026-02-29', time: null, sourceTimeZone: null }, 'UNRESOLVED', null],
  [{ date: null, time: '14:30', sourceTimeZone: 'UTC' }, 'UNRESOLVED', null],
] as const)('preserves temporal certainty %j', (input, precision, instant) => {
  expect(resolveTemporal(input)).toMatchObject({ precision, instant });
});
it('only stores verified bounded excerpts', () => {
  expect(verifiedCandidates([candidate], 'Interview\n on 2026-10-04')[0].evidence).toBe(
    candidate.evidence,
  );
  expect(verifiedCandidates([candidate], 'Unrelated message')[0].evidence).toBeNull();
  expect(() => candidateEnvelope(Array(6).fill(candidate))).toThrow();
});
it('pins v2 held/completed/pending claims and keeps selected v3 after disable', async () => {
  for (const status of ['PENDING', 'PROCESSING', 'UNKNOWN', 'FAILED', 'COMPLETED'] as const) {
    await prisma.aIOperation.deleteMany({ where: { emailId } });
    await prisma.aIOperation.create({
      data: { emailId, operation: 'extraction', version: 'extraction/v2', status },
    });
    expect((await selectExtractionContract(userId, emailId)).version).toBe('extraction/v2');
    expect(await prisma.aIOperation.count({ where: { emailId, operation: 'extraction' } })).toBe(1);
  }
  await prisma.aIOperation.deleteMany({ where: { emailId } });
  expect(
    (
      await Promise.all([
        selectExtractionContract(userId, emailId),
        selectExtractionContract(userId, emailId),
      ])
    ).map((c) => c.version),
  ).toEqual(['extraction/v3', 'extraction/v3']);
  vi.stubEnv('AGENDA_EXTRACTION_V3_ENABLED', 'false');
  expect((await selectExtractionContract(userId, emailId)).version).toBe('extraction/v3');
});
it('adopts completed v2/v3 without fetching Gmail or calling a provider', async () => {
  const fetch = vi
    .spyOn(GmailFetcherService, 'fetchMessageMetadata')
    .mockRejectedValue(Error('Unexpected fetch'));
  for (const version of ['extraction/v2', 'extraction/v3']) {
    await prisma.aIProcessingResult.update({
      where: { emailId },
      data: { contractVersion: version },
    });
    await EmailAIPipeline.processEmail(userId, emailId);
  }
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
  expect(await prisma.aIOperation.count({ where: { emailId } })).toBe(0);
});
it('projects once, confirms date-only, rejects stale no-op and isolates ownership', async () => {
  const row = await project();
  await project();
  expect(await prisma.agendaItem.count({ where: { emailId } })).toBe(1);
  expect((await readAgenda(userId, query('upcoming'), 20, 0, now)).items).toHaveLength(0);
  expect((await readAgenda(userId, query('review'), 20, 0, now)).items).toHaveLength(1);
  const saved = await updateAgenda(userId, row.id, { expectedRevision: 0, state: 'CONFIRMED' });
  expect(saved.timing.precision).toBe('DATE');
  expect(saved.suggestion).toMatchObject(candidate);
  await expect(
    updateAgenda(userId, row.id, { expectedRevision: 0, state: 'CONFIRMED' }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(
    updateAgenda(foreign, row.id, { expectedRevision: 1, state: 'CANCELLED' }),
  ).rejects.toMatchObject({ status: 404 });
  expect((await readAgenda(foreign, query('history'), 20, 0, now)).items).toHaveLength(0);
  expect((await readAgenda(userId, query('upcoming'), 20, 0, now)).items).toHaveLength(1);
});
it('retains source decisions across move/unlink/restore without status or provider changes', async () => {
  const row = await project();
  await updateAgenda(userId, row.id, { expectedRevision: 0, state: 'CONFIRMED' });
  await MatcherService.correctEmailMatch(userId, emailId, {
    expectedMatchState: 'MATCHED',
    expectedApplicationId: appId,
    applicationId: target,
  });
  const moved = await prisma.agendaItem.findFirstOrThrow({
    where: { emailId, applicationId: target },
  });
  expect(moved.state).toBe('CONFIRMED');
  expect(moved.decisionSourceId).toBe(row.id);
  await expect(
    updateAgenda(userId, row.id, { expectedRevision: 2, state: 'CANCELLED' }),
  ).rejects.toMatchObject({ code: 'AGENDA_RETIRED' });
  await updateAgenda(userId, moved.id, { expectedRevision: 0, state: 'CANCELLED' });
  await MatcherService.correctEmailMatch(userId, emailId, {
    expectedMatchState: 'MATCHED',
    expectedApplicationId: target,
    applicationId: null,
  });
  await MatcherService.correctEmailMatch(userId, emailId, {
    expectedMatchState: 'IGNORED',
    expectedApplicationId: null,
    applicationId: target,
  });
  expect((await prisma.agendaItem.findUniqueOrThrow({ where: { id: moved.id } })).state).toBe(
    'CANCELLED',
  );
  expect(await prisma.application.findUniqueOrThrow({ where: { id: appId } })).toMatchObject({
    userStatus: 'CLOSED',
    userStatusRevision: 4,
  });
  expect((await readAgenda(userId, query('history'), 20, 0, now)).items).toHaveLength(2);
});
it('validates unresolved writes and paginates review without hiding uncertain items', async () => {
  const row = await project();
  await expect(
    updateAgenda(userId, row.id, {
      expectedRevision: 0,
      timing: { date: '2026-10-04', time: '14:00', sourceTimeZone: null },
      state: 'CONFIRMED',
    }),
  ).rejects.toMatchObject({ code: 'TIMING_UNRESOLVED' });
  await prisma.agendaItem.createMany({
    data: Array.from({ length: 24 }, (_, i) => ({
      userId,
      applicationId: appId,
      emailId,
      candidateKey: `extra-${i}`,
      extractionVersion: 'extraction/v3',
      suggestion: {
        ...candidate,
        key: `extra-${i}`,
        temporal: resolveTemporal({ date: null, time: null, sourceTimeZone: null }),
      },
      precision: 'UNRESOLVED',
    })),
  });
  const a = await readAgenda(userId, query('review'), 20, 0, now),
    b = await readAgenda(userId, query('review'), 20, 20, now);
  expect(a.items).toHaveLength(20);
  expect(b.items).toHaveLength(5);
  expect(new Set([...a.items, ...b.items].map((r) => r.id)).size).toBe(25);
  expect(
    AgendaQuerySchema.safeParse({ view: 'review', from: '2026-10-01', to: '2026-10-10' }).success,
  ).toBe(false);
  const other = await prisma.application.create({
    data: { userId: foreign, companyName: 'Foreign' },
  });
  await expect(
    prisma.agendaItem.create({
      data: {
        userId,
        applicationId: other.id,
        emailId,
        candidateKey: 'foreign',
        extractionVersion: 'extraction/v3',
        suggestion: {},
        precision: 'UNRESOLVED',
      },
    }),
  ).rejects.toThrow();
});

it('serializes an observed edit/correction interleaving under the shared lock order', async () => {
  const row = await project();
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM emails WHERE id=${emailId}::uuid FOR UPDATE`;
      locked();
      await gate;
    },
    { timeout: 15000 },
  );
  await ready;
  const editing = updateAgenda(userId, row.id, { expectedRevision: 0, state: 'CONFIRMED' });
  try {
    await vi.waitFor(async () => {
      const waiting = await prisma.$queryRaw<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM emails%'`;
      expect(waiting[0].n).toBeGreaterThan(0);
    });
    const moving = MatcherService.correctEmailMatch(userId, emailId, {
      expectedMatchState: 'MATCHED',
      expectedApplicationId: appId,
      applicationId: target,
    });
    release();
    await holder;
    await editing;
    await moving;
    expect(
      await prisma.agendaItem.findFirst({ where: { emailId, applicationId: target } }),
    ).toMatchObject({ state: 'CONFIRMED' });
    expect(await prisma.agendaItem.findUnique({ where: { id: row.id } })).toMatchObject({
      revision: 2,
      retiredReason: 'EMAIL_MOVED',
    });
  } finally {
    release();
    await holder;
  }
});
