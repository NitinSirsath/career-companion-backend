import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { runOperation } from '../services/ai/operations';
import { AIAccessError, ProviderFailure } from '../services/ai/errors';
import { processEmail } from '../services/ai/pipeline';
import { fetchMessageBody, fetchMessageMetadata } from '../services/gmailFetcher';
import { createProviderClient } from '../services/ai/providers';
import * as matcher from '../services/matcher';
import { JobExtractionSchema } from '../services/ai/contracts';
import { fakeProviderClient } from './helpers/fakeProviderClient';
import { configureAI, fakeAccess } from './helpers/aiAccess';
vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/providers', () => ({ createProviderClient: vi.fn() }));
vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueNotificationJob: vi.fn(),
}));

let userId: string;
let emailId: string;
const schema = z.object({ decision: z.string() });
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: 'idempotency@audit.test' } })).id;
  await configureAI(userId);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(createProviderClient).mockReset();
  process.env.AI_USER_DAILY_CALL_LIMIT = '100';
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
  await configureAI(userId, { cooldownUntil: null, accessIssue: null, consecutiveFailures: 0 });
  emailId = (await prisma.email.create({ data: { userId, gmailMessageId: 'logical-message' } })).id;
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});

const contract = { version: 'v1', schema, role: 'fast' as const };
const run = (call: () => Promise<{ decision: string }>) =>
  runOperation({
    userId,
    emailId,
    operation: 'classification',
    contract,
    access: async () => fakeAccess(userId),
    call: async () => ({
      version: 'v1',
      data: await call(),
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  });
describe('Durable AI external-effect boundary', () => {
  it('reuses a result on repeated execution', async () => {
    const call = vi.fn().mockResolvedValue({ decision: 'yes' });
    await run(call);
    await run(call);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('allows only one concurrent provider call', async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call = vi.fn(async () => {
      started();
      await pending;
      return { decision: 'yes' };
    });
    const first = run(call);
    await ready;
    await expect(run(call)).rejects.toThrow();
    release();
    await first;
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('does not repeat a successful call when checkpoint persistence fails', async () => {
    const call = vi.fn().mockResolvedValue({ decision: 'yes' });
    vi.spyOn(prisma.aIOperation, 'update').mockRejectedValueOnce(new Error('database unavailable'));
    await expect(run(call)).rejects.toThrow('database unavailable');
    await expect(run(call)).rejects.toThrow('requires review');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('does not repeat an ambiguous network outcome', async () => {
    const call = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(run(call)).rejects.toThrow();
    await expect(run(call)).rejects.toThrow('requires review');
    expect(call).toHaveBeenCalledTimes(1);
    expect((await prisma.aIOperation.findFirstOrThrow({ where: { emailId } })).status).toBe(
      'UNKNOWN',
    );
  });
  it('never charges an attempt for an explicit provider refusal (ADR-0001 decision 9)', async () => {
    const call = vi.fn().mockRejectedValue(new ProviderFailure('RATE_LIMITED'));
    for (let i = 0; i < 4; i++) {
      await prisma.aIConfiguration.update({ where: { userId }, data: { cooldownUntil: null } });
      await expect(run(call)).rejects.toBeInstanceOf(AIAccessError);
      expect(await prisma.aIOperation.findFirstOrThrow({ where: { emailId } })).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        errorCode: 'RATE_LIMITED',
      });
    }
    // Four refusals, no attempt used: the per-user cooldown and safety limit bound the loop instead.
    expect(call).toHaveBeenCalledTimes(4);
  });
  it('enforces the application safety limit and rolls back claims when paused', async () => {
    process.env.AI_USER_DAILY_CALL_LIMIT = '0';
    const call = vi.fn();
    await expect(run(call)).rejects.toMatchObject({ name: 'AIAccessError', reason: 'PAUSED' });
    expect(call).not.toHaveBeenCalled();
    expect((await prisma.aIOperation.findFirstOrThrow({ where: { emailId } })).status).toBe(
      'PENDING',
    );
  });
  it('rejects a job with another user before calling the provider', async () => {
    const call = vi.fn();
    await expect(
      runOperation({
        userId: '00000000-0000-0000-0000-000000000000',
        emailId,
        operation: 'classification',
        contract,
        access: async () => fakeAccess(userId),
        call,
      }),
    ).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
  it('adopts legacy completed results and resumes domain processing without Gemini', async () => {
    await prisma.aIProcessingResult.create({
      data: {
        emailId,
        provider: 'gemini',
        model: 'old',
        contractVersion: 'old',
        processingStatus: 'COMPLETED',
        relevanceDecision: 'IRRELEVANT',
      },
    });
    await processEmail(userId, emailId);
    expect(createProviderClient).not.toHaveBeenCalled();
    expect((await prisma.email.findUniqueOrThrow({ where: { id: emailId } })).processingState).toBe(
      'COMPLETED',
    );
  });
  it('filters promotions before creating any paid operation or fetching the body', async () => {
    vi.mocked(fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
      snippet: null,
    });
    vi.mocked(fetchMessageBody).mockClear();
    await processEmail(userId, emailId);
    await processEmail(userId, emailId);
    expect(createProviderClient).not.toHaveBeenCalled();
    expect(fetchMessageBody).not.toHaveBeenCalled();
    expect(await prisma.aIOperation.count({ where: { emailId } })).toBe(0);
    expect((await prisma.email.findUniqueOrThrow({ where: { id: emailId } })).relevanceState).toBe(
      'IRRELEVANT',
    );
  });

  it('keeps low-confidence classifications eligible for extraction without repeating either call', async () => {
    const extraction = JobExtractionSchema.parse(
      Object.fromEntries(Object.keys(JobExtractionSchema.shape).map((key) => [key, null])),
    );
    const client = fakeProviderClient({
      classification: { decision: 'IRRELEVANT', confidence: 0.2, reasoning: 'uncertain' },
      extraction,
    });
    vi.mocked(createProviderClient).mockReturnValue(client);
    vi.mocked(fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX'],
      snippet: null,
    });
    vi.mocked(fetchMessageBody).mockResolvedValue('x'.repeat(9000));
    vi.spyOn(matcher, 'matchEmailToApplication').mockResolvedValue(undefined);
    await processEmail(userId, emailId);
    await processEmail(userId, emailId);
    expect(client.calls('email_relevance')).toHaveLength(1);
    expect(client.calls('job_extraction')).toHaveLength(1);
    expect(client.calls('job_extraction')[0][0].input).toHaveLength(8000);
    expect(
      (await prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId } })).relevanceDecision,
    ).toBe('UNCERTAIN');
  });
  it('keeps classification/extraction checkpoints across a matching failure', async () => {
    const extraction = JobExtractionSchema.parse(
      Object.fromEntries(Object.keys(JobExtractionSchema.shape).map((key) => [key, null])),
    );
    const client = fakeProviderClient({
      classification: { decision: 'RELEVANT', confidence: 0.9, reasoning: 'job' },
      extraction,
    });
    vi.mocked(createProviderClient).mockReturnValue(client);
    vi.mocked(fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX'],
      snippet: '',
    });
    vi.mocked(fetchMessageBody).mockResolvedValue('bounded body');
    vi.spyOn(matcher, 'matchEmailToApplication')
      .mockRejectedValueOnce(new Error('domain failure'))
      .mockResolvedValue(undefined);
    await expect(processEmail(userId, emailId)).rejects.toThrow('domain failure');
    await processEmail(userId, emailId);
    expect(client.calls('email_relevance')).toHaveLength(1);
    expect(client.calls('job_extraction')).toHaveLength(1);
  });
});
