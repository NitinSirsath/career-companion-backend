import { gmailCallOptions, SYNC_ATTEMPT_BUDGET_MS } from './googleTransport';
import { randomUUID } from 'crypto';
import { gmail_v1 } from 'googleapis';
import { prisma } from '../db/prisma';
import { withGmail, googleStatus, googleAuthFailure } from './gmailClient';
import { enqueueEmailProcessingJob } from '../jobs/emailProcessingJob';
import { enqueueRelevanceTriage } from '../jobs/relevanceTriageJob';
import { triageBatchEnabled } from './ai/triage';
import { getAccessState } from './ai/access';

import {
  GmailAuthError,
  SyncInProgressError,
  SyncBusyError,
  SyncSupersededError,
  SyncDeadlineError,
  SyncCancelledError,
} from './gmailSyncErrors';
import { acquireSync, withOwnedSync } from './gmailSyncOwnership';
export { GmailAuthError, SyncInProgressError } from './gmailSyncErrors';
export interface SyncDelivery {
  signal?: AbortSignal;
  trigger?: 'manual' | 'scheduled';
  jobId?: string;
  retryCount?: number;
  retryLimit?: number;
}
function syncCategory(error: unknown): string {
  if (error instanceof GmailAuthError || googleAuthFailure(error)) return 'AUTH_REVOKED';
  if (error instanceof SyncInProgressError || error instanceof SyncBusyError) return 'REQUEST_BUSY';
  if (error instanceof SyncSupersededError) return 'SUPERSEDED';
  if (error instanceof SyncDeadlineError) return 'DEADLINE_EXCEEDED';
  if (error instanceof SyncCancelledError) return 'CANCELLED';
  const reason = (error as { reason?: string })?.reason;
  if (reason === 'timeout') return 'REQUEST_TIMEOUT';
  if (reason === 'network') return 'NETWORK_ERROR';
  if (reason === 'rate_limit') return 'RATE_LIMIT';
  const status = googleStatus(error);
  return status === 429
    ? 'RATE_LIMIT'
    : status === 403
      ? 'FORBIDDEN'
      : status && status >= 500
        ? 'PROVIDER_UNAVAILABLE'
        : 'UNCLASSIFIED';
}
export const REOFFER_LIMIT = 100;

/**
 * Re-offers up to 100 of the user's PENDING emails to the worker, newest first, so fresh mail is
 * not stuck behind a backlog. Covers the DB-insert / queue-send gap and emails that waited for AI
 * access. Does nothing while the user's AI access is not ready: those emails wait and are
 * re-offered by the next sync or after the user fixes access (no scheduler). Enqueueing is
 * idempotent per email (singleton key).
 */
