import { AIOperation, Prisma } from '@prisma/client';
import type { AIFailure } from '../../contracts/ai';
import { prisma } from '../../db/prisma';
import { AI_CATALOG, AIRole } from '../../contracts/aiCatalog';
import type { AIAccess } from './access';
import { AIContract, AIResult, RELEVANCE_BATCH_VERSIONS } from './contracts';
import {
  AccessReason,
  AIAccessError,
  AIOutcomeUnknownError,
  AIProviderError,
  ProviderFailure,
  RetryableAIError,
  SchemaValidationFailure,
  TerminalAIError,
  isRefusal,
} from './errors';
import { failureRecord } from './failures';
import {
  blockingPause,
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
 * - The claim reserves one call against the user's daily safety limit and respects the pause of
 *   the model it calls. One user's limit or pause never affects another user, and one model's
 *   pause never stops another model.
 * - A refusal (key, account, model, rate limit, busy provider) releases the claim and restores
 *   the attempt: it was rejected before any work was done. The user's access state records it.
 * - No answer in time uses the attempt and pauses the model as for a busy provider; the email
 *   waits.
 * - A claim no live job can hold goes back to waiting, its attempt used.
 * - Each user approval (`approvedRetries`) permits exactly one call beyond MAX_ATTEMPTS.
 * - While the detailed model is paused, the fast model takes the detailed steps (same key). When
 *   the detailed model pauses during this call, the fast model takes the step at once.
 */
export async function runOperation<T>(request: OperationRequest<T>): Promise<OperationResult<T>> {
  try {
    return await runOnce(request);
  } catch (err) {
    if (!(await fallsBack(err, request))) throw err;
    return runOnce(request);
  }
}

const PAUSE_REASONS: readonly AccessReason[] = ['PROVIDER_BUSY', 'RATE_LIMITED'];

/** True when the call just paused the detailed model and the fast model can take the step now. */
async function fallsBack<T>(err: unknown, request: OperationRequest<T>): Promise<boolean> {
  if (!(err instanceof AIAccessError) || !PAUSE_REASONS.includes(err.reason)) return false;
  if (request.contract.role !== 'detailed') return false;
  const access = await request.access();
  // The test mail of "Read waiting mails now" tests the paused model itself.
  const pause = await prisma.aIModelPause.findUnique({
    where: { userId_model: { userId: access.userId, model: access.models.detailed.id } },
    select: { testEmailId: true },
  });
  if (pause?.testEmailId === request.emailId) return false;
  return (await accessForCall(access, 'detailed', request.emailId)) !== access;
}

/** The access for one call: while the detailed model is paused, the fallback with the fast one. */
async function accessForCall(access: AIAccess, role: AIRole, emailId: string): Promise<AIAccess> {
  const { fallback } = access;
  if (role !== 'detailed' || !fallback) return access;
  const now = new Date();
  const paused = (model: string) =>
    blockingPause(prisma, { userId: access.userId, model, emailId }, now);
  if (!(await paused(access.models.detailed.id))) return access;
  if (await paused(fallback.models.detailed.id)) return access;
  return fallback;
}

async function runOnce<T>(request: OperationRequest<T>): Promise<OperationResult<T>> {
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

  const resolved = await request.access();
  const access = await accessForCall(resolved, contract.role, emailId);
  const model = access.models[contract.role];
  if (access !== resolved)
    logEvent('ai_fallback_used', {
      userId,
      emailId,
      operation,
      version,
      pausedModel: resolved.models[contract.role].id,
      model: model.id,
    });
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
  await noteProviderSuccess(access, model.id);
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
  // No answer came for that try; what an earlier try answered is no longer its last failure.
  const released = await prisma.aIOperation.updateMany({
    where: { id: op.id, status: 'PROCESSING', startedAt: op.startedAt },
    data: { status: 'RETRYABLE', errorCode: 'OUTCOME_UNKNOWN', lastFailure: Prisma.DbNull },
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
          triedAt: { push: now },
          errorCode: null,
          provider: call.provider,
          model: call.model,
        },
      });
      if (claim.count !== 1) throw new RetryableAIError('AI operation not ready');
      await reserveUserCall(tx, { userId, model: call.model, emailId }, now);
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
    'id' | 'status' | 'emailId' | 'version' | 'attempts' | 'approvedRetries' | 'triedAt'
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
    providerRequestId: failure?.providerRequestId,
    providerMessage: failure?.providerMessage,
    quotaScope: failure?.quotaScope,
    retryAfterMs: failure?.retryAfterMs,
    stopReason: failure?.stopReason,
    durationMs: outcome.durationMs,
    timeoutMs: call.timeoutMs,
    result: outcome.result,
    resumesAt: outcome.resumesAt ?? undefined,
  };
  if (failure) logWarn('ai_call_failed', fields);
  else logError('ai_call_failed', fields, err);
}

