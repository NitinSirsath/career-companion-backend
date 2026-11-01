import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueEmailProcessingJob: vi.fn(async () => 'email-job'),
  enqueueNotificationJob: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import {
  blockableDomain,
  companyDomain,
  isBlockedSender,
  senderDomain,
} from '../contracts/blockedSender';
import { processEmail } from '../services/ai/pipeline';

const OWNER = `owner-${randomUUID()}@delete-block.test`;
const OTHER = `other-${randomUUID()}@delete-block.test`;
const as = { 'X-Development-User': OWNER };
const RECRUITER = 'Talent Acquisition <talent-acquisition@careers.infosys.com>';
let owner = '';
let other = '';
let appId = '';

/** A job conversation of two mails, linked to an application, with a step and a reply. */
async function conversation(threadId: string, sender = RECRUITER) {
  const mail = (n: number) =>
    prisma.email.create({
      data: {
        userId: owner,
        gmailMessageId: `${threadId}-${n}`,
        threadId,
        subject: `Interview availability ${n}`,
        sender,
        receivedAt: new Date(Date.UTC(2026, 9, 20 + n)),
        relevanceState: 'RELEVANT',
        processingState: 'COMPLETED',
        matchState: 'MATCHED',
        matchConfirmedBy: 'AI_AUTO',
        applicationId: appId,
        aiProcessingResult: {
          create: {
            provider: 'fixture',
            model: 'fixture',
            contractVersion: 'extraction/v2',
            processingStatus: 'COMPLETED',
            relevanceDecision: 'RELEVANT',
            category: 'INTERVIEW',
            companyName: 'Infosys Limited',
            recruiterEmail: 'talent-acquisition@careers.infosys.com',
          },
        },
      },
    });
  const mails = [await mail(1), await mail(2)];
  await prisma.action.create({
    data: {
      applicationId: appId,
      emailId: mails[1].id,
      origin: 'EMAIL',
      type: 'ACTION_REQUIRED',
      description: 'Share your availability',
    },
  });
  await prisma.applicationEvent.create({
    data: {
      applicationId: appId,
      emailId: mails[1].id,
      type: 'EMAIL_PROCESSED',
      description: 'Interview invite',
    },
  });
  await prisma.outgoingEmail.create({
    data: { userId: owner, gmailMessageId: `${threadId}-sent`, threadId, sentAt: new Date() },
  });
  return mails;
}

beforeAll(async () => {
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  vi.stubEnv('ENABLE_DEV_AUTH', 'true');
  for (const userId of [owner, other]) {
    await prisma.email.deleteMany({ where: { userId } });
    await prisma.outgoingEmail.deleteMany({ where: { userId } });
    await prisma.application.deleteMany({ where: { userId } });
    await prisma.blockedSender.deleteMany({ where: { userId } });
  }
  appId = (
    await prisma.application.create({
      data: { userId: owner, companyName: 'Infosys Limited', aiStatus: 'INTERVIEW' },
    })
  ).id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});

describe('which senders can be blocked', () => {
  it('blocks a whole company domain, never LinkedIn or a mail provider', () => {
    expect(senderDomain(RECRUITER)).toBe('careers.infosys.com');
    expect(senderDomain('hr@Acme.COM')).toBe('acme.com');
    expect(senderDomain('No address')).toBeNull();
    expect(companyDomain('careers.infosys.com')).toBe('infosys.com');
    expect(companyDomain('mail.tcs.co.in')).toBe('tcs.co.in');
    expect(blockableDomain(RECRUITER)).toBe('infosys.com');
    expect(blockableDomain('Andy via LinkedIn <messaging-digest-noreply@linkedin.com>')).toBeNull();
    expect(blockableDomain('jobs-noreply@e.linkedin.com')).toBeNull();
    expect(blockableDomain('Priya <priya.recruits@gmail.com>')).toBeNull();
    expect(blockableDomain('someone@yahoo.co.in')).toBeNull();
    expect(isBlockedSender('ceo@infosys.com', ['infosys.com'])).toBe(true);
    expect(isBlockedSender('ceo@infosys.co', ['infosys.com'])).toBe(false);
  });
});

