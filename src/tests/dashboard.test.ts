import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { EmailCategory } from '@prisma/client';
import { app } from '../index';
import { prisma } from '../db/prisma';
import { applyMatch } from '../services/matcher';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));

const address = 'dashboard@fixture.test';
const otherAddress = 'dashboard-other@fixture.test';
let owner: string;
let other: string;
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: address } })).id;
  other = (await prisma.user.create({ data: { email: otherAddress } })).id;
});
beforeEach(async () => {
  for (const userId of [owner, other]) {
    await prisma.email.deleteMany({ where: { userId } });
    await prisma.application.deleteMany({ where: { userId } });
  }
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});

async function mail(
  userId: string,
  applicationId: string,
  category: EmailCategory,
  receivedAt: Date,
) {
  const email = await prisma.email.create({
    data: {
      userId,
      gmailMessageId: randomUUID(),
      threadId: randomUUID(),
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      receivedAt,
    },
  });
  const result = await prisma.aIProcessingResult.create({
    data: {
      emailId: email.id,
      provider: 'fixture',
      model: 'fixture',
      contractVersion: 'fixture',
      category,
      processingStatus: 'COMPLETED',
    },
  });
  await applyMatch(email.id, applicationId, result, 'AI_AUTO');
}

const get = (query = '', as = address) =>
  request(app).get(`/api/dashboard${query}`).set('X-Development-User', as);

it('a new user gets empty numbers, not an error', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    period: '30d',
    dataStartsAt: null,
    funnel: { applied: 0 },
    goneQuiet: { count: 0, jobs: [] },
    automation: { used: false, sites: [] },
    tips: [],
    aiTip: null,
  });
  expect(res.body.weeks).toHaveLength(12);
});

it("counts only the user's own jobs, by the status log", async () => {
  const job = await prisma.application.create({
    data: { userId: owner, companyName: 'Acme', appliedAt: daysAgo(20) },
  });
  await mail(owner, job.id, 'INTERVIEW', daysAgo(10));
  await mail(owner, job.id, 'REJECTION', daysAgo(2));
  const theirs = await prisma.application.create({
    data: { userId: other, companyName: 'Other', appliedAt: daysAgo(5) },
  });
  await mail(other, theirs.id, 'OFFER', daysAgo(1));

  const res = await get('?period=30d&timeZone=Asia/Kolkata');
  expect(res.status).toBe(200);
  expect(res.body.totals.current).toEqual({
    applicationsSent: 1,
    repliesReceived: 1,
    interviewsReached: 1,
    offers: 0,
    rejections: 1,
  });
  expect(res.body.funnel).toMatchObject({ applied: 1, answered: 1, interview: 1, offer: 0 });
  expect(res.body.rejectedAfter.interview).toBe(1);
  expect(res.body.rates.interview).toEqual({ count: 1, of: 1 });
  expect(res.body.data).toEqual({ jobMailsRead: 2, notLinked: 0, waitingForAI: 0, fakeOffers: 0 });
});

it('"all" has no period before it', async () => {
  await prisma.application.create({
    data: { userId: owner, companyName: 'Acme', appliedAt: daysAgo(200) },
  });
  const res = await get('?period=all');
  expect(res.body.totals.previous).toBeNull();
  expect(res.body.totals.current.applicationsSent).toBe(1);
});

it('refuses an unknown period or time zone', async () => {
  expect((await get('?period=year')).status).toBe(400);
  expect((await get('?timeZone=Mars')).status).toBe(400);
});

it('needs a signed-in user', async () => {
  expect((await request(app).get('/api/dashboard')).status).toBe(401);
});
