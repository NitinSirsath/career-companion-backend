import type { UserProfile } from '../contracts/auth';
import { prisma } from '../db/prisma';
import { LOCK_NAMESPACE, lockUser } from '../utils/advisoryLock';
import { betaUserLimit, testAccounts } from '../utils/config';
import { isTestAccountEmail } from './testAccounts';

/** A new account was refused: the beta has all its places (`BETA_USER_LIMIT`). */
export class BetaFullError extends Error {
  constructor() {
    super('The beta is full');
    this.name = 'BetaFullError';
  }
}

/**
 * Creates a user unless the real accounts (test accounts left out) already reach the beta limit.
 * The count and the create share one lock, so two sign-ups at once cannot both take the last place.
 */
async function createWithinBetaLimit(data: {
  googleId: string;
  email: string;
  name: string | null;
}) {
  const limit = betaUserLimit();
  if (limit === 0) return prisma.user.create({ data });
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.newAccounts, 'all');
    const testEmails = testAccounts().map((account) => account.email);
    const accounts = await tx.user.count({ where: { email: { notIn: testEmails } } });
    if (accounts >= limit) throw new BetaFullError();
    return tx.user.create({ data });
  });
}

/**
 * The user for a verified Google identity: the one already linked to it, else the account with
 * the same email (linked now), else a new user while the beta has places (else `BetaFullError`).
 */
export async function findOrCreateGoogleUser(googleId: string, email: string, name: string | null) {
  const linked = await prisma.user.findUnique({ where: { googleId } });
  if (linked) {
    if (linked.name || !name) return linked;
    return prisma.user.update({ where: { id: linked.id }, data: { name } });
  }

  const sameEmail = await prisma.user.findUnique({ where: { email } });
  if (!sameEmail) return createWithinBetaLimit({ googleId, email, name });
  if (sameEmail.googleId && sameEmail.googleId !== googleId)
    throw new Error('Identity already linked');
  return prisma.user.update({
    // Preserve the identity check if two verified grants race to link an account.
    where: { id: sameEmail.id, OR: [{ googleId: null }, { googleId }] },
    data: { googleId, name: sameEmail.name || name },
  });
}

/** What a signed-in user may see about their own account; null when the user was deleted. */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, passwordHash: true, googleId: true },
  });
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    hasPassword: user.passwordHash !== null,
    hasGoogle: user.googleId !== null,
    testAccount: isTestAccountEmail(user.email),
  };
}
