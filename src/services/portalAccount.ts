/**
 * Company-portal accounts sent by the user's automation (owner, 21 Nov 2026; ADR-0002 amendment
 * 2026-11-21). NorthList Apply makes one account per Workday tenant or company portal and now sends
 * it with the application, so the user can sign in from NorthList.
 *
 * - One account per user, sign-in host and company: later applications reuse it, and a later send
 *   updates it (latest email, password and email check win; the date made is kept).
 * - The password is sealed with its own key (PORTAL_CREDENTIAL_ENCRYPTION_KEY, AES-256-GCM) and
 *   bound to its owner. Without that key the account is recorded with no password.
 * - The password is opened only in \`revealPortalPassword\`, for the owner, on request. It never
 *   appears in lists, logs, the tool answer or error messages.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { PortalAccount as PortalAccountView } from '../contracts/submission';
import { AppError } from '../errors';
import { prisma } from '../db/prisma';
import { portalCredentialEncryptionKey } from '../utils/config';
import { decrypt, encrypt } from '../utils/gmailTokenEncryption';

const FORMAT = 'v1';
export const PORTAL_PASSWORD_LIMIT = 200;

/** The tool's \`portalAccount\` field. Strict: unknown keys are rejected. */
export const PortalAccountInputSchema = z
  .strictObject({
    signInUrl: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .describe('Full http or https URL of the portal sign-in page'),
    loginEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    password: z
      .string()
      .min(1)
      .max(PORTAL_PASSWORD_LIMIT)
      .nullish()
      .describe(
        'The portal password, exactly as saved in the account record; leave out if unknown',
      ),
    emailVerified: z.boolean().nullish(),
    madeBy: z.enum(['northlist_apply', 'user']).nullish(),
    createdOn: z.iso.date().nullish().describe('YYYY-MM-DD, the date in the account record'),
  })
  .describe(
    'The company-portal account used for this application (Workday or another company portal). Leave out when no portal account was used.',
  );
export type PortalAccountInput = z.infer<typeof PortalAccountInputSchema>;

export interface CanonicalPortalAccount {
  signInUrl: string;
  signInHost: string;
  loginEmail: string;
  /** Plaintext only on its way to be sealed; never stored or logged as is. */
  password: string | null;
  emailVerified: boolean | null;
  madeBy: 'NORTHLIST_APPLY' | 'USER' | null;
  createdOn: Date | null;
}

const MADE_BY = { northlist_apply: 'NORTHLIST_APPLY', user: 'USER' } as const;

