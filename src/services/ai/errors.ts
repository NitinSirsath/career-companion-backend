import type { AIFailure } from '../../contracts/ai';

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

/**
 * Reads a setting while AI work runs. A bad value is terminal: a retry cannot fix configuration.
 */
export function aiSetting<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new TerminalAIError(error instanceof Error ? error.message : 'Invalid AI setting');
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

/**
 * No answer in time, and no automatic try left: held until the user's OK. A batch whose outcome is
 * unknown is held at once.
 */
export class AIOutcomeUnknownError extends TerminalAIError {
  constructor() {
    super(FAILURE_MESSAGES.OUTCOME_UNKNOWN);
    this.name = 'OutcomeUnknown';
  }
}

// ─── Provider failure vocabulary (BYO AI plan §3.3, §3.6) ──────────────────

/**
 * Career Companion's classification of any provider failure. Access kinds are refusals made
 * before any work was done, and so are RATE_LIMITED and PROVIDER_BUSY (a short server error, or a
 * request that never left). OUTCOME_UNKNOWN is no answer in time (our timer, Google's 504, or a
 * connection that dropped after sending): it may have been processed and charged.
 */
export type FailureKind =
  | 'KEY_REJECTED'
  | 'ACCOUNT_OR_BILLING'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'PROVIDER_BUSY'
  | 'OUTCOME_UNKNOWN'
  | 'INVALID_OUTPUT'
  | 'INVALID_REQUEST';

/**
 * Where a call failed, logged with each failure: our own timer ran out (TIMEOUT), Google answered
 * that its deadline expired (PROVIDER_DEADLINE, 504), no connection before the request was sent
 * (NETWORK), the connection dropped after it was sent (NETWORK_AFTER_SEND), the provider answered
 * (PROVIDER_ANSWER), or an error we cannot sort, which is our own bug (UNCLASSIFIED).
 */
export type FailureCause =
  | 'TIMEOUT'
  | 'PROVIDER_DEADLINE'
  | 'NETWORK'
  | 'NETWORK_AFTER_SEND'
  | 'PROVIDER_ANSWER'
  | 'UNCLASSIFIED';

export const ACCESS_FAILURE_KINDS = [
  'KEY_REJECTED',
  'ACCOUNT_OR_BILLING',
  'MODEL_UNAVAILABLE',
] as const;

/** Refusals that pass by themselves: the user's AI work pauses and is tried again later. */
export const PAUSE_FAILURE_KINDS = ['RATE_LIMITED', 'PROVIDER_BUSY'] as const;

/** Every refusal made before any work was done: the claim is released and no attempt is used. */
export const REFUSAL_KINDS = [...ACCESS_FAILURE_KINDS, ...PAUSE_FAILURE_KINDS] as const;
export type RefusalKind = (typeof REFUSAL_KINDS)[number];

export const isRefusal = (kind: string | undefined): kind is RefusalKind =>
  kind !== undefined && (REFUSAL_KINDS as readonly string[]).includes(kind);

const FAILURE_MESSAGES: Record<FailureKind, string> = {
  KEY_REJECTED: 'AI provider rejected the API key',
  ACCOUNT_OR_BILLING: 'AI provider refused the request for this account',
  MODEL_UNAVAILABLE: 'AI model is not available to this key',
  RATE_LIMITED: 'AI provider rejected request; retry after cooldown',
  PROVIDER_BUSY: 'AI provider is busy; retry after cooldown',
  OUTCOME_UNKNOWN: 'No clear answer from the AI provider; it is not tried again by itself',
  INVALID_OUTPUT: 'AI provider returned malformed structured data',
  INVALID_REQUEST: 'AI provider rejected request',
};

/** Which of the provider's quotas a rate limit hit. A daily one waits for the provider's reset. */
export type QuotaScope = 'PER_DAY' | 'PER_MINUTE';

const PROVIDER_CODE = /^[A-Za-z_]{2,64}$/;
const NETWORK_CODE =
  /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_[A-Z_]{1,40})$/;

export interface ProviderFailureDetails {
  message?: string;
  status?: number;
  providerCode?: string;
  retryAfterMs?: number;
  quotaScope?: QuotaScope;
  freeTier?: boolean;
  stopReason?: string;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  /** Where the call failed. The provider's answer, unless the adapter says otherwise. */
  failureCause?: FailureCause;
  networkCode?: string;
}

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
  readonly quotaScope?: QuotaScope;
  /** The quota a rate limit hit was the provider's free tier. */
  readonly freeTier?: boolean;
  /** Why the provider stopped an unusable answer (for example MAX_TOKENS); a token, never text. */
  readonly stopReason?: string;
  readonly usage?: { inputTokens: number | null; outputTokens: number | null };
  readonly failureCause: FailureCause;
  /** The failed connection's system or undici code, from a fixed list; never free text. */
  readonly networkCode?: string;

  constructor(
    readonly kind: FailureKind,
    details: ProviderFailureDetails = {},
  ) {
    super(
      details.message ?? FAILURE_MESSAGES[kind],
      (PAUSE_FAILURE_KINDS as readonly string[]).includes(kind),
    );
    this.name = 'ProviderFailure';
    this.status = details.status;
    this.providerCode =
      details.providerCode && PROVIDER_CODE.test(details.providerCode)
        ? details.providerCode
        : undefined;
    this.retryAfterMs = details.retryAfterMs;
    this.quotaScope = details.quotaScope;
    this.freeTier = details.freeTier;
    this.stopReason =
      details.stopReason && PROVIDER_CODE.test(details.stopReason) ? details.stopReason : undefined;
    this.usage = details.usage;
    this.failureCause = details.failureCause ?? 'PROVIDER_ANSWER';
    this.networkCode =
      details.networkCode && NETWORK_CODE.test(details.networkCode)
        ? details.networkCode
        : undefined;
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
  | 'PROVIDER_BUSY'
  | 'PROVIDER_UNAVAILABLE'
  | 'SAFETY_LIMIT'
  | 'PAUSED';

/**
 * The user's AI work cannot run now. A waiting condition, not a processing failure: the email
 * stays PENDING, the job is acknowledged, and no email attempt is used. Only a call with no answer
 * in time has used its operation attempt.
 */
export class AIAccessError extends AIProviderError {
  constructor(
    readonly reason: AccessReason,
    readonly resumesAt: Date | null = null,
    /** The failure behind a model's pause, when it is known. */
    readonly failure: AIFailure | null = null,
  ) {
    super('AI access is not available', false);
    this.name = 'AIAccessError';
  }
}
