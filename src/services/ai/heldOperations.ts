/**
 * Held AI operations and the user's one-attempt approval (ADR-0001 decision 10; plan §3.14).
 *
 * An operation is held when its outcome may already exist (PROCESSING, UNKNOWN), when it returned
 * unusable output or was rejected (FAILED), or when its attempts are used up. Held operations are
 * not tried again by themselves. For uncertain or unusable outcomes, and after the last automatic
 * try with no answer in time, the user who pays may approve exactly one more call, accepting a
 * possible duplicate charge. Engineering failures (invalid requests, our own errors, legacy
 * terminal errors) stay with the operator.
 */
import type { AIOperationStatus } from '@prisma/client';
import { RELEVANCE_BATCH_VERSIONS } from './contracts';
import { MAX_ATTEMPTS, isStaleClaim } from './operations';
import { TRIAGE_STALE_PROCESSING_MS } from './triage';

export type HoldReason = 'OUTCOME_UNKNOWN' | 'INVALID_OUTPUT' | 'ATTEMPTS_EXHAUSTED';

export interface LedgerRow {
  version: string;
  status: AIOperationStatus;
  attempts: number;
  approvedRetries: number;
  errorCode: string | null;
  startedAt: Date | null;
}

const INVALID_OUTPUT_CODES = ['INVALID_OUTPUT', 'SchemaValidationFailure'];

/** A batch claim no live run can hold: its outcome is unknown, so the user may approve a call. */
function heldBatchClaim(op: LedgerRow, now: Date): { approvable: HoldReason | null } {
  const stale =
    op.startedAt !== null && now.getTime() - op.startedAt.getTime() > TRIAGE_STALE_PROCESSING_MS;
  return { approvable: stale ? 'OUTCOME_UNKNOWN' : null };
}

/** The email's operations that are not tried again by themselves, each with its hold. */
export function heldOperations<Op extends LedgerRow>(
  email: {
    aiProcessingResult: { processingStatus: string } | null;
    aiOperations: Op[];
  },
  now: Date,
): { holds: { op: Op; approvable: HoldReason | null }[]; legacyPartial: boolean } {
  const holds = email.aiOperations.flatMap((op) => {
    const hold = holdOf(op, now);
    return hold ? [{ op, approvable: hold.approvable }] : [];
  });
  // A result from before the ledger, left unfinished: only the operator can finish it.
  const legacyPartial =
    !!email.aiProcessingResult &&
    email.aiProcessingResult.processingStatus !== 'COMPLETED' &&
    email.aiOperations.length === 0;
  return { holds, legacyPartial };
}

/** null: not held. `approvable: null`: held for the operator only. */
export function holdOf(op: LedgerRow, now: Date): { approvable: HoldReason | null } | null {
  if (op.status === 'COMPLETED') return null;
  if (op.status === 'UNKNOWN') return { approvable: 'OUTCOME_UNKNOWN' };
  if (op.status === 'FAILED')
    return {
      approvable:
        op.errorCode && INVALID_OUTPUT_CODES.includes(op.errorCode) ? 'INVALID_OUTPUT' : null,
    };
  if (op.status === 'PROCESSING' && RELEVANCE_BATCH_VERSIONS.includes(op.version))
    return heldBatchClaim(op, now);
  // A per-email claim no live job can hold counts as waiting, its attempt used: the next job
  // releases it.
  if (op.status === 'PROCESSING' && !isStaleClaim(op, now)) return { approvable: null };
  return op.attempts >= MAX_ATTEMPTS + op.approvedRetries
    ? { approvable: 'ATTEMPTS_EXHAUSTED' }
    : null;
}
