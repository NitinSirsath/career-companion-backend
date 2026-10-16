import { AIOperation, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { AI_CATALOG } from '../../contracts/aiCatalog';
import type { AIAccess } from './access';
import { AIContract, AIResult, RELEVANCE_BATCH_VERSIONS } from './contracts';
import {
  AIAccessError,
  AIOutcomeUnknownError,
  AIProviderError,
  ProviderFailure,
  RetryableAIError,
  SchemaValidationFailure,
  TerminalAIError,
  isRefusal,
} from './errors';
import {
  noteProviderFailure,
  noteProviderSuccess,
  recordTokens,
  reserveUserCall,
  resumeAfterPause,
} from './usage';
import { logDebug, logError, logEvent, logWarn } from '../../utils/log';

export const MAX_ATTEMPTS = 3;

/**
 * A PROCESSING claim older than this has no live job waiting for its answer: the longest model time
 * limit, our own timer 15 seconds after it, and time for the writes that follow.
 */
export const STALE_PROCESSING_MS =
  Math.max(...AI_CATALOG.flatMap((provider) => provider.models.map((model) => model.timeoutMs))) +
  60_000;

export const isStaleClaim = (op: Pick<AIOperation, 'status' | 'startedAt'>, now: Date) =>
  op.status === 'PROCESSING' &&
  op.startedAt !== null &&
  now.getTime() - op.startedAt.getTime() > STALE_PROCESSING_MS;

export interface OperationRequest<T> {
  userId: string;
  emailId: string;
  operation: string;
  contract: Pick<AIContract<T>, 'version' | 'schema' | 'role'>;
  /** Resolves the user's AI access. Called only when a provider call is about to be claimed. */
  access: () => Promise<AIAccess>;
  call: (access: AIAccess) => Promise<AIResult<T>>;
}

/** Validated output with the provider and model that produced it (null: not recorded). */
export interface OperationResult<T> {
  data: T;
  provider: string | null;
  model: string | null;
}

/**
 * Durable external-effect boundary. A claim is committed before the provider call; completed
 * results are reused; a call with no answer in time is tried again by itself at most MAX_ATTEMPTS
 * times in all, then held for the user's OK.
 *
 * Per-user rules (ADR-0001 decisions 7–10):
 * - Access is resolved before the claim, so waiting for AI uses no attempt and no call.
 * - The claim reserves one call against the user's daily safety limit and respects the user's
 *   provider cooldown. One user's limit or cooldown never affects another user.
 * - A refusal (key, account, model, rate limit, busy provider) releases the claim and restores
 *   the attempt: it was rejected before any work was done. The user's access state records it.
 * - No answer in time uses the attempt and pauses as for a busy provider; the email waits.
 * - A claim no live job can hold goes back to waiting, its attempt used.
 * - Each user approval (`approvedRetries`) permits exactly one call beyond MAX_ATTEMPTS.
 */
export async function runOperation<T>(request: OperationRequest<T>): Promise<OperationResult<T>> {
  const { userId, emailId, operation, contract } = request;
  const version = contract.version;
  const opened = await openOperation(userId, { emailId, operation, version });
  if (opened.status === 'COMPLETED') {
    logDebug('ai_result_reused', { emailId, operation, version });
    return {
      data: contract.schema.parse(opened.result),
      provider: opened.provider,
      model: opened.model,
    };
  }
  const existing = isStaleClaim(opened, new Date()) ? await releaseClaim(opened) : opened;
  assertCallAllowed(existing);

  const access = await request.access();
  const model = access.models[contract.role];
  const now = new Date();
  await claimAttempt(userId, existing, { provider: access.provider, model: model.id, now });
  logEvent('ai_call_started', {
    userId,
    emailId,
    operation,
    version,
    attempt: existing.attempts + 1,
    provider: access.provider,
    model: model.id,
  });

  let result: AIResult<T>;
  let data: T;
  try {
    result = await request.call(access);
    await recordTokens(userId, now, result.usage);
    data = contract.schema.parse(result.data);
  } catch (err) {
    throw await recordFailure(err, {
      access,
      existing,
      operation,
      now,
      modelId: model.id,
      timeoutMs: model.timeoutMs,
    });
  }
  // Deliberately outside the catch: persistence failure leaves PROCESSING.
  // Retrying the job cannot submit again when the provider succeeded but this write failed.
  await prisma.aIOperation.update({
    where: { id: existing.id },
    data: {
      status: 'COMPLETED',
      result: data as Prisma.InputJsonValue,
      completedAt: new Date(),
      retryAfter: null,
    },
  });
  await noteProviderSuccess(access);
  logEvent('ai_call_completed', {
    userId,
    emailId,
    operation,
    version,
    provider: access.provider,
    model: model.id,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    durationMs: Date.now() - now.getTime(),
  });
  return { data, provider: access.provider, model: model.id };
}

/** The operation's ledger row, created on first use. The email must belong to the user. */
async function openOperation(
  userId: string,
  key: { emailId: string; operation: string; version: string },
): Promise<AIOperation> {
  const owned = await prisma.email.findFirst({
    where: { id: key.emailId, userId },
    select: { id: true },
  });
  if (!owned) throw new TerminalAIError('Email unavailable');
  await prisma.aIOperation.createMany({ data: [key], skipDuplicates: true });
  return prisma.aIOperation.findUniqueOrThrow({ where: { emailId_operation_version: key } });
}

/**
 * Puts a claim no live job can hold back to waiting, its attempt used: the call may have been sent.
 * Returns the row as it is now.
 */
async function releaseClaim(op: AIOperation): Promise<AIOperation> {
  const released = await prisma.aIOperation.updateMany({
    where: { id: op.id, status: 'PROCESSING', startedAt: op.startedAt },
    data: { status: 'RETRYABLE' },
  });
  if (released.count)
    logWarn('ai_claim_released', {
      emailId: op.emailId,
      operation: op.operation,
      version: op.version,
      attempt: op.attempts,
      startedAt: op.startedAt ?? undefined,
    });
  return prisma.aIOperation.findUniqueOrThrow({ where: { id: op.id } });
}

/**
 * When the worker starts, no job holds a claim yet: every per-email claim still PROCESSING goes
 * back to waiting, its attempt used. Batch claims keep their own rules.
 */
export async function releaseClaimsAtStart(): Promise<void> {
  const claims = await prisma.aIOperation.findMany({
    where: { status: 'PROCESSING', version: { notIn: [...RELEVANCE_BATCH_VERSIONS] } },
  });
  for (const op of claims) await releaseClaim(op);
}

/** A held operation, or one with no attempts left, is never called again without review. */
function assertCallAllowed(existing: AIOperation) {
  const { emailId, operation, version, status, attempts } = existing;
  if (
    !['PROCESSING', 'UNKNOWN', 'FAILED'].includes(status) &&
    attempts < MAX_ATTEMPTS + existing.approvedRetries
  )
    return;
  logWarn('ai_call_blocked', { emailId, operation, version, status, attempts });
  throw new TerminalAIError(`AI operation requires review: ${status}`);
}

/** Commits the claim and reserves one call for the user, before the provider is called. */
async function claimAttempt(
  userId: string,
  existing: AIOperation,
  call: { provider: string; model: string; now: Date },
) {
  const { emailId, operation, version } = existing;
  const { now } = call;
  await prisma
    .$transaction(async (tx) => {
      // Compare-and-set on the observed attempts: exactly one worker can claim each attempt.
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
          provider: call.provider,
          model: call.model,
        },
      });
      if (claim.count !== 1) throw new RetryableAIError('AI operation not ready');
      await reserveUserCall(tx, userId, now);
    })
    .catch((err: unknown) => {
      if (err instanceof AIAccessError)
        logEvent('ai_call_deferred', { userId, emailId, operation, version, reason: err.reason });
      if (err instanceof AIProviderError) err.operationStage = operation;
      throw err;
    });
}

