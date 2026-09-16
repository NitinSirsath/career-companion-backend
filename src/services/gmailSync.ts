import { google } from 'googleapis';
import { GaxiosError } from 'gaxios';
import { prisma } from '../db/prisma';
import { decryptToken, encryptToken } from '../utils/gmailTokenEncryption';

/**
 * Typed error thrown when Google returns a 401/403 auth failure during sync.
 * Allows the route layer to return a safe 503 instead of a generic 500.
 */
export class SyncInProgressError extends Error {
  readonly code = 'SYNC_IN_PROGRESS';
  constructor(message: string) {
    super(message);
    this.name = 'SyncInProgressError';
  }
}

export class GmailAuthError extends Error {
  readonly code = 'GMAIL_AUTH_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'GmailAuthError';
  }
}

interface SyncResult {
  synced: boolean;
  messagesIngested: number;
  messagesSkipped: number;
  lastSyncedAt: Date;
}

/**
 * Extracts specific headers from the Gmail payload.headers array.
 */
export function extractHeaders(headers: { name?: string | null; value?: string | null }[] | undefined) {
  let subject: string | null = null;
  let sender: string | null = null;
  let dateHeader: string | null = null;

  if (headers) {
    for (const h of headers) {
      if (!h.name || !h.value) continue;
      const lowerName = h.name.toLowerCase();
      if (lowerName === 'subject') {
        subject = h.value;
      } else if (lowerName === 'from') {
        sender = h.value;
      } else if (lowerName === 'date') {
        dateHeader = h.value;
      }
    }
  }

  let receivedAt: Date | null = null;
  if (dateHeader) {
    const parsed = new Date(dateHeader);
    if (!isNaN(parsed.getTime())) {
      receivedAt = parsed;
    }
  }

  return { subject, sender, receivedAt };
}

