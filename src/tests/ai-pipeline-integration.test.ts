import type { JobWithMetadata } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db/prisma';
import { processEmailJob } from '../jobs/emailProcessingJob';
import { EmailProcessingJobData } from '../services/enqueue';
import { JobExtractionV4Schema } from '../services/ai/contracts';
import { ProviderFailure } from '../services/ai/errors';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { createProviderClient } from '../services/ai/providers';
import { configureAI } from './helpers/aiAccess';
import { fakeProviderClient } from './helpers/fakeProviderClient';

vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));

const extraction = JobExtractionV4Schema.parse({
  ...Object.fromEntries(Object.keys(JobExtractionV4Schema.shape).map((key) => [key, null])),
  companyName: 'Northwind Robotics',
  jobTitle: 'Platform Engineer',
  interviewStage: 'First round',
  actionRequired: true,
  requestedAction: 'Confirm the interview time',
});
const relevant = {
  decision: 'RELEVANT',
  category: 'INTERVIEW',
  confidence: 0.95,
  reasoning: 'interview',
};

let ready: string;
let notSetUp: string;
let limited: string;
const job = (userId: string, emailId: string) =>
  ({
    id: `job-${emailId}`,
    data: { userId, emailId },
    retryCount: 0,
    retryLimit: 3,
  }) as JobWithMetadata<EmailProcessingJobData>;
const newEmail = async (userId: string) =>
  (
    await prisma.email.create({
      data: { userId, gmailMessageId: `pipeline-${Math.random()}`, subject: 'Interview' },
    })
  ).id;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@pipeline.test' } } });
  ready = (await prisma.user.create({ data: { email: 'ready@pipeline.test' } })).id;
  notSetUp = (await prisma.user.create({ data: { email: 'none@pipeline.test' } })).id;
  limited = (await prisma.user.create({ data: { email: 'limited@pipeline.test' } })).id;
  await configureAI(ready);
  await configureAI(limited);
  for (const userId of [ready, notSetUp, limited])
    await prisma.application.create({
      data: { userId, companyName: 'Northwind Robotics', jobTitle: 'Platform Engineer' },
    });
});
beforeEach(async () => {
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  vi.mocked(fetchMessageMetadata).mockResolvedValue({
    labelIds: ['INBOX'],
    snippet: 'Interview invitation',
  });
  vi.mocked(fetchMessageBody).mockResolvedValue('Synthetic interview invitation body');
  // Each user's provider client answers for that user only.
  vi.mocked(createProviderClient).mockReset();
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: '@pipeline.test' } } });
});

