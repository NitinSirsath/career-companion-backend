import { randomUUID } from 'crypto';
import { gmail_v1 } from 'googleapis';
import { prisma } from '../db/prisma';
import { withGmail, googleStatus, googleAuthFailure } from './gmailClient';
import { enqueueEmailProcessingJob } from '../jobs/emailProcessingJob';

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
const LEASE_MS = 5 * 60_000;
export const syncLease = () => new Date(Date.now() + LEASE_MS);

export function extractHeaders(
  headers: { name?: string | null; value?: string | null }[] | undefined,
) {
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
  static async syncUser(userId: string, queuedClaim?: string) {
    const connection = await prisma.gmailConnection.findUnique({ where: { userId } });
    if (!connection || connection.status !== 'CONNECTED')
      throw new GmailAuthError('Gmail is not connected');
    const claim = randomUUID();
    const acquired = await prisma.gmailConnection.updateMany({
      where: {
        id: connection.id,
        status: 'CONNECTED',
        ...(queuedClaim
          ? { syncClaim: queuedClaim }
          : {
              OR: [
                { syncStatus: { not: 'SYNCING' } },
                { syncLeaseUntil: { lt: new Date() } },
                { syncLeaseUntil: null },
              ],
            }),
      },
      data: {
        syncStatus: 'SYNCING',
        syncClaim: claim,
        syncLeaseUntil: syncLease(),
        syncError: null,
      },
    });
    if (!acquired.count) throw new SyncInProgressError('A sync is already in progress');
    let messagesIngested = 0;
    let messagesSkipped = 0;
    const started = Date.now();
    const heartbeat = async () => {
      if (Date.now() - started > 4 * 60_000)
        throw new Error('Sync time budget reached; resume on next sync');
      const alive = await prisma.gmailConnection.updateMany({
        where: { id: connection.id, syncClaim: claim, status: 'CONNECTED' },
        data: { syncLeaseUntil: syncLease() },
      });
      if (!alive.count) throw new Error('Sync superseded or disconnected');
    };
    try {
      const historyId = await withGmail(userId, async (gmail) => {
        const ingest = async (ids: string[]) => {
          for (const id of new Set(ids)) {
            await heartbeat();
            const existing = await prisma.email.findUnique({
              where: { userId_gmailMessageId: { userId, gmailMessageId: id } },
            });
            if (existing) {
              if (existing.processingState === 'PENDING')
                await enqueueEmailProcessingJob(userId, existing.id);
              messagesSkipped++;
              continue;
            }
            let message: gmail_v1.Schema$Message;
            try {
              message = (
                await gmail.users.messages.get(
                  {
                    userId: 'me',
                    id,
                    format: 'metadata',
                    metadataHeaders: ['Subject', 'From', 'Date'],
                  },
                  { timeout: 15_000 },
                )
              ).data;
            } catch (err) {
              if (googleStatus(err) === 404) continue;
              throw err;
            }
            if (!message.labelIds?.includes('INBOX')) continue;
            const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : null;
            if (receivedAt && receivedAt.getTime() < Date.now() - 90 * 86400_000) continue;
            await heartbeat();
            const record = await prisma.email.upsert({
              where: { userId_gmailMessageId: { userId, gmailMessageId: id } },
              create: {
                userId,
                gmailMessageId: id,
                threadId: message.threadId,
                ...extractHeaders(message.payload?.headers),
                ...(receivedAt && !isNaN(receivedAt.getTime()) ? { receivedAt } : {}),
              },
              update: {},
            });
            if (record.processingState === 'PENDING')
              await enqueueEmailProcessingJob(userId, record.id);
            messagesIngested++;
          }
        };
        const fullSync = async () => {
          // Capture checkpoint BEFORE scanning so mail arriving during the scan remains discoverable.
          const profile = await gmail.users.getProfile({ userId: 'me' }, { timeout: 15_000 });
          const baseline = profile.data.historyId;
          if (!baseline) throw new Error('Missing Gmail history checkpoint');
          let pageToken: string | undefined;
          do {
            await heartbeat();
            const page = await gmail.users.messages.list(
              {
                userId: 'me',
                labelIds: ['INBOX'],
                q: 'newer_than:90d',
                maxResults: 100,
                pageToken,
              },
              { timeout: 15_000 },
            );
            await ingest((page.data.messages ?? []).flatMap((m) => (m.id ? [m.id] : [])));
            pageToken = page.data.nextPageToken ?? undefined;
          } while (pageToken);
          return baseline;
        };
        if (!connection.lastHistoryId) return fullSync();
        let pageToken: string | undefined;
        let latest = connection.lastHistoryId;
        do {
          await heartbeat();
          let page;
          try {
            page = await gmail.users.history.list(
              {
                userId: 'me',
                startHistoryId: connection.lastHistoryId,
                historyTypes: ['messageAdded', 'labelAdded'],
                pageToken,
                maxResults: 100,
              },
              { timeout: 15_000 },
            );
          } catch (err) {
            if (googleStatus(err) === 404) return fullSync();
            throw err;
          }
          const ids = (page.data.history ?? []).flatMap((h) => [
            ...(h.messagesAdded ?? []).flatMap((m) => (m.message?.id ? [m.message.id] : [])),
            ...(h.labelsAdded ?? []).flatMap((m) =>
              m.labelIds?.includes('INBOX') && m.message?.id ? [m.message.id] : [],
            ),
          ]);
          await ingest(ids);
          latest = page.data.historyId ?? latest;
          pageToken = page.data.nextPageToken ?? undefined;
        } while (pageToken);
        return latest;
      });
      // Recover the DB-insert / queue-send gap even when the history no longer returns that email.
      const pending = await prisma.email.findMany({
        where: { userId, processingState: 'PENDING' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      for (const email of pending) await enqueueEmailProcessingJob(userId, email.id);
      const lastSyncedAt = new Date();
      await prisma.gmailConnection.updateMany({
        where: { id: connection.id, syncClaim: claim, status: 'CONNECTED' },
        data: {
          syncStatus: 'IDLE',
          syncClaim: null,
          syncLeaseUntil: null,
          lastHistoryId: historyId,
          lastSyncedAt,
        },
      });
      console.log(
        JSON.stringify({
          event: 'gmail_sync_completed',
          userId,
          messagesIngested,
          messagesSkipped,
          durationMs: Date.now() - started,
        }),
      );
      return { synced: true, messagesIngested, messagesSkipped, lastSyncedAt };
    } catch (error) {
      const auth = googleAuthFailure(error);
      await prisma.gmailConnection.updateMany({
        where: { id: connection.id, syncClaim: claim },
        data: {
          syncStatus: 'FAILED',
          syncClaim: queuedClaim ?? null,
          syncLeaseUntil: null,
          syncError: auth ? 'GMAIL_AUTH_FAILED' : 'SYNC_FAILED',
        },
      });
      if (auth) throw new GmailAuthError('Gmail authorization expired; reconnect Gmail');
      throw error;
    }
  }
}