describe('deleting a conversation', () => {
  it('keeps only bare ids, removes what the app took from it, and leaves the application', async () => {
    const mails = await conversation('thread-del');
    const res = await request(app).delete('/api/conversations/thread-del').set(as).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2, blocked: null });

    const kept = await prisma.email.findMany({
      where: { userId: owner },
      include: { aiProcessingResult: true },
    });
    expect(kept).toHaveLength(2);
    for (const mail of kept) {
      expect(mail).toMatchObject({
        subject: null,
        sender: null,
        relevanceState: 'IRRELEVANT',
        processingState: 'COMPLETED',
        applicationId: null,
        matchState: 'UNMATCHED',
      });
      expect(mail.aiProcessingResult).toMatchObject({
        provider: 'deleted',
        relevanceDecision: 'IRRELEVANT',
        companyName: null,
        recruiterEmail: null,
      });
    }
    expect(await prisma.action.count({ where: { applicationId: appId } })).toBe(0);
    expect(await prisma.applicationEvent.count({ where: { applicationId: appId } })).toBe(0);
    expect(await prisma.outgoingEmail.count({ where: { userId: owner } })).toBe(0);
    expect(await prisma.application.findUnique({ where: { id: appId } })).toMatchObject({
      aiStatus: 'INTERVIEW',
    });
    await request(app).get('/api/conversations/thread-del').set(as).expect(404);
    const listed = await request(app).get('/api/gmail/messages').set(as);
    expect(listed.body.items).toEqual([]);

    // A queued AI job for a deleted mail adopts the deletion and never reads it again.
    await processEmail(owner, mails[0].id);
    expect(await prisma.email.findUniqueOrThrow({ where: { id: mails[0].id } })).toMatchObject({
      relevanceState: 'IRRELEVANT',
      subject: null,
    });
  });

  it("also blocks the company when asked, and opens by any mail's id", async () => {
    const [first] = await conversation('thread-block');
    const res = await request(app)
      .delete(`/api/conversations/${first.id}`)
      .set(as)
      .send({ block: true });
    expect(res.body).toEqual({ deleted: 2, blocked: 'infosys.com' });
    const list = await request(app).get('/api/blocked-senders').set(as);
    expect(list.body.items).toEqual([
      expect.objectContaining({ domain: 'infosys.com', source: 'DELETE' }),
    ]);
  });

  it('refuses a block for LinkedIn and changes nothing', async () => {
    await conversation('thread-li', 'Andy via LinkedIn <messaging-digest-noreply@linkedin.com>');
    const res = await request(app)
      .delete('/api/conversations/thread-li')
      .set(as)
      .send({ block: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_BLOCKABLE');
    expect(await prisma.email.count({ where: { userId: owner, sender: { not: null } } })).toBe(2);
  });

  it('waits while the AI reads one of its mails', async () => {
    const [, second] = await conversation('thread-busy');
    await prisma.email.update({
      where: { id: second.id },
      data: { processingState: 'PROCESSING' },
    });
    const res = await request(app).delete('/api/conversations/thread-busy').set(as).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MAIL_BEING_READ');
  });

  it("never touches another user's conversation", async () => {
    await conversation('thread-own');
    await request(app)
      .delete('/api/conversations/thread-own')
      .set({ 'X-Development-User': OTHER })
      .send({})
      .expect(404);
    expect(await prisma.email.count({ where: { userId: owner, relevanceState: 'RELEVANT' } })).toBe(
      2,
    );
  });
});

describe('blocking from the menu', () => {
  it('blocks the company and keeps the conversation; blocking twice keeps one row', async () => {
    await conversation('thread-menu');
    const first = await request(app).post('/api/conversations/thread-menu/block').set(as).send({});
    expect(first.body).toMatchObject({ domain: 'infosys.com', source: 'MENU' });
    await request(app).post('/api/conversations/thread-menu/block').set(as).send({}).expect(200);
    expect(await prisma.blockedSender.count({ where: { userId: owner } })).toBe(1);
    expect(await prisma.email.count({ where: { userId: owner, relevanceState: 'RELEVANT' } })).toBe(
      2,
    );
    await request(app)
      .delete(`/api/blocked-senders/${first.body.id}`)
      .set({ 'X-Development-User': OTHER })
      .expect(200);
    expect(await prisma.blockedSender.count({ where: { userId: owner } })).toBe(1);
    await request(app).delete(`/api/blocked-senders/${first.body.id}`).set(as).expect(200);
    expect(await prisma.blockedSender.count({ where: { userId: owner } })).toBe(0);
  });
});