describe('Gmail → user-provided AI → application pipeline', () => {
  it('passes the worker signal to both Gmail fetches without changing provider requests', async () => {
    const provider = fakeProviderClient({ classification: relevant, extraction });
    vi.mocked(createProviderClient).mockReturnValue(provider);
    const emailId = await newEmail(ready);
    const email = await prisma.email.findUniqueOrThrow({ where: { id: emailId } });
    const controller = new AbortController();
    await processEmailJob({ ...job(ready, emailId), signal: controller.signal });
    expect(fetchMessageMetadata).toHaveBeenCalledWith(ready, email.gmailMessageId, {
      signal: controller.signal,
    });
    expect(fetchMessageBody).toHaveBeenCalledWith(ready, email.gmailMessageId, {
      signal: controller.signal,
    });
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
    for (const [sent] of provider.generateStructured.mock.calls)
      expect(sent).not.toHaveProperty('signal');
  });

  it("processes a configured user's email end to end with provenance, while other users wait", async () => {
    const working = fakeProviderClient({ classification: relevant, extraction });
    const refusing = {
      generateStructured: vi.fn().mockRejectedValue(new ProviderFailure('RATE_LIMITED')),
      verifyModels: vi.fn(),
    };
    vi.mocked(createProviderClient).mockImplementation(() => working);
    const readyEmail = await newEmail(ready);
    const waitingEmail = await newEmail(notSetUp);
    const limitedEmail = await newEmail(limited);

    vi.mocked(createProviderClient).mockImplementationOnce(() => refusing);
    await processEmailJob(job(limited, limitedEmail));
    await processEmailJob(job(notSetUp, waitingEmail));
    await processEmailJob(job(ready, readyEmail));

    // Ready user: classified, extracted, matched, with provider and model provenance.
    const done = await prisma.email.findUniqueOrThrow({
      where: { id: readyEmail },
      include: { aiProcessingResult: true },
    });
    expect(done).toMatchObject({
      processingState: 'COMPLETED',
      relevanceState: 'RELEVANT',
      matchState: 'MATCHED',
    });
    expect(done.aiProcessingResult).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      companyName: 'Northwind Robotics',
    });
    expect(
      await prisma.aIOperation.findMany({
        where: { emailId: readyEmail },
        orderBy: { operation: 'asc' },
      }),
    ).toMatchObject([
      {
        operation: 'classification',
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
        status: 'COMPLETED',
      },
      {
        operation: 'extraction',
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        status: 'COMPLETED',
      },
    ]);
    expect(working.calls('email_relevance')).toHaveLength(1);
    expect(working.calls('job_extraction_v4')).toHaveLength(1);

    // Not set up: waits as PENDING; nothing was claimed or sent.
    expect(await prisma.email.findUniqueOrThrow({ where: { id: waitingEmail } })).toMatchObject({
      processingState: 'PENDING',
      processingErrorCategory: null,
    });
    expect(await prisma.aIOperation.findMany({ where: { emailId: waitingEmail } })).toMatchObject([
      { status: 'PENDING', attempts: 0 },
    ]);

    // Rate-limited: waits as PENDING with the attempt restored; the pause is that user's only.
    expect(await prisma.email.findUniqueOrThrow({ where: { id: limitedEmail } })).toMatchObject({
      processingState: 'PENDING',
    });
    expect(await prisma.aIOperation.findMany({ where: { emailId: limitedEmail } })).toMatchObject([
      { status: 'PENDING', attempts: 0 },
    ]);
    expect(await prisma.aIModelPause.findMany({ where: { userId: limited } })).toMatchObject([
      { model: 'gemini-3.5-flash-lite', reason: 'RATE_LIMITED' },
    ]);
    expect(await prisma.aIModelPause.count({ where: { userId: ready } })).toBe(0);
  });

  it('resumes a waiting email after access is fixed, reusing completed work', async () => {
    const emailId = await newEmail(ready);
    const firstClient = {
      generateStructured: vi.fn(async ({ contract }: { contract: { schemaName: string } }) => {
        if (contract.schemaName === 'email_relevance')
          return { data: relevant, usage: { inputTokens: 1, outputTokens: 1 } };
        throw new ProviderFailure('ACCOUNT_OR_BILLING');
      }),
      verifyModels: vi.fn(),
    };
    vi.mocked(createProviderClient).mockReturnValue(firstClient);
    await processEmailJob(job(ready, emailId));
    expect(await prisma.email.findUniqueOrThrow({ where: { id: emailId } })).toMatchObject({
      processingState: 'PENDING',
    });
    expect(
      (await prisma.aIConfiguration.findUniqueOrThrow({ where: { userId: ready } })).accessIssue,
    ).toBe('ACCOUNT_OR_BILLING');

    // The user fixes billing (a new save clears the issue); only extraction is called.
    await configureAI(ready, { accessIssue: null, revision: 1 });
    const fixed = fakeProviderClient({ classification: relevant, extraction });
    vi.mocked(createProviderClient).mockReturnValue(fixed);
    await processEmailJob(job(ready, emailId));
    expect(await prisma.email.findUniqueOrThrow({ where: { id: emailId } })).toMatchObject({
      processingState: 'COMPLETED',
    });
    expect(fixed.calls('email_relevance')).toHaveLength(0);
    expect(fixed.calls('job_extraction_v4')).toHaveLength(1);
  });
});

