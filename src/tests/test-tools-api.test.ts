import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueEmailProcessingJob: vi.fn(async () => 'email-job'),
  enqueueRelevanceTriage: vi.fn(async () => 'triage-job'),
  enqueueNotificationJob: vi.fn(),
}));
vi.mock('../services/gmailClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/gmailClient')>()),
  withGmail: vi.fn(async () => {
    throw new Error('Gmail must never be called for test-inbox emails');
  }),
}));

import { app } from '../index';
import { prisma } from '../db/prisma';
import { TEST_EMAIL_TEMPLATES, fillTemplate } from '../contracts/testTools';
import { JobExtractionSchema } from '../services/ai/contracts';
import { processEmail } from '../services/ai/pipeline';
import { createProviderClient } from '../services/ai/providers';
import { utcDay } from '../services/ai/usage';
import { enqueueEmailProcessingJob, enqueueRelevanceTriage } from '../services/enqueue';
import { withGmail } from '../services/gmailClient';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { configureAI } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

const OWNER = 'owner@test-tools.test';
const OTHER = 'other@test-tools.test';
const values = { company: 'Northwind Robotics', role: 'Senior Platform Engineer' };
const template = (id: string) =>
  fillTemplate(
    TEST_EMAIL_TEMPLATES.find((t) => t.id === id)!,
    values,
  );
let owner: string;
let other: string;

const as = (user: string) => ({ 'X-Development-User': user });
const status = () => request(app).get('/api/test-tools/status');
const deliver = (body: unknown, user = OWNER) =>
  request(app)
    .post('/api/test-tools/emails')
    .set(as(user))
    .send(body as object);
const reset = (body: unknown = { confirm: 'RESET' }) =>
  request(app)
    .post('/api/test-tools/reset')
    .set(as(OWNER))
    .send(body as object);

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [OWNER, OTHER] } } });
  owner = (await prisma.user.create({ data: { email: OWNER } })).id;
  other = (await prisma.user.create({ data: { email: OTHER } })).id;
});
beforeEach(async () => {
  vi.stubEnv('ENABLE_DEV_AUTH', 'true');
  vi.stubEnv('TEST_TOOLS_ENABLED', 'true');
  await prisma.email.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.application.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.aIConfiguration.deleteMany({ where: { userId: { in: [owner, other] } } });
  await prisma.aIUsageDay.deleteMany({ where: { userId: { in: [owner, other] } } });
  vi.mocked(enqueueEmailProcessingJob).mockClear();
  vi.mocked(enqueueRelevanceTriage).mockClear();
  vi.mocked(withGmail).mockClear();
  vi.mocked(createProviderClient).mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});

describe('test tools switch', () => {
  it('answers 404 on every path when off, before login', async () => {
    vi.stubEnv('TEST_TOOLS_ENABLED', '');
    expect((await status()).status).toBe(404);
    expect((await status().set(as(OWNER))).status).toBe(404);
    expect((await deliver(template('offer'))).status).toBe(404);
    expect((await reset()).status).toBe(404);
    expect(await prisma.email.count({ where: { userId: owner } })).toBe(0);
  });

  it('stays off when the database name has no "test", even with the flag on', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/career_companion_db?schema=public');
    expect((await status().set(as(OWNER))).status).toBe(404);
    expect((await deliver(template('offer'))).status).toBe(404);
  });

  it('reports status to a logged-in user only', async () => {
    expect((await status()).status).toBe(401);
    const response = await status().set(as(OWNER));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: true });
  });
});

