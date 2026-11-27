import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ApplicationStatus, EmailCategory } from '@prisma/client';

vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { DashboardResponseSchema } from '../contracts';
import { matchEmailToApplication } from '../services/matcher';
import { tidyAllStatuses } from '../services/statusUpkeep';

const OWNER = 'owner@status-upkeep.test';
let owner: string;
let counter = 0;
let server: Server;

const as = { 'X-Development-User': OWNER };
/** A moment in November 2026 (UTC). */
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour));

type Read = {
  category: EmailCategory;
  companyName: string;
  recruiterName?: string;
  assessmentInfo?: string;
  offerInfo?: string;
  rejectionInfo?: string;
};

/** A job mail with its AI read, linked to the application or waiting for one. */
const jobMail = (day: number, read: Read, applicationId?: string) =>
  prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: `status-${++counter}`,
      threadId: `t-status-${counter}`,
      subject: `${read.companyName} mail`,
      sender: `Hiring <jobs@${read.companyName.toLowerCase().replace(/\W/g, '')}.example>`,
      receivedAt: at(day),
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      ...(applicationId ? { applicationId, matchState: 'MATCHED' as const } : {}),
      aiProcessingResult: {
        create: {
          provider: 'fixture',
          model: 'fixture',
          contractVersion: 'extraction/v8',
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          ...read,
        },
      },
    },
  });

/** An AI step in the history, as the old rule wrote it when the mail was linked. */
const step = (
  applicationId: string,
  mail: { id: string; receivedAt: Date | null },
  fromStatus: ApplicationStatus | null,
  toStatus: ApplicationStatus,
) =>
  prisma.statusChange.create({
    data: {
      applicationId,
      emailId: mail.id,
      source: 'AI',
      fromStatus,
      toStatus,
      changedAt: mail.receivedAt ?? at(1),
    },
  });

const application = (
  companyName: string,
  aiStatus: ApplicationStatus | null,
  userStatus?: ApplicationStatus,
) =>
  prisma.application.create({
    data: {
      userId: owner,
      companyName,
      aiStatus,
      ...(userStatus ? { userStatus, userStatusSetAt: at(2) } : {}),
    },
  });

const aiStatusOf = async (id: string) =>
  (await prisma.application.findUniqueOrThrow({ where: { id } })).aiStatus;
/** The live AI steps of an application, oldest first. */
const steps = async (applicationId: string) =>
  (
    await prisma.statusChange.findMany({
      where: { applicationId, source: 'AI', retiredAt: null },
      orderBy: { changedAt: 'asc' },
    })
  ).map((row) => row.toStatus);
const funnel = async () => {
  const res = await request(server).get('/api/dashboard?period=30d&timeZone=UTC').set(as);
  expect(res.status).toBe(200);
  return DashboardResponseSchema.parse(res.body).funnel;
};

const PITCH: Read = {
  category: 'RECRUITER',
  companyName: 'Meridial by Invisible',
  recruiterName: 'Ishan Patnaik',
  assessmentInfo: 'Complete a language fluency introduction and a JSON Skills Assessment.',
};
const CONFIRMATION: Read = {
  category: 'FOLLOW_UP',
  companyName: 'Genpact',
  assessmentInfo: 'Assessments will only be triggered for specific positions.',
};

/**
 * The owner's real case (27 Nov 2026), as the old rule left it: a recruiter's pitch and an
 * application confirmation shown as Assessment, next to a real test, a status the user set by hand
 * and a job rejected after its confirmation.
 */
async function oldStatuses() {
  const meridial = await application('Meridial by Invisible', 'ASSESSMENT');
  await step(meridial.id, await jobMail(26, PITCH, meridial.id), null, 'ASSESSMENT');

  const genpact = await application('Genpact', 'ASSESSMENT');
  await step(genpact.id, await jobMail(22, CONFIRMATION, genpact.id), null, 'ASSESSMENT');

  const rampwork = await application('Rampwork', 'ASSESSMENT');
  const test: Read = {
    category: 'ASSESSMENT',
    companyName: 'Rampwork',
    assessmentInfo: 'Complete a 30-45 minute AI assessment.',
  };
  await step(rampwork.id, await jobMail(7, test, rampwork.id), null, 'ASSESSMENT');

  // The user's own status hides the AI's: the old rule wrote no step for it.
  const initech = await application('Initech', 'ASSESSMENT', 'INTERVIEW');
  await jobMail(11, { ...CONFIRMATION, companyName: 'Initech' }, initech.id);

  const globex = await application('Globex', 'REJECTED');
  const globexMail = await jobMail(11, { ...CONFIRMATION, companyName: 'Globex' }, globex.id);
  await step(globex.id, globexMail, null, 'ASSESSMENT');
  const no: Read = { category: 'REJECTION', companyName: 'Globex', rejectionInfo: 'Not selected' };
  await step(globex.id, await jobMail(21, no, globex.id), 'ASSESSMENT', 'REJECTED');

  return { meridial, genpact, rampwork, initech, globex };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(27, 12));
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
});
beforeEach(async () => {
  vi.setSystemTime(at(27, 12));
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
});
afterAll(async () => {
  vi.useRealTimers();
  await new Promise((resolve) => server.close(resolve));
  await prisma.user.deleteMany({ where: { id: owner } });
});

