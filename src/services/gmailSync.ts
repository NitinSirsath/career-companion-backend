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
import { noteSentForReading } from './replyReading';
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
  counts: { ingested: number; skipped: number; sent: number };
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

type SentRef = { id: string; threadId: string };

const sentRef = (m: gmail_v1.Schema$Message): SentRef[] =>
  m.id && m.threadId ? [{ id: m.id, threadId: m.threadId }] : [];

/** Sent by the user and not also delivered to their own inbox. */
const isSentOnly = (m: gmail_v1.Schema$Message) =>
  !!m.labelIds?.includes('SENT') && !m.labelIds.includes('INBOX');

/**
 * Notes the user's own messages in conversations we already hold, so a conversation can show
 * that the user replied. Only IDs and the sent time are stored, never the content. A sent message
 * is never classified or matched; in a conversation with an open ask, the AI reads its new text
 * once to see what it answers (`replyReading.ts`, owner 24 Oct 2026).
 */
async function recordSentMessages(run: SyncRun, gmail: gmail_v1.Gmail, refs: SentRef[]) {
  if (!refs.length) return;
  const { userId } = run;
  const held = await prisma.email.findMany({
    where: { userId, threadId: { in: refs.map((ref) => ref.threadId) } },
    select: { threadId: true },
    distinct: ['threadId'],
  });
  const heldThreads = new Set(held.map((email) => email.threadId));
  const recorded = await prisma.outgoingEmail.findMany({
    where: { userId, gmailMessageId: { in: refs.map((ref) => ref.id) } },
    select: { gmailMessageId: true },
  });
  const known = new Set(recorded.map((sent) => sent.gmailMessageId));
  for (const ref of refs) {
    if (!heldThreads.has(ref.threadId) || known.has(ref.id)) continue;
    known.add(ref.id);
    await heartbeat(run);
    const message = await fetchMessage(run, gmail, ref.id);
    const sentAt = message?.internalDate ? new Date(Number(message.internalDate)) : null;
    if (!message || !isSentOnly(message) || !sentAt || isNaN(sentAt.getTime())) continue;
    checkDeadline(run);
    const recorded = await withOwnedSync(userId, run.connectionId, run.claim, (tx) => {
      checkDeadline(run);
      return tx.outgoingEmail.upsert({
        where: { userId_gmailMessageId: { userId, gmailMessageId: ref.id } },
        create: { userId, gmailMessageId: ref.id, threadId: ref.threadId, sentAt },
        update: {},
      });
    });
    await noteSentForReading(userId, recorded.id);
    run.counts.sent++;
  }
}

/** Reads the sent mail of the sync window. Skipped while we hold no conversation to reply to. */
async function scanSentMail(run: SyncRun, gmail: gmail_v1.Gmail) {
  const anyThread = await prisma.email.findFirst({
    where: { userId: run.userId, threadId: { not: null } },
    select: { id: true },
  });
  if (!anyThread) return;
  let pageToken: string | undefined;
  do {
    await heartbeat(run);
    const page = await gmail.users.messages.list(
      {
        userId: 'me',
        labelIds: ['SENT'],
        q: `newer_than:${run.window.windowDays}d`,
        maxResults: 100,
        pageToken,
      },
      gmailCallOptions(run.signal),
    );
    await recordSentMessages(run, gmail, (page.data.messages ?? []).flatMap(sentRef));
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken);
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
  await scanSentMail(run, gmail);
  return baseline;
}

/** Message IDs that arrived in, or were moved into, the inbox. */
const inboxArrivals = (history: gmail_v1.Schema$History[]) =>
  history.flatMap((h) => [
    ...(h.messagesAdded ?? []).flatMap((m) =>
      m.message?.id && !isSentOnly(m.message) ? [m.message.id] : [],
    ),
    ...(h.labelsAdded ?? []).flatMap((m) =>
      m.labelIds?.includes('INBOX') && m.message?.id ? [m.message.id] : [],
    ),
  ]);

/** Messages the user sent since the last checkpoint. */
const sentArrivals = (history: gmail_v1.Schema$History[]) =>
  history.flatMap((h) =>
    (h.messagesAdded ?? []).flatMap((m) =>
      m.message && isSentOnly(m.message) ? sentRef(m.message) : [],
    ),
  );

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
    // After the inbox, so a reply to mail from this same page finds its conversation.
    await recordSentMessages(run, gmail, sentArrivals(page.data.history ?? []));
    latest = page.data.historyId ?? latest;
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken);
  return latest;
}

