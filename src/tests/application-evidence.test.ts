import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { ApplicationResponseSchema, ListApplicationEventsResponseSchema } from '../contracts';
import * as gmailFetcher from '../services/gmailFetcher';

const OWNER = 'evidence-owner@s6e.test';
const OTHER = 'evidence-other@s6e.test';
let ownerId: string;
let otherId: string;
let appId: string;

const events = (id = appId, offset = 0, user = OWNER) =>
  request(app)
    .get(`/api/applications/${id}/events?offset=${offset}`)
    .set('X-Development-User', user);

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@s6e.test' } } });
  ownerId = (await prisma.user.create({ data: { email: OWNER } })).id;
  otherId = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await prisma.application.deleteMany({ where: { userId: { in: [ownerId, otherId] } } });
  await prisma.email.deleteMany({ where: { userId: { in: [ownerId, otherId] } } });
  appId = (
    await prisma.application.create({ data: { userId: ownerId, companyName: 'Evidence Co' } })
  ).id;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@s6e.test' } } });
});

describe('event source evidence', () => {
  it('returns owned bounded source metadata with distinct recording and email dates', async () => {
    const email = await prisma.email.create({
      data: {
        userId: ownerId,
        gmailMessageId: 'ev-1',
        subject: 'Interview <b>invite</b>',
        sender: 'hr@evidence.example',
        receivedAt: new Date('2026-09-01T08:00:00.000Z'),
      },
    });
    const event = await prisma.applicationEvent.create({
      data: {
        applicationId: appId,
        emailId: email.id,
        type: 'EMAIL_PROCESSED',
        oldState: null,
        newState: 'INTERVIEW',
        createdAt: new Date('2026-09-03T10:00:00.000Z'),
        provenance: 'AI said so',
      },
    });
    const fetcher = vi.spyOn(gmailFetcher, 'fetchMessageBody');
    const res = await events();
    expect(res.status).toBe(200);
    const page = ListApplicationEventsResponseSchema.parse(res.body);
    expect(page.items[0]).toMatchObject({
      id: event.id,
      emailId: email.id,
      recordedAt: '2026-09-03T10:00:00.000Z',
      sourceEmail: {
        id: email.id,
        subject: 'Interview <b>invite</b>',
        sender: 'hr@evidence.example',
        receivedAt: '2026-09-01T08:00:00.000Z',
      },
    });
    expect(new Date(page.items[0].createdAt as string).toISOString()).toBe(
      page.items[0].recordedAt,
    );
    expect(Object.keys(page.items[0].sourceEmail!).sort()).toEqual([
      'id',
      'receivedAt',
      'sender',
      'subject',
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns explicit null for an event without a source and keeps nullable metadata', async () => {
    const email = await prisma.email.create({
      data: { userId: ownerId, gmailMessageId: 'ev-null' },
    });
    await prisma.applicationEvent.create({
      data: {
        applicationId: appId,
        type: 'NOTE_ADDED',
        createdAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
    await prisma.applicationEvent.create({
      data: {
        applicationId: appId,
        emailId: email.id,
        type: 'EMAIL_PROCESSED',
        createdAt: new Date('2026-09-02T00:00:00Z'),
      },
    });
    const page = ListApplicationEventsResponseSchema.parse((await events()).body);
    expect(page.items[0].sourceEmail).toBeNull();
    expect(page.items[1].sourceEmail).toEqual({
      id: email.id,
      subject: null,
      sender: null,
      receivedAt: null,
    });
  });

  it('labels each event with the provider and model that produced its AI result (ADR-0001)', async () => {
    const analyzed = await prisma.email.create({
      data: { userId: ownerId, gmailMessageId: 'ev-ai' },
    });
    await prisma.aIProcessingResult.create({
      data: {
        emailId: analyzed.id,
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        contractVersion: 'extraction/v2',
      },
    });
    const plain = await prisma.email.create({
      data: { userId: ownerId, gmailMessageId: 'ev-plain' },
    });
    await prisma.applicationEvent.create({
      data: {
        applicationId: appId,
        emailId: analyzed.id,
        type: 'EMAIL_PROCESSED',
        createdAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
    await prisma.applicationEvent.create({
      data: {
        applicationId: appId,
        emailId: plain.id,
        type: 'EMAIL_PROCESSED',
        createdAt: new Date('2026-09-02T00:00:00Z'),
      },
    });
    await prisma.applicationEvent.create({
      data: {
        applicationId: appId,
        type: 'NOTE_ADDED',
        createdAt: new Date('2026-09-03T00:00:00Z'),
      },
    });
    const page = ListApplicationEventsResponseSchema.parse((await events()).body);
    expect(page.items.map((e) => e.analyzedBy)).toEqual([
      { provider: 'gemini', model: 'gemini-2.5-flash' },
      null,
      null,
    ]);
  });

  it('keeps recording order with id tie-breaks across capped pages', async () => {
    const tie = new Date('2026-09-05T00:00:00Z');
    await prisma.applicationEvent.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        applicationId: appId,
        type: `T${i}`,
        createdAt: i < 5 ? tie : new Date(tie.getTime() + i * 1000),
      })),
    });
    const first = ListApplicationEventsResponseSchema.parse((await events()).body);
    const second = ListApplicationEventsResponseSchema.parse((await events(appId, 20)).body);
    expect(first.items).toHaveLength(20);
    expect(first.metadata.nextOffset).toBe(20);
    expect(second.items).toHaveLength(5);
    expect(second.metadata.nextOffset).toBeNull();
    const all = [...first.items, ...second.items];
    const ordered = [...all].sort(
      (a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id),
    );
    expect(all.map((e) => e.id)).toEqual(ordered.map((e) => e.id));
  });

  it('returns an empty history and keeps the existing 403 for missing or foreign parents', async () => {
    expect(ListApplicationEventsResponseSchema.parse((await events()).body).items).toEqual([]);
    const foreign = await prisma.application.create({
      data: { userId: otherId, companyName: 'Theirs' },
    });
    expect((await events(foreign.id)).status).toBe(403);
    expect((await events('00000000-0000-4000-8000-000000000000')).status).toBe(403);
  });

  it('never discloses a foreign source from inconsistent legacy data', async () => {
    const real = await prisma.applicationEvent.create({
      data: { applicationId: appId, type: 'EMAIL_PROCESSED' },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = prisma.applicationEvent.findMany.bind(prisma.applicationEvent);
    vi.spyOn(prisma.applicationEvent, 'findMany').mockImplementation((async (args: unknown) => {
      const rows = (await original(args as never)) as Record<string, unknown>[];
      return rows.map((r) => ({
        ...r,
        emailId: 'foreign-email-id',
        email: {
          id: 'foreign-email-id',
          userId: otherId,
          subject: 'Secret',
          sender: 'x@y',
          receivedAt: null,
        },
      }));
    }) as never);
    const res = await events();
    expect(res.body.items[0]).toMatchObject({ id: real.id, emailId: null, sourceEmail: null });
    expect(JSON.stringify(res.body)).not.toContain('foreign-email-id');
    expect(JSON.stringify(res.body)).not.toContain('Secret');
    expect(log.mock.calls.flat().join(' ')).toContain('evidence_ownership_mismatch');
    expect(log.mock.calls.flat().join(' ')).not.toContain('Secret');
  });
});

describe('recentEvent evidence', () => {
  it('selects the latest recorded event with its owned source on list, detail and status PATCH', async () => {
    const email = await prisma.email.create({
      data: {
        userId: ownerId,
        gmailMessageId: 'recent',
        subject: 'Offer',
        receivedAt: new Date('2026-08-01T00:00:00Z'),
      },
    });
    await prisma.applicationEvent.create({
      data: { applicationId: appId, type: 'OLDER', createdAt: new Date('2026-09-01T00:00:00Z') },
    });
    await prisma.applicationEvent.create({
      data: {
        applicationId: appId,
        emailId: email.id,
        type: 'EMAIL_PROCESSED',
        createdAt: new Date('2026-09-02T00:00:00Z'),
      },
    });
    const expected = {
      type: 'EMAIL_PROCESSED',
      recordedAt: '2026-09-02T00:00:00.000Z',
      sourceEmail: {
        id: email.id,
        subject: 'Offer',
        sender: null,
        receivedAt: '2026-08-01T00:00:00.000Z',
      },
    };
    const list = await request(app).get('/api/applications').set('X-Development-User', OWNER);
    expect(ApplicationResponseSchema.parse(list.body.items[0]).recentEvent).toMatchObject(expected);
    const detail = await request(app)
      .get(`/api/applications/${appId}`)
      .set('X-Development-User', OWNER);
    expect(ApplicationResponseSchema.parse(detail.body).recentEvent).toMatchObject(expected);
    const patched = await request(app)
      .patch(`/api/applications/${appId}/status`)
      .set('X-Development-User', OWNER)
      .send({ userStatus: 'OFFER', expectedUserStatusRevision: 0 });
    expect(ApplicationResponseSchema.parse(patched.body).recentEvent).toMatchObject(expected);
  });

  it('reads at most one recent event and one source email per application (bounded selection)', async () => {
    const second = await prisma.application.create({
      data: { userId: ownerId, companyName: 'Second Co' },
    });
    for (const [applicationId, count] of [
      [appId, 30],
      [second.id, 5],
    ] as const)
      for (let i = 0; i < count; i++) {
        const email = await prisma.email.create({
          data: {
            userId: ownerId,
            gmailMessageId: `bounded-${applicationId}-${i}`,
            subject: `S${i}`,
          },
        });
        await prisma.applicationEvent.create({
          data: {
            applicationId,
            emailId: email.id,
            type: `T${i}`,
            createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
          },
        });
      }
    const eventFindMany = vi.spyOn(prisma.applicationEvent, 'findMany');
    const raw = vi.spyOn(prisma, '$queryRaw');
    const emailFindMany = vi.spyOn(prisma.email, 'findMany');
    const res = await request(app).get('/api/applications').set('X-Development-User', OWNER);
    expect(res.status).toBe(200);
    expect(eventFindMany).not.toHaveBeenCalled(); // no unbounded relation load of history
    const [strings] = raw.mock.calls[0] as unknown as [TemplateStringsArray];
    expect(strings.join('?')).toMatch(/LATERAL[\s\S]*LIMIT 1/);
    const rows = (await raw.mock.results[0].value) as unknown[];
    expect(rows).toHaveLength(2); // one event per application, not 35
    const emailArgs = emailFindMany.mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect(emailArgs.where.id.in).toHaveLength(2);
    const byCompany = Object.fromEntries(
      res.body.items.map((i: { companyName: string; recentEvent: { type: string } }) => [
        i.companyName,
        i.recentEvent.type,
      ]),
    );
    expect(byCompany).toEqual({ 'Evidence Co': 'T29', 'Second Co': 'T4' });
  });

  it('never discloses a foreign recentEvent source from inconsistent legacy data', async () => {
    const email = await prisma.email.create({
      data: { userId: ownerId, gmailMessageId: 'recent-foreign' },
    });
    await prisma.applicationEvent.create({
      data: { applicationId: appId, emailId: email.id, type: 'EMAIL_PROCESSED' },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(prisma.email, 'findMany').mockResolvedValueOnce([
      { id: email.id, userId: otherId, subject: 'Secret subject', sender: 'x@y', receivedAt: null },
    ] as never);
    const res = await request(app)
      .get(`/api/applications/${appId}`)
      .set('X-Development-User', OWNER);
    expect(res.body.recentEvent).toMatchObject({ type: 'EMAIL_PROCESSED', sourceEmail: null });
    expect(JSON.stringify(res.body)).not.toContain('Secret subject');
    expect(log.mock.calls.flat().join(' ')).toContain('evidence_ownership_mismatch');
  });

  it('keeps a null recentEvent when no history exists', async () => {
    const detail = await request(app)
      .get(`/api/applications/${appId}`)
      .set('X-Development-User', OWNER);
    expect(detail.body.recentEvent).toBeNull();
  });

  it('rejects contract payloads missing evidence keys or with invalid timestamps', () => {
    const base = {
      id: 'e',
      applicationId: 'a',
      emailId: null,
      type: 'T',
      oldState: null,
      newState: null,
      description: null,
      provenance: null,
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    const page = (item: object) => ({
      items: [item],
      metadata: { limit: 20, offset: 0, nextOffset: null },
    });
    const evidence = {
      retiredAt: null,
      retiredReason: null,
      sourceEmail: null,
      analyzedBy: null,
      sourceSubmission: null,
    };
    expect(
      ListApplicationEventsResponseSchema.safeParse(
        page({ ...base, recordedAt: base.createdAt, ...evidence }),
      ).success,
    ).toBe(true);
    expect(
      ListApplicationEventsResponseSchema.safeParse(
        page({ ...base, recordedAt: base.createdAt, sourceEmail: null, analyzedBy: null }),
      ).success,
    ).toBe(false);
    expect(
      ListApplicationEventsResponseSchema.safeParse(
        page({ ...base, recordedAt: base.createdAt, analyzedBy: null }),
      ).success,
    ).toBe(false);
    expect(
      ListApplicationEventsResponseSchema.safeParse(
        page({ ...base, recordedAt: base.createdAt, sourceEmail: null }),
      ).success,
    ).toBe(false);
    expect(
      ListApplicationEventsResponseSchema.safeParse(page({ ...base, ...evidence })).success,
    ).toBe(false);
    expect(
      ListApplicationEventsResponseSchema.safeParse(
        page({ ...base, recordedAt: 'yesterday', ...evidence }),
      ).success,
    ).toBe(false);
  });
});