it('runs extraction/v5 through the shared provider boundary and persists verified candidates once', async () => {
  vi.stubEnv('AGENDA_EXTRACTION_V3_ENABLED', 'true');
  try {
    const provider = {
      generateStructured: vi.fn(async ({ contract }: { contract: { schemaName: string } }) => ({
        data:
          contract.schemaName === 'email_relevance'
            ? relevant
            : {
                ...extraction,
                fakeOfferWarning: '   ',
                scheduleCandidates: [
                  {
                    kind: 'INTERVIEW',
                    change: 'SCHEDULED',
                    date: '2026-10-04',
                    time: '14:30',
                    sourceTimeZone: '+05:30',
                    rawWhen: '2026-10-04 14:30 +05:30',
                    evidence: 'Invented quote',
                  },
                ],
              },
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
      verifyModels: vi.fn(),
    };
    vi.mocked(createProviderClient).mockReturnValue(provider);
    const emailId = await newEmail(ready);
    await processEmailJob(job(ready, emailId));
    const result = await prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId } });
    expect(result.contractVersion).toBe('extraction/v5');
    expect(result.fakeOfferWarning).toBeNull();
    expect(result.scheduleCandidates).toMatchObject({
      version: 'agenda/v1',
      candidates: [
        {
          evidence: null,
          temporal: { precision: 'DATETIME', instant: '2026-10-04T09:00:00.000Z' },
        },
      ],
    });
    const sent = provider.generateStructured.mock.calls[1][0] as unknown as {
      contract: { version: string };
      input: string;
    };
    expect(sent.contract.version).toBe('extraction/v5');
    expect(JSON.parse(sent.input).receivedAt).toBeNull();
    expect(await prisma.agendaItem.count({ where: { emailId } })).toBe(1);
    vi.stubEnv('AGENDA_EXTRACTION_V3_ENABLED', 'false');
    await processEmailJob(job(ready, emailId));
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('the warning for a job offer that asks for money', () => {
  const offer = { ...relevant, category: 'OFFER' };
  const feeOffer = (fakeOfferWarning: string | null) => ({
    ...extraction,
    actionRequired: true,
    requestedAction: 'Pay the laptop security fee of Rs 8,500',
    actionDeadline: 'within 24 hours',
    fakeOfferWarning,
  });
  const run = async (fakeOfferWarning: string | null) => {
    const provider = fakeProviderClient({
      classification: offer,
      extraction: feeOffer(fakeOfferWarning),
    });
    vi.mocked(createProviderClient).mockReturnValue(provider);
    const emailId = await newEmail(ready);
    await processEmailJob(job(ready, emailId));
    return { emailId, provider };
  };

  it('a new mail is read with classification/v4 and extraction/v4, and the warning is stored trimmed', async () => {
    const { emailId, provider } = await run('  It asks for a fee of Rs 8,500.  ');
    expect(provider.generateStructured.mock.calls.map(([sent]) => sent.contract.version)).toEqual([
      'classification/v4',
      'extraction/v4',
    ]);
    expect(await prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId } })).toMatchObject(
      {
        contractVersion: 'extraction/v4',
        fakeOfferWarning: 'It asks for a fee of Rs 8,500.',
      },
    );
  });

  it('stores an empty warning as none', async () => {
    const { emailId } = await run('   ');
    expect(
      (await prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId } })).fakeOfferWarning,
    ).toBeNull();
  });

  it('a mail with a warning is never linked automatically and makes no action', async () => {
    const { emailId } = await run('It asks for a fee of Rs 8,500.');
    const email = await prisma.email.findUniqueOrThrow({ where: { id: emailId } });
    expect(email).toMatchObject({ relevanceState: 'RELEVANT', matchState: 'UNMATCHED' });
    expect(email.applicationId).toBeNull();
    expect(await prisma.action.count({ where: { emailId } })).toBe(0);
    expect(await prisma.applicationEvent.count({ where: { emailId } })).toBe(0);
  });

  it('an email that started on extraction/v2 finishes on it and stores no warning', async () => {
    const provider = fakeProviderClient({
      classification: offer,
      extraction: feeOffer('It asks for a fee.'),
    });
    vi.mocked(createProviderClient).mockReturnValue(provider);
    const emailId = await newEmail(ready);
    await prisma.aIOperation.create({
      data: { emailId, operation: 'extraction', version: 'extraction/v2' },
    });
    await processEmailJob(job(ready, emailId));
    const [, sent] = provider.generateStructured.mock.calls.map(([request]) => request);
    expect(sent.contract.version).toBe('extraction/v2');
    expect(sent.contract.instructions).not.toContain('fakeOfferWarning');
    expect(await prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId } })).toMatchObject(
      { contractVersion: 'extraction/v2', fakeOfferWarning: null },
    );
  });
});
