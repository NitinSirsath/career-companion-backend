// S6-03 matching interleavings with deterministic barriers (not sequential replay).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AIProcessingResult, Prisma } from '@prisma/client';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { applyMatch, matchEmailToApplication, resolveEmailMatch } from '../services/matcher';

vi.mock('../jobs/notificationJob', () => ({ enqueueNotificationJob: vi.fn() }));

const OWNER = 'race-owner@s6m.test';
let owner: string;

const barrier = () => {
  let open!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const arrived = new Promise<void>((r) => (reached = r));
  return { gate, arrived, open, reached };
};

async function relevantEmail(
  gmailMessageId: string,
  ai: Partial<Prisma.AIProcessingResultUncheckedCreateInput>,
  matchState: 'UNMATCHED' | 'AMBIGUOUS' = 'UNMATCHED',
) {
  const email = await prisma.email.create({
    data: { userId: owner, gmailMessageId, relevanceState: 'RELEVANT', matchState },
  });
  const result = await prisma.aIProcessingResult.create({
    data: {
      emailId: email.id,
      provider: 't',
      model: 't',
      contractVersion: 't',
      processingStatus: 'COMPLETED',
      ...ai,
    },
  });
  return { email, result: result as AIProcessingResult };
}
const application = (
  companyName: string,
  data: Partial<Prisma.ApplicationUncheckedCreateInput> = {},
) => prisma.application.create({ data: { userId: owner, companyName, ...data } });
const effects = async (emailId: string) => ({
  email: await prisma.email.findUniqueOrThrow({
    where: { id: emailId },
    select: { applicationId: true, matchState: true, matchConfirmedBy: true },
  }),
  events: await prisma.applicationEvent.findMany({
    where: { emailId },
    select: { applicationId: true },
  }),
  actions: await prisma.action.findMany({ where: { emailId }, select: { applicationId: true } }),
});

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@s6m.test' } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@s6m.test' } } });
});

describe('distinct and duplicate processing', () => {
  it('keeps each distinct email effect on one application and preserves manual fields', async () => {
    const target = await application('Parallel Co', {
      aiStatus: 'APPLIED',
      userStatus: 'OFFER',
      userStatusSetAt: new Date('2026-09-01T00:00:00Z'),
      userStatusRevision: 4,
    });
    const emails = await Promise.all(
      ['ASSESSMENT', 'INTERVIEW', 'RECRUITER'].map((category, i) =>
        relevantEmail(`parallel-${i}`, {
          category: category as never,
          actionRequired: true,
          requestedAction: `Do ${i}`,
        }),
      ),
    );
    await Promise.all(
      emails.map(({ email, result }) => applyMatch(email.id, target.id, result, 'AI_AUTO')),
    );
    for (const { email } of emails) {
      const e = await effects(email.id);
      expect(e.events).toEqual([{ applicationId: target.id }]);
      expect(e.actions).toEqual([{ applicationId: target.id }]);
    }
    const after = await prisma.application.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.aiStatus).toBe('INTERVIEW'); // highest monotonic AI state, regardless of finish order
    expect(after).toMatchObject({
      userStatus: 'OFFER',
      userStatusRevision: 4,
      userStatusSetAt: new Date('2026-09-01T00:00:00Z'),
    });
  });

  it('keeps one event and action when the same email is processed concurrently', async () => {
    const target = await application('Dup Co');
    const { email, result } = await relevantEmail('dup', {
      companyName: 'Dup Co',
      category: 'INTERVIEW',
      actionRequired: true,
    });
    await Promise.all(Array.from({ length: 5 }, () => matchEmailToApplication(email.id)));
    const e = await effects(email.id);
    expect(e.events).toHaveLength(1);
    expect(e.actions).toHaveLength(1);
    expect(result.emailId).toBe(email.id);
    expect(e.email.applicationId).toBe(target.id);
  });
});

