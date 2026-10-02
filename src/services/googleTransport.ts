import { google } from 'googleapis';

export const GMAIL_REQUEST_TIMEOUT_MS = 15_000;
export const GOOGLE_OAUTH_TIMEOUT_MS = 10_000;
export const GOOGLE_REVOKE_TIMEOUT_MS = 5_000;
export const SYNC_ATTEMPT_BUDGET_MS = 240_000;

export function createGoogleOAuthClient(options: {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  const { timeoutMs, signal, ...credentials } = options;
  const client = new google.auth.OAuth2({
    ...credentials,
    transporterOptions: { timeout: timeoutMs, retryConfig: { retry: 0 }, signal },
  });
  // A cancellation can precede an SDK-internal refresh/replay. Check the original
  // signal after gaxios has prepared options, before every transport request.
  if (signal)
    client.transporter?.interceptors.request.add({
      resolved: async (request) => {
        signal.throwIfAborted();
        return request;
      },
    });
  return client;
}

export function gmailCallOptions(signal?: AbortSignal) {
  // gaxios replaces an already-aborted signal when it appends its timeout.
  signal?.throwIfAborted();
  return { timeout: GMAIL_REQUEST_TIMEOUT_MS, retryConfig: { retry: 0 }, signal };
}

/** Preserve only transport categories, never Google text, request options or causes. */
export function googleFailureReason(
  error: unknown,
): 'timeout' | 'network' | 'rate_limit' | undefined {
  const e = error as {
    name?: string;
    code?: string;
    cause?: { name?: string };
    config?: { signal?: AbortSignal };
    response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } };
  };
  if (
    e?.name === 'TimeoutError' ||
    e?.cause?.name === 'TimeoutError' ||
    e?.code === 'ETIMEDOUT' ||
    e?.config?.signal?.reason?.name === 'TimeoutError'
  )
    return 'timeout';
  if (
    e?.response?.status === 403 &&
    Array.isArray(e.response.data?.error?.errors) &&
    e.response.data?.error?.errors?.some((item) =>
      ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(
        item.reason ?? '',
      ),
    )
  )
    return 'rate_limit';
  if (
    !e?.response &&
    ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(e?.code ?? '')
  )
    return 'network';
  return undefined;
}
