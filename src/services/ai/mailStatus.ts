/**
 * A mail's AI status for the screens (plan §4): why a waiting or stopped mail is not read yet, the
 * exact failure, its tries and what happens next. It comes from the stored kind and the live
 * pauses, never from stored text, so older mails get plain reasons too.
 */
import type { AIOperationStatus, EmailProcessingState, Prisma } from '@prisma/client';
import type { AISettingsResponse } from '../../contracts/ai';
import type { AIRole } from '../../contracts/aiCatalog';
import type { EmailAIReason, EmailAIStatus } from '../../contracts/email';
import { prisma } from '../../db/prisma';
import { ModelPause, UserAccess, blockingPause } from './access';
import { readFailure } from './failures';
import { HoldReason, heldOperations } from './heldOperations';
import { nextRole } from './offer';
import { MAX_ATTEMPTS } from './operations';

/** The ledger fields a mail's status reads. */
export const STATUS_STEP_SELECT = {
  operation: true,
  version: true,
  status: true,
  attempts: true,
  approvedRetries: true,
  errorCode: true,
  startedAt: true,
  provider: true,
  model: true,
  lastFailure: true,
  triedAt: true,
} satisfies Prisma.AIOperationSelect;

/** The mail fields a mail's status reads. */
export const STATUS_MAIL_SELECT = {
  id: true,
  processingState: true,
  processingErrorCategory: true,
  aiProcessingResult: { select: { processingStatus: true } },
  aiOperations: { select: STATUS_STEP_SELECT },
} satisfies Prisma.EmailSelect;

interface StatusStep {
  operation: string;
  version: string;
  status: AIOperationStatus;
  attempts: number;
  approvedRetries: number;
  errorCode: string | null;
  startedAt: Date | null;
  provider: string | null;
  model: string | null;
  lastFailure: Prisma.JsonValue;
  triedAt: Date[];
}

export interface StatusMail {
  id: string;
  processingState: EmailProcessingState;
  processingErrorCategory: string | null;
  aiProcessingResult: { processingStatus: string } | null;
  aiOperations: StatusStep[];
}

type Operation = EmailAIStatus['step'] & string;
const OPERATION_OF: Record<AIRole, Operation> = { fast: 'classification', detailed: 'extraction' };

/** What a stored error code says, for rows from before the exact failure was kept too. */
const CODE_REASONS: Record<string, EmailAIReason> = {
  OUTCOME_UNKNOWN: 'NO_ANSWER_IN_TIME',
  OutcomeUnknown: 'NO_ANSWER_IN_TIME',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  SchemaValidationFailure: 'INVALID_OUTPUT',
  // The provider's answer left the mail out of its batch.
  BATCH_ITEM_MISSING: 'INVALID_OUTPUT',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNCLASSIFIED: 'INTERNAL_ERROR',
  KEY_REJECTED: 'KEY_REJECTED',
  ACCOUNT_OR_BILLING: 'ACCOUNT_OR_BILLING',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_BUSY: 'PROVIDER_BUSY',
};

/** Reasons that pass by themselves: the mail is tried again when the model's pause ends. */
const WAIT_REASONS: readonly EmailAIReason[] = [
  'RATE_LIMITED',
  'PROVIDER_BUSY',
  'NO_ANSWER_IN_TIME',
  'PROVIDER_UNAVAILABLE',
];

/**
 * Why a step waits or stopped: its kept failure, or for older rows its stored code. A failed batch
 * stores OutcomeUnknown also for an error in our own code; the kept failure says which it was.
 */
function stepReason(step: StatusStep, otherwise: EmailAIReason): EmailAIReason {
  const kept = readFailure(step.lastFailure);
  if (kept) return kept.kind;
  const coded = step.errorCode ? CODE_REASONS[step.errorCode] : undefined;
  if (coded) return coded;
  if (step.status === 'UNKNOWN') return 'NO_ANSWER_IN_TIME';
  return otherwise;
}

/**
 * Why a model's pause holds a mail back. No answer in time pauses the model as for a busy
 * provider; the failure behind the pause says what really happened.
 */
const pauseReason = (pause: ModelPause): EmailAIReason =>
  pause.reason === 'PROVIDER_BUSY' && pause.failure?.kind === 'NO_ANSWER_IN_TIME'
    ? 'NO_ANSWER_IN_TIME'
    : pause.reason;

