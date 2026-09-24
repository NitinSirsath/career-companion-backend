import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { EmailRelevanceState, EmailMatchState } from '@prisma/client';

describe('System-Wide Pagination (COM-48)', () => {
  const userEmail = 'pagination-user@test.local';
  let userId: string;

  beforeAll(async () => {
    // Set up user
    const user = await prisma.user.create({
      data: {
        email: userEmail,
        name: 'Pagination Test User',
      }
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
  });

  beforeEach(async () => {
    // Clear previous emails for this user
    await prisma.email.deleteMany({ where: { userId } });
  });

  async function createEmails(count: number) {
    const data = [];
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      data.push({
        userId,
        gmailMessageId: `msg-${i}`,
        relevanceState: EmailRelevanceState.RELEVANT,
        matchState: EmailMatchState.UNMATCHED,
        receivedAt: new Date(now - i * 1000), // Ensures deterministic ordering (descending)
      });
    }
    // We do sequential creation for stability or just createMany
    await prisma.email.createMany({ data });
  }

  describe('GET /api/emails/unmatched', () => {
    it('1. default pagination', async () => {
      await createEmails(25); // Default limit is 20
      const res = await request(app)
        .get('/api/emails/unmatched')
        .set('X-Development-User', userEmail);
      
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(20);
      expect(res.body.metadata.limit).toBe(20);
      expect(res.body.metadata.offset).toBe(0);
      expect(res.body.metadata.nextOffset).toBe(20);
    });

    it('2. explicit page size', async () => {
      await createEmails(10);
      const res = await request(app)
        .get('/api/emails/unmatched?limit=5')
        .set('X-Development-User', userEmail);
      
      expect(res.body.items.length).toBe(5);
      expect(res.body.metadata.limit).toBe(5);
      expect(res.body.metadata.nextOffset).toBe(5);
    });

    it('3. maximum page size enforcement', async () => {
      await createEmails(30); // Create more than max (20)
      const res = await request(app)
        .get('/api/emails/unmatched?limit=200') // Requesting beyond max
        .set('X-Development-User', userEmail);
      
      expect(res.body.items.length).toBe(20); // Should clamp to max
      expect(res.body.metadata.limit).toBe(20);
      expect(res.body.metadata.nextOffset).toBe(20);
    });

    it('4. first page, 5. middle page, 6. final page, 8. deterministic ordering, 9. multiple pages', async () => {
      await createEmails(25);
      
      // Page 1
      const res1 = await request(app)
        .get('/api/emails/unmatched?limit=10&offset=0')
        .set('X-Development-User', userEmail);
      
      expect(res1.body.items.length).toBe(10);
      expect(res1.body.metadata.nextOffset).toBe(10);
      // Deterministic order: msg-0 to msg-9
      expect(new Date(res1.body.items[0].receivedAt).getTime()).toBeGreaterThan(new Date(res1.body.items[1].receivedAt).getTime());

      // Page 2 (middle)
      const res2 = await request(app)
        .get('/api/emails/unmatched?limit=10&offset=10')
        .set('X-Development-User', userEmail);
        
      expect(res2.body.items.length).toBe(10);
      expect(res2.body.metadata.nextOffset).toBe(20);
      
      // Page 3 (final)
      const res3 = await request(app)
        .get('/api/emails/unmatched?limit=10&offset=20')
        .set('X-Development-User', userEmail);
        
      expect(res3.body.items.length).toBe(5);
      expect(res3.body.metadata.nextOffset).toBeNull();
    });

    it('7. empty result', async () => {
      const res = await request(app)
        .get('/api/emails/unmatched')
        .set('X-Development-User', userEmail);
        
      expect(res.body.items.length).toBe(0);
      expect(res.body.metadata.nextOffset).toBeNull();
    });

    it('10. invalid pagination parameters', async () => {
      await createEmails(10);
      const res = await request(app)
        .get('/api/emails/unmatched?limit=-10&offset=invalid')
        .set('X-Development-User', userEmail);
        
      // Limit clamped to 1 minimum, offset clamped to 0
      expect(res.body.items.length).toBe(1);
      expect(res.body.metadata.limit).toBe(1);
      expect(res.body.metadata.offset).toBe(0);
    });

    it('11. prevention of unbounded requests & 12. contract shape', async () => {
      await createEmails(30); // Create enough to hit the clamp
      const res = await request(app)
        .get('/api/emails/unmatched?limit=9999999999999')
        .set('X-Development-User', userEmail);
        
      expect(res.body.items.length).toBe(20);
      expect(res.body.metadata).toBeDefined();
      expect(res.body.metadata.limit).toBe(20);
      expect(res.body.items[0]).toHaveProperty('id');
    });
  });
});
