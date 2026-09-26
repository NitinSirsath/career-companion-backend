import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../db/prisma';
import { app } from '../index';
import { assertTestDatabase } from '../utils/testDatabase';
import { validateProductionConfig } from '../utils/config';
import { MatcherService } from '../services/matcher';
vi.mock('../jobs/notificationJob', () => ({ enqueueNotificationJob: vi.fn() }));

it('rejects test-like credentials/hosts when the actual database is development', () => {
  for (const url of [
    'postgresql://test:test@localhost/development',
    'postgresql://user@test.example/career_companion_test',
    'postgresql://user@localhost/career_companion_test?host=prod',
    'postgresql://user@localhost/career_companion_db',
  ]) {
    expect(() => assertTestDatabase(url, url)).toThrow('SAFETY GUARD');
  }
  const safe = 'postgresql://user@localhost:55439/career_companion_audit_test';
  expect(() => assertTestDatabase(safe, safe)).not.toThrow();
  expect(() => assertTestDatabase(safe, undefined)).toThrow();
});
it('fails closed with production dev auth or default secrets', () => {
  expect(() =>
    validateProductionConfig({ NODE_ENV: 'production', ENABLE_DEV_AUTH: 'true' }),
  ).toThrow();
  expect(() => validateProductionConfig({ NODE_ENV: 'production' })).toThrow();
});

describe('Domain ownership and concurrent processing', () => {
  let owner: string;
  let other: string;
  let applicationId: string;
  let foreignId: string;
  let emailId: string;
  beforeAll(async () => {
    owner = (await prisma.user.create({ data: { email: 'domain-owner@audit.test' } })).id;
    other = (await prisma.user.create({ data: { email: 'domain-other@audit.test' } })).id;
    applicationId = (
      await prisma.application.create({ data: { userId: owner, companyName: 'Concurrent' } })
    ).id;
    foreignId = (await prisma.application.create({ data: { userId: other, companyName: 'Other' } }))
      .id;
    emailId = (
      await prisma.email.create({
        data: { userId: owner, gmailMessageId: 'domain-email', relevanceState: 'RELEVANT' },
      })
    ).id;
    await prisma.aIProcessingResult.create({
      data: {
        emailId,
        provider: 'test',
        model: 'test',
        contractVersion: 'test',
        actionRequired: true,
        requestedAction: 'Reply',
        companyName: 'Concurrent',
        category: 'INTERVIEW',
        processingStatus: 'COMPLETED',
      },
    });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
  });
  it('does not permit production header impersonation even if the flag is set', async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(
        (
          await request(app)
            .get('/api/applications')
            .set('X-Development-User', 'domain-owner@audit.test')
        ).status,
      ).toBe(401);
    } finally {
      process.env.NODE_ENV = env;
    }
  });
  it('rejects cross-user matching before changing email state', async () => {
    const ai = await prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId } });
    await expect(MatcherService.applyMatch(emailId, foreignId, ai, 'AI_AUTO')).rejects.toThrow(
      'APPLICATION_NOT_FOUND',
    );
    expect(
      (await prisma.email.findUniqueOrThrow({ where: { id: emailId } })).applicationId,
    ).toBeNull();
  });
  it('enforces ownership on direct database links', async () => {
    await expect(
      prisma.email.update({ where: { id: emailId }, data: { applicationId: foreignId } }),
    ).rejects.toThrow();
    await expect(
      prisma.action.create({
        data: { emailId, applicationId: foreignId, type: 'ACTION_REQUIRED' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.applicationEvent.create({
        data: { emailId, applicationId: foreignId, type: 'EMAIL_PROCESSED' },
      }),
    ).rejects.toThrow();
  });
  it('creates one event and one action under duplicate concurrent execution', async () => {
    await Promise.all(
      Array.from({ length: 5 }, () => MatcherService.matchEmailToApplication(emailId)),
    );
    expect(await prisma.action.count({ where: { emailId } })).toBe(1);
    expect(await prisma.applicationEvent.count({ where: { emailId } })).toBe(1);
  });
  it('preserves a user-confirmed ignore on replay', async () => {
    await prisma.email.update({
      where: { id: emailId },
      data: { applicationId: null, matchState: 'IGNORED', matchConfirmedBy: 'USER_CONFIRMED' },
    });
    await MatcherService.matchEmailToApplication(emailId);
    expect((await prisma.email.findUniqueOrThrow({ where: { id: emailId } })).matchState).toBe(
      'IGNORED',
    );
  });
  it('provides a scoped detail endpoint and rejects malformed identifiers', async () => {
    const get = (id: string) =>
      request(app)
        .get(`/api/applications/${id}`)
        .set('X-Development-User', 'domain-owner@audit.test');
    expect((await get(applicationId)).body.companyName).toBe('Concurrent');
    expect((await get(foreignId)).status).toBe(404);
    expect((await get('invalid')).status).toBe(400);
  });
  it('caps all API list surfaces and paginates equal timestamps without overlap', async () => {
    await prisma.applicationEvent.createMany({
      data: Array.from({ length: 25 }, () => ({
        applicationId,
        type: 'NOTE_ADDED',
        createdAt: new Date('2026-09-01'),
      })),
    });
    const first = await request(app)
      .get(`/api/applications/${applicationId}/events?limit=50`)
      .set('X-Development-User', 'domain-owner@audit.test');
    const second = await request(app)
      .get(`/api/applications/${applicationId}/events?offset=20`)
      .set('X-Development-User', 'domain-owner@audit.test');
    expect(first.body.items).toHaveLength(20);
    expect(first.body.metadata.nextOffset).toBe(20);
    expect(new Set([...first.body.items, ...second.body.items].map((e) => e.id)).size).toBe(26);
    for (const path of [
      '/api/applications',
      '/api/actions',
      '/api/emails/unmatched',
      '/api/emails/ambiguous',
      '/api/gmail/messages',
      `/api/applications/${applicationId}/actions`,
    ]) {
      const res = await request(app)
        .get(`${path}?limit=50`)
        .set('X-Development-User', 'domain-owner@audit.test');
      expect(res.status).toBe(200);
      expect(res.body.metadata.limit).toBe(20);
    }
    for (const query of [
      'limit=1.2',
      'limit=10junk',
      'limit=0',
      'offset=Infinity',
      'offset=9999999999999',
      'limit=1&limit=2',
    ]) {
      expect(
        (
          await request(app)
            .get(`/api/applications?${query}`)
            .set('X-Development-User', 'domain-owner@audit.test')
        ).status,
      ).toBe(400);
    }
  });
});
