/**
 * Per-user integration tokens for the MCP endpoint (ADR-0002 decision 10; MCP-02).
 *
 * Format `ccmcp_` + 32 random bytes in base64url. Only the SHA-256 hash and a display prefix are
 * stored; the plaintext is returned once, by create, and never logged. Revoking keeps the row.
 */
import crypto from 'crypto';
import { IntegrationToken as TokenRow } from '@prisma/client';
import { prisma } from '../db/prisma';
import {
  CreateIntegrationTokenRequest,
  CreateIntegrationTokenRequestSchema,
  CreateIntegrationTokenResponse,
  INTEGRATION_TOKEN_MAX_ACTIVE,
  IntegrationToken,
  IntegrationTokenStatus,
} from '../contracts/integrationToken';
import { LOCK_NAMESPACE, lockUser } from '../utils/advisoryLock';

export const TOKEN_PREFIX = 'ccmcp_';
export const TOKEN_SCOPE = 'submissions:write';
const TOKEN_FORMAT = /^ccmcp_[A-Za-z0-9_-]{43}$/;
const DISPLAY_PREFIX_LENGTH = 12;
const DAY_MS = 86_400_000;

/** An expected, user-facing outcome of a token request. Never carries token material. */
export class IntegrationTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationTokenError';
  }
}

const hashToken = (plaintext: string) => crypto.createHash('sha256').update(plaintext).digest('hex');

function statusOf(row: Pick<TokenRow, 'expiresAt' | 'revokedAt'>, now: Date): IntegrationTokenStatus {
  if (row.revokedAt) return 'revoked';
  return row.expiresAt <= now ? 'expired' : 'active';
}

function toResponse(row: TokenRow, now = new Date()): IntegrationToken {
  return {
    id: row.id,
    name: row.name,
    displayPrefix: row.displayPrefix,
    scope: row.scope,
    status: statusOf(row, now),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

export async function createIntegrationToken(
  userId: string,
  request: CreateIntegrationTokenRequest,
  now = new Date(),
): Promise<CreateIntegrationTokenResponse> {
  const { name, expiresInDays } = CreateIntegrationTokenRequestSchema.parse(request);
  const plaintextToken = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const row = await prisma.$transaction(async (tx) => {
    // Serialise creation per user so concurrent requests cannot exceed the active-token limit.
    await lockUser(tx, LOCK_NAMESPACE.integrationTokens, userId);
    const active = await tx.integrationToken.count({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
    });
    if (active >= INTEGRATION_TOKEN_MAX_ACTIVE)
      throw new IntegrationTokenError(
        409,
        'TOKEN_LIMIT_REACHED',
        `You can have at most ${INTEGRATION_TOKEN_MAX_ACTIVE} active tokens. Revoke one first.`,
      );
    return tx.integrationToken.create({
      data: {
        userId,
        name,
        tokenHash: hashToken(plaintextToken),
        displayPrefix: plaintextToken.slice(0, DISPLAY_PREFIX_LENGTH),
        scope: TOKEN_SCOPE,
        createdAt: now,
        expiresAt: new Date(now.getTime() + expiresInDays * DAY_MS),
      },
    });
  });
  console.log(JSON.stringify({ event: 'integration_token_created', userId, tokenId: row.id, expiresInDays }));
  return { integrationToken: toResponse(row, now), plaintextToken };
}

export async function listIntegrationTokens(userId: string, limit: number, offset: number, now = new Date()) {
  const rows = await prisma.integrationToken.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    skip: offset,
  });
  return rows.map((row) => toResponse(row, now));
}

/** Immediate. Unknown or foreign IDs are 404; revoking a revoked token returns it unchanged. */
export async function revokeIntegrationToken(userId: string, id: string, now = new Date()): Promise<IntegrationToken> {
  const revoked = await prisma.integrationToken.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: now },
  });
  const row = await prisma.integrationToken.findFirst({ where: { id, userId } });
  if (!row) throw new IntegrationTokenError(404, 'NOT_FOUND', 'Token not found.');
  if (revoked.count) console.log(JSON.stringify({ event: 'integration_token_revoked', userId, tokenId: id }));
  return toResponse(row, now);
}

export interface VerifiedIntegrationToken {
  tokenId: string;
  userId: string;
  scope: string;
  expiresAt: Date;
}

/**
 * Returns the token's owner, or null for anything unusable. Malformed values are rejected before
 * any database lookup; a usable token records `lastUsedAt`. The presented value is never logged.
 */
export async function verifyIntegrationToken(
  presented: string,
  now = new Date(),
): Promise<VerifiedIntegrationToken | null> {
  if (!TOKEN_FORMAT.test(presented)) return null;
  const row = await prisma.integrationToken.findUnique({ where: { tokenHash: hashToken(presented) } });
  if (!row || statusOf(row, now) !== 'active') return null;
  await prisma.integrationToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { lastUsedAt: now } });
  return { tokenId: row.id, userId: row.userId, scope: row.scope, expiresAt: row.expiresAt };
}
