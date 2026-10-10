import { prisma } from '../db/prisma';

/**
 * The user for a verified Google identity: the one already linked to it, else the account with
 * the same email (linked now), else a new user.
 */
export async function findOrCreateGoogleUser(googleId: string, email: string, name: string | null) {
  const linked = await prisma.user.findUnique({ where: { googleId } });
  if (linked) {
    if (linked.name || !name) return linked;
    return prisma.user.update({ where: { id: linked.id }, data: { name } });
  }

  const sameEmail = await prisma.user.findUnique({ where: { email } });
  if (!sameEmail) return prisma.user.create({ data: { googleId, email, name } });
  if (sameEmail.googleId && sameEmail.googleId !== googleId)
    throw new Error('Identity already linked');
  return prisma.user.update({
    // Preserve the identity check if two verified grants race to link an account.
    where: { id: sameEmail.id, OR: [{ googleId: null }, { googleId }] },
    data: { googleId, name: sameEmail.name || name },
  });
}

/** What a signed-in user may see about their own account; null when the user was deleted. */
export function getUserProfile(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });
}
