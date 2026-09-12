export class AIProviderError extends Error {
  constructor(message: string, public readonly isRetryable: boolean, public readonly cause?: unknown) {
    super(message);
    this.name = 'AIProviderError';
  }
}

export class RetryableAIError extends AIProviderError {
  constructor(message: string, cause?: unknown) {
    super(message, true, cause);
    this.name = 'RetryableAIError';
  }
}

export class TerminalAIError extends AIProviderError {
  constructor(message: string, cause?: unknown) {
    super(message, false, cause);
    this.name = 'TerminalAIError';
  }
}

export class SchemaValidationFailure extends TerminalAIError {
  constructor(message: string, public readonly validationErrors: unknown) {
    super(message);
    this.name = 'SchemaValidationFailure';
  }
}
