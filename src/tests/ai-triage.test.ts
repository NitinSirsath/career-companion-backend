import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db/prisma';
import {
  AIAccessError,
  AIOutcomeUnknownError,
  ProviderFailure,
  RetryableAIError,
  SchemaValidationFailure,
  TerminalAIError,
} from '../services/ai/errors';
import {
  AI_CONTRACT_VERSIONS,
  LEGACY_CONTRACT_VERSIONS,
  buildRelevanceBatchInput,
  mapBatchResults,
  RelevanceBatchItemSchema,
  RelevanceBatchSchema,
} from '../services/ai/contracts';
import {
  triageBatchSize,
  relevanceThreshold,
  classifyBatch,
  classifyOne,
  runTriage,
  isLinkedInSender,
  autoIrrelevant,
} from '../services/ai/triage';
import {
  relevanceTriageJobOptions,
  RELEVANCE_TRIAGE_WORKER_OPTIONS,
} from '../jobs/relevanceTriageJob';
import { getQueue } from '../services/queue';
import { parseAI_TRIAGE_BATCH_ENABLED, parseAI_TRIAGE_BATCH_SIZE } from '../utils/config';
import { fetchMessageMetadata } from '../services/gmailFetcher';
import { getAccessState, resolveAIAccess } from '../services/ai/access';
import { processEmail } from '../services/ai/pipeline';
import { holdOf } from '../services/ai/heldOperations';
import { bindCapabilities } from '../services/ai/capabilities';
import { strictJsonSchema } from '../services/ai/providers/jsonSchema';
import { reofferPendingEmails } from '../services/gmailSync';

const send = vi.fn();
const classify = vi.fn();
const classifySingle = vi.fn();
vi.mock('../jobs/emailProcessingJob', () => ({
  enqueueEmailProcessingJob: vi.fn(async (...args: unknown[]) => send(...args)),
}));
vi.mock('../services/queue', () => ({
  QUEUE_NAMES: [
    'email-processing-job',
    'discord-notification-job',
    'gmail-sync-job',
    'relevance-triage-job',
  ],
  getQueue: vi.fn(),
}));
vi.mock('../services/gmailFetcher');
vi.mock('../services/ai/access', () => ({ getAccessState: vi.fn(), resolveAIAccess: vi.fn() }));

const providerFixture = {
  provider: 'fixture',
  userId: '',
  revision: 0,
  models: { fast: { id: 'fixture-fast' }, detailed: { id: 'fixture-detailed' } },
  classifier: { classifyRelevanceBatch: classify, classifyRelevance: classifySingle },
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
  classifySingle.mockReset();
  process.env.AI_TRIAGE_BATCH_ENABLED = 'true';
  process.env.AI_TRIAGE_BATCH_SIZE = '20';
  process.env.RELEVANCE_CONFIDENCE_THRESHOLD = '0.7';
  await prisma.aIConfiguration.update({
    where: { userId },
    data: {
      cooldownUntil: null,
      accessIssue: null,
      accessIssueModel: null,
      consecutiveFailures: 0,
    },
  });
  vi.mocked(fetchMessageMetadata).mockResolvedValue({
    labelIds: ['INBOX'],
    snippet: 'fixture',
  });
});
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
});