describe('stale automatic selection versus user decisions', () => {
  // Pause the matcher right after its pre-lock candidate read.
  function pauseAfterCandidateRead() {
    const b = barrier();
    const original = prisma.application.findMany.bind(prisma.application);
    vi.spyOn(prisma.application, 'findMany').mockImplementation((async (args: unknown) => {
      const rows = await original(args as never);
      b.reached();
      await b.gate;
      return rows;
    }) as never);
    return b;
  }

  it('does not overwrite a user link made after the automatic candidate read', async () => {
    const auto = await application('Stale Co');
    const chosen = await application('Chosen Co');
    const { email } = await relevantEmail('stale-link', {
      companyName: 'Stale Co',
      category: 'INTERVIEW',
      actionRequired: true,
    });
    const pause = pauseAfterCandidateRead();
    const matching = matchEmailToApplication(email.id);
    await pause.arrived;
    vi.mocked(prisma.application.findMany).mockRestore();
    await resolveEmailMatch(owner, email.id, chosen.id);
    pause.open();
    await matching;
    const e = await effects(email.id);
    expect(e.email).toEqual({
      applicationId: chosen.id,
      matchState: 'MATCHED',
      matchConfirmedBy: 'USER_CONFIRMED',
    });
    expect(e.events).toEqual([{ applicationId: chosen.id }]);
    expect(e.actions).toEqual([{ applicationId: chosen.id }]);
    expect(await prisma.applicationEvent.count({ where: { applicationId: auto.id } })).toBe(0);
  });

  it('does not overwrite a user ignore made after the ambiguous candidate read', async () => {
    await application('Twin Co', { jobTitle: 'A' });
    await application('Twin Co', { jobTitle: 'B' });
    const { email } = await relevantEmail('stale-ignore', { companyName: 'Twin Co' }, 'AMBIGUOUS');
    const pause = pauseAfterCandidateRead();
    const matching = matchEmailToApplication(email.id);
    await pause.arrived;
    vi.mocked(prisma.application.findMany).mockRestore();
    await resolveEmailMatch(owner, email.id, null);
    pause.open();
    await matching;
    expect((await effects(email.id)).email).toEqual({
      applicationId: null,
      matchState: 'IGNORED',
      matchConfirmedBy: 'USER_CONFIRMED',
    });
  });

  it('rejects a user link whose pre-lock read predates a completed automatic match', async () => {
    // Sequentially this resolution is INVALID_MATCH_STATE; the race must not produce a different result.
    const auto = await application('Auto Co');
    const chosen = await application('Other Co');
    const { email, result } = await relevantEmail('late-user', {
      category: 'INTERVIEW',
      actionRequired: true,
    });
    const b = barrier();
    const original = prisma.application.findUnique.bind(prisma.application);
    vi.spyOn(prisma.application, 'findUnique').mockImplementation((async (args: unknown) => {
      b.reached();
      await b.gate;
      return original(args as never);
    }) as never);
    const resolving = resolveEmailMatch(owner, email.id, chosen.id);
    await b.arrived; // user read UNMATCHED; now the automatic match commits first
    await applyMatch(email.id, auto.id, result, 'AI_AUTO');
    b.open();
    await expect(resolving).rejects.toThrow('INVALID_MATCH_STATE');
    const e = await effects(email.id);
    expect(e.email).toEqual({
      applicationId: auto.id,
      matchState: 'MATCHED',
      matchConfirmedBy: 'AI_AUTO',
    });
    expect(e.events).toEqual([{ applicationId: auto.id }]);
    expect(e.actions).toEqual([{ applicationId: auto.id }]);
  });
});

describe('competing user resolutions', () => {
  const resolve = (emailId: string, applicationId: string | null) =>
    request(app)
      .post(`/api/emails/${emailId}/resolve`)
      .set('X-Development-User', OWNER)
      .send({ applicationId });

  it('link versus link: one decision is accepted and effects stay on it', async () => {
    const a = await application('Link A');
    const b = await application('Link B');
    const { email } = await relevantEmail('link-link', {
      category: 'INTERVIEW',
      actionRequired: true,
    });
    const results = await Promise.all([resolve(email.id, a.id), resolve(email.id, b.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = results[0].status === 200 ? a.id : b.id;
    const e = await effects(email.id);
    expect(e.email).toEqual({
      applicationId: winner,
      matchState: 'MATCHED',
      matchConfirmedBy: 'USER_CONFIRMED',
    });
    expect(e.events).toEqual([{ applicationId: winner }]);
    expect(e.actions).toEqual([{ applicationId: winner }]);
  });

  it('link versus ignore: exactly one decision is accepted', async () => {
    const a = await application('Amb Co', { jobTitle: 'A' });
    await application('Amb Co', { jobTitle: 'B' });
    const { email } = await relevantEmail('link-ignore', { category: 'INTERVIEW' }, 'AMBIGUOUS');
    const results = await Promise.all([resolve(email.id, a.id), resolve(email.id, null)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const e = await effects(email.id);
    if (results[0].status === 200) {
      expect(e.email).toEqual({
        applicationId: a.id,
        matchState: 'MATCHED',
        matchConfirmedBy: 'USER_CONFIRMED',
      });
      expect(e.events).toEqual([{ applicationId: a.id }]);
    } else {
      expect(e.email).toEqual({
        applicationId: null,
        matchState: 'IGNORED',
        matchConfirmedBy: 'USER_CONFIRMED',
      });
      expect(e.events).toEqual([]);
    }
  });

  it('preserves deliberate ambiguity without creating or merging applications', async () => {
    await application('Same Co');
    await application('Same Co');
    const { email } = await relevantEmail('ambiguous', { companyName: 'Same Co' });
    await Promise.all([matchEmailToApplication(email.id), matchEmailToApplication(email.id)]);
    expect((await effects(email.id)).email.matchState).toBe('AMBIGUOUS');
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(2);
  });
});
