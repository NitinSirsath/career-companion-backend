import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';

describe('Application API (COM-13)', () => {
  let userA: import('@prisma/client').User;
  let userB: import('@prisma/client').User;
  
  beforeAll(async () => {
    // Ensure ENABLE_DEV_AUTH is true
    process.env.ENABLE_DEV_AUTH = 'true';

    // Clear db for clean slate
    await prisma.application.deleteMany();
    await prisma.user.deleteMany();

    // Setup two users for isolation testing
    userA = await prisma.user.create({
      data: { email: 'user-a@test.local' }
    });

    userB = await prisma.user.create({
      data: { email: 'user-b@test.local' }
    });
  });

  afterAll(async () => {
    await prisma.application.deleteMany();
    await prisma.user.deleteMany();
  });

  describe('Authentication', () => {
    it('request without development auth fails with 401', async () => {
      const res = await request(app).get('/api/applications');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing X-Development-User header'
        }
      });
    });

    it('valid development auth resolves the seeded development user', async () => {
      const res = await request(app)
        .get('/api/applications')
        .set('X-Development-User', 'user-a@test.local');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('fails if ENABLE_DEV_AUTH is not true', async () => {
      process.env.ENABLE_DEV_AUTH = 'false';
      const res = await request(app)
        .get('/api/applications')
        .set('X-Development-User', 'user-a@test.local');
      expect(res.status).toBe(401);
      process.env.ENABLE_DEV_AUTH = 'true'; // Restore
    });
  });

  describe('Validation', () => {
    it('missing companyName fails with 400', async () => {
      const res = await request(app)
        .post('/api/applications')
        .set('X-Development-User', 'user-a@test.local')
        .send({ jobTitle: 'Engineer' });
      
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toBeDefined();
    });

    it('invalid input fails with 400', async () => {
      const res = await request(app)
        .post('/api/applications')
        .set('X-Development-User', 'user-a@test.local')
        .send({ companyName: 123 }); // should be string
      
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Create & Cross-user Isolation', () => {
    it('valid authenticated request creates an Application', async () => {
      const res = await request(app)
        .post('/api/applications')
        .set('X-Development-User', 'user-a@test.local')
        .send({ companyName: 'Company A' });
      
      expect(res.status).toBe(201);
      expect(res.body.companyName).toBe('Company A');
      expect(res.body.id).toBeDefined();

      const dbApp = await prisma.application.findUnique({
        where: { id: res.body.id }
      });
      expect(dbApp?.userId).toBe(userA.id);
    });

    it('client cannot choose userId', async () => {
      const res = await request(app)
        .post('/api/applications')
        .set('X-Development-User', 'user-a@test.local')
        .send({ companyName: 'Company A2', userId: userB.id });
      
      expect(res.status).toBe(201);
      
      const dbApp = await prisma.application.findUnique({
        where: { id: res.body.id }
      });
      expect(dbApp?.userId).toBe(userA.id); // Must remain user A
      expect(dbApp?.userId).not.toBe(userB.id);
    });
  });

  describe('List & Isolation', () => {
    beforeAll(async () => {
      // Create for User B
      await prisma.application.create({
        data: {
          companyName: 'Company B',
          userId: userB.id
        }
      });
    });

    it('authenticated user can list their applications', async () => {
      const res = await request(app)
        .get('/api/applications')
        .set('X-Development-User', 'user-a@test.local');
      
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      
      // returned applications belong only to authenticated user
      for (const application of res.body) {
        const dbApp = await prisma.application.findUnique({ where: { id: application.id } });
        expect(dbApp?.userId).toBe(userA.id);
      }
    });

    it('GET /api/applications must return ONLY User A applications and never User B applications', async () => {
      const res = await request(app)
        .get('/api/applications')
        .set('X-Development-User', 'user-a@test.local');
      
      const appNames = res.body.map((a: import('../contracts').ApplicationResponse) => a.companyName);
      expect(appNames).toContain('Company A');
      expect(appNames).not.toContain('Company B');
    });
  });
});
