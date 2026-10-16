/**
 * The exact error (plan §4): what a failed AI call was, as Career Companion keeps and shows it. The
 * status, the provider's short code, the model and the times we measured. Only allowlisted tokens:
 * never the provider's message text, which can echo the key or mail content.
 */
import type { Prisma } from '@prisma/client';
import { AIFailure, AIFailureKind, AIFailureSchema, AIModelPause } from '../../contracts/ai';
import type { ModelPause } from './access';
import { FailureKind, ProviderFailure } from './errors';

/** A failure kind in the screens' words: no answer in time is never an "unknown outcome". */
export const shownKind = (kind: FailureKind): AIFailureKind =>
  kind === 'OUTCOME_UNKNOWN' ? 'NO_ANSWER_IN_TIME' : kind;

/** One call as measured: where it went, when it started and failed, and the time limit it had. */
export interface MeasuredCall {
  provider: string;
  model: string;
  startedAt: Date;
  failedAt: Date;
  timeoutMs: number;
  /** The try the call used, and how many the step may use; absent when it used none. */
  attempt?: { used: number; max: number };
}

/** What the provider or the connection said: allowlisted tokens only. */
function providerDetails(failure: ProviderFailure | null) {
  // An error the provider adapter could not sort is an error in Career Companion's own code.
  if (!failure || failure.failureCause === 'UNCLASSIFIED')
    return {
      kind: 'INTERNAL_ERROR' as const,
      cause: 'UNCLASSIFIED' as const,
      httpStatus: null,
      providerCode: null,
      quotaScope: null,
      freeTier: false,
      networkCode: null,
      stopReason: null,
    };
  return {
    kind: shownKind(failure.kind),
    cause: failure.failureCause,
    httpStatus: failure.status ?? null,
    providerCode: failure.providerCode ?? null,
    quotaScope: failure.quotaScope ?? null,
    freeTier: failure.freeTier ?? false,
    networkCode: failure.networkCode ?? null,
    stopReason: failure.stopReason ?? null,
  };
}

/** The failure of one call, as kept and shown. */
export function failureRecord(err: unknown, call: MeasuredCall): AIFailure {
  return {
    ...providerDetails(err instanceof ProviderFailure ? err : null),
    provider: call.provider,
    model: call.model,
    at: call.failedAt.toISOString(),
    waitedMs: call.failedAt.getTime() - call.startedAt.getTime(),
    timeoutMs: call.timeoutMs,
    attempt: call.attempt ? call.attempt.used : null,
    maxAttempts: call.attempt ? call.attempt.max : null,
  };
}

/**
 * A model's pause as the screens get it: why, until when, and its test mail. The reason is the
 * stored one (no answer in time pauses as PROVIDER_BUSY); the failure says what really happened.
 */
export const shownPause = (pause: ModelPause): AIModelPause => ({
  model: pause.model,
  roles: pause.roles,
  reason: pause.reason,
  resumesAt: pause.resumesAt.toISOString(),
  failure: pause.failure,
  test: pause.test && {
    emailId: pause.test.emailId,
    startedAt: pause.test.startedAt?.toISOString() ?? null,
    result: pause.test.result ? shownKind(pause.test.result as FailureKind) : null,
  },
});

/** A kept failure; null for a row from before failures were kept. */
export function readFailure(value: Prisma.JsonValue | null | undefined): AIFailure | null {
  const parsed = AIFailureSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The latest of the given failures. */
export const latestFailure = (failures: (AIFailure | null)[]): AIFailure | null =>
  failures.reduce<AIFailure | null>(
    (latest, failure) => (failure && (!latest || failure.at > latest.at) ? failure : latest),
    null,
  );
