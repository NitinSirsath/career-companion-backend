import { google, gmail_v1 } from 'googleapis';
import { prisma } from '../db/prisma';
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
): Promise<T> {
  const connection = await prisma.gmailConnection.findUnique({ where: { userId } });
  if (!connection || connection.status !== 'CONNECTED') throw new Error('Gmail is not connected');
  const oauth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI,
  );
  const access = decryptToken(connection.accessToken);
  oauth.setCredentials({
    access_token: access,
    ...(connection.refreshToken ? { refresh_token: decryptToken(connection.refreshToken) } : {}),
  });
  try {
    return await work(google.gmail({ version: 'v1', auth: oauth }));
  } catch (err) {
    if (googleAuthFailure(err))
      await prisma.gmailConnection.updateMany({
        where: { id: connection.id, accessToken: connection.accessToken },
        data: { status: 'REVOKED' },
      });
    const sanitized = new Error('Gmail request failed');
    throw Object.assign(sanitized, { status: googleAuthFailure(err) ? 401 : googleStatus(err) });
  } finally {
    const updated = oauth.credentials;
    if (updated?.access_token && updated.access_token !== access) {
      await prisma.gmailConnection.updateMany({
        where: { id: connection.id, status: 'CONNECTED', accessToken: connection.accessToken },
        data: {
          accessToken: encryptToken(updated.access_token),
          ...(updated.refresh_token ? { refreshToken: encryptToken(updated.refresh_token) } : {}),
        },
      });
    }
  }
}