export async function reofferPendingEmails(
  userId: string,
  guard?: () => Promise<void>,
): Promise<number> {
  if ((await getAccessState(userId)).state !== 'READY') return 0;
  const pending = await prisma.email.findMany({
    where: { userId, processingState: 'PENDING' },
    orderBy: [{ receivedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: REOFFER_LIMIT,
    select: {
      id: true,
      aiProcessingResult: { select: { id: true } },
      aiOperations: { where: { operation: 'classification' }, select: { id: true } },
    },
  });
  let triageQueued = false;
  for (const email of pending) {
    await guard?.();
    // With batching on, an email with no result and no classification row goes to the batched
    // check; every other email continues on the per-email job, which reuses or resumes its row.
    if (triageBatchEnabled() && !email.aiProcessingResult && !email.aiOperations.length) {
      if (!triageQueued) {
        await enqueueRelevanceTriage(userId);
        triageQueued = true;
      }
      continue;
    }
    await enqueueEmailProcessingJob(userId, email.id);
  }
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
  static async syncUser(userId: string, queuedClaim?: string, delivery: SyncDelivery = {}) {
    const started = Date.now();
    const requestId = queuedClaim ?? `direct:${randomUUID()}`;
    const claim = `${requestId}:attempt:${delivery.retryCount ?? 0}:${randomUUID()}`;
    const context = {
      trigger: delivery.trigger ?? 'manual',
      userId,
      requestId,
      jobId: delivery.jobId ?? null,
      attemptId: claim,
      retryCount: delivery.retryCount ?? 0,
      retryLimit: delivery.retryLimit ?? 0,
    };
    let checkpointCommitted: boolean | null = false;
    let checkpointAdvanced = false;
    let messagesIngested = 0;
    let messagesSkipped = 0;
    let connectionId: string | undefined;
    let budget: AbortSignal | undefined;
    let signal: AbortSignal | undefined;
    try {
      const acquired = await acquireSync(userId, queuedClaim, claim);
      budget = AbortSignal.timeout(SYNC_ATTEMPT_BUDGET_MS);
      signal = delivery.signal ? AbortSignal.any([delivery.signal, budget]) : budget;
      const connection = acquired.connection;
      connectionId = connection.id;
      const syncLookbackDays = connection.syncLookbackDays || 1;
      const window = syncWindow({
        now: acquired.now,
        lastSyncedAt: connection.lastSyncedAt,
        lookbackDays: syncLookbackDays,
      });
      const daysSinceLastSync = connection.lastSyncedAt
        ? (acquired.now.getTime() - connection.lastSyncedAt.getTime()) / DAY_MS
        : Infinity;
      const shouldFullSync =
        !connection.lastHistoryId ||
        !connection.lastSyncedAt ||
        daysSinceLastSync > syncLookbackDays ||
        (connection.lastSyncedLookbackDays !== null &&
          syncLookbackDays > connection.lastSyncedLookbackDays);
      console.log(JSON.stringify({ event: 'gmail_sync_started', ...context }));
      const deadline = () => {
        signal!.throwIfAborted();
      };
      const heartbeat = async () => {
        deadline();
        await withOwnedSync(userId, connection.id, claim, async () => {
          deadline();
        });
      };
      const historyId = await withGmail(
        userId,
        async (gmail) => {
          const ingest = async (ids: string[]) => {
            for (const id of new Set(ids)) {
              await heartbeat();
              const existing = await prisma.email.findUnique({
                where: { userId_gmailMessageId: { userId, gmailMessageId: id } },
              });
              if (existing) {
                if (existing.processingState === 'PENDING') {
                  await heartbeat();
                  if (triageBatchEnabled()) await enqueueRelevanceTriage(userId); else await enqueueEmailProcessingJob(userId, existing.id);
                }
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
                    gmailCallOptions(signal),
                  )
                ).data;
              } catch (err) {
                if (googleStatus(err) === 404) continue;
                throw err;
              }
              if (!message.labelIds?.includes('INBOX')) continue;
              const receivedAt = message.internalDate
                ? new Date(Number(message.internalDate))
                : null;
              if (receivedAt && receivedAt < window.windowStart) continue;
              deadline();
              const record = await withOwnedSync(userId, connection.id, claim, (tx) => {
                deadline();
                return tx.email.upsert({
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
              });
              if (record.processingState === 'PENDING') {
                await heartbeat();
                if (triageBatchEnabled()) await enqueueRelevanceTriage(userId); else await enqueueEmailProcessingJob(userId, record.id);
              }
              messagesIngested++;
            }
          };
          const fullSync = async () => {
            // Capture checkpoint BEFORE scanning so mail arriving during the scan remains discoverable.
            const profile = await gmail.users.getProfile(
              { userId: 'me' },
              gmailCallOptions(signal),
            );
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
                gmailCallOptions(signal),
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
                gmailCallOptions(signal),
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
        },
        { signal },
      );
      // Recover the DB-insert / queue-send gap even when the history no longer returns that email,
      // and resume emails that waited for AI access.
      deadline();
      await reofferPendingEmails(userId, heartbeat);
      await heartbeat();
      const lastSyncedAt = new Date();
      const committed = await withOwnedSync(userId, connection.id, claim, (tx) => {
        deadline();
        checkpointCommitted = null;
        return tx.gmailConnection.updateMany({
          where: { id: connection.id, userId, syncClaim: claim, status: 'CONNECTED' },
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
      });
      if (committed.count !== 1) {
        checkpointCommitted = false;
        throw new SyncSupersededError();
      }
      checkpointCommitted = true;
      checkpointAdvanced = historyId !== connection.lastHistoryId;
      console.log(
        JSON.stringify({
          event: 'gmail_sync_completed',
          ...context,
          checkpointCommitted,
          checkpointAdvanced,
          windowDays: window.windowDays,
          gapCapped: window.unscanned !== null,
          userId,
          messagesIngested,
          messagesSkipped,
          durationMs: Date.now() - started,
        }),
      );
      return { synced: true, messagesIngested, messagesSkipped, lastSyncedAt, checkpointAdvanced };
    } catch (caught) {
      const error = signal?.aborted
        ? budget?.aborted && signal.reason === budget.reason
          ? new SyncDeadlineError()
          : new SyncCancelledError()
        : caught;
      const superseded = error instanceof SyncSupersededError;
      if (superseded) checkpointCommitted = false;
      if (connectionId && !superseded) {
        try {
          await prisma.gmailConnection.updateMany({
            where: { id: connectionId, userId, syncClaim: claim },
            data: {
              syncStatus: 'FAILED',
              syncClaim: queuedClaim ?? null,
              syncLeaseUntil: null,
              syncError:
                googleAuthFailure(error) || error instanceof GmailAuthError
                  ? 'GMAIL_AUTH_FAILED'
                  : 'SYNC_FAILED',
            },
          });
        } catch {
          /* A failed cleanup must not hide the original delivery outcome. */
        }
      }
      console.error(
        JSON.stringify({
          event: superseded ? 'gmail_sync_superseded' : 'gmail_sync_failed',
          ...context,
          durationMs: Date.now() - started,
          checkpointCommitted,
          checkpointAdvanced,
          category: syncCategory(error),
        }),
      );
      if (googleAuthFailure(error)) throw new GmailAuthError();
      throw error;
    }
  }
}
