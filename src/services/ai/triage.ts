import type { AIAccess } from './access';
import { getAccessState, resolveAIAccess } from './access';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { fetchMessageMetadata } from '../gmailFetcher';
import { enqueueEmailProcessingJob } from '../enqueue';
import {
  AIAccessError,
  AIProviderError,
  RetryableAIError,
  TerminalAIError,
  aiSetting,
} from './errors';
import {
  AI_CONTRACT_VERSIONS,
  CLASSIFICATION_VERSIONS,
  RELEVANCE_BATCH_VERSIONS,
  AIResult,
  RelevanceClassifierInput,
  RelevanceBatchItem,
  buildRelevanceBatchInput,
  mapBatchResults,
} from './contracts';
import { noteProviderFailure, noteProviderSuccess, recordTokens, reserveUserCall } from './usage';
import { failureError, failureKind } from './operations';
import * as config from '../../utils/config';
import { logEvent, logWarn } from '../../utils/log';

export const TRIAGE_STALE_PROCESSING_MS = 15 * 60_000;
export const TRIAGE_RUN_LIMIT_MS = 180_000;
export const MAX_ATTEMPTS = 3;

// The settings of a triage run. Passing a value checks that value instead of the configured one.
export const triageBatchEnabled = () => aiSetting(config.triageBatchEnabled);
export const triageBatchSize = (value?: string) =>
  aiSetting(() =>
    value === undefined ? config.triageBatchSize() : config.parseAI_TRIAGE_BATCH_SIZE(value),
  );
export const relevanceThreshold = (value?: string) =>
  aiSetting(() =>
    value === undefined
      ? config.relevanceThreshold()
      : config.parseRELEVANCE_CONFIDENCE_THRESHOLD(value),
  );

type Candidate = {
  emailId: string;
  input: RelevanceClassifierInput;
};
type BatchOutcome = 'RELEVANT' | 'IRRELEVANT' | 'UNCERTAIN' | 'UNDECIDED';

const AUTO_IRRELEVANT_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM'];

