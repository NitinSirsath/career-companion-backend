/**
 * "What the app has read" on the Gmail sync page (owner, 17 Nov 2026): GET /api/gmail/summary
 * counts the last 30 days by the day each mail arrived, and only the signed-in user's mails.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { GmailSummaryResponseSchema } from '../contracts/gmail';
import { readGmailSummary, summaryStart } from '../services/gmailSummary';

const DAY = 86_400_000;
const NOW = new Date('2026-11-17T15:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe('GET /api/gmail/summary', () => {
  let user: import('@prisma/client').User;
  let other: import('@prisma/client').User;

  beforeAll(async () => {
    process.env.ENABLE_DEV_AUTH = 'true';
    await prisma.user.deleteMany({
      where: { email: { in: ['summary@test.local', 'summary-other@test.local'] } },
    });
    user = await prisma.user.create({ data: { email: 'summary@test.local' } });
    other = await prisma.user.create({ data: { email: 'summary-other@test.local' } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
  });

  beforeEach(async () => {
    await prisma.email.deleteMany({ where: { userId: { in: [user.id, other.id] } } });
    await prisma.mailScanDay.deleteMany({ where: { userId: { in: [user.id, other.id] } } });
  });

  it('starts at midnight UTC 29 days before today', () => {
    expect(summaryStart(NOW).toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('counts the 30 days by arrival, and failed mails of any date', async () => {
    await prisma.mailScanDay.createMany({
      data: [
        { userId: user.id, day: '2026-11-17', count: 5 },
        { userId: user.id, day: '2026-10-19', count: 2 },
        // The day before the 30 days, and another user's day: not counted.
        { userId: user.id, day: '2026-10-18', count: 40 },
        { userId: other.id, day: '2026-11-17', count: 9 },
      ],
    });
    const mail = (id: string, data: Record<string, unknown>) => ({
      userId: user.id,
      gmailMessageId: id,
      receivedAt: ago(1),
      ...data,
    });
    await prisma.email.createMany({
      data: [
        mail('job-1', { relevanceState: 'RELEVANT', processingState: 'COMPLETED' }),
        mail('job-old', { relevanceState: 'RELEVANT', receivedAt: ago(31) }),
        mail('other-1', { relevanceState: 'IRRELEVANT' }),
        mail('other-2', { relevanceState: 'IRRELEVANT', receivedAt: null }),
        mail('other-old', { relevanceState: 'IRRELEVANT', receivedAt: ago(32) }),
        mail('wait-1', { relevanceState: 'UNPROCESSED', processingState: 'PENDING' }),
        mail('stopped-new', { relevanceState: 'UNPROCESSED', processingState: 'FAILED' }),
        mail('stopped-old', {
          relevanceState: 'RELEVANT',
          processingState: 'FAILED',
          receivedAt: ago(60),
        }),
        { userId: other.id, gmailMessageId: 'x', relevanceState: 'RELEVANT', receivedAt: ago(1) },
      ],
    });
    await prisma.email.create({
      data: {
        ...mail('fake-1', { relevanceState: 'RELEVANT' }),
        aiProcessingResult: {
          create: {
            provider: 'fixture',
            model: 'fixture-fast',
            contractVersion: 'fixture',
            processingStatus: 'COMPLETED',
            fakeOfferWarning: 'Asks for a fee before the job starts.',
          },
        },
      },
    });

    expect(await readGmailSummary(user.id, NOW)).toEqual({
      days: 30,
      since: '2026-10-19T00:00:00.000Z',
      checked: 7,
      jobMails: 2,
      notJobMails: 2,
      waiting: 1,
      fakeOffers: 1,
      failed: 2,
    });
  });

  it('answers in the contract shape, for the signed-in user only', async () => {
    await prisma.mailScanDay.create({
      data: { userId: other.id, day: new Date().toISOString().slice(0, 10), count: 3 },
    });
    const res = await request(app).get('/api/gmail/summary').set('X-Development-User', user.email);
    expect(res.status).toBe(200);
    const body = GmailSummaryResponseSchema.parse(res.body);
    expect(body).toMatchObject({ checked: 0, jobMails: 0, notJobMails: 0, failed: 0 });
  });

  it('needs a signed-in user', async () => {
    const res = await request(app).get('/api/gmail/summary');
    expect(res.status).toBe(401);
  });
});