/** Saves the new checkpoint and releases the sync, only if this attempt still owns it. */
async function commitCheckpoint(
  run: SyncRun,
  outcome: SyncOutcome,
  checkpoint: { historyId: string; lastSyncedAt: Date; lookbackDays: number },
) {
  const { userId, connectionId, claim, window } = run;
  const committed = await withOwnedSync(userId, connectionId, claim, (tx) => {
    checkDeadline(run);
    outcome.checkpointCommitted = null;
    return tx.gmailConnection.updateMany({
      where: { id: connectionId, userId, syncClaim: claim, status: 'CONNECTED' },
      data: {
        syncStatus: 'IDLE',
        syncClaim: null,
        syncLeaseUntil: null,
        lastHistoryId: checkpoint.historyId,
        lastSyncedAt: checkpoint.lastSyncedAt,
        lastSyncedLookbackDays: checkpoint.lookbackDays,
        ...(window.unscanned && {
          unscannedFrom: window.unscanned.from,
          unscannedUntil: window.unscanned.until,
        }),
      },
    });
  });
  if (committed.count !== 1) {
    outcome.checkpointCommitted = false;
    throw new SyncSupersededError();
  }
  outcome.checkpointCommitted = true;
}

/** An aborted attempt reports why it was aborted, not the error the abort surfaced as. */
function deliveryError(caught: unknown, signal?: AbortSignal, budget?: AbortSignal) {
  if (!signal?.aborted) return caught;
  return budget?.aborted && signal.reason === budget.reason
    ? new SyncDeadlineError()
    : new SyncCancelledError();
}

/** Hands the claim back to the queued request, so a retry of the same job can take it. */
async function markSyncFailed(
  userId: string,
  connectionId: string,
  claim: string,
  queuedClaim: string | undefined,
  error: unknown,
) {
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

export async function syncUser(userId: string, queuedClaim?: string, delivery: SyncDelivery = {}) {
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
  const outcome: SyncOutcome = { checkpointCommitted: false, checkpointAdvanced: false };
  const counts = { ingested: 0, skipped: 0, sent: 0 };
  let connectionId: string | undefined;
  let budget: AbortSignal | undefined;
  let signal: AbortSignal | undefined;
  try {
    const { connection, now } = await acquireSync(userId, queuedClaim, claim);
    budget = AbortSignal.timeout(SYNC_ATTEMPT_BUDGET_MS);
    signal = delivery.signal ? AbortSignal.any([delivery.signal, budget]) : budget;
    connectionId = connection.id;
    const lookbackDays = connection.syncLookbackDays || 1;
    const window = syncWindow({ now, lastSyncedAt: connection.lastSyncedAt, lookbackDays });
    const run: SyncRun = { userId, connectionId, claim, signal, window, counts };
    const startHistoryId = needsFullSync(connection, now, lookbackDays)
      ? null
      : connection.lastHistoryId;
    logDebug('gmail_sync_started', { ...context });
    const historyId = await withGmail(
      userId,
      (gmail) =>
        startHistoryId ? incrementalSync(run, gmail, startHistoryId) : fullSync(run, gmail),
      { signal },
    );
    // Recover the DB-insert / queue-send gap even when the history no longer returns that email,
    // and resume emails that waited for AI access.
    checkDeadline(run);
    await reofferPendingEmails(userId, () => heartbeat(run));
    await heartbeat(run);
    const lastSyncedAt = new Date();
    await commitCheckpoint(run, outcome, { historyId, lastSyncedAt, lookbackDays });
    outcome.checkpointAdvanced = historyId !== connection.lastHistoryId;
    logEvent('gmail_sync_completed', {
      ...context,
      ...outcome,
      windowDays: window.windowDays,
      gapCapped: window.unscanned !== null,
      userId,
      messagesIngested: counts.ingested,
      messagesSkipped: counts.skipped,
      sentRecorded: counts.sent,
      durationMs: Date.now() - started,
    });
    return {
      synced: true,
      messagesIngested: counts.ingested,
      messagesSkipped: counts.skipped,
      lastSyncedAt,
      checkpointAdvanced: outcome.checkpointAdvanced,
    };
  } catch (caught) {
    const error = deliveryError(caught, signal, budget);
    const superseded = error instanceof SyncSupersededError;
    if (superseded) outcome.checkpointCommitted = false;
    if (connectionId && !superseded)
      await markSyncFailed(userId, connectionId, claim, queuedClaim, error);
    const fields = {
      ...context,
      durationMs: Date.now() - started,
      ...outcome,
      category: syncCategory(error),
    };
    // A newer sync taking over is a normal outcome, not a failure.
    if (superseded) logEvent('gmail_sync_superseded', fields);
    else logError('gmail_sync_failed', fields);
    if (googleAuthFailure(error)) throw new GmailAuthError();
    throw error;
  }
}