/** The step's most recent row of an operation that is not done yet. */
const openStep = (mail: StatusMail, operation: Operation) =>
  mail.aiOperations
    .filter((op) => op.operation === operation && op.status !== 'COMPLETED')
    .reduce<StatusStep | null>(
      (latest, op) =>
        latest && (latest.startedAt?.getTime() ?? 0) > (op.startedAt?.getTime() ?? 0) ? latest : op,
      null,
    );

/** The parts that describe the step itself; the step's own failure only when it is the reason. */
function describe(
  step: StatusStep | null,
  operation: Operation,
  reason: EmailAIReason,
): Omit<EmailAIStatus, 'nextTryAt' | 'nextStep'> {
  const status = { reason, step: operation, readNowTest: null };
  if (!step)
    return {
      ...status,
      provider: null,
      model: null,
      failure: null,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      triedAt: [],
    };
  const failure = readFailure(step.lastFailure);
  return {
    ...status,
    provider: step.provider,
    model: step.model,
    failure: failure?.kind === reason ? failure : null,
    attempts: step.attempts,
    maxAttempts: MAX_ATTEMPTS + step.approvedRetries,
    triedAt: step.triedAt.map((at) => at.toISOString()),
  };
}

/** The step's own reason, when it passes by itself (a pause from its own failure). */
function ownWait(step: StatusStep | null): EmailAIReason | null {
  const own = step && stepReason(step, 'INTERNAL_ERROR');
  return own && WAIT_REASONS.includes(own) ? own : null;
}

/**
 * Waiting for the pause of the model the step needs. The step's own failure is the reason only
 * when it is no answer in time (it used a try) or the same kind as the pause; an older failure of
 * another kind is not why the mail waits now. While "Read waiting mails now" tests that model, the
 * test mail says so, and every other mail waits for it.
 */
function pauseStatus(
  mail: StatusMail,
  step: StatusStep | null,
  operation: Operation,
  pause: ModelPause,
): EmailAIStatus {
  const { test } = pause;
  const own = ownWait(step);
  const current = pauseReason(pause);
  const reason = own && (own === 'NO_ANSWER_IN_TIME' || own === current) ? own : current;
  const status = describe(step, operation, reason);
  const base = {
    ...status,
    provider: status.provider ?? pause.failure?.provider ?? null,
    model: pause.model,
    nextTryAt: pause.resumesAt.toISOString(),
  };
  if (!test) return { ...base, nextStep: 'AUTOMATIC_RETRY' };
  if (test.emailId !== mail.id)
    return { ...base, nextStep: 'WAITS_FOR_TEST_MAIL', readNowTest: 'WAITS_FOR_TEST_MAIL' };
  return {
    ...base,
    // The test mail is being tried now, until the model answers.
    nextTryAt: test.result === null ? null : base.nextTryAt,
    nextStep: 'AUTOMATIC_RETRY',
    readNowTest: 'TEST_MAIL',
  };
}

/**
 * A waiting mail: the user's own access comes first, then the pause of the model its next step
 * needs, then Career Companion's daily limit (the plan §3.7 precedence). A mail that waits for
 * nothing any more is read again soon; one that never failed is simply in line (null).
 */
function waitingStatus(mail: StatusMail, access: UserAccess): EmailAIStatus | null {
  const role = nextRole({
    aiOperations: mail.aiOperations.filter((op) => op.operation === 'classification'),
  });
  const operation = OPERATION_OF[role];
  const step = openStep(mail, operation);

  if (access.reason && access.state !== 'READY' && access.reason !== 'SAFETY_LIMIT') {
    const status = describe(step, operation, access.reason);
    return {
      ...status,
      model: access.modelId ?? status.model,
      nextTryAt: null,
      nextStep: access.reason === 'PAUSED' ? 'CAREER_COMPANION' : 'FIX_AI_SETTINGS',
    };
  }
  const pause = blockingPause(access.pauses, [role]);
  if (pause) return pauseStatus(mail, step, operation, pause);
  if (access.reason === 'SAFETY_LIMIT')
    return {
      ...describe(step, operation, 'SAFETY_LIMIT'),
      nextTryAt: access.resumesAt?.toISOString() ?? null,
      nextStep: 'AUTOMATIC_RETRY',
    };
  const waits = ownWait(step);
  if (!waits) return null;
  return { ...describe(step, operation, waits), nextTryAt: null, nextStep: 'AUTOMATIC_RETRY' };
}

