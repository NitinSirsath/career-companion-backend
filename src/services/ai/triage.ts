import type { AIAccess } from './access';
import { getAccessState, resolveAIAccess } from './access';
import { prisma } from '../../db/prisma';
import { GmailFetcherService } from '../gmailFetcher';
import { enqueueEmailProcessingJob } from '../../jobs/emailProcessingJob';
import { AIAccessError, AIOutcomeUnknownError, ProviderFailure, RetryableAIError, TerminalAIError } from './errors';
import {
  AI_CONTRACT_VERSIONS,
  CLASSIFICATION_INPUT_LIMITS,
  AIResult,
  RelevanceClassifierInput,
  RelevanceBatchInputItem,
  RelevanceBatchItem,
  buildRelevanceBatchInput,
  mapBatchResults,
} from './contracts';
import { noteProviderFailure, noteProviderSuccess, recordTokens, reserveUserCall } from './usage';
import { failureError, failureKind } from './operations';

export const TRIAGE_STALE_PROCESSING_MS = 15 * 60_000;
export const TRIAGE_RUN_LIMIT_MS = 180_000;
export const MAX_ATTEMPTS = 3;

export function triageBatchEnabled(value = process.env.AI_TRIAGE_BATCH_ENABLED) {
  return value === 'true';
}
export function triageBatchSize(value = process.env.AI_TRIAGE_BATCH_SIZE): number {
  if (value === undefined || value === '') return 20;
  if (!/^\d+$/.test(value)) throw new TerminalAIError('Invalid AI_TRIAGE_BATCH_SIZE');
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > 25) throw new TerminalAIError('Invalid AI_TRIAGE_BATCH_SIZE');
  return size;
}
export function relevanceThreshold(value = process.env.RELEVANCE_CONFIDENCE_THRESHOLD): number {
  const threshold = Number(value ?? 0.7);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new TerminalAIError('Invalid relevance threshold');
  return threshold;
}

type Candidate = {
  emailId: string;
  input: RelevanceClassifierInput;
};

