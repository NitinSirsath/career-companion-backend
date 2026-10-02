import { AIOperationStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import type { AIAccess } from './access';
import type { AIContract, AIResult } from './contracts';
import {
  AIAccessError,
  AIOutcomeUnknownError,
  AIProviderError,
  ProviderFailure,
  RetryableAIError,
  SchemaValidationFailure,
  TerminalAIError,
} from './errors';
import { noteProviderFailure, noteProviderSuccess, recordTokens, reserveUserCall } from './usage';

export const MAX_ATTEMPTS = 3;

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
 * results are reused; a call with an unknown outcome is never replayed automatically.
 *
 * Per-user rules (ADR-0001 decisions 7–10):
 * - Access is resolved before the claim, so waiting for AI uses no attempt and no call.
 * - The claim reserves one call against the user's daily safety limit and respects the user's
 *   provider cooldown. One user's limit or cooldown never affects another user.
 * - A refusal (key, account, model, rate limit) releases the claim and restores the attempt: it
 *   was rejected before any work was done. The user's access state records it.
 * - Each user approval (`approvedRetries`) permits exactly one call beyond MAX_ATTEMPTS.
 */
export async function runOperation<T>(request: OperationRequest<T>): Promise<OperationResult<T>> {
  const { userId, emailId, operation, contract } = request;
  const version = contract.version;
  const owned = await prisma.email.findFirst({
    where: { id: emailId, userId },
    select: { id: true },
  });
  if (!owned) throw new TerminalAIError('Email unavailable');
  const key = { emailId, operation, version };
  await prisma.aIOperation.createMany({ data: [key], skipDuplicates: true });
  const existing = await prisma.aIOperation.findUniqueOrThrow({
    where: { emailId_operation_version: key },
  });
  if (existing.status === 'COMPLETED') {
    console.log(JSON.stringify({ event: 'ai_result_reused', emailId, operation, version }));
    return {
      data: contract.schema.parse(existing.result),
      provider: existing.provider,
      model: existing.model,
    };
  }
  if (
    ['PROCESSING', 'UNKNOWN', 'FAILED'].includes(existing.status) ||
    existing.attempts >= MAX_ATTEMPTS + existing.approvedRetries
  ) {
    console.warn(
      JSON.stringify({
        event: 'ai_call_blocked',
        emailId,
        operation,
        version,
        status: existing.status,
        attempts: existing.attempts,
      }),
    );
    throw new TerminalAIError(`AI operation requires review: ${existing.status}`);
  }

  const access = await request.access();
  const model = access.models[contract.role];
  const now = new Date();
  await prisma.$transaction(async (tx) => {
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
        provider: access.provider,
        model: model.id,
      },
    });
    if (claim.count !== 1) throw new RetryableAIError('AI operation not ready');
    await reserveUserCall(tx, userId, now);
  }).catch((err: unknown) => {
    if (err instanceof AIAccessError)
      console.log(
        JSON.stringify({ event: 'ai_call_deferred', userId, emailId, operation, version, reason: err.reason }),
      );
    if (err instanceof AIProviderError) err.operationStage = operation;
    throw err;
  });
  console.log(
    JSON.stringify({
      event: 'ai_call_started',
      userId,
      emailId,
      operation,
      version,
      attempt: existing.attempts + 1,
      provider: access.provider,
      model: model.id,
    }),
  );

  let result: AIResult<T>;
  let data: T;
  try {
    result = await request.call(access);
    await recordTokens(userId, now, result.usage);
    data = contract.schema.parse(result.data);
  } catch (err) {
    throw await recordFailure(err, { access, existing, operation, now, modelId: model.id });
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
  console.log(
    JSON.stringify({
      event: 'ai_call_completed',
      userId,
      emailId,
      operation,
      version,
      provider: access.provider,
      model: model.id,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      durationMs: Date.now() - now.getTime(),
    }),
  );
  return { data, provider: access.provider, model: model.id };
}

/**
 * Records a failed call on the ledger and the user's access state, and returns the error the
 * caller sees. Refusals restore the claim; uncertain and unusable outcomes are held.
 */
async function recordFailure(
  err: unknown,
  context: {
    access: AIAccess;
    existing: { id: string; status: AIOperationStatus };
    operation: string;
    now: Date;
    modelId: string;
  },
): Promise<unknown> {
  const { access, existing, operation, now, modelId } = context;
  const failure = err instanceof ProviderFailure ? err : null;
  const kind = failure?.kind;
  if (failure?.usage) await recordTokens(access.userId, now, failure.usage);
  let thrown: unknown;
  await prisma.$transaction(async (tx) => {
    if (kind === 'KEY_REJECTED' || kind === 'ACCOUNT_OR_BILLING' || kind === 'MODEL_UNAVAILABLE' || kind === 'RATE_LIMITED') {
      // Refused before any work was done: the claim is released and the attempt is not charged.
      await tx.aIOperation.updateMany({
        where: { id: existing.id, status: 'PROCESSING' },
        data: { status: existing.status, attempts: { decrement: 1 }, errorCode: kind, retryAfter: null },
      });
      const resumesAt = await noteProviderFailure(tx, access, kind, now, {
        modelId,
        retryAfterMs: failure!.retryAfterMs,
      });
      thrown = new AIAccessError(kind, resumesAt);
      return;
    }
    if (kind === 'INVALID_OUTPUT' || kind === 'INVALID_REQUEST') {
      await tx.aIOperation.update({ where: { id: existing.id }, data: { status: 'FAILED', errorCode: kind } });
      thrown =
        kind === 'INVALID_OUTPUT'
          ? new SchemaValidationFailure(failure!.message, 'Structured response failed validation')
          : new TerminalAIError(failure!.message);
      return;
    }
    // Timeout, lost connection or anything unclassified may have been processed and charged:
    // held, never replayed automatically.
    await tx.aIOperation.update({
      where: { id: existing.id },
      data: { status: 'UNKNOWN', errorCode: kind ?? 'OutcomeUnknown' },
    });
    if (kind === 'OUTCOME_UNKNOWN') {
      // A short per-user pause keeps an outage from holding one uncertain call per email.
      await noteProviderFailure(tx, access, 'OUTCOME_UNKNOWN', now);
      thrown = new AIOutcomeUnknownError();
    } else {
      thrown = err;
    }
  });
  if (thrown instanceof AIProviderError) thrown.operationStage = operation;
  console.warn(
    JSON.stringify({
      event: 'ai_call_failed',
      userId: access.userId,
      operation,
      provider: access.provider,
      model: modelId,
      kind: kind ?? 'UNCLASSIFIED',
      status: failure?.status,
      providerCode: failure?.providerCode,
    }),
  );
  return thrown;
}