describe('test inbox', () => {
  it('rejects invalid emails', async () => {
    expect((await deliver({ ...template('offer'), body: ' ' })).status).toBe(400);
    expect((await deliver({ ...template('offer'), label: 'INBOX' })).status).toBe(400);
    expect((await deliver({ ...template('offer'), threadId: '18c2f0a1b2c3d4e5' })).status).toBe(
      400,
    );
    const unknownField = await deliver({ ...template('offer'), extra: true });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('saves the email and queues it like a newly synced Gmail email', async () => {
    const response = await deliver(template('interview-invite'));
    expect(response.status).toBe(201);
    const email = await prisma.email.findUniqueOrThrow({
      where: { id: response.body.emailId },
      include: { simulatedContent: true },
    });
    expect(email).toMatchObject({
      userId: owner,
      threadId: response.body.threadId,
      sender: template('interview-invite').sender,
      subject: template('interview-invite').subject,
      processingState: 'PENDING',
      relevanceState: 'UNPROCESSED',
    });
    expect(email.gmailMessageId.startsWith('sim-')).toBe(true);
    expect(email.threadId!.startsWith('sim-thread-')).toBe(true);
    expect(email.receivedAt).not.toBeNull();
    expect(email.simulatedContent).toMatchObject({
      labels: ['INBOX', 'CATEGORY_PRIMARY'],
      body: template('interview-invite').body,
    });
    expect(enqueueEmailProcessingJob).toHaveBeenCalledWith(owner, email.id);
    expect(enqueueRelevanceTriage).not.toHaveBeenCalled();

    const reply = await deliver({ ...template('offer'), threadId: response.body.threadId });
    expect(reply.body.threadId).toBe(response.body.threadId);
  });

  it('queues the batched relevance check when batching is on', async () => {
    vi.stubEnv('AI_TRIAGE_BATCH_ENABLED', 'true');
    expect((await deliver(template('offer'))).status).toBe(201);
    expect(enqueueRelevanceTriage).toHaveBeenCalledWith(owner);
    expect(enqueueEmailProcessingJob).not.toHaveBeenCalled();
  });

  it('is read from the database by the Gmail fetcher, never from Gmail', async () => {
    const { body } = await deliver(template('rejection'));
    const { gmailMessageId } = await prisma.email.findUniqueOrThrow({
      where: { id: body.emailId },
    });
    const metadata = await fetchMessageMetadata(owner, gmailMessageId);
    expect(metadata.labelIds).toEqual(['INBOX', 'CATEGORY_UPDATES']);
    expect(metadata.snippet).toContain('Unfortunately');
    expect(await fetchMessageBody(owner, gmailMessageId)).toBe(template('rejection').body);
    await expect(fetchMessageBody(other, gmailMessageId)).rejects.toThrow('Test email unavailable');
    expect(withGmail).not.toHaveBeenCalled();
  });

  it('never reaches Gmail when test tools are turned off later', async () => {
    const { body } = await deliver(template('rejection'));
    const { gmailMessageId } = await prisma.email.findUniqueOrThrow({
      where: { id: body.emailId },
    });
    vi.stubEnv('TEST_TOOLS_ENABLED', '');
    await expect(fetchMessageMetadata(owner, gmailMessageId)).rejects.toThrow('test tools are off');
    await expect(fetchMessageBody(owner, gmailMessageId)).rejects.toThrow('test tools are off');
    await configureAI(owner);
    await expect(processEmail(owner, body.emailId)).rejects.toThrow('test tools are off');
    expect(withGmail).not.toHaveBeenCalled();
    expect(createProviderClient).not.toHaveBeenCalled();
  });
});

describe('reset', () => {
  it('needs confirmation', async () => {
    expect((await reset({})).status).toBe(400);
  });

  it('refuses when the user has real Gmail mail and deletes nothing', async () => {
    await prisma.email.create({ data: { userId: owner, gmailMessageId: '18c2f0a1b2c3d4e5' } });
    await deliver(template('offer'));
    const response = await reset();
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('REAL_MAIL_PRESENT');
    expect(await prisma.email.count({ where: { userId: owner } })).toBe(2);
  });

  it("deletes the user's test data, clears an AI pause and keeps the account and AI settings", async () => {
    await configureAI(owner, {
      cooldownUntil: new Date(Date.now() + 60_000),
      accessIssue: 'RATE_LIMITED',
    });
    await prisma.aIUsageDay.create({ data: { userId: owner, day: utcDay(new Date()), calls: 7 } });
    await prisma.application.create({ data: { userId: owner, companyName: values.company } });
    await deliver(template('offer'));
    await deliver(template('offer'), OTHER);

    const response = await reset();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deletedEmails: 1, deletedApplications: 1 });
    expect(await prisma.email.count({ where: { userId: owner } })).toBe(0);
    expect(await prisma.simulatedEmailContent.count({ where: { userId: owner } })).toBe(0);
    expect(await prisma.aIUsageDay.count({ where: { userId: owner } })).toBe(0);
    expect(await prisma.user.count({ where: { id: owner } })).toBe(1);
    const settings = await prisma.aIConfiguration.findUniqueOrThrow({ where: { userId: owner } });
    expect(settings).toMatchObject({ provider: 'gemini', cooldownUntil: null, accessIssue: null });
    expect(settings.encryptedApiKey).toBeTruthy();
    expect(await prisma.email.count({ where: { userId: other } })).toBe(1);
  });
});