describe('deleting an application', () => {
  it('removes it with its steps and history; its mails stay, no longer linked', async () => {
    await conversation('thread-app');
    await request(app)
      .delete(`/api/applications/${appId}`)
      .set({ 'X-Development-User': OTHER })
      .expect(404);
    const res = await request(app).delete(`/api/applications/${appId}`).set(as);
    expect(res.status).toBe(200);
    expect(await prisma.application.findUnique({ where: { id: appId } })).toBeNull();
    expect(await prisma.action.count({ where: { applicationId: appId } })).toBe(0);
    const mails = await prisma.email.findMany({ where: { userId: owner } });
    expect(mails).toHaveLength(2);
    for (const mail of mails)
      expect(mail).toMatchObject({
        relevanceState: 'RELEVANT',
        applicationId: null,
        matchState: 'UNMATCHED',
        matchConfirmedBy: null,
      });
    const detail = await request(app).get('/api/conversations/thread-app').set(as);
    expect(detail.body.conversation.application).toBeNull();
  });

  it('also deletes what the automation reported for it, and nothing else of the automation', async () => {
    const otherApp = await prisma.application.create({
      data: { userId: owner, companyName: 'Wipro Limited' },
    });
    const settled = { resolvedBy: 'AUTOMATIC', resolvedAt: new Date() } as const;
    const record = (sourceRecordRef: string, data: object) =>
      prisma.externalSubmission.create({
        data: {
          userId: owner,
          source: 'AUTOMATION',
          sourceRecordRef,
          platform: 'linkedin',
          company: 'Infosys Limited',
          jobTitle: 'Frontend Engineer',
          submittedAt: new Date(Date.UTC(2026, 9, 30)),
          submittedAnswers: [{ question: 'Notice period?', answer: '30 days' }],
          matchState: 'NEEDS_REVIEW',
          ...data,
        },
      });
    const created = await record('2026-10-30/10:00:00', {
      ...settled,
      matchState: 'CREATED',
      applicationId: appId,
    });
    await record('2026-10-30/11:00:00', { ...settled, matchState: 'LINKED', applicationId: appId });
    await prisma.applicationEvent.create({
      data: {
        applicationId: appId,
        type: 'AUTOMATION_SUBMITTED',
        externalSubmissionId: created.id,
      },
    });
    const kept = [
      await record('2026-10-30/12:00:00', {}),
      await record('2026-10-30/13:00:00', {
        matchState: 'IGNORED',
        resolvedBy: 'USER',
        resolvedAt: new Date(),
      }),
      await record('2026-10-30/14:00:00', {
        ...settled,
        matchState: 'LINKED',
        applicationId: otherApp.id,
      }),
    ];
    const skipped = await prisma.notSubmittedJob.create({
      data: {
        userId: owner,
        source: 'AUTOMATION',
        sourceRecordRef: '2026-10-30/15:00:00',
        outcome: 'SKIPPED',
        platform: 'naukri',
        company: 'Infosys Limited',
        jobTitle: 'Backend Engineer',
        reason: 'Asks for 8 years of experience',
        loggedAt: new Date(),
      },
    });

    await request(app).delete(`/api/applications/${appId}`).set(as).expect(200);

    const left = await prisma.externalSubmission.findMany({
      where: { userId: owner },
      select: { id: true },
    });
    expect(left.map((row) => row.id).sort()).toEqual(kept.map((row) => row.id).sort());
    expect(await prisma.notSubmittedJob.findUnique({ where: { id: skipped.id } })).not.toBeNull();
    expect(await prisma.application.findUnique({ where: { id: otherApp.id } })).not.toBeNull();
  });
});
