import { gmailCallOptions, SYNC_ATTEMPT_BUDGET_MS } from './googleTransport';
import { randomUUID } from 'crypto';
import { gmail_v1 } from 'googleapis';
import { prisma } from '../db/prisma';
import { withGmail, googleStatus, googleAuthFailure } from './gmailClient';
import { enqueueForProcessing, reofferPendingEmails } from './ai/offer';

import {
  GmailAuthError,
  SyncInProgressError,
  SyncBusyError,
  SyncSupersededError,
  SyncDeadlineError,
  SyncCancelledError,
} from './gmailSyncErrors';
import { acquireSync, withOwnedSync } from './gmailSyncOwnership';
import { logDebug, logEvent, logError } from '../utils/log';
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
  if (status === 429) return 'RATE_LIMIT';
  if (status === 403) return 'FORBIDDEN';
  return status && status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'UNCLASSIFIED';
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

/** What every step of one sync attempt needs. */
interface SyncRun {
  userId: string;
  connectionId: string;
  claim: string;
  /** Aborts when the attempt's time budget is used up or the delivery is cancelled. */
  signal: AbortSignal;
  window: ReturnType<typeof syncWindow>;
  counts: { ingested: number; skipped: number };
}

/** null while the commit is in flight: its outcome is not known until the transaction returns. */
type SyncOutcome = { checkpointCommitted: boolean | null; checkpointAdvanced: boolean };

const checkDeadline = (run: SyncRun) => run.signal.throwIfAborted();

/** Proves this attempt still owns the sync before it does more work. */
async function heartbeat(run: SyncRun) {
  checkDeadline(run);
  await withOwnedSync(run.userId, run.connectionId, run.claim, async () => {
    checkDeadline(run);
  });
}

/** A history checkpoint is only trusted when it is recent and covers the user's lookback. */
function needsFullSync(
  connection: Awaited<ReturnType<typeof acquireSync>>['connection'],
  now: Date,
  lookbackDays: number,
) {
  const daysSinceLastSync = connection.lastSyncedAt
    ? (now.getTime() - connection.lastSyncedAt.getTime()) / DAY_MS
    : Infinity;
  return (
    !connection.lastHistoryId ||
    !connection.lastSyncedAt ||
    daysSinceLastSync > lookbackDays ||
    (connection.lastSyncedLookbackDays !== null && lookbackDays > connection.lastSyncedLookbackDays)
  );
}

/** The message's metadata, or null when Gmail no longer has it. */
async function fetchMessage(run: SyncRun, gmail: gmail_v1.Gmail, id: string) {
  try {
    const response = await gmail.users.messages.get(
      { userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] },
      gmailCallOptions(run.signal),
    );
    return response.data;
  } catch (err) {
    if (googleStatus(err) === 404) return null;
    throw err;
  }
}

/**
 * Saves one new inbox message from inside the sync window and offers it to AI. A message we
 * already have is not fetched again; it is only re-offered while it still waits.
 */
