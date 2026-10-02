/**
 * Held AI operations and the user's one-attempt approval (ADR-0001 decision 10; plan §3.14).
 *
 * An operation is held when its outcome may already exist (PROCESSING, UNKNOWN), when it returned
 * unusable output or was rejected (FAILED), or when its attempts are used up. Held operations are
 * never replayed automatically. For uncertain or unusable outcomes the user who pays may approve
 * exactly one more call, accepting a possible duplicate charge. Engineering failures (invalid
 * requests, legacy terminal errors) stay with the operator.
 */
import type { AIOperationStatus } from '@prisma/client';
import { MAX_ATTEMPTS } from './operations';

/** A PROCESSING claim older than this cannot belong to a live job (jobs expire after 5 minutes). */
export const STALE_PROCESSING_MS = 15 * 60_000;

export type HoldReason = 'OUTCOME_UNKNOWN' | 'INVALID_OUTPUT' | 'ATTEMPTS_EXHAUSTED';

export interface LedgerRow {
  status: AIOperationStatus;
  attempts: number;
  approvedRetries: number;
  errorCode: string | null;
  startedAt: Date | null;
}

const INVALID_OUTPUT_CODES = ['INVALID_OUTPUT', 'SchemaValidationFailure'];

/** null: not held. `approvable: null`: held for the operator only. */
export function holdOf(op: LedgerRow, now: Date): { approvable: HoldReason | null } | null {
  if (op.status === 'COMPLETED') return null;
  if (op.status === 'UNKNOWN') return { approvable: 'OUTCOME_UNKNOWN' };
  if (op.status === 'FAILED')
    return { approvable: op.errorCode && INVALID_OUTPUT_CODES.includes(op.errorCode) ? 'INVALID_OUTPUT' : null };
  if (op.status === 'PROCESSING')
    return {
      approvable:
        op.startedAt && now.getTime() - op.startedAt.getTime() > STALE_PROCESSING_MS ? 'OUTCOME_UNKNOWN' : null,
    };
  return op.attempts >= MAX_ATTEMPTS + op.approvedRetries ? { approvable: 'ATTEMPTS_EXHAUSTED' } : null;
}
