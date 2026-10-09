/**
 * An expected failure the API reports to the user: not found, conflict, not allowed or invalid.
 * Services throw it; the central handler (`middleware/error.ts`) sends its status and
 * `{ error: { code, message, details? } }`. Never put keys, tokens or email content in it.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** The message for a change that does not fit the saved state any more. */
export const CHANGE_REJECTED =
  'This change could not be saved. Refresh and review the current state.';