// The provider is mocked the way the other pipeline tests do it: it answers from the text it is
// sent, so a wrong or missing test email body would give a wrong result.
const emptyExtraction = Object.fromEntries(
  Object.keys(JobExtractionSchema.shape).map((key) => [key, null]),
);
const kindOf = (text: string) => {
  if (text.includes('Unfortunately')) return 'REJECTION';
  return /interview/i.test(text) ? 'INTERVIEW' : 'RECRUITER';
};
const answeringProvider = () =>
  fakeProviderClient({
    classification: (input: string) => ({
      decision: 'RELEVANT',
      category: kindOf(input),
      confidence: 0.95,
      reasoning: 'fixture',
    }),
    extraction: (input: string) => {
      const kind = kindOf(input);
      return JobExtractionSchema.parse({
        ...emptyExtraction,
        companyName: input.includes(values.company) ? values.company : null,
        jobTitle: input.includes(values.role) ? values.role : null,
        interviewStage: kind === 'INTERVIEW' ? 'First round' : null,
        rejectionInfo: kind === 'REJECTION' ? 'Not moving forward' : null,
        actionRequired: kind === 'INTERVIEW',
        requestedAction: kind === 'INTERVIEW' ? 'Confirm the interview time' : null,
        actionDeadline: kind === 'INTERVIEW' ? '2026-10-30' : null,
      });
    },
  });

describe('a test email goes through the real pipeline', () => {
  it('moves an application through interview to rejection, with an action', async () => {
    await configureAI(owner);
    const provider = answeringProvider();
    vi.mocked(createProviderClient).mockReturnValue(provider);
    const created = await request(app)
      .post('/api/applications')
      .set(as(OWNER))
      .send({ companyName: values.company, jobTitle: values.role });
    expect(created.status).toBe(201);
    const applicationId: string = created.body.id;

    const first = await deliver(template('application-received'));
    await processEmail(owner, first.body.emailId);
    expect(
      await prisma.email.findUniqueOrThrow({ where: { id: first.body.emailId } }),
    ).toMatchObject({
      processingState: 'COMPLETED',
      relevanceState: 'RELEVANT',
      matchState: 'MATCHED',
      applicationId,
    });

    const interview = await deliver({
      ...template('interview-invite'),
      threadId: first.body.threadId,
    });
    await processEmail(owner, interview.body.emailId);
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: applicationId } }),
    ).toMatchObject({ aiStatus: 'INTERVIEW' });
    expect(
      await prisma.action.findMany({ where: { applicationId, emailId: interview.body.emailId } }),
    ).toMatchObject([{ type: 'ACTION_REQUIRED', status: 'PENDING' }]);

    const rejection = await deliver({ ...template('rejection'), threadId: first.body.threadId });
    await processEmail(owner, rejection.body.emailId);
    expect(
      await prisma.application.findUniqueOrThrow({ where: { id: applicationId } }),
    ).toMatchObject({ aiStatus: 'REJECTED' });

    // The application's own API shows the result the user sees.
    const shown = await request(app).get(`/api/applications/${applicationId}`).set(as(OWNER));
    expect(shown.body).toMatchObject({ effectiveStatus: 'REJECTED', statusSource: 'AI' });

    expect(provider.calls('email_relevance')).toHaveLength(3);
    expect(provider.calls('job_extraction')).toHaveLength(3);
    expect(withGmail).not.toHaveBeenCalled();
  });

  it('ends a Promotions email as not job-related without an AI call', async () => {
    await configureAI(owner);
    const provider = answeringProvider();
    vi.mocked(createProviderClient).mockReturnValue(provider);
    const newsletter = await deliver(template('newsletter'));
    await processEmail(owner, newsletter.body.emailId);
    expect(
      await prisma.email.findUniqueOrThrow({ where: { id: newsletter.body.emailId } }),
    ).toMatchObject({
      processingState: 'COMPLETED',
      relevanceState: 'IRRELEVANT',
      applicationId: null,
    });
    expect(provider.generateStructured).not.toHaveBeenCalled();
    expect(withGmail).not.toHaveBeenCalled();
  });

  it('waits for AI when the user has not connected a provider', async () => {
    const waiting = await deliver(template('interview-invite'));
    await expect(processEmail(owner, waiting.body.emailId)).rejects.toMatchObject({
      name: 'AIAccessError',
    });
    expect(createProviderClient).not.toHaveBeenCalled();
    expect(withGmail).not.toHaveBeenCalled();
  });
});