async function ingestMessage(
  run: SyncRun,
  gmail: gmail_v1.Gmail,
  id: string,
): Promise<'ingested' | 'skipped' | 'ignored'> {
  const { userId } = run;
  const existing = await prisma.email.findUnique({
    where: { userId_gmailMessageId: { userId, gmailMessageId: id } },
  });
  if (existing) {
    if (existing.processingState === 'PENDING') {
      await heartbeat(run);
      await enqueueForProcessing(userId, existing.id);
    }
    return 'skipped';
  }
  const message = await fetchMessage(run, gmail, id);
  if (!message?.labelIds?.includes('INBOX')) return 'ignored';
  const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : null;
  if (receivedAt && receivedAt < run.window.windowStart) return 'ignored';
  checkDeadline(run);
  const record = await withOwnedSync(userId, run.connectionId, run.claim, (tx) => {
    checkDeadline(run);
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
    await heartbeat(run);
    await enqueueForProcessing(userId, record.id);
  }
  return 'ingested';
}

async function ingestMessages(run: SyncRun, gmail: gmail_v1.Gmail, ids: string[]) {
  for (const id of new Set(ids)) {
    await heartbeat(run);
    const outcome = await ingestMessage(run, gmail, id);
    if (outcome === 'ingested') run.counts.ingested++;
    if (outcome === 'skipped') run.counts.skipped++;
  }
}

/** Scans the inbox for the whole sync window. Returns the checkpoint for the next sync. */
async function fullSync(run: SyncRun, gmail: gmail_v1.Gmail): Promise<string> {
  // Capture checkpoint BEFORE scanning so mail arriving during the scan remains discoverable.
  const profile = await gmail.users.getProfile({ userId: 'me' }, gmailCallOptions(run.signal));
  const baseline = profile.data.historyId;
  if (!baseline) throw new Error('Missing Gmail history checkpoint');
  let pageToken: string | undefined;
  do {
    await heartbeat(run);
    const page = await gmail.users.messages.list(
      {
        userId: 'me',
        labelIds: ['INBOX'],
        q: `newer_than:${run.window.windowDays}d`,
        maxResults: 100,
        pageToken,
      },
      gmailCallOptions(run.signal),
    );
    await ingestMessages(
      run,
      gmail,
      (page.data.messages ?? []).flatMap((m) => (m.id ? [m.id] : [])),
    );
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken);
  return baseline;
}

/** Message IDs that arrived in, or were moved into, the inbox. */
const inboxArrivals = (history: gmail_v1.Schema$History[]) =>
  history.flatMap((h) => [
    ...(h.messagesAdded ?? []).flatMap((m) => (m.message?.id ? [m.message.id] : [])),
    ...(h.labelsAdded ?? []).flatMap((m) =>
      m.labelIds?.includes('INBOX') && m.message?.id ? [m.message.id] : [],
    ),
  ]);

/**
 * Reads only what changed since the last checkpoint. Gmail forgets old checkpoints; when it
 * no longer knows ours, the attempt falls back to a full scan.
 */
async function incrementalSync(
  run: SyncRun,
  gmail: gmail_v1.Gmail,
  startHistoryId: string,
): Promise<string> {
  let pageToken: string | undefined;
  let latest = startHistoryId;
  do {
    await heartbeat(run);
    let page;
    try {
      page = await gmail.users.history.list(
        {
          userId: 'me',
          startHistoryId,
          historyTypes: ['messageAdded', 'labelAdded'],
          pageToken,
          maxResults: 100,
        },
        gmailCallOptions(run.signal),
      );
    } catch (err) {
      if (googleStatus(err) === 404) return fullSync(run, gmail);
      throw err;
    }
    await ingestMessages(run, gmail, inboxArrivals(page.data.history ?? []));
    latest = page.data.historyId ?? latest;
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken);
  return latest;
}

/** Records that a sync failed, but only if it still owns the connection. */
async function markSyncFailed(run: SyncRun, error: unknown) {
  const category = syncCategory(error);
  try {
    await withOwnedSync(run.userId, run.connectionId, run.claim, (tx) =>
      tx.gmailConnection.updateMany({
        where: { id: run.connectionId, userId: run.userId, syncClaim: run.claim },
        data: { syncState: 'FAILED', syncError: category, syncLeaseUntil: null },
      }),
    );
  } catch (markErr) {
    logDebug('gmail_sync_failure_state_skipped', {
      userId: run.userId,
      connectionId: run.connectionId,
      category,
      reason: syncCategory(markErr),
    });
  }
}

/** Persist the checkpoint after all page processing has succeeded. */
async function commitCheckpoint(
  run: SyncRun,
  historyId: string,
  outcome: SyncOutcome,
  startedAt: Date,
) {
  try {
    await withOwnedSync(run.userId, run.connectionId, run.claim, async (tx) => {
      checkDeadline(run);
      const updated = await tx.gmailConnection.updateMany({
        where: { id: run.connectionId, userId: run.userId, syncClaim: run.claim },
        data: {
          lastHistoryId: historyId,
          lastSyncedAt: startedAt,
          lastSyncedLookbackDays: run.window.windowDays,
          syncState: 'IDLE',
          syncError: null,
          syncLeaseUntil: null,
        },
      });
      if (updated.count !== 1) throw new SyncSupersededError();
    });
    outcome.checkpointCommitted = true;
    outcome.checkpointAdvanced = true;
  } catch (err) {
    outcome.checkpointCommitted = false;
    throw err;
  }
}

async function syncUser(userId: string, delivery: SyncDelivery = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const startedAt = new Date();
  const budget = setTimeout(() => controller.abort(new SyncDeadlineError()), SYNC_ATTEMPT_BUDGET_MS);
  budget.unref();
  const claim = randomUUID();
  let acquired: Awaited<ReturnType<typeof acquireSync>> | null = null;
  const outcome: SyncOutcome = { checkpointCommitted: null, checkpointAdvanced: false };
  const counts = { ingested: 0, skipped: 0 };
  let releaseSignal: (() => void) | undefined;
  const cleanup = () => {
    clearTimeout(budget);
    delivery.signal?.removeEventListener('abort', onDeliveryAbort);
    releaseSignal?.();
  };
  const onDeliveryAbort = () => controller.abort(new SyncCancelledError());
  if (delivery.signal?.aborted) onDeliveryAbort();
  else {
    delivery.signal?.addEventListener('abort', onDeliveryAbort, { once: true });
    releaseSignal = () => delivery.signal?.removeEventListener('abort', onDeliveryAbort);
  }
  const run: SyncRun = {
    userId,
    connectionId: '',
    claim,
    signal,
    window: syncWindow({ now: startedAt, lastSyncedAt: null, lookbackDays: 1 }),
    counts,
  };
  try {
    checkDeadline(run);
    acquired = await acquireSync(userId, claim);
    if (!acquired) throw new SyncInProgressError();
    run.connectionId = acquired.connection.id;
    run.window = syncWindow({
      now: startedAt,
      lastSyncedAt: acquired.connection.lastSyncedAt,
      lookbackDays: acquired.connection.syncLookbackDays,
    });
    const { connection } = acquired;
    const lookbackDays = connection.syncLookbackDays;
    await withGmail(userId, async (gmail) => {
      checkDeadline(run);
      let historyId: string;
      if (needsFullSync(connection, startedAt, lookbackDays)) {
        historyId = await fullSync(run, gmail);
      } else {
        historyId = await incrementalSync(run, gmail, connection.lastHistoryId!);
      }
      await heartbeat(run);
      await commitCheckpoint(run, historyId, outcome, startedAt);
    }, signal);
    logEvent('gmail_sync_completed', {
      userId,
      connectionId: run.connectionId,
      trigger: delivery.trigger ?? 'manual',
      jobId: delivery.jobId,
      retryCount: delivery.retryCount,
      retryLimit: delivery.retryLimit,
      windowDays: run.window.windowDays,
      ingested: counts.ingested,
      skipped: counts.skipped,
      checkpointAdvanced: outcome.checkpointAdvanced,
    });
    return {
      success: true,
      ...counts,
      windowDays: run.window.windowDays,
      checkpointAdvanced: outcome.checkpointAdvanced,
    };
  } catch (error) {
    const category = syncCategory(error);
    const canRetry = category !== 'AUTH_REVOKED' && category !== 'SUPERSEDED';
    if (acquired && !(error instanceof SyncInProgressError)) await markSyncFailed(run, error);
    logError('gmail_sync_failed', {
      userId,
      connectionId: acquired?.connection.id,
      trigger: delivery.trigger ?? 'manual',
      jobId: delivery.jobId,
      retryCount: delivery.retryCount,
      retryLimit: delivery.retryLimit,
      category,
      canRetry,
      checkpointCommitted: outcome.checkpointCommitted,
      checkpointAdvanced: outcome.checkpointAdvanced,
    });
    if (error instanceof SyncSupersededError || error instanceof SyncDeadlineError || error instanceof SyncCancelledError) throw error;
    if (error instanceof SyncInProgressError) throw error;
    if (error instanceof GmailAuthError || googleAuthFailure(error)) {
      throw new GmailAuthError();
    }
    throw error;
  } finally {
    cleanup();
  }
}

export async function syncNow(userId: string, delivery: SyncDelivery = {}) {
  return syncUser(userId, delivery);
}

export async function syncWithRetry(userId: string, delivery: SyncDelivery = {}) {
  const maxRetries = Math.min(5, Math.max(0, delivery.retryLimit ?? 2));
  const retries = Math.max(0, delivery.retryCount ?? 0);
  try {
    return await syncUser(userId, delivery);
  } catch (error) {
    const category = syncCategory(error);
    const retryable = category !== 'AUTH_REVOKED' && category !== 'SUPERSEDED';
    if (retryable && retries < maxRetries) {
      const delay = Math.min(60_000, 1000 * 2 ** retries);
      logDebug('gmail_sync_retry_scheduled', {
        userId,
        jobId: delivery.jobId,
        retryCount: retries + 1,
        retryLimit: maxRetries,
        delayMs: delay,
        category,
      });
      throw error;
    }
    if (error instanceof GmailAuthError || googleAuthFailure(error)) {
      throw new GmailAuthError();
    }
    throw error;
  }
}

export async function syncUserWithRetry(userId: string, delivery: SyncDelivery = {}) {
  return syncWithRetry(userId, delivery);
}
