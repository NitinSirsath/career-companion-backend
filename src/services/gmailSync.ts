import { randomUUID } from 'crypto';
import { gmail_v1 } from 'googleapis';
import { prisma } from '../db/prisma';
import { withGmail, googleStatus, googleAuthFailure } from './gmailClient';
import { enqueueEmailProcessingJob } from '../jobs/emailProcessingJob';
import { getAccessState } from './ai/access';

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
export const REOFFER_LIMIT = 100;

/**
 * Re-offers up to 100 of the user's PENDING emails to the worker, newest first, so fresh mail is
 * not stuck behind a backlog. Covers the DB-insert / queue-send gap and emails that waited for AI
 * access. Does nothing while the user's AI access is not ready: those emails wait and are
 * re-offered by the next sync or after the user fixes access (no scheduler). Enqueueing is
 * idempotent per email (singleton key).
 */
export async function reofferPendingEmails(userId: string): Promise<number> {
  if ((await getAccessState(userId)).state !== 'READY') return 0;
  const pending = await prisma.email.findMany({
    where: { userId, processingState: 'PENDING' },
    orderBy: [{ receivedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: REOFFER_LIMIT,
    select: { id: true },
  });
  for (const email of pending) await enqueueEmailProcessingJob(userId, email.id);
  return pending.length;
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

export const MAX_SYNC_WINDOW_DAYS = 30;
export const SYNC_GAP_MARGIN_MS = 60 * 60_000;
const DAY_MS = 86400_000;

/** One immutable cutoff per attempt; the overlap covers mail arriving during the prior scan. */
export function syncWindow({
  now,
  lastSyncedAt,
  lookbackDays,
}: {
  now: Date;
  lastSyncedAt: Date | null;
  lookbackDays: number;
}) {
  const gapStart = lastSyncedAt ? new Date(lastSyncedAt.getTime() - SYNC_GAP_MARGIN_MS) : null;
  const requiredDays = gapStart
    ? Math.ceil((now.getTime() - gapStart.getTime()) / DAY_MS)
    : lookbackDays;
  const windowDays = Math.min(MAX_SYNC_WINDOW_DAYS, Math.max(lookbackDays, requiredDays));
  const windowStart = new Date(now.getTime() - windowDays * DAY_MS);
  const unscanned =
    gapStart && gapStart < windowStart ? { from: gapStart, until: windowStart } : null;
  return { windowDays, windowStart, unscanned };
}

export class GmailSyncService {
  static async syncUser(userId: string, queuedClaim?: string) {
    const connection = await prisma.gmailConnection.findUnique({ where: { userId } });
    if (!connection || connection.status !== 'CONNECTED')
      throw new GmailAuthError('Gmail is not connected');

    const syncLookbackDays = connection.syncLookbackDays || 1;
    const lastSyncedLookbackDays = connection.lastSyncedLookbackDays;
    const window = syncWindow({
      now: new Date(),
      lastSyncedAt: connection.lastSyncedAt,
      lookbackDays: syncLookbackDays,
    });
    const daysSinceLastSync = connection.lastSyncedAt
      ? (Date.now() - connection.lastSyncedAt.getTime()) / 86400000
      : Infinity;
    const shouldFullSync =
      !connection.lastHistoryId ||
      !connection.lastSyncedAt ||
      daysSinceLastSync > syncLookbackDays ||
      (lastSyncedLookbackDays !== null && syncLookbackDays > lastSyncedLookbackDays);

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
            if (receivedAt && receivedAt < window.windowStart) continue;
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
                q: `newer_than:${window.windowDays}d`,
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
        if (shouldFullSync) return fullSync();
        let pageToken: string | undefined;
        let latest = connection.lastHistoryId;
        do {
          await heartbeat();
          let page;
          try {
            page = await gmail.users.history.list(
              {
                userId: 'me',
                startHistoryId: connection.lastHistoryId!,
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
      // Recover the DB-insert / queue-send gap even when the history no longer returns that email,
      // and resume emails that waited for AI access.
      await reofferPendingEmails(userId);
      const lastSyncedAt = new Date();
      await prisma.gmailConnection.updateMany({
        where: { id: connection.id, syncClaim: claim, status: 'CONNECTED' },
        data: {
          syncStatus: 'IDLE',
          syncClaim: null,
          syncLeaseUntil: null,
          lastHistoryId: historyId,
          lastSyncedAt,
          lastSyncedLookbackDays: syncLookbackDays,
          ...(window.unscanned && {
            unscannedFrom: window.unscanned.from,
            unscannedUntil: window.unscanned.until,
          }),
        },
      });
      console.log(
        JSON.stringify({
          event: 'gmail_sync_completed',
          windowDays: window.windowDays,
          gapCapped: window.unscanned !== null,
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
