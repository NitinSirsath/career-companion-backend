/**
 * Base of every AI-layer error. Messages are application-written; there is deliberately no
 * `cause`, so an original provider or SDK error can never travel with it into logs or storage.
 */
export class AIProviderError extends Error {
  public operationStage?: string;
  constructor(
    message: string,
    public readonly isRetryable: boolean,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}

export class RetryableAIError extends AIProviderError {
  constructor(message: string) {
    super(message, true);
    this.name = 'RetryableAIError';
  }
}

export class TerminalAIError extends AIProviderError {
  constructor(message: string) {
    super(message, false);
    this.name = 'TerminalAIError';
  }
}

export class SchemaValidationFailure extends TerminalAIError {
  constructor(
    message: string,
    public readonly validationErrors: unknown,
  ) {
    super(message);
    this.name = 'SchemaValidationFailure';
  }
}

/** An operation's outcome is unknown (timeout, lost connection): held, never replayed. */
export class AIOutcomeUnknownError extends TerminalAIError {
  constructor() {
    super('AI provider outcome unknown; reconciliation required');
    this.name = 'OutcomeUnknown';
  }
}

// ─── Provider failure vocabulary (BYO AI plan §3.3, §3.6) ──────────────────

/**
 * Career Companion's classification of any provider failure. Access kinds are refusals made
 * before any work was done; OUTCOME_UNKNOWN may have been processed and charged.
 */
export type FailureKind =
  | 'KEY_REJECTED'
  | 'ACCOUNT_OR_BILLING'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'OUTCOME_UNKNOWN'
  | 'INVALID_OUTPUT'
  | 'INVALID_REQUEST';

export const ACCESS_FAILURE_KINDS = ['KEY_REJECTED', 'ACCOUNT_OR_BILLING', 'MODEL_UNAVAILABLE'] as const;

const FAILURE_MESSAGES: Record<FailureKind, string> = {
  KEY_REJECTED: 'AI provider rejected the API key',
  ACCOUNT_OR_BILLING: 'AI provider refused the request for this account',
  MODEL_UNAVAILABLE: 'AI model is not available to this key',
  RATE_LIMITED: 'AI provider rejected request; retry after cooldown',
  OUTCOME_UNKNOWN: 'AI provider outcome unknown; reconciliation required',
  INVALID_OUTPUT: 'AI provider returned malformed structured data',
  INVALID_REQUEST: 'AI provider rejected request',
};

const PROVIDER_CODE = /^[A-Za-z_]{2,64}$/;

/**
 * Thrown by provider adapters and the capability layer only, and converted at the operation
 * boundary. Carries a fixed application message, never provider text and never the original
 * error as a cause: provider messages can echo the key or email content.
 */
export class ProviderFailure extends AIProviderError {
  readonly status?: number;
  /** Allowlisted provider token (for example RESOURCE_EXHAUSTED); never free text. */
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
  readonly usage?: { inputTokens: number | null; outputTokens: number | null };

  constructor(
    readonly kind: FailureKind,
    details: {
      message?: string;
      status?: number;
      providerCode?: string;
      retryAfterMs?: number;
      usage?: { inputTokens: number | null; outputTokens: number | null };
    } = {},
  ) {
    super(details.message ?? FAILURE_MESSAGES[kind], kind === 'RATE_LIMITED');
    this.name = 'ProviderFailure';
    this.status = details.status;
    this.providerCode =
      details.providerCode && PROVIDER_CODE.test(details.providerCode) ? details.providerCode : undefined;
    this.retryAfterMs = details.retryAfterMs;
    this.usage = details.usage;
  }
}

// ─── AI access (ADR-0001 decisions 7–9) ────────────────────────────────────

export type AccessReason =
  | 'NOT_SET_UP'
  | 'KEY_REJECTED'
  | 'ACCOUNT_OR_BILLING'
  | 'MODEL_UNAVAILABLE'
  | 'PROVIDER_UNSUPPORTED'
  | 'KEY_UNREADABLE'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'SAFETY_LIMIT'
  | 'PAUSED';

/**
 * The user's AI work cannot run now. A waiting condition, not a processing failure: the email
 * stays PENDING, the job is acknowledged, and no email or operation attempt is used.
 */
export class AIAccessError extends AIProviderError {
  constructor(
    readonly reason: AccessReason,
    readonly resumesAt: Date | null = null,
  ) {
    super('AI access is not available', false);
    this.name = 'AIAccessError';
  }
}