export function failureKind(err: unknown): ProviderFailure | null {
  return err instanceof ProviderFailure ? err : null;
}

export function failureError(kind: ProviderFailure['kind'], message: string): AIProviderError {
  if (kind === 'INVALID_OUTPUT')
    return new SchemaValidationFailure(message, 'Structured response failed validation');
  if (kind === 'INVALID_REQUEST') return new TerminalAIError(message);
  if (kind === 'OUTCOME_UNKNOWN') return new AIOutcomeUnknownError();
  return new TerminalAIError(message);
}

/** After a failed call: a pause, a new try after a pause, waiting for the user, or held. */
type NextStep = 'paused' | 'retry_scheduled' | 'waiting_for_user' | 'held';

interface FailedCall {
  access: AIAccess;
  existing: Pick<
    AIOperation,
    'id' | 'status' | 'emailId' | 'version' | 'attempts' | 'approvedRetries'
  >;
  operation: string;
  now: Date;
  modelId: string;
  timeoutMs: number;
}

interface FailureOutcome {
  thrown: unknown;
  resumesAt: Date | null;
  next: NextStep;
}

/** A failure the provider adapter could sort. Anything else is our own bug. */
const sortedFailure = (err: unknown) =>
  err instanceof ProviderFailure && err.failureCause !== 'UNCLASSIFIED' ? err : null;

