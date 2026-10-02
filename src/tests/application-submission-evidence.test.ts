// MCP-06: submittedVia and sourceSubmission on application and timeline responses (ADR-0002 §8–9).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import {
  ApplicationResponseSchema,
  ListApplicationEventsResponseSchema,
  ListApplicationsResponseSchema,
} from '../contracts';
import { recordSubmission, resolveSubmission } from '../services/externalSubmission';

const DOMAIN = '@mcp-evidence.test';
const OWNER = `owner${DOMAIN}`;
let owner: string;
const as = { 'X-Development-User': OWNER };

const submit = (ref: string, company: string, jobTitle = 'Engineer', extra: Record<string, unknown> = {}) =>
  recordSubmission(owner, null, {
    sourceRecordRef: ref,
    platform: 'company_direct',
    company,
    jobTitle,
    submittedAt: '2026-10-01T08:30:00+05:30',
    destinationHost: 'Jobs.Lever.co',
    confirmationText: 'Application received',
    ...extra,
  });

beforeAll(async () => {
  process.env.ENABLE_DEV_AUTH = 'true';
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
});
beforeEach(async () => {
  await prisma.externalSubmission.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
  await prisma.email.deleteMany({ where: { userId: owner } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('submittedVia', () => {
  it('is present and null on create, list, detail and status PATCH for manual applications', async () => {
    const created = await request(app).post('/api/applications').set(as).send({ companyName: 'Manual' });
    expect(ApplicationResponseSchema.parse(created.body).submittedVia).toBeNull();
    const list = ListApplicationsResponseSchema.parse((await request(app).get('/api/applications').set(as)).body);
    expect(list.items[0].submittedVia).toBeNull();
    const detail = await request(app).get(`/api/applications/${created.body.id}`).set(as);
    expect(ApplicationResponseSchema.parse(detail.body).submittedVia).toBeNull();
    const patched = await request(app)
      .patch(`/api/applications/${created.body.id}/status`)
      .set(as)
      .send({ userStatus: 'INTERVIEW', expectedUserStatusRevision: 0 });
    expect(ApplicationResponseSchema.parse(patched.body).submittedVia).toBeNull();
  });

  it('is AUTOMATION for created and linked submissions, on every response path, without writing a status', async () => {
    const created = await submit('2026-10-01/08:30:00', 'Auto Co');
    const appId = (await prisma.externalSubmission.findUniqueOrThrow({ where: { id: created.recordId } })).applicationId!;
    const manual = await prisma.application.create({ data: { userId: owner, companyName: 'Link Co', jobTitle: 'Engineer' } });
    expect((await submit('2026-10-01/08:31:00', 'Link Co Ltd')).result).toBe('linked');

    const list = ListApplicationsResponseSchema.parse((await request(app).get('/api/applications').set(as)).body);
    for (const id of [appId, manual.id]) {
      const item = list.items.find((i) => i.id === id)!;
      expect(item).toMatchObject({ submittedVia: 'AUTOMATION', statusSource: 'UNKNOWN', effectiveStatus: null, aiStatus: null, userStatus: null });
      const detail = ApplicationResponseSchema.parse((await request(app).get(`/api/applications/${id}`).set(as)).body);
      expect(detail.submittedVia).toBe('AUTOMATION');
    }
    // A user correction wins; submittedVia stays a fact, not a status.
    const patched = await request(app).patch(`/api/applications/${appId}/status`).set(as).send({ userStatus: 'REJECTED', expectedUserStatusRevision: 0 });
    expect(ApplicationResponseSchema.parse(patched.body)).toMatchObject({ submittedVia: 'AUTOMATION', statusSource: 'USER', effectiveStatus: 'REJECTED' });
  });

  it('stays null for submissions that are pending review or ignored', async () => {
    const existing = await prisma.application.create({ data: { userId: owner, companyName: 'Review Co', jobTitle: 'Designer' } });
    const pending = await submit('2026-10-01/08:32:00', 'Review Co');
    expect(pending.result).toBe('needs_review');
    const detail = await request(app).get(`/api/applications/${existing.id}`).set(as);
    expect(detail.body.submittedVia).toBeNull();
    await resolveSubmission(owner, pending.recordId, { action: 'ignore' });
    expect((await request(app).get(`/api/applications/${existing.id}`).set(as)).body.submittedVia).toBeNull();
  });
});

describe('sourceSubmission', () => {
  it('describes the AUTOMATION_SUBMITTED event on the timeline and never as AI output', async () => {
    const created = await submit('2026-10-01/08:30:00', 'Timeline Co', 'Engineer', { confirmationText: '<b>Thanks</b>' });
    const appId = (await prisma.externalSubmission.findUniqueOrThrow({ where: { id: created.recordId } })).applicationId!;
    const res = await request(app).get(`/api/applications/${appId}/events`).set(as);
    const page = ListApplicationEventsResponseSchema.parse(res.body);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      type: 'AUTOMATION_SUBMITTED',
      emailId: null,
      sourceEmail: null,
      analyzedBy: null,
      oldState: null,
      newState: null,
      description: null,
      provenance: null,
      sourceSubmission: {
        platform: 'company_direct',
        destinationHost: 'jobs.lever.co',
        submittedAt: '2026-10-01T03:00:00.000Z',
        confirmationText: '<b>Thanks</b>', // stored as given; rendered as plain text
      },
    });
    expect(Object.keys(page.items[0].sourceSubmission!).sort()).toEqual(['confirmationText', 'destinationHost', 'platform', 'submittedAt']);
  });

  it('is on the list page’s recentEvent for this event type, and null for email events', async () => {
    const created = await submit('2026-10-01/08:30:00', 'Recent Co');
    const appId = (await prisma.externalSubmission.findUniqueOrThrow({ where: { id: created.recordId } })).applicationId!;
    let list = ListApplicationsResponseSchema.parse((await request(app).get('/api/applications').set(as)).body);
    expect(list.items.find((i) => i.id === appId)!.recentEvent).toMatchObject({
      type: 'AUTOMATION_SUBMITTED',
      sourceEmail: null,
      sourceSubmission: { platform: 'company_direct', destinationHost: 'jobs.lever.co' },
    });

    // A later email event becomes the recent event and carries no submission evidence.
    const email = await prisma.email.create({ data: { userId: owner, gmailMessageId: 'evidence-1', subject: 'Interview', applicationId: appId, matchState: 'MATCHED' } });
    await prisma.applicationEvent.create({ data: { applicationId: appId, emailId: email.id, type: 'EMAIL_PROCESSED' } });
    list = ListApplicationsResponseSchema.parse((await request(app).get('/api/applications').set(as)).body);
    expect(list.items.find((i) => i.id === appId)!.recentEvent).toMatchObject({ type: 'EMAIL_PROCESSED', sourceSubmission: null });
    const events = ListApplicationEventsResponseSchema.parse((await request(app).get(`/api/applications/${appId}/events`).set(as)).body);
    expect(events.items.map((e) => [e.type, e.sourceSubmission === null])).toEqual([
      ['AUTOMATION_SUBMITTED', false],
      ['EMAIL_PROCESSED', true],
    ]);
  });
});
