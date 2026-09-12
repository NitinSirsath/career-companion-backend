import { google } from 'googleapis';
import { prisma } from '../db/prisma';
import { decryptToken } from '../utils/gmailTokenEncryption';

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
   * The architecture (COM-6) calls for a pg-boss background Worker.
   * This will be replaced in Sprint 3 when AI processing is introduced.
   * The POST /api/gmail/sync API shape is stable and will not change.
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

    // Set status to syncing
    await prisma.gmailConnection.update({
      where: { userId },
      data: { syncStatus: 'SYNCING' }
    });

    let messagesIngested = 0;
    let messagesSkipped = 0;
    const now = new Date();
    let firstPageHistoryId: string | null = null;

    try {
      const decryptedToken = decryptToken(connection.accessToken);
      
      const oauth2Client = new google.auth.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET,
        process.env.GMAIL_REDIRECT_URI
      );
      oauth2Client.setCredentials({ access_token: decryptedToken });
      
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      let pageToken: string | undefined = undefined;
      do {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const listRes: any = await gmail.users.messages.list({
          userId: 'me',
          labelIds: ['INBOX'],
          q: 'newer_than:90d',
          maxResults: 100,
          pageToken
        });

        if (!firstPageHistoryId && listRes.data.messages && listRes.data.messages.length > 0) {
          // Store the historyId from the first list request (optional depending on API details, 
          // but typically listRes.data does not have historyId globally, so we can wait until we get a message)
          // Actually, `messages.list` doesn't always return a global historyId at the root, 
          // wait, it does return `resultSizeEstimate` but not historyId. 
          // We will extract historyId from the first retrieved message.
        }

        const messages = listRes.data.messages || [];

        for (const msg of messages) {
          if (!msg.id) continue;

          // Check if it already exists to avoid redundant fetch + upsert
          const existing = await prisma.email.findUnique({
            where: {
              userId_gmailMessageId: {
                userId,
                gmailMessageId: msg.id
              }
            }
          });

          if (existing) {
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

          await prisma.email.upsert({
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
              matchState: 'UNMATCHED'
            },
            update: {} // No-op update if it somehow conflicts during race
          });

          messagesIngested++;
        }

        pageToken = listRes.data.nextPageToken || undefined;
      } while (pageToken);

      // On completion, set syncStatus to IDLE
      await prisma.gmailConnection.update({
        where: { userId },
        data: {
          syncStatus: 'IDLE',
          lastSyncedAt: now,
          ...(firstPageHistoryId ? { lastHistoryId: firstPageHistoryId } : {})
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
