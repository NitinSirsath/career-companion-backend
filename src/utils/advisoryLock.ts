import { Prisma } from '@prisma/client';

/**
 * Namespaces for per-user transaction advisory locks. The two-key form
 * `pg_advisory_xact_lock(namespace, hashtext(userId))` cannot collide with single-key locks
 * (pg-boss, the smoke lane), because Postgres keeps the two forms apart.
 */
export const LOCK_NAMESPACE = {
  /** MCP submission intake and review resolution (ADR-0002 decision 7). */
  externalSubmissions: 0x4d435001,
  /** Integration token creation, to enforce the active-token limit. */
  integrationTokens: 0x4d435002,
} as const;

/** Holds the lock until the surrounding transaction ends. */
export async function lockUser(
  tx: Prisma.TransactionClient,
  namespace: (typeof LOCK_NAMESPACE)[keyof typeof LOCK_NAMESPACE],
  userId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${namespace}::int, hashtext(${userId}))`;
}
