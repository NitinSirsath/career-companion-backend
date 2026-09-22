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
          message: 'Not authenticated'
        }
      });
    });

    it('valid development auth resolves the seeded development user', async () => {
      const res = await request(app)
        .get('/api/applications')
        .set('X-Development-User', 'user-a@test.local');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
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

    it('list response includes recentEvent and pendingActionCount fields', async () => {
      const res = await request(app)
        .get('/api/applications')
        .set('X-Development-User', 'user-a@test.local');
      
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      for (const app of res.body.items) {
        expect(app).toHaveProperty('recentEvent');
        expect(app).toHaveProperty('pendingActionCount');
        expect(typeof app.pendingActionCount).toBe('number');
      }
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
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
      
      // returned applications belong only to authenticated user
      for (const application of res.body.items) {
        const dbApp = await prisma.application.findUnique({ where: { id: application.id } });
        expect(dbApp?.userId).toBe(userA.id);
      }
    });

    it('GET /api/applications must return ONLY User A applications and never User B applications', async () => {
      const res = await request(app)
        .get('/api/applications')
        .set('X-Development-User', 'user-a@test.local');
      
      const appNames = res.body.items.map((a: import('../contracts').ApplicationResponse) => a.companyName);
      expect(appNames).toContain('Company A');
      expect(appNames).not.toContain('Company B');
    });
  });

  // ─── Events endpoint (COM-31) ──────────────────────────────────────────────

  describe('GET /api/applications/:id/events (COM-31)', () => {
    let appWithEvents: import('@prisma/client').Application;

    beforeAll(async () => {
      appWithEvents = await prisma.application.create({
        data: { companyName: 'EventCo', userId: userA.id }
      });

      // Create events with explicit createdAt to test deterministic ordering
      // We insert them out-of-order by time to confirm DB ordering works
      await prisma.applicationEvent.create({
        data: {
          applicationId: appWithEvents.id,
          type: 'EMAIL_PROCESSED',
          description: 'Second event',
          newState: 'RECRUITER_CONTACT',
          createdAt: new Date('2026-01-02T10:00:00Z'),
        }
      });
      await prisma.applicationEvent.create({
        data: {
          applicationId: appWithEvents.id,
          type: 'EMAIL_PROCESSED',
          description: 'First event',
          newState: 'APPLIED',
          createdAt: new Date('2026-01-01T10:00:00Z'),
        }
      });
    });

    afterAll(async () => {
      await prisma.applicationEvent.deleteMany({ where: { applicationId: appWithEvents.id } });
      await prisma.application.delete({ where: { id: appWithEvents.id } });
    });

    it('returns 401 without authentication', async () => {
      const res = await request(app)
        .get(`/api/applications/${appWithEvents.id}/events`);
      expect(res.status).toBe(401);
    });

    it('authenticated user can retrieve their application events', async () => {
      const res = await request(app)
        .get(`/api/applications/${appWithEvents.id}/events`)
        .set('X-Development-User', 'user-a@test.local');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });

    it('events are returned in chronological order (createdAt ASC)', async () => {
      const res = await request(app)
        .get(`/api/applications/${appWithEvents.id}/events`)
        .set('X-Development-User', 'user-a@test.local');

      expect(res.status).toBe(200);
      const events = res.body;
      expect(events[0].description).toBe('First event');
      expect(events[1].description).toBe('Second event');

      // Verify timestamps are monotonically increasing
      const t0 = new Date(events[0].createdAt).getTime();
      const t1 = new Date(events[1].createdAt).getTime();
      expect(t1).toBeGreaterThan(t0);
    });

    it('events contain expected fields including provenance', async () => {
      const res = await request(app)
        .get(`/api/applications/${appWithEvents.id}/events`)
        .set('X-Development-User', 'user-a@test.local');

      const event = res.body[0];
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('applicationId');
      expect(event).toHaveProperty('type');
      expect(event).toHaveProperty('createdAt');
      // emailId and provenance may be null — that is valid
      expect(Object.prototype.hasOwnProperty.call(event, 'emailId')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(event, 'provenance')).toBe(true);
    });

    it('user cannot retrieve another user\'s application events (returns 403)', async () => {
      const res = await request(app)
        .get(`/api/applications/${appWithEvents.id}/events`)
        .set('X-Development-User', 'user-b@test.local');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 403 for a non-existent application ID', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await request(app)
        .get(`/api/applications/${fakeId}/events`)
        .set('X-Development-User', 'user-a@test.local');

      expect(res.status).toBe(403);
    });
  });

  // ─── Actions endpoint (COM-31) ─────────────────────────────────────────────

  describe('GET /api/applications/:id/actions (COM-31)', () => {
    let appWithActions: import('@prisma/client').Application;

    beforeAll(async () => {
      appWithActions = await prisma.application.create({
        data: { companyName: 'ActionCo', userId: userA.id }
      });

      await prisma.action.create({
        data: {
          applicationId: appWithActions.id,
          type: 'ACTION_REQUIRED',
          description: 'Submit portfolio',
          status: 'PENDING',
        }
      });
      await prisma.action.create({
        data: {
          applicationId: appWithActions.id,
          type: 'FOLLOW_UP_REQUIRED',
          description: 'Send thank-you email',
          status: 'COMPLETED',
        }
      });
    });

    afterAll(async () => {
      await prisma.action.deleteMany({ where: { applicationId: appWithActions.id } });
      await prisma.application.delete({ where: { id: appWithActions.id } });
    });

    it('returns 401 without authentication', async () => {
      const res = await request(app)
        .get(`/api/applications/${appWithActions.id}/actions`);
      expect(res.status).toBe(401);
    });

    it('authenticated user can retrieve their application actions', async () => {
      const res = await request(app)
        .get(`/api/applications/${appWithActions.id}/actions`)
        .set('X-Development-User', 'user-a@test.local');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });

    it('actions contain expected fields', async () => {
      const res = await request(app)
        .get(`/api/applications/${appWithActions.id}/actions`)
        .set('X-Development-User', 'user-a@test.local');

      const action = res.body[0];
      expect(action).toHaveProperty('id');
      expect(action).toHaveProperty('type');
      expect(action).toHaveProperty('status');
      expect(action).toHaveProperty('description');
      expect(Object.prototype.hasOwnProperty.call(action, 'deadline')).toBe(true);
    });

    it('user cannot retrieve another user\'s application actions (returns 403)', async () => {
      const res = await request(app)
        .get(`/api/applications/${appWithActions.id}/actions`)
        .set('X-Development-User', 'user-b@test.local');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('returns 403 for a non-existent application ID', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await request(app)
        .get(`/api/applications/${fakeId}/actions`)
        .set('X-Development-User', 'user-a@test.local');

      expect(res.status).toBe(403);
    });
  });
});
