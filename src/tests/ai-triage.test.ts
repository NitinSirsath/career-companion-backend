import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db/prisma';
import { AIAccessError, AIOutcomeUnknownError, ProviderFailure, SchemaValidationFailure, TerminalAIError } from '../services/ai/errors';
import { buildRelevanceBatchInput, mapBatchResults, RelevanceBatchItemSchema } from '../services/ai/contracts';
import { triageBatchSize, relevanceThreshold, classifyBatch, runTriage } from '../services/ai/triage';
import { relevanceTriageJobOptions, RELEVANCE_TRIAGE_WORKER_OPTIONS } from '../jobs/relevanceTriageJob';
import { QUEUE_NAMES } from '../services/queue';
import { parseAI_TRIAGE_BATCH_ENABLED, parseAI_TRIAGE_BATCH_SIZE } from '../utils/config';
import { GmailFetcherService } from '../services/gmailFetcher';
import { getAccessState, resolveAIAccess } from '../services/ai/access';
import { EmailAIPipeline } from '../services/ai/pipeline';

const send = vi.fn();
const classify = vi.fn();
vi.mock('../jobs/emailProcessingJob', () => ({ enqueueEmailProcessingJob: vi.fn(async (...args: unknown[]) => send(...args)) }));
vi.mock('../services/queue', () => ({
  QUEUE_NAMES: ['email-processing-job', 'discord-notification-job', 'gmail-sync-job', 'relevance-triage-job'],
  getQueue: vi.fn(),
}));
vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/access', () => ({ getAccessState: vi.fn(), resolveAIAccess: vi.fn() }));

const providerFixture = {
  provider: 'fixture',
  userId: '',
  revision: 0,
  models: { fast: { id: 'fixture-fast' }, detailed: { id: 'fixture-detailed' } },
  classifier: { classifyRelevanceBatch: classify },
  analyzer: {},
};
const provider = providerFixture as never;

let userId = '';
async function reset() {
  await prisma.email.deleteMany({ where: { userId } });
  await prisma.aIOperation.deleteMany({ where: { email: { userId } } });
  await prisma.aIBatch.deleteMany({ where: { userId } });
  await prisma.aIUsageDay.deleteMany({ where: { userId } });
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `com125-${Date.now()}@fixture.test` } });
  userId = user.id;
  providerFixture.userId = userId;
  await prisma.aIConfiguration.create({
    data: {
      userId,
      provider: 'fixture',
      encryptedApiKey: 'v1:fixture',
      consentDisclosure: 'fixture',
      consentedAt: new Date(),
    },
  });
});
beforeEach(async () => {
  await reset();
  send.mockReset();
  classify.mockReset();
  process.env.AI_TRIAGE_BATCH_ENABLED = 'true';
  process.env.AI_TRIAGE_BATCH_SIZE = '20';
  process.env.RELEVANCE_CONFIDENCE_THRESHOLD = '0.7';
  await prisma.aIConfiguration.update({ where: { userId }, data: { cooldownUntil: null, accessIssue: null, accessIssueModel: null, consecutiveFailures: 0 } });
  vi.mocked(GmailFetcherService.fetchMessageMetadata).mockResolvedValue({ labelIds: ['INBOX'], snippet: 'fixture' });
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});

