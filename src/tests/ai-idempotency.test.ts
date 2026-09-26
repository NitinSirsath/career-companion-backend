import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { runOperation } from '../services/ai/operations';
import { RetryableAIError } from '../services/ai/errors';
import { EmailAIPipeline } from '../services/ai/pipeline';
import { GmailFetcherService } from '../services/gmailFetcher';
import { GeminiProvider } from '../services/ai/gemini/GeminiProvider';
import { MatcherService } from '../services/matcher';
import { JobExtractionSchema } from '../services/ai/contracts';
vi.mock('../services/gmailFetcher');
vi.mock('../jobs/notificationJob', () => ({ enqueueNotificationJob: vi.fn() }));

let userId: string;
let emailId: string;
const schema = z.object({ decision: z.string() });
beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: 'idempotency@audit.test' } })).id;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  process.env.AI_DAILY_CALL_LIMIT = '100';
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.aICallBudget.deleteMany();
  emailId = (await prisma.email.create({ data: { userId, gmailMessageId: 'logical-message' } })).id;
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});

const run = (call: () => Promise<{ decision: string }>) =>
  runOperation(userId, emailId, 'classification', 'v1', schema, call);
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
  it('bounds explicit provider rejection retries durably', async () => {
    const call = vi.fn().mockRejectedValue(new RetryableAIError('rate limited'));
    for (let i = 0; i < 3; i++) {
      await prisma.aIOperation.updateMany({ where: { emailId }, data: { retryAfter: null } });
      await prisma.aICallBudget.updateMany({ data: { cooldownUntil: null } });
      await expect(run(call)).rejects.toThrow();
    }
    await expect(run(call)).rejects.toThrow('requires review');
    expect(call).toHaveBeenCalledTimes(3);
  });
  it('enforces the application budget and rolls back claims when exhausted', async () => {
    process.env.AI_DAILY_CALL_LIMIT = '0';
    const call = vi.fn();
    await expect(run(call)).rejects.toThrow('budget');
    expect(call).not.toHaveBeenCalled();
    expect((await prisma.aIOperation.findFirstOrThrow({ where: { emailId } })).status).toBe(
      'PENDING',
    );
  });
  it('rejects a job with another user before calling the provider', async () => {
    const call = vi.fn();
    await expect(
      runOperation(
        '00000000-0000-0000-0000-000000000000',
        emailId,
        'classification',
        'v1',
        schema,
        call,
      ),
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
    const provider = vi.spyOn(GeminiProvider, 'getInstance');
    await EmailAIPipeline.processEmail(userId, emailId);
    expect(provider).not.toHaveBeenCalled();
    expect((await prisma.email.findUniqueOrThrow({ where: { id: emailId } })).processingState).toBe(
      'COMPLETED',
    );
  });
  it('filters promotions before creating any paid operation or fetching the body', async () => {
    vi.mocked(GmailFetcherService.fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
      snippet: null,
    });
    const provider = vi.spyOn(GeminiProvider, 'getInstance');
    vi.mocked(GmailFetcherService.fetchMessageBody).mockClear();
    await EmailAIPipeline.processEmail(userId, emailId);
    await EmailAIPipeline.processEmail(userId, emailId);
    expect(provider).not.toHaveBeenCalled();
    expect(GmailFetcherService.fetchMessageBody).not.toHaveBeenCalled();
    expect(await prisma.aIOperation.count({ where: { emailId } })).toBe(0);
    expect((await prisma.email.findUniqueOrThrow({ where: { id: emailId } })).relevanceState).toBe(
      'IRRELEVANT',
    );
  });

  it('keeps low-confidence classifications eligible for extraction without repeating either call', async () => {
    const extraction = JobExtractionSchema.parse(
      Object.fromEntries(Object.keys(JobExtractionSchema.shape).map((key) => [key, null])),
    );
    const classifyRelevance = vi
      .fn()
      .mockResolvedValue({
        data: { decision: 'IRRELEVANT', confidence: 0.2, reasoning: 'uncertain' },
      });
    const extractJobData = vi.fn().mockResolvedValue({ data: extraction });
    vi.spyOn(GeminiProvider, 'getInstance').mockReturnValue({
      classifyRelevance,
      extractJobData,
      getProviderName: () => 'gemini',
      getRelevanceModel: () => 'test',
      getExtractionModel: () => 'test',
    } as unknown as GeminiProvider);
    vi.mocked(GmailFetcherService.fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: null });
    vi.mocked(GmailFetcherService.fetchMessageBody).mockResolvedValue('x'.repeat(9000));
    vi.spyOn(MatcherService, 'matchEmailToApplication').mockResolvedValue(undefined);
    await EmailAIPipeline.processEmail(userId, emailId);
    await EmailAIPipeline.processEmail(userId, emailId);
    expect(classifyRelevance).toHaveBeenCalledTimes(1);
    expect(extractJobData).toHaveBeenCalledTimes(1);
    expect(extractJobData.mock.calls[0][0]).toHaveLength(8000);
    expect(
      (await prisma.aIProcessingResult.findUniqueOrThrow({ where: { emailId } })).relevanceDecision,
    ).toBe('UNCERTAIN');
  });
  it('keeps classification/extraction checkpoints across a matching failure', async () => {
    const extraction = JobExtractionSchema.parse(
      Object.fromEntries(Object.keys(JobExtractionSchema.shape).map((key) => [key, null])),
    );
    const classifyRelevance = vi
      .fn()
      .mockResolvedValue({
        version: 'v1',
        data: { decision: 'RELEVANT', confidence: 0.9, reasoning: 'job' },
      });
    const extractJobData = vi.fn().mockResolvedValue({ version: 'v1', data: extraction });
    vi.spyOn(GeminiProvider, 'getInstance').mockReturnValue({
      classifyRelevance,
      extractJobData,
      getProviderName: () => 'gemini',
      getRelevanceModel: () => 'test',
      getExtractionModel: () => 'test',
    } as unknown as GeminiProvider);
    vi.mocked(GmailFetcherService.fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX'],
      snippet: '',
    });
    vi.mocked(GmailFetcherService.fetchMessageBody).mockResolvedValue('bounded body');
    vi.spyOn(MatcherService, 'matchEmailToApplication')
      .mockRejectedValueOnce(new Error('domain failure'))
      .mockResolvedValue(undefined);
    await expect(EmailAIPipeline.processEmail(userId, emailId)).rejects.toThrow('domain failure');
    await EmailAIPipeline.processEmail(userId, emailId);
    expect(classifyRelevance).toHaveBeenCalledTimes(1);
    expect(extractJobData).toHaveBeenCalledTimes(1);
  });
});