/** A provider failure is an expected outcome, logged as a warning; anything else is our own bug. */
function logFailure(
  err: unknown,
  call: FailedCall,
  outcome: { durationMs: number; result: NextStep; resumesAt: Date | null },
) {
  const { access, existing } = call;
  const failure = sortedFailure(err);
  const fields = {
    userId: access.userId,
    emailId: existing.emailId,
    operation: call.operation,
    version: existing.version,
    attempt: existing.attempts + 1,
    provider: access.provider,
    model: call.modelId,
    kind: failure?.kind ?? 'UNCLASSIFIED',
    failureCause: failure?.failureCause ?? 'UNCLASSIFIED',
    networkCode: failure?.networkCode,
    status: failure?.status,
    providerCode: failure?.providerCode,
    quotaScope: failure?.quotaScope,
    retryAfterMs: failure?.retryAfterMs,
    durationMs: outcome.durationMs,
    timeoutMs: call.timeoutMs,
    result: outcome.result,
    resumesAt: outcome.resumesAt ?? undefined,
  };
  if (failure) logWarn('ai_call_failed', fields);
  else logError('ai_call_failed', fields, err);
}

/**
 * Records a failed call on the ledger and the user's access state, logs it, and returns the error
 * the caller sees.
 */
async function recordFailure(err: unknown, call: FailedCall): Promise<unknown> {
  const durationMs = Date.now() - call.now.getTime();
  if (err instanceof ProviderFailure && err.usage)
    await recordTokens(call.access.userId, call.now, err.usage);
  const outcome = await prisma.$transaction((tx) => recordOutcome(tx, sortedFailure(err), call));
  await resumeAfterPause(call.access.userId, outcome.resumesAt);
  if (outcome.thrown instanceof AIProviderError) outcome.thrown.operationStage = call.operation;
  logFailure(err, call, { durationMs, result: outcome.next, resumesAt: outcome.resumesAt });
  return outcome.thrown;
}

const OWN_ERROR_MESSAGE =
  'An error in Career Companion stopped this AI step; Career Companion must check it';

/**
 * Refusals restore the claim; no answer in time uses it and is tried again; unusable outcomes are
 * held; an error we cannot sort is our own bug: it fails, is never tried again by itself and is
 * never taken for an unknown outcome.
 */
async function recordOutcome(
  tx: Prisma.TransactionClient,
  failure: ProviderFailure | null,
  call: FailedCall,
): Promise<FailureOutcome> {
  const { access, existing, now, modelId } = call;
  const kind = failure?.kind;
  if (failure && isRefusal(kind)) {
    // Refused before any work was done: the claim is released and the attempt is not charged.
    await tx.aIOperation.updateMany({
      where: { id: existing.id, status: 'PROCESSING' },
      data: {
        status: existing.status,
        attempts: { decrement: 1 },
        errorCode: kind,
        retryAfter: null,
      },
    });
    const resumesAt = await noteProviderFailure(tx, access, kind, now, {
      modelId,
      retryAfterMs: failure.retryAfterMs,
      quotaScope: failure.quotaScope,
    });
    const next = resumesAt ? 'paused' : 'waiting_for_user';
    return { thrown: new AIAccessError(kind, resumesAt), resumesAt, next };
  }
  if (failure && (kind === 'INVALID_OUTPUT' || kind === 'INVALID_REQUEST')) {
    await tx.aIOperation.update({
      where: { id: existing.id },
      data: { status: 'FAILED', errorCode: kind },
    });
    const thrown =
      kind === 'INVALID_OUTPUT'
        ? new SchemaValidationFailure(failure.message, 'Structured response failed validation')
        : new TerminalAIError(failure.message);
    return { thrown, resumesAt: null, next: 'held' };
  }
  if (kind === 'OUTCOME_UNKNOWN') return noAnswerInTime(tx, call);
  await tx.aIOperation.update({
    where: { id: existing.id },
    data: { status: 'FAILED', errorCode: 'UNCLASSIFIED' },
  });
  return { thrown: new TerminalAIError(OWN_ERROR_MESSAGE), resumesAt: null, next: 'held' };
}

/**
 * No answer in time: the attempt is used, and AI pauses as for a busy provider. With attempts left
 * the email waits and is tried again by itself when the pause ends; after the last one it waits
 * for the user's OK.
 */
async function noAnswerInTime(
  tx: Prisma.TransactionClient,
  call: FailedCall,
): Promise<FailureOutcome> {
  const { access, existing, now, modelId } = call;
  await tx.aIOperation.update({
    where: { id: existing.id },
    data: { status: 'RETRYABLE', errorCode: 'OUTCOME_UNKNOWN' },
  });
  const resumesAt = await noteProviderFailure(tx, access, 'OUTCOME_UNKNOWN', now, { modelId });
  if (existing.attempts + 1 >= MAX_ATTEMPTS + existing.approvedRetries)
    return { thrown: new AIOutcomeUnknownError(), resumesAt, next: 'held' };
  return {
    thrown: new AIAccessError('PROVIDER_BUSY', resumesAt),
    resumesAt,
    next: 'retry_scheduled',
  };
}