describe('COM-125 relevance batch pure behavior', () => {
  it('1 converts the contract envelope without accepting malformed items', () => {
    expect(
      RelevanceBatchItemSchema.safeParse({
        key: 'e1',
        decision: 'RELEVANT',
        confidence: 0.8,
        category: null,
      }).success,
    ).toBe(true);
    expect(
      RelevanceBatchItemSchema.safeParse({
        key: 'e1',
        decision: 'BAD',
        confidence: 0.8,
        category: null,
      }).success,
    ).toBe(false);
  });
  it('2 maps all decided results', () => {
    const r = mapBatchResults(
      ['e1', 'e2'],
      [
        { key: 'e1', decision: 'RELEVANT', confidence: 1, category: 'RECRUITER' },
        { key: 'e2', decision: 'IRRELEVANT', confidence: 1, category: null },
      ],
    );
    expect(r.undecided).toEqual([]);
    expect(r.decided.size).toBe(2);
  });
  it('3 never marks a missing key irrelevant', () => {
    const r = mapBatchResults(
      ['e1', 'e2'],
      [{ key: 'e1', decision: 'RELEVANT', confidence: 1, category: null }],
    );
    expect(r.undecided).toEqual(['e2']);
    expect(r.decided.has('e2')).toBe(false);
  });
  it('4 treats duplicate keys as undecided', () => {
    const r = mapBatchResults(
      ['e1'],
      [
        { key: 'e1', decision: 'RELEVANT', confidence: 1, category: null },
        { key: 'e1', decision: 'IRRELEVANT', confidence: 1, category: null },
      ],
    );
    expect(r.undecided).toEqual(['e1']);
  });
  it('5 ignores unknown keys', () => {
    expect(
      mapBatchResults(
        ['e1'],
        [{ key: 'other', decision: 'IRRELEVANT', confidence: 1, category: null }],
      ).ignored,
    ).toBeGreaterThan(0);
  });
  it('6 ignores invalid items', () => {
    expect(mapBatchResults(['e1'], [{ key: 'e1', decision: 'BAD' }]).undecided).toEqual(['e1']);
  });
  it('7 handles empty results', () => {
    expect(mapBatchResults(['e1'], []).undecided).toEqual(['e1']);
  });
  it('8 maps shuffled results by key', () => {
    const r = mapBatchResults(
      ['e1', 'e2'],
      [
        { key: 'e2', decision: 'IRRELEVANT', confidence: 1, category: null },
        { key: 'e1', decision: 'RELEVANT', confidence: 1, category: 'INTERVIEW' },
      ],
    );
    expect(r.decided.get('e1')?.category).toBe('INTERVIEW');
  });
  it('9 bounds batch input fields and assigns e1..eN', () => {
    const result = buildRelevanceBatchInput([
      {
        sender: 's'.repeat(600),
        subject: 'x'.repeat(1200),
        labels: Array.from({ length: 40 }, (_, i) => String(i)),
        snippet: 'p'.repeat(1200),
      },
      { sender: null, subject: null, labels: [], snippet: null },
    ]);
    expect(result.items.map((i) => i.key)).toEqual(['e1', 'e2']);
    expect(result.items[0].sender).toHaveLength(512);
    expect(result.items[0].subject).toHaveLength(1000);
    expect(result.items[0].labels).toHaveLength(30);
    expect(result.items[0].snippet).toHaveLength(1000);
  });
  it('10 serializes only bounded provider fields', () => {
    const input = buildRelevanceBatchInput([
      { sender: 's', subject: 'x', labels: [], snippet: 'p' },
    ]);
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
  it('18 triage job options set the per-user singleton key and ten-second delay', () => {
    expect(relevanceTriageJobOptions('u')).toMatchObject({
      singletonKey: 'triage:u',
      startAfter: 10,
    });
  });
  it('19 triage job options set retry behavior and expiration', () => {
    expect(relevanceTriageJobOptions('u')).toMatchObject({
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 300,
    });
  });
  it('20 happy path uses one batch call for non-spam candidates', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        prisma.email.create({ data: { userId, gmailMessageId: `happy-${i}` } }),
      ),
    );
    vi.mocked(fetchMessageMetadata).mockImplementation(async (_u, id) => ({
      labelIds: id.endsWith('0') || id.endsWith('1') ? ['INBOX', 'SPAM'] : ['INBOX'],
      snippet: 'fixture',
    }));
    classify.mockResolvedValue({
      data: {
        results: [
          { key: 'e1', decision: 'RELEVANT', confidence: 0.9, category: 'RECRUITER' },
          { key: 'e2', decision: 'UNCERTAIN', confidence: 0.5, category: null },
          { key: 'e3', decision: 'IRRELEVANT', confidence: 0.9, category: null },
        ],
      },
      usage: { inputTokens: 3, outputTokens: 3 },
      version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
      model: 'fixture-fast',
    });
    vi.mocked(getAccessState).mockResolvedValue({
      state: 'READY',
      reason: null,
      modelId: null,
      resumesAt: null,
    });
    vi.mocked(resolveAIAccess).mockResolvedValue(provider);
    await runTriage(userId);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(
      await prisma.aIUsageDay.findUnique({
        where: { userId_day: { userId, day: new Date().toISOString().slice(0, 10) } },
      }),
    ).toMatchObject({ calls: 1 });
    expect(
      await prisma.email.count({
        where: { userId, processingState: 'COMPLETED', relevanceState: 'IRRELEVANT' },
      }),
    ).toBe(3);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('21 missing batch item remains pending on first miss', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'missing-1' } });
    const access = provider;
    classify.mockResolvedValue({
      data: { results: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
      version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
      model: 'fixture-fast',
    });
    const result = await classifyBatch(
      userId,
      [{ emailId: email.id, input: { sender: null, subject: 'x', labels: [], snippet: null } }],
      access,
    );
    expect(result.undecided).toEqual(['e1']);
    expect(
      await prisma.aIOperation.findUnique({
        where: {
          emailId_operation_version: {
            emailId: email.id,
            operation: 'classification',
            version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
          },
        },
      }),
    ).toMatchObject({ status: 'RETRYABLE', attempts: 1 });
  });
  it('22 a refusal restores the attempt and leaves the email pending', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'refused-1' } });
    classify.mockRejectedValue(new ProviderFailure('RATE_LIMITED'));
    await expect(
      classifyBatch(
        userId,
        [{ emailId: email.id, input: { sender: null, subject: 'x', labels: [], snippet: null } }],
        provider,
      ),
    ).rejects.toBeInstanceOf(AIAccessError);
    expect(
      await prisma.aIOperation.findUnique({
        where: {
          emailId_operation_version: {
            emailId: email.id,
            operation: 'classification',
            version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
          },
        },
      }),
    ).toMatchObject({ status: 'PENDING', attempts: 0 });
  });
  it('23 unknown outcome holds every item', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'unknown-1' } });
    classify.mockRejectedValue(new ProviderFailure('OUTCOME_UNKNOWN'));
    await expect(
      classifyBatch(
        userId,
        [{ emailId: email.id, input: { sender: null, subject: 'x', labels: [], snippet: null } }],
        provider,
      ),
    ).rejects.toBeInstanceOf(AIOutcomeUnknownError);
    expect(
      await prisma.aIOperation.findUnique({
        where: {
          emailId_operation_version: {
            emailId: email.id,
            operation: 'classification',
            version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
          },
        },
      }),
    ).toMatchObject({ status: 'UNKNOWN' });
  });
  it('24 invalid envelope is held', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'invalid-1' } });
    classify.mockRejectedValue(new ProviderFailure('INVALID_OUTPUT'));
    await expect(
      classifyBatch(
        userId,
        [{ emailId: email.id, input: { sender: null, subject: 'x', labels: [], snippet: null } }],
        provider,
      ),
    ).rejects.toBeInstanceOf(SchemaValidationFailure);
    expect(
      await prisma.aIOperation.findUnique({
        where: {
          emailId_operation_version: {
            emailId: email.id,
            operation: 'classification',
            version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
          },
        },
      }),
    ).toMatchObject({ status: 'FAILED' });
  });
  it('25 safety limit prevents a batch claim', async () => {
    process.env.AI_USER_DAILY_CALL_LIMIT = '0';
    try {
      const email = await prisma.email.create({ data: { userId, gmailMessageId: 'limit-1' } });
      await expect(
        classifyBatch(
          userId,
          [{ emailId: email.id, input: { sender: null, subject: 'x', labels: [], snippet: null } }],
          provider,
        ),
      ).rejects.toBeInstanceOf(AIAccessError);
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
    await processEmail(userId, perEmail.id);
    expect(fetchMessageMetadata).toHaveBeenCalledTimes(1);
    expect(
      await prisma.aIProcessingResult.findUnique({ where: { emailId: perEmail.id } }),
    ).toMatchObject({
      contractVersion: 'classification/v2',
      relevanceDecision: 'IRRELEVANT',
    });

    vi.clearAllMocks();
    const batched = await prisma.email.create({
      data: { userId, gmailMessageId: 'routing-batch' },
    });
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
    await processEmail(userId, batched.id);
    expect(fetchMessageMetadata).toHaveBeenCalledTimes(1);
    expect(
      await prisma.aIProcessingResult.findUnique({ where: { emailId: batched.id } }),
    ).toMatchObject({
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
      data: {
        emailId: b.id,
        operation: 'classification',
        version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
        status: 'PROCESSING',
        attempts: 1,
        startedAt: new Date(),
      },
    });
    classify.mockResolvedValue({
      data: {
        results: [
          { key: 'e1', decision: 'RELEVANT', confidence: 0.9, category: 'RECRUITER' },
          { key: 'e2', decision: 'IRRELEVANT', confidence: 0.5, category: null },
        ],
      },
      usage: { inputTokens: 2, outputTokens: 2 },
      version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
      model: 'fixture-fast',
    });
    const result = await classifyBatch(
      userId,
      [
        { emailId: a.id, input: { sender: null, subject: 'a', labels: [], snippet: null } },
        { emailId: b.id, input: { sender: null, subject: 'b', labels: [], snippet: null } },
        { emailId: c.id, input: { sender: null, subject: 'c', labels: [], snippet: null } },
      ],
      provider,
    );
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][0].items).toHaveLength(2);
    expect(result.byEmail.get(a.id)).toBe('RELEVANT');
    expect(result.byEmail.get(c.id)).toBe('UNCERTAIN');
    expect(result.byEmail.has(b.id)).toBe(false);
    expect(await prisma.aIProcessingResult.findUnique({ where: { emailId: c.id } })).toMatchObject({
      relevanceDecision: 'UNCERTAIN',
    });
    expect(
      await prisma.aIOperation.findUnique({
        where: {
          emailId_operation_version: {
            emailId: b.id,
            operation: 'classification',
            version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
          },
        },
      }),
    ).toMatchObject({ status: 'PROCESSING', attempts: 1 });
  });

  it('28 runTriage queues a low-confidence IRRELEVANT as UNCERTAIN', async () => {
    const email = await prisma.email.create({
      data: { userId, gmailMessageId: 'queue-uncertain' },
    });
    vi.mocked(getAccessState).mockResolvedValue({
      state: 'READY',
      reason: null,
      modelId: null,
      resumesAt: null,
    });
    vi.mocked(resolveAIAccess).mockResolvedValue(provider);
    classify.mockResolvedValue({
      data: { results: [{ key: 'e1', decision: 'IRRELEVANT', confidence: 0.5, category: null }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
      model: 'fixture-fast',
    });
    await runTriage(userId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(userId, email.id);
  });

  const one = { sender: null, subject: 'x', labels: [], snippet: null };
  const ok = (results: unknown[]) => ({
    data: { results },
    usage: { inputTokens: 1, outputTokens: 1 },
    version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
    model: 'fixture-fast',
  });
  const opWhere = (emailId: string) => ({
    emailId_operation_version: {
      emailId,
      operation: 'classification',
      version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
    },
  });
  const ready = () => {
    vi.mocked(getAccessState).mockResolvedValue({
      state: 'READY',
      reason: null,
      modelId: null,
      resumesAt: null,
    });
    vi.mocked(resolveAIAccess).mockResolvedValue(provider);
  };

  it('29 a missing answer at the attempt limit stays RETRYABLE and approvable', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'exhausted-1' } });
    await prisma.aIOperation.create({
      data: {
        emailId: email.id,
        operation: 'classification',
        version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
        status: 'RETRYABLE',
        attempts: 2,
      },
    });
    classify.mockResolvedValue(ok([]));
    await classifyBatch(userId, [{ emailId: email.id, input: one }], provider);
    const row = await prisma.aIOperation.findUniqueOrThrow({ where: opWhere(email.id) });
    expect(row).toMatchObject({ status: 'RETRYABLE', attempts: 3 });
    expect(holdOf(row, new Date())).toEqual({ approvable: 'ATTEMPTS_EXHAUSTED' });
    expect(await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({
      processingState: 'FAILED',
      processingErrorCategory: 'BatchItemMissing',
    });
  });

  it('30 a save failure after the AI answered leaves rows PROCESSING, never FAILED', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'save-fail-1' } });
    classify.mockImplementation(async () => {
      await prisma.aIBatch.deleteMany({ where: { userId } });
      return ok([{ key: 'e1', decision: 'RELEVANT', confidence: 0.9, category: null }]);
    });
    await expect(
      classifyBatch(userId, [{ emailId: email.id, input: one }], provider),
    ).rejects.toThrow();
    expect(await prisma.aIOperation.findUniqueOrThrow({ where: opWhere(email.id) })).toMatchObject({
      status: 'PROCESSING',
    });
  });

  it('31 an unclassified call error is held as UNKNOWN', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'unclassified-1' } });
    classify.mockRejectedValue(new Error('adapter bug'));
    await expect(
      classifyBatch(userId, [{ emailId: email.id, input: one }], provider),
    ).rejects.toThrow('adapter bug');
    expect(await prisma.aIOperation.findUniqueOrThrow({ where: opWhere(email.id) })).toMatchObject({
      status: 'UNKNOWN',
    });
  });

  it('32 a triage run stops on an AI error instead of failing the job', async () => {
    await prisma.email.create({ data: { userId, gmailMessageId: 'stop-1' } });
    ready();
    classify.mockRejectedValue(new ProviderFailure('INVALID_OUTPUT'));
    await expect(runTriage(userId)).resolves.toMatchObject({ stoppedBy: 'ai_failure' });
  });

  it('33 classifyOne never changes the email state', async () => {
    const email = await prisma.email.create({
      data: { userId, gmailMessageId: 'one-1', processingState: 'PROCESSING' },
    });
    ready();
    classify.mockResolvedValue(
      ok([{ key: 'e1', decision: 'RELEVANT', confidence: 0.9, category: 'RECRUITER' }]),
    );
    const out = await classifyOne(userId, email.id, one);
    expect(out.decision).toBe('RELEVANT');
    expect(await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({
      processingState: 'PROCESSING',
      relevanceState: 'UNPROCESSED',
    });
  });

  it('34 triage leaves relevanceState UNPROCESSED for job-related email', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'state-1' } });
    ready();
    classify.mockResolvedValue(
      ok([{ key: 'e1', decision: 'RELEVANT', confidence: 0.9, category: 'RECRUITER' }]),
    );
    await runTriage(userId);
    expect(await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({
      processingState: 'PENDING',
      relevanceState: 'UNPROCESSED',
    });
    expect(send).toHaveBeenCalledWith(userId, email.id);
  });

  it('35 the batch capability sends the item schema and checks only the envelope', async () => {
    const calls: unknown[] = [];
    const client = {
      generateStructured: async (request: unknown) => {
        calls.push(request);
        return {
          data: {
            results: [
              { key: 'e1', decision: 'RELEVANT', confidence: 0.9, category: null },
              { key: 'e2', decision: 'BAD' },
            ],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      verifyModels: async () => ({ result: 'VERIFIED' as const }),
    };
    const model = { id: 'fixture-fast' };
    const ai = bindCapabilities(client as never, { fast: model, detailed: model } as never);
    const out = await ai.classifier.classifyRelevanceBatch({ items: [] });
    expect(out.data.results).toHaveLength(2);
    expect((calls[0] as { contract: { schema: unknown } }).contract.schema).toBe(
      RelevanceBatchSchema,
    );
    const json = JSON.stringify(strictJsonSchema(RelevanceBatchSchema));
    for (const field of ['key', 'decision', 'confidence', 'category'])
      expect(json).toContain(`"${field}"`);
  });

  it('36 re-offer sends unclassified email to triage and the rest to the per-email job', async () => {
    const fresh = await prisma.email.create({ data: { userId, gmailMessageId: 'reoffer-fresh' } });
    const legacy = await prisma.email.create({ data: { userId, gmailMessageId: 'reoffer-v2' } });
    await prisma.aIOperation.create({
      data: {
        emailId: legacy.id,
        operation: 'classification',
        version: 'classification/v2',
        status: 'PENDING',
      },
    });
    ready();
    const queueSend = vi.fn(async () => 'triage-job');
    vi.mocked(getQueue).mockResolvedValue({ send: queueSend } as never);
    await reofferPendingEmails(userId);
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend).toHaveBeenCalledWith('relevance-triage-job', { userId }, expect.anything());
    expect(send).toHaveBeenCalledWith(userId, legacy.id);
    expect(send).not.toHaveBeenCalledWith(userId, fresh.id);
  });

  it('37 two runs at the same time never claim the same email', async () => {
    const [a, b, c] = await Promise.all(
      ['par-a', 'par-b', 'par-c'].map((gmailMessageId) =>
        prisma.email.create({ data: { userId, gmailMessageId } }),
      ),
    );
    classify.mockImplementation(async (input: { items: { key?: string }[] }) =>
      ok(
        input.items.map((item) => ({
          key: item.key,
          decision: 'IRRELEVANT',
          confidence: 0.9,
          category: null,
        })),
      ),
    );
    await Promise.all(
      [
        classifyBatch(
          userId,
          [
            { emailId: a.id, input: one },
            { emailId: b.id, input: one },
          ],
          provider,
        ),
        classifyBatch(
          userId,
          [
            { emailId: b.id, input: one },
            { emailId: c.id, input: one },
          ],
          provider,
        ),
      ].map((run) => run.catch(() => undefined)),
    );
    const sentItems = classify.mock.calls.reduce(
      (total, [arg]) => total + (arg as { items: unknown[] }).items.length,
      0,
    );
    expect(sentItems).toBe(3);
    const rows = await prisma.aIOperation.findMany({
      where: { emailId: { in: [a.id, b.id, c.id] } },
    });
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
  });

  it('38 a Gmail failure hands that email to the per-email job', async () => {
    const bad = await prisma.email.create({ data: { userId, gmailMessageId: 'gmail-bad' } });
    await prisma.email.create({ data: { userId, gmailMessageId: 'gmail-good' } });
    vi.mocked(fetchMessageMetadata).mockImplementation(async (_u, id) => {
      if (id === 'gmail-bad') throw new Error('Gmail request failed');
      return { labelIds: ['INBOX'], snippet: 'fixture' };
    });
    ready();
    classify.mockResolvedValue(
      ok([{ key: 'e1', decision: 'IRRELEVANT', confidence: 0.9, category: null }]),
    );
    await runTriage(userId);
    expect(send).toHaveBeenCalledWith(userId, bad.id);
    expect(classify).toHaveBeenCalledTimes(1);
    expect((classify.mock.calls[0][0] as { items: unknown[] }).items).toHaveLength(1);
  });

  it('39 classifyOne waits for a live batch claim instead of failing', async () => {
    const email = await prisma.email.create({
      data: { userId, gmailMessageId: 'live-1', processingState: 'PROCESSING' },
    });
    await prisma.aIOperation.create({
      data: {
        emailId: email.id,
        operation: 'classification',
        version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
        status: 'PROCESSING',
        attempts: 1,
        startedAt: new Date(),
      },
    });
    await expect(classifyOne(userId, email.id, one)).rejects.toBeInstanceOf(RetryableAIError);
    expect(classify).not.toHaveBeenCalled();
  });

  it('40 classifyOne reuses a completed batch result without a call', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'reuse-1' } });
    await prisma.aIOperation.create({
      data: {
        emailId: email.id,
        operation: 'classification',
        version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
        status: 'COMPLETED',
        attempts: 1,
        provider: 'fixture',
        model: 'fixture-fast',
        result: { decision: 'RELEVANT', confidence: 0.9, category: 'INTERVIEW' },
        completedAt: new Date(),
      },
    });
    const out = await classifyOne(userId, email.id, one);
    expect(out).toMatchObject({ decision: 'RELEVANT', category: 'INTERVIEW' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('41 an email with a missing answer is not picked again in the same run', async () => {
    await prisma.email.create({ data: { userId, gmailMessageId: 'loop-1' } });
    ready();
    classify.mockResolvedValue(ok([]));
    await runTriage(userId);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('42 a run with AI access not ready makes no Gmail calls and no claims', async () => {
    const email = await prisma.email.create({ data: { userId, gmailMessageId: 'noaccess-1' } });
    vi.mocked(fetchMessageMetadata).mockClear();
    vi.mocked(getAccessState).mockResolvedValue({
      state: 'LIMITED',
      reason: 'RATE_LIMITED',
      modelId: null,
      resumesAt: null,
    });
    await expect(runTriage(userId)).resolves.toMatchObject({ stoppedBy: 'access_not_ready' });
    expect(fetchMessageMetadata).not.toHaveBeenCalled();
    expect(await prisma.aIOperation.count({ where: { emailId: email.id } })).toBe(0);
  });

  it('26 redaction logs contain no provider input fields', () => {
    const log = JSON.stringify({
      event: 'triage_run',
      userId,
      batchId: 'b',
      emails: 3,
      sender: undefined,
    });
    expect(log).not.toContain('subject');
    expect(log).not.toContain('preview');
    expect(log).not.toContain('labels');
  });
});

describe('strict relevance rules apply to new mails only', () => {
  const LEGACY = LEGACY_CONTRACT_VERSIONS;
  const one = { sender: null, subject: 'x', labels: [], snippet: null };
  const answerAll = async (input: { items: { key?: string }[] }) => ({
    data: {
      results: input.items.map((item) => ({
        key: item.key,
        decision: 'IRRELEVANT',
        confidence: 0.9,
        category: null,
      })),
    },
    usage: { inputTokens: 1, outputTokens: 1 },
    version: 'fixture',
    model: 'fixture-fast',
  });
  const single = {
    data: { decision: 'IRRELEVANT', confidence: 0.9, reasoning: 'fixture' },
    usage: { inputTokens: 1, outputTokens: 1 },
    version: 'fixture',
    model: 'fixture-fast',
  };
  const ready = () => {
    vi.mocked(getAccessState).mockResolvedValue({
      state: 'READY',
      reason: null,
      modelId: null,
      resumesAt: null,
    });
    vi.mocked(resolveAIAccess).mockResolvedValue(provider);
  };
  const linkedin = 'Recruiter <inmail-hit-reply@linkedin.com>';

  it('43 recognizes LinkedIn senders only at linkedin.com', () => {
    expect(isLinkedInSender('Nidhi Sarda <inmail-hit-reply@linkedin.com>')).toBe(true);
    expect(isLinkedInSender('jobs-noreply@linkedin.com')).toBe(true);
    expect(isLinkedInSender('LinkedIn <messages-noreply@e.linkedin.com>')).toBe(true);
    expect(isLinkedInSender('Fake <hr@notlinkedin.com>')).toBe(false);
    expect(isLinkedInSender('Fake <hr@linkedin.com.example.org>')).toBe(false);
    expect(isLinkedInSender('linkedin.com')).toBe(false);
    expect(isLinkedInSender(null)).toBe(false);
  });

  it('44 Social mail from LinkedIn reaches the AI only under the strict rules', () => {
    expect(autoIrrelevant(['INBOX', 'CATEGORY_SOCIAL'], linkedin, true)).toBe(false);
    expect(autoIrrelevant(['INBOX', 'CATEGORY_SOCIAL'], linkedin, false)).toBe(true);
    expect(
      autoIrrelevant(['INBOX', 'CATEGORY_SOCIAL'], 'Friend <a@social.example.com>', true),
    ).toBe(true);
    expect(autoIrrelevant(['INBOX', 'CATEGORY_PROMOTIONS'], linkedin, true)).toBe(true);
    expect(autoIrrelevant(['SPAM'], linkedin, true)).toBe(true);
    expect(autoIrrelevant(['INBOX'], null, true)).toBe(false);
  });

  it('45 a new LinkedIn email in Social is classified with the current rules', async () => {
    const email = await prisma.email.create({
      data: { userId, gmailMessageId: 'li-social', sender: linkedin },
    });
    vi.mocked(fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX', 'CATEGORY_SOCIAL'],
      snippet: 'fixture',
    });
    ready();
    classify.mockImplementation(answerAll);
    await runTriage(userId);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][1]).toBe(AI_CONTRACT_VERSIONS.RELEVANCE_BATCH);
    expect(await prisma.aIOperation.findMany({ where: { emailId: email.id } })).toMatchObject([
      { version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH },
    ]);
  });

  it('46 triage sends an older email with its v1 rules and a new email with the current rules', async () => {
    const old = await prisma.email.create({ data: { userId, gmailMessageId: 'old-v1' } });
    await prisma.aIOperation.create({
      data: {
        emailId: old.id,
        operation: 'classification',
        version: LEGACY.RELEVANCE_BATCH,
        status: 'RETRYABLE',
        attempts: 1,
      },
    });
    const fresh = await prisma.email.create({ data: { userId, gmailMessageId: 'fresh-v2' } });
    ready();
    classify.mockImplementation(answerAll);
    await runTriage(userId);
    expect(classify).toHaveBeenCalledTimes(2);
    const sizes = new Map(
      classify.mock.calls.map(([input, version]) => [
        version,
        (input as { items: unknown[] }).items.length,
      ]),
    );
    expect(sizes).toEqual(
      new Map([
        [LEGACY.RELEVANCE_BATCH, 1],
        [AI_CONTRACT_VERSIONS.RELEVANCE_BATCH, 1],
      ]),
    );
    expect(
      (await prisma.aIOperation.findMany({ where: { emailId: old.id } })).map((row) => row.version),
    ).toEqual([LEGACY.RELEVANCE_BATCH]);
    expect(
      await prisma.aIProcessingResult.findUnique({ where: { emailId: old.id } }),
    ).toMatchObject({ contractVersion: LEGACY.RELEVANCE_BATCH });
    expect(
      await prisma.aIProcessingResult.findUnique({ where: { emailId: fresh.id } }),
    ).toMatchObject({ contractVersion: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH });
  });

  it('47 classifyBatch never starts an email on a second version', async () => {
    const old = await prisma.email.create({ data: { userId, gmailMessageId: 'old-guard' } });
    await prisma.aIOperation.create({
      data: {
        emailId: old.id,
        operation: 'classification',
        version: LEGACY.CLASSIFICATION,
        status: 'PENDING',
      },
    });
    classify.mockImplementation(answerAll);
    await expect(
      classifyBatch(userId, [{ emailId: old.id, input: one }], provider),
    ).rejects.toBeInstanceOf(RetryableAIError);
    expect(classify).not.toHaveBeenCalled();
    expect(await prisma.aIOperation.count({ where: { emailId: old.id } })).toBe(1);
  });

  it('48 classifyOne keeps an older email on relevance-batch/v1', async () => {
    const old = await prisma.email.create({
      data: { userId, gmailMessageId: 'old-one', processingState: 'PROCESSING' },
    });
    await prisma.aIOperation.create({
      data: {
        emailId: old.id,
        operation: 'classification',
        version: LEGACY.RELEVANCE_BATCH,
        status: 'PENDING',
      },
    });
    ready();
    classify.mockImplementation(answerAll);
    const out = await classifyOne(userId, old.id, one);
    expect(out.version).toBe(LEGACY.RELEVANCE_BATCH);
    expect(classify.mock.calls[0][1]).toBe(LEGACY.RELEVANCE_BATCH);
  });

  it('49 the per-email path keeps an older email on classification/v2 and the old Social rule', async () => {
    process.env.AI_TRIAGE_BATCH_ENABLED = 'false';
    ready();
    classifySingle.mockResolvedValue(single);
    const social = await prisma.email.create({
      data: { userId, gmailMessageId: 'old-social', sender: linkedin },
    });
    await prisma.aIOperation.create({
      data: {
        emailId: social.id,
        operation: 'classification',
        version: LEGACY.CLASSIFICATION,
        status: 'PENDING',
      },
    });
    vi.mocked(fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX', 'CATEGORY_SOCIAL'],
      snippet: 'fixture',
    });
    await processEmail(userId, social.id);
    expect(classifySingle).not.toHaveBeenCalled();
    expect(
      await prisma.aIProcessingResult.findUnique({ where: { emailId: social.id } }),
    ).toMatchObject({ deterministic: true, relevanceDecision: 'IRRELEVANT' });

    const waiting = await prisma.email.create({ data: { userId, gmailMessageId: 'old-waiting' } });
    await prisma.aIOperation.create({
      data: {
        emailId: waiting.id,
        operation: 'classification',
        version: LEGACY.CLASSIFICATION,
        status: 'PENDING',
      },
    });
    vi.mocked(fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX'],
      snippet: 'fixture',
    });
    await processEmail(userId, waiting.id);
    expect(classifySingle).toHaveBeenCalledTimes(1);
    expect(classifySingle.mock.calls[0][1]).toBe(LEGACY.CLASSIFICATION);
    expect(
      await prisma.aIProcessingResult.findUnique({ where: { emailId: waiting.id } }),
    ).toMatchObject({ contractVersion: LEGACY.CLASSIFICATION });
  });

  it('50 the per-email path starts a new LinkedIn email in Social on classification/v3', async () => {
    process.env.AI_TRIAGE_BATCH_ENABLED = 'false';
    ready();
    classifySingle.mockResolvedValue(single);
    const email = await prisma.email.create({
      data: { userId, gmailMessageId: 'new-social', sender: linkedin },
    });
    vi.mocked(fetchMessageMetadata).mockResolvedValue({
      labelIds: ['INBOX', 'CATEGORY_SOCIAL'],
      snippet: 'fixture',
    });
    await processEmail(userId, email.id);
    expect(classifySingle).toHaveBeenCalledTimes(1);
    expect(classifySingle.mock.calls[0][1]).toBe(AI_CONTRACT_VERSIONS.CLASSIFICATION);
    expect(
      await prisma.aIProcessingResult.findUnique({ where: { emailId: email.id } }),
    ).toMatchObject({ contractVersion: AI_CONTRACT_VERSIONS.CLASSIFICATION, deterministic: false });
  });

  it('51 an already-classified older email is never rechecked', async () => {
    const old = await prisma.email.create({
      data: {
        userId,
        gmailMessageId: 'old-done',
        processingState: 'COMPLETED',
        relevanceState: 'RELEVANT',
      },
    });
    await prisma.aIOperation.create({
      data: {
        emailId: old.id,
        operation: 'classification',
        version: LEGACY.CLASSIFICATION,
        status: 'COMPLETED',
        attempts: 1,
        provider: 'fixture',
        model: 'fixture-fast',
        result: {
          decision: 'RELEVANT',
          confidence: 0.9,
          category: 'NEWSLETTER',
          reasoning: 'fixture',
        },
        completedAt: new Date(),
      },
    });
    await prisma.aIProcessingResult.create({
      data: {
        emailId: old.id,
        provider: 'fixture',
        model: 'fixture-fast',
        contractVersion: LEGACY.CLASSIFICATION,
        relevanceDecision: 'RELEVANT',
        category: 'NEWSLETTER',
        processingStatus: 'COMPLETED',
      },
    });
    ready();
    await runTriage(userId);
    expect(classify).not.toHaveBeenCalled();
    expect(classifySingle).not.toHaveBeenCalled();
    expect(await prisma.aIOperation.count({ where: { emailId: old.id } })).toBe(1);
    expect(await prisma.email.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      processingState: 'COMPLETED',
      relevanceState: 'RELEVANT',
    });
    expect(
      await prisma.aIProcessingResult.findUnique({ where: { emailId: old.id } }),
    ).toMatchObject({ contractVersion: LEGACY.CLASSIFICATION, relevanceDecision: 'RELEVANT' });
  });
});
