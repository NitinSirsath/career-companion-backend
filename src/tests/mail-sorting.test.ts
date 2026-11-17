import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { EmailCategory } from '@prisma/client';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { sameJobTitle } from '../services/jobTitle';
import { matchEmailToApplication } from '../services/matcher';
import {
  ConversationDetailSchema,
  LinkConversationResponseSchema,
  ListConversationsResponseSchema,
} from '../contracts';

const OWNER = 'owner@mail-sorting.test';
let owner: string;
let counter = 0;
let server: Server;

const as = { 'X-Development-User': OWNER };
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9));

async function jobMail(
  threadId: string,
  receivedAt: Date,
  analysis: { category: EmailCategory; companyName: string | null; jobTitle?: string | null },
) {
  return prisma.email.create({
    data: {
      userId: owner,
      gmailMessageId: \`mail-sorting-\${++counter}\`,
      threadId,
      subject: 'A job mail',
      sender: 'Someone <someone@example.com>',
      receivedAt,
      relevanceState: 'RELEVANT',
      processingState: 'COMPLETED',
      aiProcessingResult: {
        create: {
          provider: 'gemini',
          model: 'test-model',
          contractVersion: 'extraction/v6',
          processingStatus: 'COMPLETED',
          relevanceDecision: 'RELEVANT',
          recruiterName: 'Joeri',
          jobTitle: null,
          ...analysis,
        },
      },
    },
  });
}

const application = (companyName: string, jobTitle: string | null) =>
  prisma.application.create({ data: { userId: owner, companyName, jobTitle } });
const emailRow = (id: string) => prisma.email.findUniqueOrThrow({ where: { id } });
const detail = async (key: string) => {
  const res = await request(server).get(\`/api/conversations/\${key}\`).set(as);
  expect(res.status).toBe(200);
  return ConversationDetailSchema.parse(res.body).conversation;
};
const link = (key: string, body: object = {}) =>
  request(server).post(\`/api/conversations/\${key}/application\`).set(as).send(body);

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
});
beforeEach(async () => {
  await prisma.email.deleteMany({ where: { userId: owner } });
  await prisma.application.deleteMany({ where: { userId: owner } });
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: OWNER } });
  await new Promise((resolve) => server.close(resolve));
});

describe('job titles that name the same job (owner, 17 Nov 2026)', () => {
  it.each([
    ['Front-end Developer (only for folks graduated in 2026 or earlier)', 'Front-end Developer'],
    ['Backend Engineer - Remote', 'Backend Engineer'],
    ['Data Analyst [Contract]', 'Data Analyst'],
    ['Frontend Developer', 'Front end developer'],
    ['Senior Front-end Developer', 'Front-end Developer'],
    ['SWE', 'swe'],
    ['Product Designer | Payments', 'Product Designer'],
  ])('"%s" is the same job as "%s"', (a, b) => {
    expect(sameJobTitle(a, b)).toBe(true);
    expect(sameJobTitle(b, a)).toBe(true);
  });

  it.each([
    ['Front-end Developer', 'Backend Developer'],
    ['Developer', 'Development Lead'],
    ['Intern', 'Internal Tools Engineer'],
    ['(Remote)', 'Engineer'],
  ])('"%s" is not the same job as "%s"', (a, b) => {
    expect(sameJobTitle(a, b)).toBe(false);
  });
});

describe('matching a platform mail to the application', () => {
  it('links the Wellfound POOLit mail to the NorthList Apply application', async () => {
    const poolit = await application('POOLit', 'Front-end Developer');
    const mail = await jobMail('poolit', at(16), {
      category: 'FOLLOW_UP',
      companyName: 'POOLit',
      jobTitle: 'Front-end Developer (only for folks graduated in 2026 or earlier)',
    });
    await matchEmailToApplication(mail.id);
    expect(await emailRow(mail.id)).toMatchObject({
      matchState: 'MATCHED',
      applicationId: poolit.id,
      matchConfirmedBy: 'AI_AUTO',
    });
  });

  it('still needs the same company', async () => {
    await application('Other Co', 'Front-end Developer');
    const mail = await jobMail('other', at(16), {
      category: 'FOLLOW_UP',
      companyName: 'POOLit',
      jobTitle: 'Front-end Developer',
    });
    await matchEmailToApplication(mail.id);
    expect((await emailRow(mail.id)).matchState).toBe('UNMATCHED');
  });

  it('asks the user when two applications of the company fit', async () => {
    await application('POOLit', 'Front-end Developer');
    await application('POOLit', 'Senior Front-end Developer');
    const mail = await jobMail('two', at(16), {
      category: 'FOLLOW_UP',
      companyName: 'POOLit',
      jobTitle: 'Senior Front-end Developer (Remote)',
    });
    await matchEmailToApplication(mail.id);
    expect((await emailRow(mail.id)).matchState).toBe('AMBIGUOUS');
  });
});

describe('the "Link to" offer for an unlinked mail', () => {
  it('offers the company’s applications when the title differs, and links the chosen one', async () => {
    const poolit = await application('POOLit', 'Front-end Developer');
    await application('Someone Else', 'Frontend Engineer');
    const mail = await jobMail('offer', at(16), {
      category: 'FOLLOW_UP',
      companyName: 'POOLit',
      jobTitle: 'Frontend Engineer',
    });
    await matchEmailToApplication(mail.id);
    const conversation = await detail('offer');
    expect(conversation.link).toBe('UNLINKED');
    expect(conversation.sameCompanyApplications).toEqual([
      { id: poolit.id, companyName: 'POOLit', jobTitle: 'Front-end Developer' },
    ]);

    const res = await link('offer', { applicationId: poolit.id });
    expect(res.status).toBe(200);
    const linked = LinkConversationResponseSchema.parse(res.body);
    expect(linked.created).toBe(false);
    expect(linked.conversation.sameCompanyApplications).toEqual([]);
  });

  it('offers nothing when the company has no application, or only an archived one', async () => {
    const old = await application('POOLit', 'Designer');
    await prisma.application.update({ where: { id: old.id }, data: { archivedAt: new Date() } });
    await jobMail('none', at(16), {
      category: 'RECRUITER',
      companyName: 'POOLit',
      jobTitle: 'Frontend Engineer',
    });
    expect((await detail('none')).sameCompanyApplications).toEqual([]);
    const res = await request(server).get('/api/conversations').set(as);
    expect(
      ListConversationsResponseSchema.parse(res.body).items[0].sameCompanyApplications,
    ).toEqual([]);
  });

  it('"Create application" joins the application whose title is the same job', async () => {
    const poolit = await application('POOLit', 'Front-end Developer');
    await jobMail('create', at(16), {
      category: 'RECRUITER',
      companyName: 'POOLit',
      jobTitle: 'Front-end Developer - Remote',
    });
    const res = await link('create');
    expect(res.status).toBe(200);
    const linked = LinkConversationResponseSchema.parse(res.body);
    expect(linked.created).toBe(false);
    expect(linked.application.id).toBe(poolit.id);
  });
});

describe('career contact (owner, 17 Nov 2026)', () => {
  it('is never linked by itself, not even to the company’s application or the thread’s', async () => {
    const agensi = await application('Agensi', null);
    await prisma.email.create({
      data: {
        userId: owner,
        gmailMessageId: \`mail-sorting-\${++counter}\`,
        threadId: 'joeri',
        matchState: 'MATCHED',
        applicationId: agensi.id,
      },
    });
    const mail = await jobMail('joeri', at(15), {
      category: 'CAREER_CONTACT',
      companyName: 'Agensi',
    });
    await matchEmailToApplication(mail.id);
    expect(await emailRow(mail.id)).toMatchObject({ matchState: 'UNMATCHED', applicationId: null });
  });

  it('offers no link and refuses to create or join an application', async () => {
    const agensi = await application('Agensi', null);
    await jobMail('contact', at(15), { category: 'CAREER_CONTACT', companyName: 'Agensi' });
    const conversation = await detail('contact');
    expect(conversation).toMatchObject({ category: 'CAREER_CONTACT', link: 'UNLINKED' });
    expect(conversation.sameCompanyApplications).toEqual([]);

    for (const body of [{}, { applicationId: agensi.id }]) {
      const res = await link('contact', body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CAREER_CONTACT');
    }
    expect(await prisma.application.count({ where: { userId: owner } })).toBe(1);
  });

  it('follows the newest typed mail: a later job mail in the thread can be linked', async () => {
    await jobMail('later', at(15), { category: 'CAREER_CONTACT', companyName: 'Agensi' });
    await jobMail('later', at(16), {
      category: 'RECRUITER',
      companyName: 'Agensi',
      jobTitle: 'Developer Advocate',
    });
    const res = await link('later');
    expect(res.status).toBe(200);
    expect(LinkConversationResponseSchema.parse(res.body).created).toBe(true);
  });
});
