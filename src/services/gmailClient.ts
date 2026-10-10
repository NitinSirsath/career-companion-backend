import {
  createGoogleOAuthClient,
  GOOGLE_OAUTH_TIMEOUT_MS,
  googleFailureReason,
} from './googleTransport';
import {
  SyncBusyError,
  SyncSupersededError,
  SyncDeadlineError,
  SyncCancelledError,
} from './gmailSyncErrors';
import { google, gmail_v1 } from 'googleapis';
import { prisma } from '../db/prisma';
import { gmailOAuth } from '../utils/config';
import { decryptToken, encryptToken } from '../utils/gmailTokenEncryption';

export function googleStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { status?: number; code?: number; response?: { status?: number } };
  return e.response?.status ?? e.status ?? (typeof e.code === 'number' ? e.code : undefined);
}
export function googleAuthFailure(error: unknown): boolean {
  const e = error as { response?: { data?: { error?: unknown } } };
  return googleStatus(error) === 401 || e?.response?.data?.error === 'invalid_grant';
}

export async function withGmail<T>(
  userId: string,
  work: (gmail: gmail_v1.Gmail) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const connection = await prisma.gmailConnection.findUnique({ where: { userId } });
  if (!connection || connection.status !== 'CONNECTED') throw new Error('Gmail is not connected');
  if (options.signal?.aborted) throw new Error('Gmail request failed');
  const oauth = createGoogleOAuthClient({
    ...gmailOAuth(),
    timeoutMs: GOOGLE_OAUTH_TIMEOUT_MS,
    signal: options.signal,
  });
  const access = decryptToken(connection.accessToken);
  oauth.setCredentials({
    access_token: access,
    ...(connection.accessTokenExpiresAt
      ? { expiry_date: connection.accessTokenExpiresAt.getTime() }
      : {}),
    ...(connection.refreshToken ? { refresh_token: decryptToken(connection.refreshToken) } : {}),
  });
  try {
    return await work(google.gmail({ version: 'v1', auth: oauth }));
  } catch (err) {
    if (
      err instanceof SyncBusyError ||
      err instanceof SyncSupersededError ||
      err instanceof SyncDeadlineError ||
      err instanceof SyncCancelledError
    )
      throw err;
    if (googleAuthFailure(err))
      await prisma.gmailConnection.updateMany({
        where: { id: connection.id, accessToken: connection.accessToken },
        data: { status: 'REVOKED' },
      });
    const sanitized = new Error('Gmail request failed');
    throw Object.assign(sanitized, {
      status: googleAuthFailure(err) ? 401 : googleStatus(err),
      reason: googleFailureReason(err),
    });
  } finally {
    const updated = oauth.credentials;
    if (updated?.access_token && updated.access_token !== access) {
      await prisma.gmailConnection.updateMany({
        where: { id: connection.id, status: 'CONNECTED', accessToken: connection.accessToken },
        data: {
          accessToken: encryptToken(updated.access_token),
          accessTokenExpiresAt: updated.expiry_date ? new Date(updated.expiry_date) : null,
          ...(updated.refresh_token ? { refreshToken: encryptToken(updated.refresh_token) } : {}),
        },
      });
    }
  }
}