/** True when the sender address is at linkedin.com or one of its subdomains. */
export function isLinkedInSender(sender: string | null | undefined): boolean {
  const address = (sender?.match(/<([^<>]+)>\s*$/)?.[1] ?? sender ?? '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 1) return false;
  const domain = address.slice(at + 1);
  return domain === 'linkedin.com' || domain.endsWith('.linkedin.com');
}

/**
 * Labels that mark an email IRRELEVANT without an AI call. Under the strict rules, Gmail's Social
 * label no longer drops LinkedIn mail: people reach out there about roles, so the AI decides.
 * Emails still on the legacy rules keep the old label rule (new mails only).
 */
export function autoIrrelevant(
  labels: string[],
  sender: string | null | undefined,
  strictRules: boolean,
): boolean {
  return labels.some(
    (label) =>
      AUTO_IRRELEVANT_LABELS.includes(label) &&
      !(label === 'CATEGORY_SOCIAL' && strictRules && isLinkedInSender(sender)),
  );
}

/**
 * New mails only: an email keeps the relevance version of its existing batch row; only an email
 * with no classification row yet starts on the current rules.
 */
async function batchCandidates(
  userId: string,
  limit: number,
): Promise<{ emailId: string; version: string }[]> {
  const emails = await prisma.email.findMany({
    where: { userId, processingState: 'PENDING', aiProcessingResult: null },
    orderBy: [{ receivedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: Math.max(limit * 4, 100),
    select: {
      id: true,
      aiOperations: {
        where: {
          operation: 'classification',
          version: { in: [...CLASSIFICATION_VERSIONS, ...RELEVANCE_BATCH_VERSIONS] },
        },
        select: {
          version: true,
          status: true,
          attempts: true,
          approvedRetries: true,
          retryAfter: true,
        },
      },
    },
  });
  return emails
    .flatMap((email) => {
      if (email.aiOperations.some((row) => CLASSIFICATION_VERSIONS.includes(row.version)))
        return [];
      const batch = email.aiOperations.find((row) =>
        RELEVANCE_BATCH_VERSIONS.includes(row.version),
      );
      if (!batch) return [{ emailId: email.id, version: AI_CONTRACT_VERSIONS.RELEVANCE_BATCH }];
      const ready =
        ['PENDING', 'RETRYABLE'].includes(batch.status) &&
        batch.attempts < MAX_ATTEMPTS + batch.approvedRetries &&
        (!batch.retryAfter || batch.retryAfter <= new Date());
      return ready ? [{ emailId: email.id, version: batch.version }] : [];
    })
    .slice(0, limit);
}

/** What every step of one batch call needs. */
interface BatchRun {
  userId: string;
  access: AIAccess;
  /** Every item in one batch shares one version; callers group older emails by their pinned version. */
  version: string;
  now: Date;
  /** false when called from classifyOne: the per-email job owns the email's state there. */
  updateEmails: boolean;
}

const classificationKey = (emailId: string, version: string) => ({
  emailId_operation_version: { emailId, operation: 'classification', version },
});

const CLEARED_FAILURE = {
  processingErrorCategory: null,
  processingErrorDetails: null,
  processingErrorStage: null,
  processingRetryable: null,
  processingFailedAt: null,
};

export async function classifyBatch(
  userId: string,
  items: Candidate[],
  access: AIAccess,
  options: { signal?: AbortSignal; updateEmails?: boolean; version?: string } = {},
) {
  const updateEmails = options.updateEmails ?? true;
  const version = options.version ?? AI_CONTRACT_VERSIONS.RELEVANCE_BATCH;
  if (!RELEVANCE_BATCH_VERSIONS.includes(version))
    throw new TerminalAIError('Unknown relevance batch version');
  if (!items.length)
    return {
      decided: new Map<string, RelevanceBatchItem>(),
      undecided: [],
      ignored: 0,
      batchId: null,
      byEmail: new Map<string, BatchOutcome>(),
    };
  const size = triageBatchSize();
  if (items.length > size || items.length > 25)
    throw new TerminalAIError('Invalid relevance batch size');
  const threshold = relevanceThreshold();
  // Checked before claiming: an abort here leaves nothing claimed and nothing sent.
  options.signal?.throwIfAborted();
  const run: BatchRun = { userId, access, version, now: new Date(), updateEmails };
  const { batchId, claimed } = await claimBatch(run, items);

  const sent = buildRelevanceBatchInput(claimed.map((item) => item.input));
  let result: AIResult<{ results: unknown[] }>;
  try {
    result = await access.classifier.classifyRelevanceBatch(sent, version);
  } catch (err) {
    throw await failBatch(err, {
      userId,
      access,
      batchId,
      claimed,
      now: run.now,
      modelId: access.models.fast.id,
      updateEmails,
      version,
    });
  }

  // Deliberately outside the catch (same rule as runOperation): if saving fails after the provider
  // answered, the rows stay PROCESSING, later become held for approval, and are never resent.
  await recordTokens(userId, run.now, result.usage);
  const keys = sent.items.map((item) => item.key!);
  const mapped = mapBatchResults(keys, result.data.results);
  const byEmail = new Map<string, BatchOutcome>();
  await prisma.$transaction(async (tx) => {
    const batch = await tx.aIBatch.update({
      where: { id: batchId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        errorCode: null,
      },
    });
    for (let index = 0; index < claimed.length; index++) {
      const { emailId } = claimed[index];
      const answer = mapped.decided.get(keys[index]);
      if (!answer) {
        await saveMissingAnswer(tx, run, emailId);
        byEmail.set(emailId, 'UNDECIDED');
        continue;
      }
      const decision = {
        decision: answer.confidence < threshold ? ('UNCERTAIN' as const) : answer.decision,
        confidence: answer.confidence,
        category: answer.category,
      };
      await saveDecision(tx, run, emailId, decision, {
        provider: batch.provider!,
        model: batch.model!,
      });
      byEmail.set(emailId, decision.decision);
    }
  });
  await noteProviderSuccess(access);
  logEvent('ai_batch_completed', {
    batchId,
    userId,
    itemCount: claimed.length,
    decided: mapped.decided.size,
    undecided: mapped.undecided.length,
    ignored: mapped.ignored,
  });
  return { ...mapped, batchId, byEmail };
}

/**
 * Commits the batch and one claimed attempt per email before the provider is called, and
 * reserves one call for the user. Emails another worker holds are left out of the batch.
 */
async function claimBatch(run: BatchRun, items: Candidate[]) {
  const { userId, access, version, now } = run;
  const model = access.models.fast;
  return prisma.$transaction(async (tx) => {
    // New mails only: an email that already has a row of another relevance version is never claimed here.
    const pinned = await tx.aIOperation.findMany({
      where: {
        emailId: { in: items.map((item) => item.emailId) },
        operation: 'classification',
        version: {
          in: [...CLASSIFICATION_VERSIONS, ...RELEVANCE_BATCH_VERSIONS].filter(
            (other) => other !== version,
          ),
        },
      },
      select: { emailId: true },
    });
    const elsewhere = new Set(pinned.map((row) => row.emailId));
    const eligible = items.filter((item) => !elsewhere.has(item.emailId));
    await tx.aIOperation.createMany({
      data: eligible.map((item) => ({
        emailId: item.emailId,
        operation: 'classification',
        version,
      })),
      skipDuplicates: true,
    });
    const batch = await tx.aIBatch.create({
      data: {
        userId,
        operation: 'classification',
        version,
        status: 'PROCESSING',
        itemCount: items.length,
        provider: access.provider,
        model: model.id,
        startedAt: now,
      },
    });
    const claimed: Candidate[] = [];
    for (const item of eligible) {
      const existing = await tx.aIOperation.findUniqueOrThrow({
        where: classificationKey(item.emailId, version),
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
    if (run.updateEmails)
      await tx.email.updateMany({
        where: {
          userId,
          id: { in: claimed.map((item) => item.emailId) },
          processingState: 'PENDING',
        },
        data: { processingState: 'PROCESSING' },
      });
    await tx.aIBatch.update({ where: { id: batch.id }, data: { itemCount: claimed.length } });
    logEvent('ai_batch_claimed', {
      batchId: batch.id,
      userId,
      itemCount: claimed.length,
      provider: access.provider,
      model: model.id,
    });
    return { batchId: batch.id, claimed };
  });
}

/** The provider's answer left this email out: it is offered again, or fails once attempts run out. */
async function saveMissingAnswer(tx: Prisma.TransactionClient, run: BatchRun, emailId: string) {
  const op = await tx.aIOperation.findUniqueOrThrow({
    where: classificationKey(emailId, run.version),
  });
  // Stays RETRYABLE even when its attempts are used up: holdOf then offers the user an approval.
  await tx.aIOperation.update({
    where: { id: op.id },
    data: { status: 'RETRYABLE', errorCode: 'BATCH_ITEM_MISSING', retryAfter: null },
  });
  if (!run.updateEmails) return;
  const exhausted = op.attempts >= MAX_ATTEMPTS + op.approvedRetries;
  await tx.email.updateMany({
    where: { id: emailId, userId: run.userId },
    data: exhausted
      ? {
          processingState: 'FAILED',
          processingErrorCategory: 'BatchItemMissing',
          processingErrorDetails: null,
          processingErrorStage: 'classification',
          processingRetryable: false,
          processingFailedAt: new Date(),
        }
      : { processingState: 'PENDING', ...CLEARED_FAILURE },
  });
}

/** Saves one email's decision on its operation row and its result, and moves the email on. */
async function saveDecision(
  tx: Prisma.TransactionClient,
  run: BatchRun,
  emailId: string,
  decision: Pick<RelevanceBatchItem, 'confidence' | 'category'> & {
    decision: Exclude<BatchOutcome, 'UNDECIDED'>;
  },
  producedBy: { provider: string; model: string },
) {
  const irrelevant = decision.decision === 'IRRELEVANT';
  const op = await tx.aIOperation.findUniqueOrThrow({
    where: classificationKey(emailId, run.version),
  });
  await tx.aIOperation.update({
    where: { id: op.id },
    data: { status: 'COMPLETED', result: decision, completedAt: new Date(), retryAfter: null },
  });
  const result = {
    ...producedBy,
    contractVersion: run.version,
    relevanceDecision: decision.decision,
    confidence: decision.confidence,
    category: decision.category,
    deterministic: false,
    processingStatus: irrelevant ? ('COMPLETED' as const) : ('PROCESSING' as const),
  };
  await tx.aIProcessingResult.upsert({
    where: { emailId },
    create: { emailId, ...result },
    update: { ...result, errorCategory: null, errorDetails: null },
  });
  if (!run.updateEmails) return;
  await tx.email.updateMany({
    where: { id: emailId, userId: run.userId },
    // relevanceState of job-related email is set by the pipeline's finish(), after extraction.
    data: irrelevant
      ? { processingState: 'COMPLETED', relevanceState: 'IRRELEVANT', ...CLEARED_FAILURE }
      : { processingState: 'PENDING', ...CLEARED_FAILURE },
  });
}

const REFUSALS = [
  'KEY_REJECTED',
  'ACCOUNT_OR_BILLING',
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
] as const;
type Refusal = (typeof REFUSALS)[number];
const isRefusal = (kind: string | undefined): kind is Refusal =>
  kind !== undefined && (REFUSALS as readonly string[]).includes(kind);

function batchFailureStatus(kind: string | undefined) {
  if (isRefusal(kind)) return 'REFUSED';
  return kind === 'INVALID_OUTPUT' || kind === 'INVALID_REQUEST' ? 'FAILED' : 'UNKNOWN';
}

/**
 * Records a failed batch call on every claimed row (and, from the triage job, on the emails) and
 * returns the error to throw. Same rules as runOperation: a refusal releases the claim; invalid
 * output or request is FAILED; anything else may have been charged and is held as UNKNOWN.
 */
async function failBatch(
  err: unknown,
  ctx: {
    userId: string;
    access: AIAccess;
    batchId: string;
    claimed: Candidate[];
    now: Date;
    modelId: string;
    updateEmails: boolean;
    version: string;
  },
): Promise<unknown> {
  const failure = failureKind(err);
  const kind = failure?.kind;
  const refusal = isRefusal(kind) ? kind : null;
  const status = batchFailureStatus(kind);
  const classified = failure ? failureError(failure.kind, failure.message) : err;
  const thrown: unknown = refusal ? null : classified;
  const resumesAt = await prisma.$transaction(async (tx) => {
    await tx.aIBatch.update({
      where: { id: ctx.batchId },
      data: {
        status,
        errorCode: kind ?? 'OutcomeUnknown',
        completedAt: status === 'UNKNOWN' ? null : new Date(),
      },
    });
    for (const item of ctx.claimed) {
      const where = {
        emailId_operation_version: {
          emailId: item.emailId,
          operation: 'classification',
          version: ctx.version,
        },
      };
      if (refusal)
        await tx.aIOperation.update({
          where,
          data: {
            status: 'PENDING',
            attempts: { decrement: 1 },
            errorCode: refusal,
            batchId: null,
            startedAt: null,
          },
        });
      else
        await tx.aIOperation.update({
          where,
          data: {
            status: status === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
            errorCode: kind ?? 'OutcomeUnknown',
          },
        });
      if (!ctx.updateEmails) continue;
      await tx.email.updateMany({
        where: { id: item.emailId, userId: ctx.userId },
        data: refusal
          ? {
              processingState: 'PENDING',
              processingErrorCategory: null,
              processingErrorDetails: null,
              processingErrorStage: null,
              processingRetryable: null,
              processingFailedAt: null,
            }
          : {
              processingState: 'FAILED',
              processingErrorCategory:
                thrown instanceof AIProviderError ? thrown.name : 'ProcessingError',
              processingErrorDetails: null,
              processingErrorStage: 'classification',
              processingRetryable: false,
              processingFailedAt: new Date(),
            },
      });
    }
    if (refusal)
      return noteProviderFailure(tx, ctx.access, refusal, ctx.now, {
        modelId: ctx.modelId,
        retryAfterMs: failure?.retryAfterMs,
      });
    if (kind === 'OUTCOME_UNKNOWN')
      await noteProviderFailure(tx, ctx.access, 'OUTCOME_UNKNOWN', ctx.now);
    return null;
  });
  logWarn('ai_batch_failed', {
    batchId: ctx.batchId,
    userId: ctx.userId,
    itemCount: ctx.claimed.length,
    kind: kind ?? 'OutcomeUnknown',
  });
  return refusal ? new AIAccessError(refusal, resumesAt) : thrown;
}

export async function classifyOne(
  userId: string,
  emailId: string,
  input: RelevanceClassifierInput,
  options: { signal?: AbortSignal } = {},
) {
  const rows = await prisma.aIOperation.findMany({
    where: { emailId, operation: 'classification', version: { in: [...RELEVANCE_BATCH_VERSIONS] } },
  });
  if (rows.length > 1) throw new TerminalAIError('Relevance version requires reconciliation');
  const row = rows[0] ?? null;
  // New mails only: an email that started on an older version stays on it.
  const version = row?.version ?? AI_CONTRACT_VERSIONS.RELEVANCE_BATCH;
  if (row?.status === 'COMPLETED') {
    const data = row.result as unknown as RelevanceBatchItem;
    return {
      decision: data.decision,
      confidence: data.confidence,
      category: data.category,
      provider: row.provider,
      model: row.model,
      version,
    };
  }
  if (
    row?.status === 'PROCESSING' &&
    row.startedAt &&
    Date.now() - row.startedAt.getTime() < TRIAGE_STALE_PROCESSING_MS
  )
    throw new RetryableAIError('AI operation not ready');
  if (
    row &&
    (row.status === 'UNKNOWN' ||
      row.status === 'FAILED' ||
      row.attempts >= MAX_ATTEMPTS + row.approvedRetries ||
      row.status === 'PROCESSING')
  )
    throw new TerminalAIError(`AI operation requires review: ${row.status}`);
  const access = await resolveAIAccess(userId);
  const result = await classifyBatch(userId, [{ emailId, input }], access, {
    ...options,
    updateEmails: false,
    version,
  });
  if (result.undecided.length) throw new RetryableAIError('AI answer missing');
  const item = result.decided.get('e1') ?? [...result.decided.values()][0];
  if (!item) throw new RetryableAIError('AI answer missing');
  return {
    decision: item.confidence < relevanceThreshold() ? 'UNCERTAIN' : item.decision,
    confidence: item.confidence,
    category: item.category,
    provider: access.provider,
    model: access.models.fast.id,
    version,
  };
}

async function markDeterministicIrrelevant(userId: string, emailId: string) {
  await prisma.aIProcessingResult.upsert({
    where: { emailId },
    create: {
      emailId,
      provider: 'deterministic',
      model: 'none',
      contractVersion: 'deterministic/v1',
      relevanceDecision: 'IRRELEVANT',
      confidence: 1,
      category: null,
      deterministic: true,
      processingStatus: 'COMPLETED',
    },
    update: {
      provider: 'deterministic',
      model: 'none',
      contractVersion: 'deterministic/v1',
      relevanceDecision: 'IRRELEVANT',
      confidence: 1,
      category: null,
      deterministic: true,
      processingStatus: 'COMPLETED',
    },
  });
  await prisma.email.update({
    where: { id: emailId },
    data: {
      processingState: 'COMPLETED',
      relevanceState: 'IRRELEVANT',
      processingErrorCategory: null,
      processingErrorDetails: null,
      processingErrorStage: null,
      processingRetryable: null,
      processingFailedAt: null,
    },
  });
}

export async function runTriage(userId: string, signal?: AbortSignal) {
  if ((await getAccessState(userId)).state !== 'READY')
    return { batches: 0, emails: 0, stoppedBy: 'access_not_ready' as const };
  const started = Date.now();
  const handled = new Set<string>();
  let batches = 0,
    processed = 0;
  let stoppedBy: 'time_limit' | 'ai_failure' = 'time_limit';
  run: while (Date.now() - started < TRIAGE_RUN_LIMIT_MS) {
    const picked = (await batchCandidates(userId, triageBatchSize())).filter(
      (pick) => !handled.has(pick.emailId),
    );
    if (!picked.length) return { batches, emails: processed, stoppedBy: 'no_candidates' as const };
    const candidates: (Candidate & { version: string })[] = [];
    for (const { emailId, version } of picked) {
      try {
        const email = await prisma.email.findFirst({
          where: { id: emailId, userId },
          select: { id: true, gmailMessageId: true, sender: true, subject: true },
        });
        if (!email) throw new TerminalAIError('Email unavailable');
        const gmail = await fetchMessageMetadata(userId, email.gmailMessageId, {
          signal,
        });
        const labels = gmail.labelIds ?? [];
        if (
          autoIrrelevant(labels, email.sender, version === AI_CONTRACT_VERSIONS.RELEVANCE_BATCH)
        ) {
          await markDeterministicIrrelevant(userId, email.id);
          handled.add(email.id);
          processed++;
          continue;
        }
        candidates.push({
          emailId: email.id,
          version,
          input: { sender: email.sender, subject: email.subject, labels, snippet: gmail.snippet },
        });
      } catch {
        handled.add(emailId);
        processed++;
        await enqueueEmailProcessingJob(userId, emailId);
      }
    }
    // One call per version: an older email is never sent with the current rules.
    for (const version of new Set(candidates.map((candidate) => candidate.version))) {
      const group = candidates.filter((candidate) => candidate.version === version);
      try {
        const access = await resolveAIAccess(userId);
        const result = await classifyBatch(userId, group, access, { signal, version });
        batches++;
        processed += group.length;
        for (const candidate of group) {
          handled.add(candidate.emailId);
          const outcome = result.byEmail.get(candidate.emailId);
          if (outcome === 'RELEVANT' || outcome === 'UNCERTAIN') {
            const id = await enqueueEmailProcessingJob(userId, candidate.emailId);
            if (!id) logEvent('triage_email_queue_suppressed', { emailId: candidate.emailId });
          }
        }
      } catch (err) {
        group.forEach((candidate) => handled.add(candidate.emailId));
        // Nothing was claimed: another run or job holds these emails. Skip them and continue.
        if (err instanceof RetryableAIError) continue;
        // Every other AI outcome is already recorded on the ledger and the emails: stop this run.
        if (err instanceof AIProviderError) {
          stoppedBy = 'ai_failure';
          break run;
        }
        throw err;
      }
    }
  }
  logEvent('triage_run', { userId, batches, emails: processed, stoppedBy });
  return { batches, emails: processed, stoppedBy };
}
