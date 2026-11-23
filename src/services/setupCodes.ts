/**
 * One-click setup of NorthList Apply (owner, 23 Nov 2026). The app's "Open in Codex / Claude Code"
 * buttons put a setup code in the link instead of a token: links stay in browser history, a code
 * that worked once for 10 minutes is worth nothing there.
 *
 * - One live code per user: making a new code ends the older unused ones.
 * - Only the SHA-256 hash of the code is stored; codes are compared without dashes or case.
 * - Swapping a code is one conditional update, so two swaps of the same code never both succeed.
 *   If the token cannot be made (for example the active-token limit), the code works again.
 * - Every refusal says the same thing, so a guess learns nothing about which codes exist.
 */
import crypto from 'crypto';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import {
  CreateSetupCodeRequestSchema,
  RedeemSetupCodeRequestSchema,
  SETUP_CODE_MINUTES,
  type CreateSetupCodeRequest,
  type CreateSetupCodeResponse,
  type RedeemSetupCodeRequest,
  type RedeemSetupCodeResponse,
} from '../contracts/integrationToken';
import { mcpServerAddress } from '../utils/config';
import { logEvent } from '../utils/log';
import { createIntegrationToken } from './integrationTokens';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MINUTE_MS = 60_000;
/** A year, as the Setup tab's own prompts (owner, 3 Nov 2026), so the setup is rarely redone. */
const TOKEN_DAYS = 365;

export const SETUP_CODE_REFUSED =
  'This setup code does not work any more. Create a new one in NorthList, under NorthList Apply › Setup.';

/** "nl-7q2x k9pd-…" and "NL7Q2XK9PD…" are the same code. */
const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code: string) =>
  crypto.createHash('sha256').update(normalize(code)).digest('hex');

function newCode(): string {
  const groups = [0, 1, 2].map(() =>
    Array.from(crypto.randomBytes(4), (b) => ALPHABET[b % ALPHABET.length]).join(''),
  );
  return `NL-${groups.join('-')}`;
}

export async function createSetupCode(
  userId: string,
  request: CreateSetupCodeRequest,
  now = new Date(),
): Promise<CreateSetupCodeResponse> {
  const { name } = CreateSetupCodeRequestSchema.parse(request);
  const code = newCode();
  const expiresAt = new Date(now.getTime() + SETUP_CODE_MINUTES * MINUTE_MS);
  await prisma.$transaction([
    prisma.setupCode.deleteMany({ where: { userId, usedAt: null } }),
    prisma.setupCode.create({
      data: { userId, codeHash: hashCode(code), name, createdAt: now, expiresAt },
    }),
  ]);
  logEvent('setup_code_created', { userId });
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function redeemSetupCode(
  request: RedeemSetupCodeRequest,
  now = new Date(),
): Promise<RedeemSetupCodeResponse> {
  const { code } = RedeemSetupCodeRequestSchema.parse(request);
  const serverAddress = mcpServerAddress();
  if (!serverAddress)
    throw new AppError(503, 'MCP_NOT_CONFIGURED', 'NorthList Apply cannot connect to this server.');
  const row = await prisma.setupCode.findUnique({ where: { codeHash: hashCode(code) } });
  const refuse = () => new AppError(400, 'SETUP_CODE_REFUSED', SETUP_CODE_REFUSED);
  if (!row || row.usedAt || row.expiresAt <= now) throw refuse();
  const claimed = await prisma.setupCode.updateMany({
    where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw refuse();
  try {
    const created = await createIntegrationToken(
      row.userId,
      { name: row.name, expiresInDays: TOKEN_DAYS },
      now,
    );
    logEvent('setup_code_redeemed', { userId: row.userId, tokenId: created.integrationToken.id });
    return {
      serverAddress,
      name: created.integrationToken.name,
      plaintextToken: created.plaintextToken,
      expiresAt: created.integrationToken.expiresAt,
    };
  } catch (error) {
    // No token was made: the code works again until it expires
    await prisma.setupCode.update({ where: { id: row.id }, data: { usedAt: null } });
    throw error;
  }
}
