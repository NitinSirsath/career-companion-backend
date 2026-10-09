// The error responses the API sends today: status, code, message and details, exactly.
// A refactor of how errors are thrown or mapped must keep every one of these.
import crypto from 'crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { utcDay } from '../services/ai/usage';
import { configureAI } from './helpers/aiAccess';

vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));

const DOMAIN = '@api-errors.test';
const OWNER = `owner${DOMAIN}`;
const CHANGE_REJECTED = 'This change could not be saved. Refresh and review the current state.';
let userId: string;

const as = () => ({ 'X-Development-User': OWNER });
const missingId = () => crypto.randomUUID();
const application = () =>
  prisma.application.create({ data: { userId, companyName: 'Acme', jobTitle: 'Designer' } });
let submissions = 0;
const submission = (resolved: boolean) =>
  prisma.externalSubmission.create({
    data: {
      userId,
      source: 'AUTOMATION',
      sourceRecordRef: `2026-10-01/10:00:${String(++submissions).padStart(2, '0')}`,
      platform: 'workday',
      company: 'Acme Inc.',
      jobTitle: 'Backend Engineer',
      submittedAt: new Date('2026-10-01T10:00:00Z'),
      ...(resolved
        ? { matchState: 'IGNORED', resolvedBy: 'USER', resolvedAt: new Date() }
        : { matchState: 'NEEDS_REVIEW' }),
    },
  });

beforeAll(async () => {
  process.env.ENABLE_DEV_AUTH = 'true';
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  userId = (await prisma.user.create({ data: { email: OWNER } })).id;
});
beforeEach(async () => {
  delete process.env.AI_USER_DAILY_CALL_LIMIT;
  await prisma.aIConfiguration.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
});
afterAll(async () => {
  delete process.env.AI_USER_DAILY_CALL_LIMIT;
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
});

describe('errors sent by the central handler', () => {
  it('400 VALIDATION_ERROR with the validation issues', async () => {
    const res = await request(app)
      .patch(`/api/applications/${missingId()}/archive`)
      .set(as())
      .send({ archived: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      details: expect.any(Array),
    });
  });

  it('404 NOT_FOUND', async () => {
    const res = await request(app)
      .patch(`/api/applications/${missingId()}/archive`)
      .set(as())
      .send({ archived: true, expectedArchiveRevision: 0 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  it('409 for a stale change', async () => {
    const { id } = await application();
    const res = await request(app)
      .patch(`/api/applications/${id}/archive`)
      .set(as())
      .send({ archived: true, expectedArchiveRevision: 5 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'REVISION_CONFLICT', message: CHANGE_REJECTED } });
  });

  it('400 for a rejected change', async () => {
    const res = await request(app)
      .patch(`/api/actions/${missingId()}/snooze`)
      .set(as())
      .send({ expectedActionRevision: 0, snoozedUntil: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'INVALID_SNOOZE', message: CHANGE_REJECTED } });
  });
});

describe('AI settings errors', () => {
  it('404 AI_NOT_CONFIGURED', async () => {
    const res = await request(app).post('/api/ai/settings/check').set(as()).send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'AI_NOT_CONFIGURED', message: 'AI is not set up.' },
    });
  });

  it('400 VALIDATION_ERROR with the settings message', async () => {
    const res = await request(app)
      .put('/api/ai/settings')
      .set(as())
      .send({ provider: 'gemini', apiKey: 'not a valid key' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'The API key format is not valid.' },
    });
  });

  it('409 AI_ACCESS_UNAVAILABLE with details', async () => {
    await configureAI(userId);
    process.env.AI_USER_DAILY_CALL_LIMIT = '1';
    await prisma.aIUsageDay.create({ data: { userId, day: utcDay(new Date()), calls: 1 } });
    const res = await request(app).post('/api/ai/settings/sample-test').set(as()).send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'AI_ACCESS_UNAVAILABLE',
        message: 'AI access cannot be used right now.',
        details: { state: 'LIMITED', reason: 'SAFETY_LIMIT', resumesAt: expect.any(String) },
      },
    });
  });
});

describe('integration token errors', () => {
  it('404 NOT_FOUND', async () => {
    const res = await request(app).delete(`/api/integration-tokens/${missingId()}`).set(as());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Token not found.' } });
  });
});

describe('submission review errors', () => {
  const resolve = (id: string, body: object) =>
    request(app).post(`/api/submissions/${id}/resolve`).set(as()).send(body);

  it('404 NOT_FOUND', async () => {
    const res = await resolve(missingId(), { action: 'ignore' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Submission not found.' } });
  });

  it('400 BAD_REQUEST when already resolved', async () => {
    const res = await resolve((await submission(true)).id, { action: 'ignore' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Submission is not in a resolvable state.' },
    });
  });

  it('403 FORBIDDEN for an application the user does not own', async () => {
    const res = await resolve((await submission(false)).id, {
      action: 'link',
      applicationId: missingId(),
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: 'FORBIDDEN', message: 'Application not found or access denied.' },
    });
  });
});

describe('application status errors', () => {
  const setStatus = (id: string, expectedUserStatusRevision: number) =>
    request(app)
      .patch(`/api/applications/${id}/status`)
      .set(as())
      .send({ userStatus: null, expectedUserStatusRevision });

  it('404 NOT_FOUND', async () => {
    const res = await setStatus(missingId(), 0);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Application not found' } });
  });

  it('409 STATUS_CONFLICT', async () => {
    const res = await setStatus((await application()).id, 5);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'STATUS_CONFLICT',
        message: 'The application status was changed elsewhere. Reload it before saving again.',
      },
    });
  });
});

describe('email match correction errors', () => {
  const correct = (id: string) =>
    request(app).patch(`/api/emails/${id}/match`).set(as()).send({
      applicationId: missingId(),
      expectedMatchState: 'MATCHED',
      expectedApplicationId: null,
    });

  it('404 NOT_FOUND', async () => {
    const res = await correct(missingId());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Email or application no longer available' },
    });
  });

  it('409 MATCH_CONFLICT', async () => {
    const email = await prisma.email.create({
      data: { userId, gmailMessageId: `api-errors-${crypto.randomUUID()}` },
    });
    const res = await correct(email.id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'MATCH_CONFLICT',
        message: 'This email link changed or cannot be corrected. Refresh before trying again.',
      },
    });
  });
});