export function canonicalPortalAccount(input: PortalAccountInput): CanonicalPortalAccount {
  const url = new URL(input.signInUrl);
  url.hash = '';
  url.username = '';
  url.password = '';
  return {
    signInUrl: url.toString(),
    signInHost: url.hostname.toLowerCase(),
    loginEmail: input.loginEmail,
    password: input.password ?? null,
    emailVerified: input.emailVerified ?? null,
    madeBy: input.madeBy ? MADE_BY[input.madeBy] : null,
    createdOn: input.createdOn ? new Date(\`\${input.createdOn}T00:00:00Z\`) : null,
  };
}

// ─── Sealing ────────────────────────────────────────────────────────────────

/** Thrown when a sealed password cannot be opened. Carries no secret material. */
export class PortalPasswordUnreadableError extends Error {
  constructor() {
    super('Stored portal password cannot be read');
    this.name = 'PortalPasswordUnreadableError';
  }
}

/** The key, or null when the server has none (then passwords are not stored). */
function portalKey(): Buffer | null {
  const hex = portalCredentialEncryptionKey();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

export const portalPasswordsEnabled = () => portalKey() !== null;

const aad = (userId: string) => Buffer.from(\`portal-credential:\${FORMAT}:\${userId}\`, 'utf8');

/** null when the server has no key. */
export function sealPortalPassword(userId: string, password: string): string | null {
  const key = portalKey();
  if (!key) return null;
  const { iv, ciphertext } = encrypt(password, key, aad(userId));
  return \`\${FORMAT}:\${iv}:\${ciphertext}\`;
}

export function openPortalPassword(userId: string, sealed: string): string {
  const key = portalKey();
  const [format, iv, ciphertext, extra] = sealed.split(':');
  if (!key || format !== FORMAT || !iv || !ciphertext || extra !== undefined)
    throw new PortalPasswordUnreadableError();
  try {
    return decrypt(ciphertext, iv, key, aad(userId));
  } catch {
    throw new PortalPasswordUnreadableError();
  }
}

// ─── Storage ────────────────────────────────────────────────────────────────

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Creates or updates the user's account for this portal and company; returns its id. Called inside
 * the intake transaction, under the user's submission lock.
 */
export async function savePortalAccount(
  db: Db,
  userId: string,
  company: { name: string; key: string },
  account: CanonicalPortalAccount,
): Promise<string> {
  const sealed = account.password ? sealPortalPassword(userId, account.password) : null;
  const where = {
    userId_signInHost_companyKey: {
      userId,
      signInHost: account.signInHost,
      companyKey: company.key,
    },
  };
  const existing = await db.portalAccount.findUnique({
    where,
    select: { id: true, createdOn: true },
  });
  if (!existing) {
    const created = await db.portalAccount.create({
      data: {
        userId,
        companyKey: company.key,
        company: company.name,
        signInUrl: account.signInUrl,
        signInHost: account.signInHost,
        loginEmail: account.loginEmail,
        passwordSealed: sealed,
        emailVerified: account.emailVerified,
        madeBy: account.madeBy,
        createdOn: account.createdOn,
      },
      select: { id: true },
    });
    return created.id;
  }
  await db.portalAccount.update({
    where: { id: existing.id },
    data: {
      company: company.name,
      signInUrl: account.signInUrl,
      loginEmail: account.loginEmail,
      ...(sealed ? { passwordSealed: sealed } : {}),
      ...(account.emailVerified !== null ? { emailVerified: account.emailVerified } : {}),
      ...(account.madeBy ? { madeBy: account.madeBy } : {}),
      ...(existing.createdOn === null && account.createdOn ? { createdOn: account.createdOn } : {}),
    },
  });
  return existing.id;
}

/** Accounts no submission uses any more (their applications were deleted) go too. */
export async function removeUnusedPortalAccounts(db: Db, userId: string) {
  await db.portalAccount.deleteMany({ where: { userId, submissions: { none: {} } } });
}

/** What the application page shows: never the password, only whether one is stored. */
export const PORTAL_ACCOUNT_SELECT = {
  id: true,
  company: true,
  signInUrl: true,
  loginEmail: true,
  passwordSealed: true,
  emailVerified: true,
  madeBy: true,
  createdOn: true,
  _count: { select: { submissions: { where: { matchState: { in: ['LINKED', 'CREATED'] } } } } },
} as const satisfies Prisma.PortalAccountSelect;

type SelectedAccount = Prisma.PortalAccountGetPayload<{ select: typeof PORTAL_ACCOUNT_SELECT }>;

/** The contract view: \`hasPassword\` instead of the sealed value. */
export function portalAccountView(account: SelectedAccount): PortalAccountView {
  return {
    id: account.id,
    company: account.company,
    signInUrl: account.signInUrl,
    loginEmail: account.loginEmail,
    hasPassword: account.passwordSealed !== null,
    emailVerified: account.emailVerified,
    madeBy: account.madeBy,
    createdOn: account.createdOn ? account.createdOn.toISOString().slice(0, 10) : null,
    otherApplications: Math.max(0, account._count.submissions - 1),
  };
}

/** The owner's password for one account. 404 when the account is not theirs or has none. */
export async function revealPortalPassword(userId: string, accountId: string) {
  const account = await prisma.portalAccount.findFirst({
    where: { id: accountId, userId },
    select: { passwordSealed: true },
  });
  if (!account?.passwordSealed) throw new AppError(404, 'NOT_FOUND', 'No saved password.');
  return openPortalPassword(userId, account.passwordSealed);
}
