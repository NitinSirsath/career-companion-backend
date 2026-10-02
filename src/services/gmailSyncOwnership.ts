import { GmailConnection, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import {
  GmailAuthError,
  SyncBusyError,
  SyncInProgressError,
  SyncSupersededError,
} from './gmailSyncErrors';

const LEASE_MS = 5 * 60_000;
async function locked<T>(
  userId: string,
  work: (tx: Prisma.TransactionClient, row: GmailConnection | null, now: Date) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
      await tx.$queryRaw`SELECT id FROM gmail_connections WHERE "userId" = ${userId}::uuid FOR UPDATE`;
      const row = await tx.gmailConnection.findUnique({ where: { userId } });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      return work(tx, row, clock.now);
    },
    { maxWait: 5000, timeout: 10000 },
  );
}
export function acquireSync(userId: string, request: string | undefined, attempt: string) {
  return locked(userId, async (tx, row, now) => {
    if (row?.status === 'REVOKED') throw new GmailAuthError();
    if (!row || row.status !== 'CONNECTED') {
      if (request) throw new SyncSupersededError();
      throw new GmailAuthError('Gmail is not connected');
    }
    const live = row.syncLeaseUntil && row.syncLeaseUntil > now;
    if (request) {
      if (row.syncClaim !== request) {
        if (!row.syncClaim?.startsWith(`${request}:attempt:`)) throw new SyncSupersededError();
        if (live) throw new SyncBusyError();
      }
    } else if (row.syncStatus === 'SYNCING' && live) throw new SyncInProgressError();
    await tx.gmailConnection.update({
      where: { id: row.id, userId },
      data: {
        syncStatus: 'SYNCING',
        syncClaim: attempt,
        syncLeaseUntil: new Date(now.getTime() + LEASE_MS),
        syncError: null,
      },
    });
    return { connection: row, now };
  });
}
/** No Google call or queue send may run inside this callback. */
export function withOwnedSync<T>(
  userId: string,
  connectionId: string,
  attempt: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return locked(userId, async (tx, row, now) => {
    if (
      !row ||
      row.id !== connectionId ||
      row.status !== 'CONNECTED' ||
      row.syncClaim !== attempt ||
      !row.syncLeaseUntil ||
      row.syncLeaseUntil <= now
    )
      throw new SyncSupersededError();
    await tx.gmailConnection.update({
      where: { id: connectionId, userId },
      data: { syncLeaseUntil: new Date(now.getTime() + LEASE_MS) },
    });
    return work(tx);
  });
}
