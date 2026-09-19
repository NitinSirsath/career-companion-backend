/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';

describe('Email API (COM-32)', () => {
  let userA: any;
  let userB: any;
  let ambiguousEmail: any;
  let unmatchedEmail: any;
  let appA: any;
  let appB: any;

  beforeAll(async () => {
    await prisma.aIProcessingResult.deleteMany({});
    await prisma.email.deleteMany({});
    await prisma.application.deleteMany({});
    await prisma.user.deleteMany({});

    userA = await prisma.user.create({
      data: { email: 'user-a-email@test.local' }
    });
    userB = await prisma.user.create({
      data: { email: 'user-b-email@test.local' }
    });

    appA = await prisma.application.create({
      data: { companyName: 'MatchCo', userId: userA.id }
    });
    appB = await prisma.application.create({
      data: { companyName: 'MatchCo', userId: userB.id }
    });

    ambiguousEmail = await prisma.email.create({
      data: {
        userId: userA.id,
        gmailMessageId: 'msg-ambig',
        subject: 'Your application',
        sender: 'recruiter@matchco.com',
        matchState: 'AMBIGUOUS',
        aiProcessingResult: {
          create: {
            provider: 'test',
            model: 'test',
            contractVersion: '1.0',
            companyName: 'MatchCo',
            confidence: 0.5,
          }
        }
      }
    });

    unmatchedEmail = await prisma.email.create({
      data: {
        userId: userA.id,
        gmailMessageId: 'msg-unmatched',
        subject: 'Interview next week',
        sender: 'eng@startup.io',
        relevanceState: 'RELEVANT',
        matchState: 'UNMATCHED',
        aiProcessingResult: {
          create: {
            provider: 'test',
            model: 'test',
            contractVersion: '1.0',
            companyName: 'Startup',
            confidence: 0.9,
          }
        }
      }
    });
  });

  afterAll(async () => {
    await prisma.aIProcessingResult.deleteMany({ where: { emailId: { in: [ambiguousEmail.id, unmatchedEmail.id] } } });
    await prisma.email.deleteMany({ where: { id: { in: [ambiguousEmail.id, unmatchedEmail.id] } } });
    await prisma.application.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  });

  describe('GET /api/emails/ambiguous', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/emails/ambiguous');
      expect(res.status).toBe(401);
    });

    it('returns ambiguous emails for the user', async () => {
      const res = await request(app)
        .get('/api/emails/ambiguous')
        .set('X-Development-User', 'user-a-email@test.local');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe(ambiguousEmail.id);
      expect(res.body[0].aiProcessingResult.companyName).toBe('MatchCo');
    });

    it('does not return ambiguous emails for another user', async () => {
      const res = await request(app)
        .get('/api/emails/ambiguous')
        .set('X-Development-User', 'user-b-email@test.local');

      if (res.status !== 200) console.log(res.body);
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(0);
    });
  });

  describe('GET /api/emails/unmatched', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/emails/unmatched');
      expect(res.status).toBe(401);
    });

    it('returns unmatched emails for the user', async () => {
      const res = await request(app)
        .get('/api/emails/unmatched')
        .set('X-Development-User', 'user-a-email@test.local');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe(unmatchedEmail.id);
      expect(res.body[0].aiProcessingResult.companyName).toBe('Startup');
    });

    it('does not return unmatched emails for another user', async () => {
      const res = await request(app)
        .get('/api/emails/unmatched')
        .set('X-Development-User', 'user-b-email@test.local');

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(0);
    });
  });

  describe('POST /api/emails/:id/resolve', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post(`/api/emails/${ambiguousEmail.id}/resolve`).send({ applicationId: appA.id });
      expect(res.status).toBe(401);
    });

    it('returns 403 if trying to resolve to another user\'s application', async () => {
      const res = await request(app)
        .post(`/api/emails/${ambiguousEmail.id}/resolve`)
        .set('X-Development-User', 'user-a-email@test.local')
        .send({ applicationId: appB.id });

      if (res.status !== 403) console.log(res.body);
      expect(res.status).toBe(403);
    });

    it('successfully resolves an ambiguous match to an application', async () => {
      const res = await request(app)
        .post(`/api/emails/${ambiguousEmail.id}/resolve`)
        .set('X-Development-User', 'user-a-email@test.local')
        .send({ applicationId: appA.id });

      if (res.status !== 200) console.log(res.body);
      expect(res.status).toBe(200);

      const email = await prisma.email.findUnique({ where: { id: ambiguousEmail.id } });
      expect(email?.matchState).toBe('MATCHED');
      expect(email?.applicationId).toBe(appA.id);
      expect(email?.matchConfirmedBy).toBe('USER_CONFIRMED');
    });

    it('successfully resolves an ambiguous match to null (ignored)', async () => {
      // Setup another ambiguous email
      const anotherEmail = await prisma.email.create({
        data: {
          userId: userA.id,
          gmailMessageId: 'msg-ignore',
          matchState: 'AMBIGUOUS',
          aiProcessingResult: {
            create: {
              provider: 'test',
              model: 'test',
              contractVersion: '1.0'
            }
          }
        }
      });

      const res = await request(app)
        .post(`/api/emails/${anotherEmail.id}/resolve`)
        .set('X-Development-User', 'user-a-email@test.local')
        .send({ applicationId: null });

      expect(res.status).toBe(200);

      const email = await prisma.email.findUnique({ where: { id: anotherEmail.id } });
      expect(email?.matchState).toBe('IGNORED');
      expect(email?.applicationId).toBeNull();
      expect(email?.matchConfirmedBy).toBe('USER_CONFIRMED');
      await prisma.aIProcessingResult.deleteMany({ where: { emailId: anotherEmail.id } });
      await prisma.email.delete({ where: { id: anotherEmail.id } });
    });

    it('successfully resolves an unmatched email to an application', async () => {
      const res = await request(app)
        .post(`/api/emails/${unmatchedEmail.id}/resolve`)
        .set('X-Development-User', 'user-a-email@test.local')
        .send({ applicationId: appA.id });

      expect(res.status).toBe(200);

      const email = await prisma.email.findUnique({ where: { id: unmatchedEmail.id } });
      expect(email?.matchState).toBe('MATCHED');
      expect(email?.applicationId).toBe(appA.id);
      expect(email?.matchConfirmedBy).toBe('USER_CONFIRMED');
    });

    it('returns 400 if trying to resolve unmatched email with null applicationId', async () => {
      // Create a fresh unmatched email because the previous test modified `unmatchedEmail`
      const freshUnmatched = await prisma.email.create({
        data: {
          userId: userA.id,
          gmailMessageId: 'msg-unmatched-2',
          matchState: 'UNMATCHED',
          aiProcessingResult: {
            create: {
              provider: 'test',
              model: 'test',
              contractVersion: '1.0'
            }
          }
        }
      });

      const res = await request(app)
        .post(`/api/emails/${freshUnmatched.id}/resolve`)
        .set('X-Development-User', 'user-a-email@test.local')
        .send({ applicationId: null });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('An application must be selected for unmatched emails.');

      await prisma.aIProcessingResult.deleteMany({ where: { emailId: freshUnmatched.id } });
      await prisma.email.delete({ where: { id: freshUnmatched.id } });
    });
  });
});
