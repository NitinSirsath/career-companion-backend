import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { EmailRelevanceState, EmailMatchState } from '@prisma/client';
import { ZodError } from 'zod';
import { createPaginatedResponse, getPaginationParams, PAGE_SIZE } from '../utils/pagination';

describe('System-Wide Pagination (COM-48)', () => {
  const userEmail = 'pagination-user@test.local';
  let userId: string;

  beforeAll(async () => {
    // Set up user
    const user = await prisma.user.create({
      data: {
        email: userEmail,
        name: 'Pagination Test User',
      },
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
      expect(new Date(res1.body.items[0].receivedAt).getTime()).toBeGreaterThan(
        new Date(res1.body.items[1].receivedAt).getTime(),
      );

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

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
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

// The helpers on their own, without HTTP or a database. A service reads one row more than the
// limit (`take: limit + 1`), so a list longer than the limit means there is a next page.
describe('pagination helpers', () => {
  describe('getPaginationParams', () => {
    it('uses the page size and offset 0 when nothing is given', () => {
      expect(getPaginationParams({})).toEqual({ limit: PAGE_SIZE, offset: 0 });
      expect(PAGE_SIZE).toBe(20);
    });

    it('reads limit and offset from query text', () => {
      expect(getPaginationParams({ limit: '5', offset: '40' })).toEqual({ limit: 5, offset: 40 });
      expect(getPaginationParams({ limit: '007', offset: '0' })).toEqual({ limit: 7, offset: 0 });
    });

    it('caps the limit at 20', () => {
      expect(getPaginationParams({ limit: '20' }).limit).toBe(20);
      expect(getPaginationParams({ limit: '21' }).limit).toBe(20);
      expect(getPaginationParams({ limit: '9999999999999' }).limit).toBe(20);
    });

    it('accepts the largest offset and ignores other query keys', () => {
      expect(getPaginationParams({ offset: '2147483627', q: 'acme' })).toEqual({
        limit: 20,
        offset: 2_147_483_627,
      });
    });

    it.each([
      ['limit 0', { limit: '0' }],
      ['a negative limit', { limit: '-1' }],
      ['a decimal limit', { limit: '1.5' }],
      ['a limit that is not a number', { limit: 'abc' }],
      ['an empty limit', { limit: '' }],
      ['a limit too big to count exactly', { limit: '99999999999999999999' }],
      ['a repeated limit', { limit: ['1', '2'] }],
      ['a limit sent as a number', { limit: 5 }],
      ['a negative offset', { offset: '-1' }],
      ['an offset that is not a number', { offset: 'invalid' }],
      ['an offset above the largest', { offset: '2147483628' }],
    ])('rejects %s', (_label, query) => {
      expect(() => getPaginationParams(query)).toThrow(ZodError);
    });
  });

  describe('createPaginatedResponse', () => {
    const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i }));

    it('gives the next offset when there is one row more than the limit', () => {
      expect(createPaginatedResponse(rows(6), 5, 10)).toEqual({
        items: rows(5),
        metadata: { nextOffset: 15, limit: 5, offset: 10 },
      });
    });

    it('has no next page when the rows fit the limit', () => {
      expect(createPaginatedResponse(rows(5), 5, 10).metadata.nextOffset).toBeNull();
      expect(createPaginatedResponse(rows(5), 5, 10).items).toHaveLength(5);
      expect(createPaginatedResponse(rows(2), 5, 0).metadata.nextOffset).toBeNull();
    });

    it('returns an empty page with its limit and offset', () => {
      expect(createPaginatedResponse([], 20, 40)).toEqual({
        items: [],
        metadata: { nextOffset: null, limit: 20, offset: 40 },
      });
    });

    it('does not change the list it is given', () => {
      const list = rows(21);
      createPaginatedResponse(list, 20, 0);
      expect(list).toHaveLength(21);
    });
  });
});
