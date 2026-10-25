import { prisma } from '../../db/prisma';
import { logEvent, logWarn } from '../../utils/log';
import { resolveAIAccess, type AIAccess } from './access';
import type { AIContract, AIResult } from './contracts';
import {
  AIAccessError,
  ProviderFailure,
  SchemaValidationFailure,
  TerminalAIError,
  isRefusal,
} from './errors';
import { failureRecord } from './failures';
import {
  afterProviderFailure,
  noteProviderFailure,
  noteProviderSuccess,
  recordTokens,
  reserveUserCall,
} from './usage';

export interface UserCallRequest<T> {
  userId: string;
  /** For the logs: what the call is for, such as `reply-read`. */
  purpose: string;
  contract: Pick<AIContract<T>, 'version' | 'schema' | 'role'>;
  call: (access: AIAccess) => Promise<AIResult<T>>;
}

/**
 * One AI call for the user that belongs to no received mail: reading the user's own reply, or
 * writing a draft. It keeps the same rules as a mail's call, without its ledger: the user's AI
 * access, the model's pause and the daily safety limit come first and use no call; the call
 * counts toward the limit; a refusal or no answer in time pauses the model as for a mail. The
 * caller sees AIAccessError (with when it may work again) or the failure, and decides on a retry.
 * Nothing of the call's input or answer is logged.
 */
export async function runUserCall<T>(
  request: UserCallRequest<T>,
): Promise<{ data: T; provider: string; model: string }> {
  const { userId, purpose, contract } = request;
  const access = await resolveAIAccess(userId);
  const model = access.models[contract.role];
  const startedAt = new Date();
  await prisma.$transaction((tx) =>
    reserveUserCall(tx, { userId, provider: access.provider, model: model.id }, startedAt),
  );
  const fields = {
    userId,
    operation: purpose,
    version: contract.version,
    provider: access.provider,
    model: model.id,
  };
  logEvent('ai_call_started', fields);
  let result: AIResult<T>;
  let data: T;
  try {
    result = await request.call(access);
    await recordTokens(userId, startedAt, result.usage);
    data = contract.schema.parse(result.data);
  } catch (err) {
    throw await failed(err, {
      access,
      modelId: model.id,
      timeoutMs: model.timeoutMs,
      startedAt,
      fields,
    });
  }
  await noteProviderSuccess(access, model.id);
  logEvent('ai_call_completed', {
    ...fields,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    durationMs: Date.now() - startedAt.getTime(),
  });
  return { data, provider: access.provider, model: model.id };
}

interface FailedUserCall {
  access: AIAccess;
  modelId: string;
  timeoutMs: number;
  startedAt: Date;
  fields: Record<string, string>;
}

/** Records the failure on the model's or the user's access state, and returns what to throw. */
async function failed(err: unknown, call: FailedUserCall): Promise<unknown> {
  const failedAt = new Date();
  const failure = err instanceof ProviderFailure ? err : null;
  if (failure?.usage) await recordTokens(call.access.userId, call.startedAt, failure.usage);
  logWarn('ai_call_failed', {
    ...call.fields,
    kind: failure?.kind ?? 'UNCLASSIFIED',
    failureCause: failure?.failureCause ?? 'UNCLASSIFIED',
    status: failure?.status,
    durationMs: failedAt.getTime() - call.startedAt.getTime(),
  });
  if (!failure) return err;
  const kind = failure.kind;
  if (isRefusal(kind) || kind === 'OUTCOME_UNKNOWN') {
    const record = failureRecord(err, {
      provider: call.access.provider,
      model: call.modelId,
      startedAt: call.startedAt,
      failedAt,
      timeoutMs: call.timeoutMs,
    });
    const resumesAt = await prisma.$transaction((tx) =>
      noteProviderFailure(tx, call.access, kind, failedAt, {
        modelId: call.modelId,
        retryAfterMs: failure.retryAfterMs,
        quotaScope: failure.quotaScope,
        failure: record,
      }),
    );
    await afterProviderFailure(call.access, resumesAt);
    return new AIAccessError(
      kind === 'OUTCOME_UNKNOWN' ? 'PROVIDER_BUSY' : kind,
      resumesAt,
      record,
    );
  }
  if (kind === 'INVALID_OUTPUT')
    return new SchemaValidationFailure(failure.message, 'Structured response failed validation');
  return new TerminalAIError(failure.message);
}