async function batchCandidates(userId: string, limit: number): Promise<string[]> {
  const emails = await prisma.email.findMany({
    where: { userId, processingState: 'PENDING', aiProcessingResult: null },
    orderBy: [{ receivedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: Math.max(limit * 4, 100),
    select: { id: true, aiOperations: { where: { operation: 'classification', version: { in: [AI_CONTRACT_VERSIONS.CLASSIFICATION, AI_CONTRACT_VERSIONS.RELEVANCE_BATCH] } }, select: { version: true, status: true, attempts: true, approvedRetries: true, retryAfter: true } } },
  });
  return emails.filter((email) => {
    const legacy = email.aiOperations.find((row) => row.version === AI_CONTRACT_VERSIONS.CLASSIFICATION);
    if (legacy) return false;
    const batch = email.aiOperations.find((row) => row.version === AI_CONTRACT_VERSIONS.RELEVANCE_BATCH);
    if (!batch) return true;
    return ['PENDING', 'RETRYABLE'].includes(batch.status) &&
      batch.attempts < MAX_ATTEMPTS + batch.approvedRetries &&
      (!batch.retryAfter || batch.retryAfter <= new Date());
  }).slice(0, limit).map((email) => email.id);
}

export async function classifyBatch(
  userId: string,
  items: Candidate[],
  access: AIAccess,
  options: { signal?: AbortSignal } = {},
) {
  if (!items.length) return { decided: new Map<string, RelevanceBatchItem>(), undecided: [], ignored: 0, batchId: null };
  const size = triageBatchSize();
  if (items.length > size || items.length > 25) throw new TerminalAIError('Invalid relevance batch size');
  const threshold = relevanceThreshold();
  const now = new Date();
  const model = access.models.fast;
  const operationKeys = items.map((item) => ({ emailId: item.emailId, operation: 'classification', version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH }));
  let claimed: Candidate[] = [];
  let batchId: string | null = null;

  await prisma.$transaction(async (tx) => {
    await tx.aIOperation.createMany({ data: operationKeys, skipDuplicates: true });
    const batch = await tx.aIBatch.create({
      data: {
        userId,
        operation: 'classification',
        version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
        status: 'PROCESSING',
        itemCount: items.length,
        provider: access.provider,
        model: model.id,
        startedAt: now,
      },
    });
    batchId = batch.id;
    for (const item of items) {
      const existing = await tx.aIOperation.findUniqueOrThrow({
        where: { emailId_operation_version: { emailId: item.emailId, operation: 'classification', version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH } },
      });
      const claim = await tx.aIOperation.updateMany({
        where: {
          id: existing.id,
          status: { in: ['PENDING', 'RETRYABLE'] },
          attempts: existing.attempts,
          OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
        },
        data: {
          status: 'PROCESSING',
          attempts: { increment: 1 },
          startedAt: now,
          errorCode: null,
          retryAfter: null,
          provider: access.provider,
          model: model.id,
          batchId: batch.id,
        },
      });
      if (claim.count === 1) claimed.push(item);
    }
    if (!claimed.length) throw new RetryableAIError('AI operation not ready');
    await reserveUserCall(tx, userId, now);
    await tx.email.updateMany({
      where: { userId, id: { in: claimed.map((item) => item.emailId) }, processingState: 'PENDING' },
      data: { processingState: 'PROCESSING' },
    });
    await tx.aIBatch.update({ where: { id: batch.id }, data: { itemCount: claimed.length } });
    console.log(JSON.stringify({ event: 'ai_batch_claimed', batchId: batch.id, userId, itemCount: claimed.length, provider: access.provider, model: model.id }));
  }).catch((err) => {
    if (err instanceof AIAccessError) throw err;
    throw err;
  });

  const sent = buildRelevanceBatchInput(claimed.map((item) => item.input));
  let result: AIResult<{ results: unknown[] }>;
  try {
    options.signal?.throwIfAborted();
    result = await access.classifier.classifyRelevanceBatch(sent);
    await recordTokens(userId, now, result.usage);
    const mapped = mapBatchResults(sent.items.map((item) => item.key!), result.data.results);
    await prisma.$transaction(async (tx) => {
      const batch = await tx.aIBatch.update({
        where: { id: batchId! },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          errorCode: null,
        },
      });
      for (const item of claimed) {
        const key = sent.items.find((candidate) => candidate.key === sent.items[claimed.indexOf(item)]?.key)?.key;
        const decision = key ? mapped.decided.get(key) : undefined;
        const op = await tx.aIOperation.findUniqueOrThrow({ where: { emailId_operation_version: { emailId: item.emailId, operation: 'classification', version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH } } });
        if (!decision) {
          const held = op.attempts >= MAX_ATTEMPTS + op.approvedRetries;
          await tx.aIOperation.update({ where: { id: op.id }, data: { status: held ? 'FAILED' : 'RETRYABLE', errorCode: 'BATCH_ITEM_MISSING', retryAfter: null } });
          await tx.email.updateMany({ where: { id: item.emailId, userId }, data: held ? { processingState: 'FAILED', processingErrorCategory: 'BatchItemMissing', processingErrorStage: 'classification', processingRetryable: false, processingFailedAt: new Date() } : { processingState: 'PENDING', processingErrorCategory: null, processingErrorDetails: null, processingErrorStage: null, processingRetryable: null, processingFailedAt: null } });
          continue;
        }
        const decisionState = decision.confidence < threshold ? 'UNCERTAIN' : decision.decision;
        await tx.aIOperation.update({ where: { id: op.id }, data: { status: 'COMPLETED', result: { decision: decisionState, confidence: decision.confidence, category: decision.category }, completedAt: new Date(), retryAfter: null } });
        await tx.aIProcessingResult.upsert({
          where: { emailId: item.emailId },
          create: {
            emailId: item.emailId, provider: batch.provider!, model: batch.model!, contractVersion: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
            relevanceDecision: decisionState, confidence: decision.confidence, category: decision.category, deterministic: false,
            processingStatus: decisionState === 'IRRELEVANT' ? 'COMPLETED' : 'PROCESSING',
          },
          update: {
            provider: batch.provider!, model: batch.model!, contractVersion: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH,
            relevanceDecision: decisionState, confidence: decision.confidence, category: decision.category, deterministic: false,
            processingStatus: decisionState === 'IRRELEVANT' ? 'COMPLETED' : 'PROCESSING',
            errorCategory: null, errorDetails: null,
          },
        });
        await tx.email.updateMany({
          where: { id: item.emailId, userId },
          data: decisionState === 'IRRELEVANT'
            ? { processingState: 'COMPLETED', relevanceState: 'IRRELEVANT', processingErrorCategory: null, processingErrorDetails: null, processingErrorStage: null, processingRetryable: null, processingFailedAt: null }
            : { processingState: 'PENDING', relevanceState: 'RELEVANT', processingErrorCategory: null, processingErrorDetails: null, processingErrorStage: null, processingRetryable: null, processingFailedAt: null },
        });
      }
    });
    await noteProviderSuccess(access);
    console.log(JSON.stringify({ event: 'ai_batch_completed', batchId, userId, itemCount: claimed.length, decided: mapped.decided.size, undecided: mapped.undecided.length, ignored: mapped.ignored }));
    return { ...mapped, batchId };
  } catch (err) {
    const failure = failureKind(err);
    const kind = failure?.kind;
    await prisma.$transaction(async (tx) => {
      const opStatus = kind === 'KEY_REJECTED' || kind === 'ACCOUNT_OR_BILLING' || kind === 'MODEL_UNAVAILABLE' || kind === 'RATE_LIMITED' ? 'REFUSED' : kind === 'OUTCOME_UNKNOWN' ? 'UNKNOWN' : 'FAILED';
      await tx.aIBatch.update({ where: { id: batchId! }, data: { status: opStatus, errorCode: kind ?? 'OutcomeUnknown', completedAt: kind === 'OUTCOME_UNKNOWN' ? null : new Date() } });
      for (const item of claimed) {
        const op = await tx.aIOperation.findUniqueOrThrow({ where: { emailId_operation_version: { emailId: item.emailId, operation: 'classification', version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH } } });
        if (opStatus === 'REFUSED') {
          await tx.aIOperation.update({ where: { id: op.id }, data: { status: 'PENDING', attempts: { decrement: 1 }, errorCode: kind, batchId: null, startedAt: null } });
        } else {
          await tx.aIOperation.update({ where: { id: op.id }, data: { status: opStatus === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED', errorCode: kind ?? 'OutcomeUnknown' } });
        }
        await tx.email.updateMany({
          where: { id: item.emailId, userId },
          data: opStatus === 'REFUSED'
            ? { processingState: 'PENDING', processingErrorCategory: null, processingErrorDetails: null, processingErrorStage: null, processingRetryable: null, processingFailedAt: null }
            : { processingState: 'FAILED', processingErrorCategory: kind === 'INVALID_OUTPUT' ? 'SchemaValidationFailure' : 'ProcessingError', processingErrorDetails: null, processingErrorStage: 'classification', processingRetryable: false, processingFailedAt: new Date() },
        });
      }
      if (kind === 'RATE_LIMITED' || kind === 'KEY_REJECTED' || kind === 'ACCOUNT_OR_BILLING' || kind === 'MODEL_UNAVAILABLE') {
        await noteProviderFailure(tx, access, kind, now, { modelId: model.id, retryAfterMs: failure?.retryAfterMs });
      } else if (kind === 'OUTCOME_UNKNOWN') {
        await noteProviderFailure(tx, access, 'OUTCOME_UNKNOWN', now);
      }
    });
    console.warn(JSON.stringify({ event: 'ai_batch_failed', batchId, userId, itemCount: claimed.length, kind: kind ?? 'OutcomeUnknown' }));
    if (failure) {
      if (kind === 'INVALID_OUTPUT' || kind === 'INVALID_REQUEST' || kind === 'OUTCOME_UNKNOWN')
        throw failureError(kind, failure.message);
      if (kind === 'KEY_REJECTED' || kind === 'ACCOUNT_OR_BILLING' || kind === 'MODEL_UNAVAILABLE' || kind === 'RATE_LIMITED')
        throw new AIAccessError(kind, null);
      throw failure;
    }
    throw err;
  }
}

export async function classifyOne(
  userId: string,
  emailId: string,
  input: RelevanceClassifierInput,
  options: { signal?: AbortSignal } = {},
) {
  const row = await prisma.aIOperation.findUnique({ where: { emailId_operation_version: { emailId, operation: 'classification', version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH } } });
  if (row?.status === 'COMPLETED') {
    const data = row.result as unknown as RelevanceBatchItem;
    return { decision: data.decision, confidence: data.confidence, category: data.category, provider: row.provider, model: row.model, version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH };
  }
  if (row?.status === 'PROCESSING' && row.startedAt && Date.now() - row.startedAt.getTime() < TRIAGE_STALE_PROCESSING_MS)
    throw new RetryableAIError('AI operation not ready');
  if (row && (row.status === 'UNKNOWN' || row.status === 'FAILED' || row.attempts >= MAX_ATTEMPTS + row.approvedRetries || row.status === 'PROCESSING'))
    throw new TerminalAIError(`AI operation requires review: ${row.status}`);
  const access = await resolveAIAccess(userId);
  const result = await classifyBatch(userId, [{ emailId, input }], access, options);
  if (result.undecided.length) throw new RetryableAIError('AI answer missing');
  const item = result.decided.get('e1') ?? [...result.decided.values()][0];
  if (!item) throw new RetryableAIError('AI answer missing');
  return { decision: item.confidence < relevanceThreshold() ? 'UNCERTAIN' : item.decision, confidence: item.confidence, category: item.category, provider: access.provider, model: access.models.fast.id, version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH };
}

async function markDeterministicIrrelevant(userId: string, emailId: string) {
  await prisma.aIProcessingResult.upsert({
    where: { emailId },
    create: { emailId, provider: 'deterministic', model: 'none', contractVersion: 'deterministic/v1', relevanceDecision: 'IRRELEVANT', confidence: 1, category: null, deterministic: true, processingStatus: 'COMPLETED' },
    update: { provider: 'deterministic', model: 'none', contractVersion: 'deterministic/v1', relevanceDecision: 'IRRELEVANT', confidence: 1, category: null, deterministic: true, processingStatus: 'COMPLETED' },
  });
  await prisma.email.update({ where: { id: emailId }, data: { processingState: 'COMPLETED', relevanceState: 'IRRELEVANT', processingErrorCategory: null, processingErrorDetails: null, processingErrorStage: null, processingRetryable: null, processingFailedAt: null } });
}

export async function runTriage(userId: string, signal?: AbortSignal) {
  if ((await getAccessState(userId)).state !== 'READY') return { batches: 0, emails: 0, stoppedBy: 'access_not_ready' as const };
  const started = Date.now();
  const handled = new Set<string>();
  let batches = 0, processed = 0;
  while (Date.now() - started < TRIAGE_RUN_LIMIT_MS) {
    const ids = (await batchCandidates(userId, triageBatchSize())).filter((id) => !handled.has(id));
    if (!ids.length) return { batches, emails: processed, stoppedBy: 'no_candidates' as const };
    const candidates: Candidate[] = [];
    for (const emailId of ids) {
      try {
        const email = await prisma.email.findFirst({ where: { id: emailId, userId }, select: { id: true, gmailMessageId: true, sender: true, subject: true } });
        if (!email) throw new TerminalAIError('Email unavailable');
        const gmail = await GmailFetcherService.fetchMessageMetadata(userId, email.gmailMessageId, { signal });
        const labels = gmail.labelIds ?? [];
        if (labels.some((label) => ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM'].includes(label))) {
          await markDeterministicIrrelevant(userId, email.id);
          handled.add(email.id); processed++; continue;
        }
        candidates.push({ emailId: email.id, input: { sender: email.sender, subject: email.subject, labels, snippet: gmail.snippet } });
      } catch (err) {
        handled.add(emailId);
        processed++;
        await enqueueEmailProcessingJob(userId, emailId);
      }
    }
    if (!candidates.length) continue;
    const inputs = buildRelevanceBatchInput(candidates.map((candidate) => candidate.input));
    try {
      const access = await resolveAIAccess(userId);
      const result = await classifyBatch(userId, candidates, access, { signal });
      batches++; processed += candidates.length;
      result.undecided.forEach((key) => {
        const candidate = candidates[inputs.items.findIndex((item) => item.key === key)];
        if (candidate) handled.add(candidate.emailId);
      });
      for (const candidate of candidates) {
        const index = candidates.indexOf(candidate);
        const key = inputs.items[index].key!;
        const decided = result.decided.get(key);
        handled.add(candidate.emailId);
        if (decided && (decided.decision === 'RELEVANT' || decided.decision === 'UNCERTAIN')) {
          const id = await enqueueEmailProcessingJob(userId, candidate.emailId);
          if (!id) console.log(JSON.stringify({ event: 'triage_email_queue_suppressed', emailId: candidate.emailId }));
        }
      }
    } catch (err) {
      candidates.forEach((candidate) => handled.add(candidate.emailId));
      if (err instanceof AIAccessError || err instanceof AIOutcomeUnknownError || err instanceof ProviderFailure) break;
      throw err;
    }
    if (candidates.length === 0) break;
  }
  const stoppedBy = Date.now() - started >= TRIAGE_RUN_LIMIT_MS ? 'time_limit' as const : 'no_progress' as const;
  console.log(JSON.stringify({ event: 'triage_run', userId, batches, emails: processed, stoppedBy }));
  return { batches, emails: processed, stoppedBy };
}