describe('COM-125 relevance batch pure behavior', () => {
  it('1 converts the contract envelope without accepting malformed items', () => {
    expect(RelevanceBatchItemSchema.safeParse({ key: 'e1', decision: 'RELEVANT', confidence: 0.8, category: null }).success).toBe(true);
    expect(RelevanceBatchItemSchema.safeParse({ key: 'e1', decision: 'BAD', confidence: 0.8, category: null }).success).toBe(false);
  });
  it('2 maps all decided results', () => {
    const r = mapBatchResults(['e1', 'e2'], [
      { key: 'e1', decision: 'RELEVANT', confidence: 1, category: 'RECRUITER' },
      { key: 'e2', decision: 'IRRELEVANT', confidence: 1, category: null },
    ]);
    expect(r.undecided).toEqual([]);
    expect(r.decided.size).toBe(2);
  });
  it('3 never marks a missing key irrelevant', () => {
    const r = mapBatchResults(['e1', 'e2'], [{ key: 'e1', decision: 'RELEVANT', confidence: 1, category: null }]);
    expect(r.undecided).toEqual(['e2']);
    expect(r.decided.has('e2')).toBe(false);
  });
  it('4 treats duplicate keys as undecided', () => {
    const r = mapBatchResults(['e1'], [
      { key: 'e1', decision: 'RELEVANT', confidence: 1, category: null },
      { key: 'e1', decision: 'IRRELEVANT', confidence: 1, category: null },
    ]);
    expect(r.undecided).toEqual(['e1']);
  });
  it('5 ignores unknown keys', () => {
    expect(mapBatchResults(['e1'], [{ key: 'other', decision: 'IRRELEVANT', confidence: 1, category: null }]).ignored).toBeGreaterThan(0);
  });
  it('6 ignores invalid items', () => {
    expect(mapBatchResults(['e1'], [{ key: 'e1', decision: 'BAD' }]).undecided).toEqual(['e1']);
  });
  it('7 handles empty results', () => {
    expect(mapBatchResults(['e1'], []).undecided).toEqual(['e1']);
  });
  it('8 maps shuffled results by key', () => {
    const r = mapBatchResults(['e1', 'e2'], [
      { key: 'e2', decision: 'IRRELEVANT', confidence: 1, category: null },
      { key: 'e1', decision: 'RELEVANT', confidence: 1, category: 'INTERVIEW' },
    ]);
    expect(r.decided.get('e1')?.category).toBe('INTERVIEW');
  });
  it('9 bounds batch input fields and assigns e1..eN', () => {
    const result = buildRelevanceBatchInput([
      { sender: 's'.repeat(600), subject: 'x'.repeat(1200), labels: Array.from({ length: 40 }, (_, i) => String(i)), snippet: 'p'.repeat(1200) },
      { sender: null, subject: null, labels: [], snippet: null },
    ]);
    expect(result.items.map((i) => i.key)).toEqual(['e1', 'e2']);
    expect(result.items[0].sender).toHaveLength(512);
    expect(result.items[0].subject).toHaveLength(1000);
    expect(result.items[0].labels).toHaveLength(30);
    expect(result.items[0].snippet).toHaveLength(1000);
  });
  it('10 serializes only bounded provider fields', () => {
    const input = buildRelevanceBatchInput([{ sender: 's', subject: 'x', labels: [], snippet: 'p' }]);
    const text = JSON.stringify(input);
    expect(text).not.toContain('gmailMessageId');
    expect(text).not.toContain('emailId');
    expect(text).not.toContain('threadId');
  });
  it('11 validates batch size bounds', () => {
    expect(triageBatchSize('1')).toBe(1);
    expect(triageBatchSize('25')).toBe(25);
    expect(() => triageBatchSize('0')).toThrow();
    expect(() => triageBatchSize('26')).toThrow();
  });
  it('12 rejects invalid batch size syntax', () => {
    expect(() => triageBatchSize('twenty')).toThrow(TerminalAIError);
  });
  it('13 flag is off for unset, empty and false', () => {
    expect(parseAI_TRIAGE_BATCH_ENABLED(undefined)).toBe(false);
    expect(parseAI_TRIAGE_BATCH_ENABLED('')).toBe(false);
    expect(parseAI_TRIAGE_BATCH_ENABLED('false')).toBe(false);
  });
  it('14 flag is on only for exact true', () => {
    expect(parseAI_TRIAGE_BATCH_ENABLED('true')).toBe(true);
    expect(() => parseAI_TRIAGE_BATCH_ENABLED('TRUE')).toThrow();
    expect(() => parseAI_TRIAGE_BATCH_ENABLED('1')).toThrow();
  });
  it('15 defaults the batch size to 20', () => {
    expect(parseAI_TRIAGE_BATCH_SIZE(undefined)).toBe(20);
    expect(parseAI_TRIAGE_BATCH_SIZE('')).toBe(20);
  });
  it('16 validates the relevance threshold', () => {
    expect(relevanceThreshold('0')).toBe(0);
    expect(relevanceThreshold('1')).toBe(1);
    expect(() => relevanceThreshold('1.1')).toThrow();
  });
  it('17 triage worker is explicitly batchSize one', () => {
    expect(RELEVANCE_TRIAGE_WORKER_OPTIONS.batchSize).toBe(1);
  });
  it('18 triage queue uses a per-user singleton and ten-second delay', () => {
    expect(relevanceTriageJobOptions('u')).toMatchObject({ singletonKey: 'triage:u', startAfter: 10, retryLimit: 3 });
  });
  it('19 appends the triage queue without moving existing queue positions', () => {
    expect(QUEUE_NAMES.slice(0, 3)).toEqual(['email-processing-job', 'discord-notification-job', 'gmail-sync-job']);
    expect(QUEUE_NAMES[3]).toBe('relevance-triage-job');
  });
  it('20 happy path uses one batch call for non-spam candidates', async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => prisma.email.create({ data: { userId, gmailMessageId: `happy-${i}` } })));
    vi.mocked(GmailFetcherService.fetchMessageMetadata).mockImplementation(async (_u, id) => ({
      labelIds: id.endsWith('0') || id.endsWith('1') ? ['INBOX', 'SPAM'] : ['INBOX'],
      snippet: 'fixture',
    }));
    classify.mockResolvedValue({ data: { results: [
      { key: 'e1', decision: 'RELEVANT', confidence: 0.9, category: 'RECRUITER' },
      { key: 'e2', decision: 'UNCERTAIN', confidence: 0.5, category: null },
      { key: 'e3', decision: 'IRRELEVANT', confidence: 0.9, category: null },
    ] }, usage: { inputTokens: 3, outputTokens: 3 }, version: 'relevance-batch/v1', model: 'fixture-fast' });
    vi.mocked(getAccessState).mockResolvedValue({ state: 'READY', reason: null, modelId: null, resumesAt: null });
    vi.mocked(resolveAIAccess).mockResolvedValue(provider);
    await runTriage(userId);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(await prisma.aIUsageDay.findUnique({ where: { userId_day: { userId, day: new Date().toISOString().slice(0, 10) } } })).toMatchObject({ calls: 1 });
    expect(await prisma.email.count({ where: { userId, processingState: 'COMPLETED', relevanceState: 'IRRELEVANT' } })).toBe(3);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('21 missing batch item remains pending on first miss', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'missing-1' } });
    const access = provider;
    classify.mockResolvedValue({ data: { results: [] }, usage: { inputTokens: 1, outputTokens: 1 }, version: 'relevance-batch/v1', model: 'fixture-fast' });
    const result = await classifyBatch(userId, [{ emailId: email.id, input: { sender: null, subject: 'x', labels: [], snippet: null } }], access);
    expect(result.undecided).toEqual(['e1']);
    expect(await prisma.aIOperation.findUnique({ where: { emailId_operation_version: { emailId: email.id, operation: 'classification', version: 'relevance-batch/v1' } } })).toMatchObject({ status: 'RETRYABLE', attempts: 1 });
  });
  it('22 a refusal restores the attempt and leaves the email pending', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'refused-1' } });
    classify.mockRejectedValue(new ProviderFailure('RATE_LIMITED'));
    await expect(classifyBatch(userId, [{ emailId: email.id, input: { sender: null, subject: 'x', labels: [], snippet: null } }], provider)).rejects.toBeInstanceOf(AIAccessError);
    expect(await prisma.aIOperation.findUnique({ where: { emailId_operation_version: { emailId: email.id, operation: 'classification', version: 'relevance-batch/v1' } } })).toMatchObject({ status: 'PENDING', attempts: 0 });
  });
  it('23 unknown outcome holds every item', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'unknown-1' } });
    classify.mockRejectedValue(new ProviderFailure('OUTCOME_UNKNOWN'));
    await expect(classifyBatch(userId, [{ emailId: email.id, input: { sender: null, subject: 'x', labels: [], snippet: null } }], provider)).rejects.toBeInstanceOf(AIOutcomeUnknownError);
    expect(await prisma.aIOperation.findUnique({ where: { emailId_operation_version: { emailId: email.id, operation: 'classification', version: 'relevance-batch/v1' } } })).toMatchObject({ status: 'UNKNOWN' });
  });
  it('24 invalid envelope is held', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'invalid-1' } });
    classify.mockRejectedValue(new ProviderFailure('INVALID_OUTPUT'));
    await expect(classifyBatch(userId, [{ emailId: email.id, input: { sender: null, subject: 'x', labels: [], snippet: null } }], provider)).rejects.toBeInstanceOf(SchemaValidationFailure);
    expect(await prisma.aIOperation.findUnique({ where: { emailId_operation_version: { emailId: email.id, operation: 'classification', version: 'relevance-batch/v1' } } })).toMatchObject({ status: 'FAILED' });
  });
  it('25 safety limit prevents a batch claim', async () => {
    process.env.AI_USER_DAILY_CALL_LIMIT = '0';
    try {
      const email = await prisma.email.create({ data: { userId, gmailMessageId: 'limit-1' } });
      await expect(classifyBatch(userId, [{ emailId: email.id, input: { sender: null, subject: 'x', labels: [], snippet: null } }], provider)).rejects.toBeInstanceOf(AIAccessError);
      expect(await prisma.aIOperation.count({ where: { emailId: email.id } })).toBe(0);
    } finally {
      process.env.AI_USER_DAILY_CALL_LIMIT = '100';
    }
  });
  it('16 pipeline routing follows the classification ledger over the feature flag', async () => {
    const perEmail = await prisma.email.create({ data: { userId, gmailMessageId: 'routing-v2' } });
    await prisma.aIOperation.create({
      data: {
        emailId: perEmail.id,
        operation: 'classification',
        version: 'classification/v2',
        status: 'COMPLETED',
        result: { decision: 'IRRELEVANT', confidence: 1, reasoning: 'fixture' },
        provider: 'fixture',
        model: 'fixture-fast',
        completedAt: new Date(),
      },
    });
    process.env.AI_TRIAGE_BATCH_ENABLED = 'true';
    await EmailAIPipeline.processEmail(userId, perEmail.id);
    expect(GmailFetcherService.fetchMessageMetadata).toHaveBeenCalledTimes(1);
    expect(await prisma.aIProcessingResult.findUnique({ where: { emailId: perEmail.id } })).toMatchObject({
      contractVersion: 'classification/v2',
      relevanceDecision: 'IRRELEVANT',
    });

    vi.clearAllMocks();
    const batched = await prisma.email.create({ data: { userId, gmailMessageId: 'routing-batch' } });
    await prisma.aIOperation.create({
      data: {
        emailId: batched.id,
        operation: 'classification',
        version: 'relevance-batch/v1',
        status: 'COMPLETED',
        result: { decision: 'IRRELEVANT', confidence: 1, category: null },
        provider: 'fixture',
        model: 'fixture-fast',
        completedAt: new Date(),
      },
    });
    process.env.AI_TRIAGE_BATCH_ENABLED = 'false';
    await EmailAIPipeline.processEmail(userId, batched.id);
    expect(GmailFetcherService.fetchMessageMetadata).toHaveBeenCalledTimes(1);
    expect(await prisma.aIProcessingResult.findUnique({ where: { emailId: batched.id } })).toMatchObject({
      contractVersion: 'relevance-batch/v1',
      relevanceDecision: 'IRRELEVANT',
    });
  });

  it('27 classifyBatch maps outcomes by email id when a candidate is not claimed', async () => {
    const [a, b, c] = await Promise.all([
      prisma.email.create({ data: { userId, gmailMessageId: 'map-a' } }),
      prisma.email.create({ data: { userId, gmailMessageId: 'map-b' } }),
      prisma.email.create({ data: { userId, gmailMessageId: 'map-c' } }),
    ]);
    await prisma.aIOperation.create({
      data: { emailId: b.id, operation: 'classification', version: 'relevance-batch/v1', status: 'PROCESSING', attempts: 1, startedAt: new Date() },
    });
    classify.mockResolvedValue({
      data: { results: [
        { key: 'e1', decision: 'RELEVANT', confidence: 0.9, category: 'RECRUITER' },
        { key: 'e2', decision: 'IRRELEVANT', confidence: 0.5, category: null },
      ] },
      usage: { inputTokens: 2, outputTokens: 2 }, version: 'relevance-batch/v1', model: 'fixture-fast',
    });
    const result = await classifyBatch(userId, [
      { emailId: a.id, input: { sender: null, subject: 'a', labels: [], snippet: null } },
      { emailId: b.id, input: { sender: null, subject: 'b', labels: [], snippet: null } },
      { emailId: c.id, input: { sender: null, subject: 'c', labels: [], snippet: null } },
    ], provider);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][0].items).toHaveLength(2);
    expect(result.byEmail.get(a.id)).toBe('RELEVANT');
    expect(result.byEmail.get(c.id)).toBe('UNCERTAIN');
    expect(result.byEmail.has(b.id)).toBe(false);
    expect(await prisma.aIProcessingResult.findUnique({ where: { emailId: c.id } })).toMatchObject({ relevanceDecision: 'UNCERTAIN' });
    expect(await prisma.aIOperation.findUnique({ where: { emailId_operation_version: { emailId: b.id, operation: 'classification', version: 'relevance-batch/v1' } } })).toMatchObject({ status: 'PROCESSING', attempts: 1 });
  });

  it('28 runTriage queues a low-confidence IRRELEVANT as UNCERTAIN', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'queue-uncertain' } });
    vi.mocked(getAccessState).mockResolvedValue({ state: 'READY', reason: null, modelId: null, resumesAt: null });
    vi.mocked(resolveAIAccess).mockResolvedValue(provider);
    classify.mockResolvedValue({
      data: { results: [{ key: 'e1', decision: 'IRRELEVANT', confidence: 0.5, category: null }] },
      usage: { inputTokens: 1, outputTokens: 1 }, version: 'relevance-batch/v1', model: 'fixture-fast',
    });
    await runTriage(userId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(userId, email.id);
  });

  it('26 redaction logs contain no provider input fields', () => {
    const log = JSON.stringify({ event: 'triage_run', userId, batchId: 'b', emails: 3, sender: undefined });
    expect(log).not.toContain('subject');
    expect(log).not.toContain('preview');
    expect(log).not.toContain('labels');
  });
});
