import type { AdminInvite, InviteRequest } from '../contracts/invites';
import { prisma } from '../db/prisma';
import { AppError } from '../errors';
import { logEvent } from '../utils/log';

/** Requests kept at most: a flood from many addresses cannot fill the database. */
export const RELEASE_INVITES_MAX = 5000;

/**
 * Saves a request for an invite. The same email again changes nothing (the first answer and date
 * stay); the caller gets the same answer either way. No email is logged.
 */
export async function saveReleaseInvite(input: InviteRequest) {
  const known = await prisma.releaseInvite.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (known) {
    logEvent('release_invite_repeated');
    return;
  }
  if ((await prisma.releaseInvite.count()) >= RELEASE_INVITES_MAX) {
    logEvent('release_invite_refused', { reason: 'list_full' });
    throw new AppError(
      503,
      'INVITE_LIST_FULL',
      'We could not save your request. Write to us instead.',
    );
  }
  // Two requests with the same email at once: the second one finds the first and changes nothing.
  await prisma.releaseInvite.createMany({
    data: [{ email: input.email, source: input.source, otherSource: input.otherSource ?? null }],
    skipDuplicates: true,
  });
  logEvent('release_invite_saved', { source: input.source });
}

/** Every request, newest first, for the Admin page. */
export async function listReleaseInvites(): Promise<AdminInvite[]> {
  const rows = await prisma.releaseInvite.findMany({
    orderBy: [{ createdAt: 'desc' }, { email: 'asc' }],
    select: { email: true, source: true, otherSource: true, createdAt: true },
  });
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