export class GmailSyncService {
  /**
   * Syncs the user's Gmail Inbox synchronously.
   *
   * SPRINT-2-NOTE: Sync runs synchronously in the API handler.
   * The POST /api/gmail/sync API shape is stable and will not change.
   *
   * TOKEN REFRESH: Both access_token and refresh_token (if stored) are passed
   * to the OAuth2 client so google-auth-library can automatically refresh an
   * expired access_token. Any refreshed credentials returned by the library are
   * re-encrypted and persisted so subsequent syncs do not require another refresh.
   */
  static async syncUser(userId: string): Promise<SyncResult> {
    const connection = await prisma.gmailConnection.findUnique({
      where: { userId }
    });

    if (!connection) {
      throw new Error('Gmail connection not found for user');
    }

    if (connection.status !== 'CONNECTED') {
      throw new Error('Gmail connection is not active');
    }

    // Set status to syncing atomically
    const updateResult = await prisma.gmailConnection.updateMany({
      where: { userId, syncStatus: { not: 'SYNCING' } },
      data: { syncStatus: 'SYNCING' }
    });
    
    if (updateResult.count === 0) {
      throw new SyncInProgressError('A sync is already in progress');
    }

    let messagesIngested = 0;
    let messagesSkipped = 0;
    const now = new Date();
    let firstPageHistoryId: string | null = null;

    try {
      const decryptedAccessToken = decryptToken(connection.accessToken);
      // Decrypt refresh token only if present — older connections may not have it.
      // SECURITY: Never log these values.
      const decryptedRefreshToken = connection.refreshToken
        ? decryptToken(connection.refreshToken)
        : null;

      const oauth2Client = new google.auth.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET,
        process.env.GMAIL_REDIRECT_URI
      );

      // IMPORTANT: Pass refresh_token so google-auth-library can silently refresh
      // an expired access_token. Without this, every sync fails with 401 once the
      // initial token expires (~1 hour after the OAuth grant).
      oauth2Client.setCredentials({
        access_token: decryptedAccessToken,
        ...(decryptedRefreshToken ? { refresh_token: decryptedRefreshToken } : {}),
      });

      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      let pageToken: string | undefined = undefined;
      try {
        do {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const listRes: any = await gmail.users.messages.list({
            userId: 'me',
            labelIds: ['INBOX'],
            q: 'newer_than:90d',
            maxResults: 100,
            pageToken
          });

          const messages = listRes.data.messages || [];

          // Batch check existing emails to prevent sequential DB query overhead
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msgIds = messages.map((m: any) => m.id).filter(Boolean);
          const existingEmails = msgIds.length > 0 ? await prisma.email.findMany({
            where: {
              userId,
              gmailMessageId: { in: msgIds }
            },
            select: { gmailMessageId: true }
          }) : [];
          const existingSet = new Set(existingEmails.map(e => e.gmailMessageId));

          for (const msg of messages) {
            if (!msg.id) continue;

            if (existingSet.has(msg.id)) {
              messagesSkipped++;
              continue;
            }

            // Fetch metadata only
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const getRes: any = await gmail.users.messages.get({
              userId: 'me',
              id: msg.id,
              format: 'metadata',
              metadataHeaders: ['Subject', 'From', 'Date']
            });

            const { threadId, historyId, payload } = getRes.data;

            if (!firstPageHistoryId && historyId) {
              firstPageHistoryId = historyId;
            }

            const { subject, sender, receivedAt } = extractHeaders(payload?.headers);

            const emailRecord = await prisma.email.upsert({
              where: {
                userId_gmailMessageId: {
                  userId,
                  gmailMessageId: msg.id
                }
              },
              create: {
                userId,
                gmailMessageId: msg.id,
                threadId: threadId || null,
                subject,
                sender,
                receivedAt,
                relevanceState: 'UNPROCESSED',
                matchState: 'UNMATCHED',
                processingState: 'PENDING'
              },
              update: {} // No-op update if it conflicts during a race
            });

            // Enqueue for processing
            const { enqueueEmailProcessingJob } = await import('../jobs/emailProcessingJob');
            await enqueueEmailProcessingJob(userId, emailRecord.id);

            messagesIngested++;
          }

          pageToken = listRes.data.nextPageToken || undefined;
        } while (pageToken);
      } catch (apiError) {
        // Re-classify Google 401/403 auth failures so the route layer can return
        // a safe, descriptive 503 instead of an opaque generic 500.
        if (
          apiError instanceof GaxiosError &&
          (apiError.status === 401 || apiError.status === 403)
        ) {
          throw new GmailAuthError(
            'Gmail credentials are invalid or expired. Please reconnect Gmail.'
          );
        }
        throw apiError;
      }

      // ── Persist any auto-refreshed access token ───────────────────────────
      // google-auth-library updates oauth2Client.credentials.access_token when it
      // silently refreshes using the stored refresh_token. Persist the new value
      // so subsequent syncs skip the extra refresh round-trip.
      // SECURITY: The token is re-encrypted before storage; never logged.
      const refreshedAccessToken = oauth2Client.credentials?.access_token;
      const encryptedAccessTokenUpdate =
        refreshedAccessToken && refreshedAccessToken !== decryptedAccessToken
          ? encryptToken(refreshedAccessToken)
          : undefined;

      // On completion, set syncStatus to IDLE
      await prisma.gmailConnection.update({
        where: { userId },
        data: {
          syncStatus: 'IDLE',
          lastSyncedAt: now,
          ...(firstPageHistoryId ? { lastHistoryId: firstPageHistoryId } : {}),
          ...(encryptedAccessTokenUpdate ? { accessToken: encryptedAccessTokenUpdate } : {}),
        }
      });

      return {
        synced: true,
        messagesIngested,
        messagesSkipped,
        lastSyncedAt: now
      };

    } catch (error) {
      // Revert status to FAILED on error
      await prisma.gmailConnection.update({
        where: { userId },
        data: { syncStatus: 'FAILED' }
      });
      throw error;
    }
  }
}