describe('the hourly upkeep: statuses the old rule gave', () => {
  it('puts the pitch and the confirmation back, and the Dashboard follows', async () => {
    const { meridial, genpact, rampwork, initech, globex } = await oldStatuses();
    expect(await funnel()).toMatchObject({ applied: 5, recruiterContact: 5, assessment: 5 });

    // Only the two the user sees change; the user's own status and the end of a job stay.
    expect(await tidyAllStatuses()).toBe(2);

    expect(await aiStatusOf(meridial.id)).toBe('RECRUITER_CONTACT');
    expect(await steps(meridial.id)).toEqual(['RECRUITER_CONTACT']);
    expect(await aiStatusOf(genpact.id)).toBe('APPLIED');
    expect(await steps(genpact.id)).toEqual(['APPLIED']);
    expect(await aiStatusOf(rampwork.id)).toBe('ASSESSMENT');
    expect(await steps(rampwork.id)).toEqual(['ASSESSMENT']);
    expect(await aiStatusOf(initech.id)).toBe('APPLIED');
    expect(await steps(initech.id)).toEqual([]);
    const hidden = await prisma.application.findUniqueOrThrow({ where: { id: initech.id } });
    expect(hidden.userStatus).toBe('INTERVIEW');
    expect(await aiStatusOf(globex.id)).toBe('REJECTED');
    expect(await steps(globex.id)).toEqual(['APPLIED', 'REJECTED']);

    // Only the real test reached Assessment; the user's Interview still counts.
    expect(await funnel()).toMatchObject({
      applied: 5,
      recruiterContact: 3,
      assessment: 2,
      interview: 1,
      offer: 0,
    });
  });

  it('is safe to run again: nothing in step is written twice', async () => {
    await oldStatuses();
    await tidyAllStatuses();
    const rows = await prisma.statusChange.findMany({
      where: { application: { userId: owner } },
      orderBy: { id: 'asc' },
    });

    expect(await tidyAllStatuses()).toBe(0);
    expect(
      await prisma.statusChange.findMany({
        where: { application: { userId: owner } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(rows);
  });

  it("leaves a recruiter's offer alone when the mail itself is an offer", async () => {
    const hooli = await application('Hooli', 'OFFER');
    const offer: Read = {
      category: 'OFFER',
      companyName: 'Hooli',
      offerInfo: '30 LPA, joining 1 Jan',
    };
    const pitch: Read = { ...PITCH, companyName: 'Hooli', offerInfo: '$11 per hour' };
    await step(hooli.id, await jobMail(10, pitch, hooli.id), null, 'RECRUITER_CONTACT');
    await step(hooli.id, await jobMail(20, offer, hooli.id), 'RECRUITER_CONTACT', 'OFFER');

    expect(await tidyAllStatuses()).toBe(0);
    expect(await aiStatusOf(hooli.id)).toBe('OFFER');
    expect(await steps(hooli.id)).toEqual(['RECRUITER_CONTACT', 'OFFER']);
  });
});

describe('a new mail, as it is linked', () => {
  it('a confirmation that names tests keeps the application at Applied', async () => {
    const hooli = await application('Hooli', null);
    const mail = await jobMail(27, { ...CONFIRMATION, companyName: 'Hooli' });

    await matchEmailToApplication(mail.id);

    expect(await aiStatusOf(hooli.id)).toBe('APPLIED');
    expect(await steps(hooli.id)).toEqual(['APPLIED']);
    expect(await tidyAllStatuses()).toBe(0);
  });
});
