import { ProviderFailure } from '../../services/ai/errors';
import type { CallOutcome } from './score';

/** Evaluation-only pacing. Never retries an ambiguous or malformed paid-call outcome. */
export async function evaluateCall<T>(
  call: () => Promise<T>,
  options: {
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ value?: T } & Omit<CallOutcome, 'valid' | 'inputTokens' | 'outputTokens'>> {
  const { delayMs = 0, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } =
    options;
  if (delayMs) await sleep(delayMs);
  for (let waits = 0; ; waits++) {
    const started = Date.now();
    try {
      return { value: await call(), latencyMs: Date.now() - started };
    } catch (error) {
      const latencyMs = Date.now() - started;
      if (!(error instanceof ProviderFailure)) return { error: 'UnknownError', latencyMs };
      const requested = error.retryAfterMs;
      const delay =
        requested !== undefined && Number.isFinite(requested) && requested >= 0 ? requested : 30000;
      if (error.kind === 'RATE_LIMITED' && waits < 3 && delay <= 120000) {
        await sleep(delay);
        continue;
      }
      return {
        error: error.kind,
        status: error.status,
        providerCode: error.providerCode,
        retryAfterMs: error.retryAfterMs,
        latencyMs,
      };
    }
  }
}