/** Why a held step stopped, when its stored code does not say. */
const HOLD_REASONS: Record<HoldReason, EmailAIReason> = {
  OUTCOME_UNKNOWN: 'NO_ANSWER_IN_TIME',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  // The last automatic try got no answer in time.
  ATTEMPTS_EXHAUSTED: 'NO_ANSWER_IN_TIME',
};

/** What a stopped mail's stored category says, when no AI step does (older mails). */
const CATEGORY_REASONS: Record<string, EmailAIReason> = {
  OutcomeUnknown: 'NO_ANSWER_IN_TIME',
  SchemaValidationFailure: 'INVALID_OUTPUT',
  GmailRequestFailed: 'GMAIL_FAILED',
};

/**
 * A stopped mail. A held step the user may approve once more is retried with the user's OK; one
 * held for Career Companion only (our request, our own error, an unfinished older result) is ours
 * to retry. A step the user approved is tried again once the worker picks the mail up. A mail
 * that failed outside the AI steps (Gmail, our own code) can be retried as it is.
 */
function stoppedStatus(mail: StatusMail, now: Date): EmailAIStatus {
  const { holds, legacyPartial } = heldOperations(mail, now);
  const hold = holds.find(({ approvable }) => approvable === null) ?? holds[0];
  if (hold) {
    const { op, approvable } = hold;
    const reason = stepReason(op, approvable ? HOLD_REASONS[approvable] : 'INTERNAL_ERROR');
    return {
      ...describe(op, op.operation === 'extraction' ? 'extraction' : 'classification', reason),
      nextTryAt: null,
      nextStep: approvable ? 'RETRY_WITH_YOUR_OK' : 'CAREER_COMPANION',
    };
  }
  const category = legacyPartial ? null : mail.processingErrorCategory;
  // An approved step whose mail then failed on Gmail or in our own code does not wait for the
  // worker any more.
  const approved =
    category !== 'GmailRequestFailed' &&
    category !== 'ProcessingError' &&
    mail.aiOperations.find(
      (op) =>
        op.status === 'RETRYABLE' &&
        op.approvedRetries > 0 &&
        op.attempts < MAX_ATTEMPTS + op.approvedRetries,
    );
  if (approved)
    return {
      ...describe(
        approved,
        approved.operation === 'extraction' ? 'extraction' : 'classification',
        stepReason(approved, 'NO_ANSWER_IN_TIME'),
      ),
      nextTryAt: null,
      nextStep: 'AUTOMATIC_RETRY',
    };
  const stored = category ? CATEGORY_REASONS[category] : undefined;
  return {
    ...describe(null, 'classification', stored ?? 'INTERNAL_ERROR'),
    step: null,
    nextTryAt: null,
    nextStep: legacyPartial ? 'CAREER_COMPANION' : 'MANUAL_RETRY',
  };
}

/** The AI status of a waiting or stopped mail; null for a mail that is read, being read or in line. */
export function aiStatusOf(mail: StatusMail, access: UserAccess, now: Date): EmailAIStatus | null {
  if (mail.processingState === 'FAILED') return stoppedStatus(mail, now);
  if (mail.processingState === 'PENDING') return waitingStatus(mail, access);
  return null;
}

/** When a stopped mail was last tried: its last counted try, or its last failure. */
const lastTried = (status: EmailAIStatus) => status.triedAt.at(-1) ?? status.failure?.at ?? null;

/**
 * Mails that got no answer in time on their last automatic try: they wait for the user's OK
 * (Manual Retry). A mail Career Companion could not use the answer for is not one of them.
 */
export async function needsYourOk(
  userId: string,
  now: Date,
): Promise<AISettingsResponse['needsYourOk']> {
  const failed = await prisma.email.findMany({
    where: { userId, processingState: 'FAILED' },
    select: STATUS_MAIL_SELECT,
  });
  const held = failed
    .map((mail) => stoppedStatus(mail, now))
    .filter(
      (status) => status.reason === 'NO_ANSWER_IN_TIME' && status.nextStep === 'RETRY_WITH_YOUR_OK',
    );
  const latest = held.reduce<EmailAIStatus | null>(
    (last, status) =>
      last && (lastTried(last) ?? '') >= (lastTried(status) ?? '') ? last : status,
    null,
  );
  return {
    emails: held.length,
    model: latest?.model ?? null,
    lastTriedAt: latest ? lastTried(latest) : null,
    // A batch claim held at once, or an older row, has fewer than 3 tries.
    tries: latest ? Math.max(latest.triedAt.length, latest.attempts) : 0,
  };
}
