/**
 * The user's Gmail connection row: status, the saved grant and settings. Tokens are stored
 * encrypted and never leave this module in plain text.
 */
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { encryptToken } from '../utils/gmailTokenEncryption';
import { nextScheduledSyncAt } from './gmailSchedule';
import { usesSandbox } from './testAccounts';

/**
 * True when replies can be sent from this connection: the Google grant covers sending. The
 * sandbox mailbox (`sandbox`, see services/testAccounts.ts) can always send; nothing leaves the app there.
 */
export const maySend = (
  connection: { status: string; canSend: boolean },
  sandbox: boolean,
): boolean => connection.status === 'CONNECTED' && (sandbox || connection.canSend);

/** Connection and sync state for the Gmail page. */
export async function readGmailStatus(userId: string) {
  const connection = await prisma.gmailConnection.findUnique({
    where: { userId },
    select: {
      gmailEmail: true,
      status: true,
      syncStatus: true,
      lastSyncedAt: true,
      unscannedFrom: true,
      unscannedUntil: true,
      syncLeaseUntil: true,
      syncError: true,
      syncLookbackDays: true,
      canSend: true,
      // accessToken and refreshToken are deliberately NOT selected.
    },
  });

  if (!connection) {
    return {
      connected: false,
      gmailEmail: null,
      status: null,
      syncStatus: null,
      lastSyncedAt: null,
      unscannedGap: null,
      nextScheduledSyncAt: null,
      syncLookbackDays: 1,
      canSend: false,
    };
  }

  return {
    connected: connection.status === 'CONNECTED',
    gmailEmail: connection.gmailEmail,
    status: connection.status,
    syncStatus:
      connection.syncStatus === 'SYNCING' &&
      (!connection.syncLeaseUntil || connection.syncLeaseUntil < new Date())
        ? 'FAILED'
        : connection.syncStatus,
    syncError: connection.syncError,
    lastSyncedAt: connection.lastSyncedAt,
    nextScheduledSyncAt: nextScheduledSyncAt(connection.status === 'CONNECTED'),
    unscannedGap:
      connection.unscannedFrom && connection.unscannedUntil
        ? {
            from: connection.unscannedFrom.toISOString(),
            until: connection.unscannedUntil.toISOString(),
          }
        : null,
    syncLookbackDays: connection.syncLookbackDays,
    canSend: maySend(connection, await usesSandbox(userId)),
  };
}

/**
 * Saves a new Google grant for the user's mailbox. Returns false, and saves nothing, when the
 * user already has a different mailbox.
 */
export async function saveGmailGrant(
  userId: string,
  gmailEmail: string,
  grant: {
    accessToken: string;
    refreshToken?: string | null;
    expiryDate?: number | null;
    canSend?: boolean;
  },
): Promise<boolean> {
  const previous = await prisma.gmailConnection.findUnique({ where: { userId } });
  if (previous && previous.gmailEmail.toLowerCase() !== gmailEmail.toLowerCase()) return false;

  const connected = {
    gmailEmail,
    status: 'CONNECTED',
    syncStatus: 'IDLE',
    accessToken: encryptToken(grant.accessToken),
    accessTokenExpiresAt: grant.expiryDate ? new Date(grant.expiryDate) : null,
    // The new grant replaces the old one, so what it allows replaces what the old one allowed.
    canSend: grant.canSend ?? false,
  } as const;
  const refreshToken = grant.refreshToken ? encryptToken(grant.refreshToken) : null;

  await prisma.gmailConnection.upsert({
    // Including mailbox identity prevents a concurrent first grant from overwriting a different mailbox.
    where: { userId, gmailEmail: { equals: gmailEmail, mode: 'insensitive' } },
    create: { userId, ...connected, refreshToken },
    update: {
      ...connected,
      syncClaim: null,
      syncLeaseUntil: null,
      syncError: null,
      // Google returns a refresh token only with prompt=consent: keep the saved one otherwise.
      ...(refreshToken ? { refreshToken } : {}),
    },
  });
  return true;
}

/**
 * Dev mode and test accounts: connects the user's sandbox mailbox in place of a Gmail account. There is no Google
 * grant, so the saved token is a placeholder that nothing reads.
 */
export async function connectSandboxMailbox(userId: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await saveGmailGrant(userId, user.email, { accessToken: 'sandbox-mailbox' });
}

/** The saved (still encrypted) access token to revoke on disconnect; null when not connected. */
export async function connectedAccessToken(userId: string): Promise<string | null> {
  const connection = await prisma.gmailConnection.findUnique({
    where: { userId },
    select: { accessToken: true, status: true },
  });
  return !connection || connection.status === 'NOT_CONNECTED' ? null : connection.accessToken;
}

/** Removes the saved grant and sync state. The row stays, marked NOT_CONNECTED. */
export async function clearGmailConnection(userId: string): Promise<void> {
  await prisma.gmailConnection.update({
    where: { userId },
    data: {
      status: 'NOT_CONNECTED',
      syncStatus: 'IDLE',
      accessToken: '', // The column is NOT NULL; an empty value is not a valid encrypted token.
      accessTokenExpiresAt: null,
      refreshToken: null,
      canSend: false,
      lastHistoryId: null,
      syncClaim: null,
      syncLeaseUntil: null,
      syncError: null,
    },
  });
}

export async function setSyncLookbackDays(userId: string, syncLookbackDays: number): Promise<void> {
  const { count } = await prisma.gmailConnection.updateMany({
    where: { userId },
    data: { syncLookbackDays },
  });
  if (!count) throw new AppError(404, 'NOT_CONNECTED', 'Gmail connection not found');
}

/** Rejects a manual sync when Gmail is not connected or another sync holds the lease. */
export async function assertSyncCanStart(userId: string): Promise<void> {
  const connection = await prisma.gmailConnection.findUnique({ where: { userId } });
  if (!connection || connection.status !== 'CONNECTED')
    throw new AppError(400, 'GMAIL_NOT_CONNECTED', 'Gmail is not connected');
  if (
    connection.syncStatus === 'SYNCING' &&
    connection.syncLeaseUntil &&
    connection.syncLeaseUntil > new Date()
  )
    throw new AppError(409, 'SYNC_IN_PROGRESS', 'A sync is already in progress');
}
