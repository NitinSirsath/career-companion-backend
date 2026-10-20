/**
 * Test accounts (TEST_ACCOUNTS, see utils/config.ts): fixed accounts that sign in on their own
 * page and use the mail sandbox instead of Gmail, next to real users on the same deploy.
 * Passwords and hashes are never logged.
 */
import { prisma } from '../db/prisma';
import { devMode, testAccounts } from '../utils/config';
import { logEvent, logWarn } from '../utils/log';
import { hashPassword, verifyPassword } from '../utils/passwordHash';

export const isTestAccountEmail = (email: string): boolean =>
  testAccounts().some((account) => account.email === email.trim().toLowerCase());

/** True when the user's mailbox is the sandbox: everyone's in dev mode, else a test account's. */
export async function usesSandbox(userId: string): Promise<boolean> {
  if (devMode()) return true;
  if (!testAccounts().length) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user !== null && isTestAccountEmail(user.email);
}

/**
 * Creates each test account that is missing and gives it the password from the setting. Runs at
 * every start: the free Render plan has no command line to create them by hand. A changed
 * password also ends the account's sessions.
 */
export async function ensureTestAccounts(): Promise<void> {
  let created = 0;
  let updated = 0;
  for (const account of testAccounts()) {
    const user = await prisma.user.findFirst({
      where: { email: { equals: account.email, mode: 'insensitive' } },
    });
    if (user?.googleId) {
      logWarn('test_account_skipped', { reason: 'linked to a Google account' });
      continue;
    }
    if (!user) {
      await prisma.user.create({
        data: { email: account.email, passwordHash: await hashPassword(account.password) },
      });
      created += 1;
      continue;
    }
    if (user.passwordHash && (await verifyPassword(account.password, user.passwordHash))) continue;
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(account.password) },
    });
    await prisma.session.deleteMany({ where: { sess: { path: ['userId'], equals: user.id } } });
    updated += 1;
  }
  if (testAccounts().length) logEvent('test_accounts_ready', { created, updated });
}
