import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db/prisma';
import { cleanUpOldMail, NOT_JOB_MAIL_KEPT_DAYS } from '../services/mailRetention';
import { MAX_SYNC_WINDOW_DAYS } from '../services/gmailSync';

const DAY = 86_400_000;
let userId = '';
const now = new Date('2026-10-26T12:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `retention-${Date.now()}@fixture.test` } }))
    .id;
});
beforeEach(async () => {
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.outgoingEmail.deleteMany({ where: { userId } });
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});

describe('old mail clean-up', () => {
  it('keeps non-job mails longer than a sync can read back', () => {
    expect(NOT_JOB_MAIL_KEPT_DAYS).toBeGreaterThan(MAX_SYNC_WINDOW_DAYS);
  });

  it('deletes only non-job mails received before the kept days', async () => {
    const mail = (id: string, relevanceState: 'IRRELEVANT' | 'RELEVANT', receivedAt: Date) => ({
      userId,
      gmailMessageId: id,
      threadId: `t-${id}`,
      relevanceState,
      receivedAt,
    });
    await prisma.email.createMany({
      data: [
        mail('old-other', 'IRRELEVANT', daysAgo(NOT_JOB_MAIL_KEPT_DAYS + 1)),
        mail('new-other', 'IRRELEVANT', daysAgo(NOT_JOB_MAIL_KEPT_DAYS - 1)),
        mail('old-job', 'RELEVANT', daysAgo(400)),
      ],
    });
    expect((await cleanUpOldMail(now)).mails).toBe(1);
    const left = await prisma.email.findMany({
      where: { userId },
      select: { gmailMessageId: true },
    });
    expect(left.map((row) => row.gmailMessageId).sort()).toEqual(['new-other', 'old-job']);
    expect((await cleanUpOldMail(now)).mails).toBe(0);
  });

  it('deletes sent-mail records only in threads with no job mail', async () => {
    await prisma.email.createMany({
      data: [
        { userId, gmailMessageId: 'j1', threadId: 'job', relevanceState: 'RELEVANT' },
        { userId, gmailMessageId: 'j2', threadId: 'job', relevanceState: 'IRRELEVANT' },
        { userId, gmailMessageId: 'u1', threadId: 'unread', relevanceState: 'UNPROCESSED' },
        { userId, gmailMessageId: 'o1', threadId: 'other', relevanceState: 'IRRELEVANT' },
      ],
    });
    const sent = (id: string, threadId: string) => ({
      userId,
      gmailMessageId: id,
      threadId,
      sentAt: now,
    });
    await prisma.outgoingEmail.createMany({
      data: [sent('s1', 'job'), sent('s2', 'unread'), sent('s3', 'other'), sent('s4', 'gone')],
    });
    expect((await cleanUpOldMail(now)).sent).toBe(2);
    const left = await prisma.outgoingEmail.findMany({
      where: { userId },
      select: { threadId: true },
    });
    expect(left.map((row) => row.threadId).sort()).toEqual(['job', 'unread']);
  });
});
