import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';

describe('Action API (COM-33)', () => {
  let userA: any;
  let userB: any;
  let appA: any;
  let appB: any;
  let actionA_Pending: any;
  let actionA_Completed: any;
  let actionB_Pending: any;

  beforeAll(async () => {
    await prisma.action.deleteMany({});
    await prisma.application.deleteMany({});
    await prisma.user.deleteMany({});

    userA = await prisma.user.create({ data: { email: 'user-a-action@test.local' } });
    userB = await prisma.user.create({ data: { email: 'user-b-action@test.local' } });

    appA = await prisma.application.create({ data: { companyName: 'App A', userId: userA.id } });
    appB = await prisma.application.create({ data: { companyName: 'App B', userId: userB.id } });

    actionA_Pending = await prisma.action.create({
      data: {
        applicationId: appA.id,
        type: 'FOLLOW_UP_REQUIRED',
        description: 'Send follow up',
        status: 'PENDING'
      }
    });

    actionA_Completed = await prisma.action.create({
      data: {
        applicationId: appA.id,
        type: 'ACTION_REQUIRED',
        description: 'Completed action',
        status: 'COMPLETED'
      }
    });

    actionB_Pending = await prisma.action.create({
      data: {
        applicationId: appB.id,
        type: 'FOLLOW_UP_REQUIRED',
        description: 'User B pending action',
        status: 'PENDING'
      }
    });
  });

  afterAll(async () => {
    await prisma.action.deleteMany({});
    await prisma.application.deleteMany({});
    await prisma.user.deleteMany({});
  });

  describe('GET /api/actions', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/actions');
      expect(res.status).toBe(401);
    });

    it('returns all actions for the user isolated from others', async () => {
      const res = await request(app)
        .get('/api/actions')
        .set('X-Development-User', userA.email);
      
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(2);
      
      const ids = res.body.map((a: any) => a.id);
      expect(ids).toContain(actionA_Pending.id);
      expect(ids).toContain(actionA_Completed.id);
      expect(ids).not.toContain(actionB_Pending.id);
      
      // Ensure context is loaded
      expect(res.body[0].application.companyName).toBe('App A');
    });

    it('filters by status', async () => {
      const res = await request(app)
        .get('/api/actions?status=PENDING')
        .set('X-Development-User', userA.email);
      
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe(actionA_Pending.id);
    });
  });

  describe('PATCH /api/actions/:id', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .patch(`/api/actions/${actionA_Pending.id}`)
        .send({ status: 'COMPLETED' });
      expect(res.status).toBe(401);
    });

    it('returns 403 when updating another user\'s action', async () => {
      const res = await request(app)
        .patch(`/api/actions/${actionB_Pending.id}`)
        .set('X-Development-User', userA.email)
        .send({ status: 'COMPLETED' });
      expect(res.status).toBe(403);
    });

    it('successfully updates an action status', async () => {
      const res = await request(app)
        .patch(`/api/actions/${actionA_Pending.id}`)
        .set('X-Development-User', userA.email)
        .send({ status: 'COMPLETED' });
      
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('COMPLETED');
      
      const inDb = await prisma.action.findUnique({ where: { id: actionA_Pending.id } });
      expect(inDb?.status).toBe('COMPLETED');
    });

    it('is idempotent (updating already completed action is safe)', async () => {
      const res = await request(app)
        .patch(`/api/actions/${actionA_Completed.id}`)
        .set('X-Development-User', userA.email)
        .send({ status: 'COMPLETED' });
      
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('COMPLETED');
    });

    it('successfully updates an action status to DISMISSED', async () => {
      // Re-create a pending action to test dismiss
      const dismissAction = await prisma.action.create({
        data: {
          applicationId: appA.id,
          type: 'FOLLOW_UP_REQUIRED',
          description: 'To dismiss',
          status: 'PENDING'
        }
      });

      const res = await request(app)
        .patch(`/api/actions/${dismissAction.id}`)
        .set('X-Development-User', userA.email)
        .send({ status: 'DISMISSED' });
      
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('DISMISSED');
      
      const inDb = await prisma.action.findUnique({ where: { id: dismissAction.id } });
      expect(inDb?.status).toBe('DISMISSED');
    });
  });
});