/**
 * Records a failed call on the ledger and the model's or the user's access state, logs it, and
 * returns the error the caller sees.
 */
async function recordFailure(err: unknown, call: FailedCall): Promise<unknown> {
  // A pause is counted from the failure, not from the start of the call.
  const failedAt = new Date();
  const durationMs = failedAt.getTime() - call.now.getTime();
  if (err instanceof ProviderFailure && err.usage)
    await recordTokens(call.access.userId, call.now, err.usage);
  const failure = sortedFailure(err);
  const { existing } = call;
  const record = failureRecord(err, {
    provider: call.access.provider,
    model: call.modelId,
    startedAt: call.now,
    failedAt,
    timeoutMs: call.timeoutMs,
    // A refusal gives its try back.
    attempt: isRefusal(failure?.kind)
      ? undefined
      : { used: existing.attempts + 1, max: MAX_ATTEMPTS + existing.approvedRetries },
  });
  const outcome = await prisma.$transaction((tx) =>
    recordOutcome(tx, failure, call, { failedAt, record }),
  );
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
  { failedAt, record }: { failedAt: Date; record: AIFailure },
): Promise<FailureOutcome> {
  const { access, existing, modelId } = call;
  const kind = failure?.kind;
  if (failure && isRefusal(kind)) {
    // Refused before any work was done: the claim is released and the attempt is not charged.
    await tx.aIOperation.updateMany({
      where: { id: existing.id, status: 'PROCESSING' },
      data: {
        status: existing.status,
        attempts: { decrement: 1 },
        triedAt: existing.triedAt,
        errorCode: kind,
        lastFailure: record,
        retryAfter: null,
      },
    });
    const resumesAt = await noteProviderFailure(tx, access, kind, failedAt, {
      modelId,
      emailId: existing.emailId,
      retryAfterMs: failure.retryAfterMs,
      quotaScope: failure.quotaScope,
      failure: record,
    });
    const next = resumesAt ? 'paused' : 'waiting_for_user';
    return { thrown: new AIAccessError(kind, resumesAt, record), resumesAt, next };
  }
  if (failure && (kind === 'INVALID_OUTPUT' || kind === 'INVALID_REQUEST')) {
    await tx.aIOperation.update({
      where: { id: existing.id },
      data: { status: 'FAILED', errorCode: kind, lastFailure: record },
    });
    const thrown =
      kind === 'INVALID_OUTPUT'
        ? new SchemaValidationFailure(failure.message, 'Structured response failed validation')
        : new TerminalAIError(failure.message);
    return { thrown, resumesAt: null, next: 'held' };
  }
  if (kind === 'OUTCOME_UNKNOWN') return noAnswerInTime(tx, call, { failedAt, record });
  await tx.aIOperation.update({
    where: { id: existing.id },
    data: { status: 'FAILED', errorCode: 'UNCLASSIFIED', lastFailure: record },
  });
  return { thrown: new TerminalAIError(OWN_ERROR_MESSAGE), resumesAt: null, next: 'held' };
}

/**
 * No answer in time: the attempt is used, and the model pauses as for a busy provider. With
 * attempts left the email waits and is tried again by itself when the pause ends; after the last
 * one it waits for the user's OK.
 */
async function noAnswerInTime(
  tx: Prisma.TransactionClient,
  call: FailedCall,
  { failedAt, record }: { failedAt: Date; record: AIFailure },
): Promise<FailureOutcome> {
  const { access, existing, modelId } = call;
  await tx.aIOperation.update({
    where: { id: existing.id },
    data: { status: 'RETRYABLE', errorCode: 'OUTCOME_UNKNOWN', lastFailure: record },
  });
  const resumesAt = await noteProviderFailure(tx, access, 'OUTCOME_UNKNOWN', failedAt, {
    modelId,
    emailId: existing.emailId,
    failure: record,
  });
  if (existing.attempts + 1 >= MAX_ATTEMPTS + existing.approvedRetries)
    return { thrown: new AIOutcomeUnknownError(), resumesAt, next: 'held' };
  return {
    thrown: new AIAccessError('PROVIDER_BUSY', resumesAt, record),
    resumesAt,
    next: 'retry_scheduled',
  };
}
