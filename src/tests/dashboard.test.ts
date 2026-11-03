import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { EmailCategory, Prisma } from '@prisma/client';
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
    await prisma.mailScanDay.deleteMany({ where: { userId } });
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

/** A job mail with what the AI read, not linked to a job. */
async function jobMail(
  receivedAt: Date,
  result: Partial<Prisma.AIProcessingResultUncheckedCreateInput> = {},
  threadId: string = randomUUID(),
) {
  return prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: randomUUID(),
      threadId,
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      receivedAt,
      aiProcessingResult: {
        create: {
          provider: 'fixture',
          model: 'fixture',
          contractVersion: 'fixture',
          processingStatus: 'COMPLETED',
          category: 'RECRUITER',
          ...result,
        },
      },
    },
  });
}

const get = (query = '', as = address) =>
  request(app).get(`/api/dashboard${query}`).set('X-Development-User', as);
const mailsPage = async (query: string) =>
  (
    await request(app)
      .get(`/api/conversations?limit=100&${query}`)
      .set('X-Development-User', address)
      .expect(200)
  ).body.items as unknown[];
const day = (date: Date) => date.toISOString().slice(0, 10);

it('a new user gets empty numbers, not an error', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    period: '30d',
    dataStartsAt: null,
    funnel: { applied: 0 },
    goneQuiet: { count: 0, jobs: [] },
    automation: { used: false, sites: [] },
    now: {
      newJobMails: { count: 0, today: 0 },
      needsAction: { count: 0, waitingOverADay: 0 },
      interviews: { count: 0, next: null },
    },
    usualReplyDays: null,
    mailbox: {
      scanned: { total: 0, inPeriod: 0 },
      jobMails: { total: 0, inPeriod: 0 },
      notLinked: 0,
      fakeOffers: 0,
    },
  });
  for (const gone of ['tips', 'aiTip', 'data', 'rightNow', 'rejectedAfter', 'weeks'])
    expect(res.body).not.toHaveProperty(gone);
  for (const gone of ['answerSpeed', 'keepingUp']) expect(res.body).not.toHaveProperty(gone);
  expect(res.body.trend.weeks).toHaveLength(12);
  expect(res.body.series.bucket).toBe('day');
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
  expect(res.body.rates.interview).toEqual({ count: 1, of: 1 });
  expect(res.body.usualReplyDays).toBe(10);
  expect(res.body.mailbox).toEqual({
    scanned: { total: 0, inPeriod: 0 },
    jobMails: { total: 2, inPeriod: 2 },
    notLinked: 0,
    fakeOffers: 0,
  });
  type Point = Record<string, number>;
  const sum = (key: string) =>
    (res.body.series.points as Point[]).reduce((total, point) => total + point[key], 0);
  expect(sum('applicationsSent')).toBe(1);
  expect(sum('replies')).toBe(1);
  expect(sum('interviews')).toBe(1);
  expect(sum('interviewMails')).toBe(1);
  expect(sum('rejectionMails')).toBe(1);
});

it('needs you now counts what the Mails page lists', async () => {
  await jobMail(new Date()); // new today
  await jobMail(daysAgo(3)); // new, older
  const seen = await jobMail(daysAgo(4));
  await prisma.email.update({ where: { id: seen.id }, data: { seenAt: new Date() } });
  // Asks for an answer by mail, two days ago: waiting over a day.
  await jobMail(daysAgo(2), {
    actionRequired: true,
    requestedAction: 'Reply with two times for a call',
    askKind: 'REPLY_BY_MAIL',
  });
  await jobMail(new Date(Date.now() - 60 * 60 * 1000), {
    actionRequired: true,
    requestedAction: 'Fill in the form',
    askKind: 'OUTSIDE_MAIL',
  });

  const now = (await get('?timeZone=UTC')).body.now;
  expect(now.newJobMails.count).toBe((await mailsPage('unseen=true')).length);
  expect(now.newJobMails.count).toBe(4);
  expect(now.needsAction.count).toBe((await mailsPage('request=open')).length);
  expect(now.needsAction).toEqual({ count: 2, waitingOverADay: 1 });
  expect(now.newJobMails.today).toBeGreaterThanOrEqual(1);
  expect(now.newJobMails.today).toBeLessThanOrEqual(2);
});

it('interviews coming up come from the dates the AI read off job mails', async () => {
  const job = await prisma.application.create({
    data: { userId: owner, companyName: 'Harbor Analytics', jobTitle: 'Designer' },
  });
  const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const later = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
  const invite = await jobMail(daysAgo(1), {
    category: 'INTERVIEW',
    interviewDate: day(soon),
    interviewTime: '10:00 AM IST',
  });
  await prisma.email.update({ where: { id: invite.id }, data: { applicationId: job.id } });
  await jobMail(daysAgo(1), {
    category: 'INTERVIEW',
    companyName: 'Quill',
    interviewDate: day(later),
  });
  await jobMail(daysAgo(9), { category: 'INTERVIEW', interviewDate: day(daysAgo(5)) });
  await jobMail(daysAgo(1), {
    category: 'OFFER',
    interviewDate: day(soon),
    fakeOfferWarning: 'Asks for a fee',
  });

  const { interviews } = (await get('?timeZone=UTC')).body.now;
  expect(interviews).toEqual({
    count: 2,
    next: {
      applicationId: job.id,
      companyName: 'Harbor Analytics',
      jobTitle: 'Designer',
      conversationKey: invite.threadId,
      date: day(soon),
      time: '10:00',
    },
  });
});

it('mails scanned come from the daily counts, all time and in the period', async () => {
  await prisma.mailScanDay.createMany({
    data: [
      { userId: owner, day: day(new Date()), count: 5 },
      { userId: owner, day: day(daysAgo(10)), count: 2 },
      { userId: owner, day: day(daysAgo(40)), count: 3 },
      { userId: other, day: day(new Date()), count: 9 },
    ],
  });
  await jobMail(daysAgo(1), { fakeOfferWarning: 'Asks for a fee', category: 'OFFER' });
  await jobMail(daysAgo(50));
  const { mailbox } = (await get('?period=30d')).body;
  expect(mailbox).toEqual({
    scanned: { total: 10, inPeriod: 7 },
    jobMails: { total: 2, inPeriod: 1 },
    notLinked: 2,
    fakeOffers: 1,
  });
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
