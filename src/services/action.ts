import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ActionWithContextResponseSchema, SnoozeAction } from '../contracts';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { AppError, CHANGE_REJECTED } from '../errors';
import { suppressNotifications } from './notificationSuppression';
import { CLOSES_BY_ITSELF, mayCloseByHand, OPEN_AGAIN } from './threadAsks';

/**
 * A step from a mail follows the mail's request, so the Mails page agrees: "done" by hand only
 * for a request done outside mail, which then closes as "you said you did it"; open again clears
 * why it closed. A dismissed step changes nothing on the mail.
 */
async function followRequest(tx: Prisma.TransactionClient, emailId: string, status: string) {
  const now = new Date();
  if (status === 'COMPLETED') {
    const read = await tx.aIProcessingResult.findUnique({
      where: { emailId },
      select: { askKind: true },
    });
    if (!mayCloseByHand(read?.askKind))
      throw new AppError(409, 'CLOSES_BY_ITSELF', CLOSES_BY_ITSELF);
    await tx.email.updateMany({
      where: { id: emailId, requestClosedReason: null },
      data: { requestClosedReason: 'YOU_SAID_DONE', requestClosedAt: now },
    });
    await tx.email.update({
      where: { id: emailId },
      data: { requestUserState: 'DONE', requestUserStateAt: now },
    });
  }
  if (status === 'PENDING')
    await tx.email.update({
      where: { id: emailId },
      data: { requestUserState: 'OPEN', requestUserStateAt: now, ...OPEN_AGAIN },
    });
}

const context = {
  application: { select: { companyName: true, jobTitle: true } },
  email: { select: { subject: true, sender: true, threadId: true, gmailMessageId: true } },
} as const;
type ActionRow = Prisma.ActionGetPayload<{ include: typeof context }>;
export const serializeAction = (row: ActionRow) =>
  ActionWithContextResponseSchema.parse({
    ...row,
    origin: row.origin ?? (row.emailId ? 'EMAIL' : null),
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    deadline: row.deadline?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
async function lockApplication(tx: Prisma.TransactionClient, userId: string, id: string) {
  await tx.$queryRaw`SELECT id FROM applications WHERE id=${id}::uuid AND "userId"=${userId}::uuid FOR UPDATE`;
  const row = await tx.application.findFirst({ where: { id, userId } });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Not found');
  if (row.archivedAt) throw new AppError(409, 'APPLICATION_ARCHIVED', CHANGE_REJECTED);
  return row;
}
async function mutate(
  userId: string,
  id: string,
  revision: number | undefined,
  change: (tx: Prisma.TransactionClient, row: ActionRow) => Promise<Prisma.ActionUpdateInput>,
) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    const initial = await tx.action.findFirst({ where: { id, application: { userId } } });
    if (!initial) return null;
    await lockApplication(tx, userId, initial.applicationId);
    await tx.$queryRaw`SELECT id FROM actions WHERE id=${id}::uuid FOR UPDATE`;
    const row = await tx.action.findUniqueOrThrow({ where: { id }, include: context });
    if (row.origin === 'USER' && revision === undefined)
      throw new AppError(400, 'REVISION_REQUIRED', CHANGE_REJECTED);
    if (revision !== undefined && revision !== row.actionRevision)
      throw new AppError(409, 'REVISION_CONFLICT', CHANGE_REJECTED);
    if (row.retiredAt) throw new AppError(409, 'ACTION_RETIRED', CHANGE_REJECTED);
    const data = await change(tx, row);
    if (!Object.keys(data).length) return serializeAction(row);
    return serializeAction(
      await tx.action.update({
        where: { id },
        data: { ...data, actionRevision: { increment: 1 } },
        include: context,
      }),
    );
  });
}
export async function getUserActions(userId: string, status?: string, limit = 20, offset = 0) {
  return (
    await prisma.action.findMany({
      where: {
        retiredAt: null,
        application: { userId, archivedAt: null },
        ...(status ? { status } : {}),
      },
      take: limit + 1,
      skip: offset,
      orderBy: [{ status: 'desc' }, { deadline: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: context,
    })
  ).map(serializeAction);
}
export async function updateActionStatus(
  userId: string,
  id: string,
  status: string,
  revision?: number,
) {
  return mutate(userId, id, revision, async (tx, row) => {
    if (row.status === status) return {};
    if (row.emailId) await followRequest(tx, row.emailId, status);
    return { status, ...(status !== 'PENDING' ? { snoozedUntil: null } : {}) };
  });
}
export async function snoozeAction(
  userId: string,
  id: string,
  request: SnoozeAction,
  now = new Date(),
) {
  const until = request.snoozedUntil ? new Date(request.snoozedUntil) : null;
  if (
    until &&
    (!Number.isFinite(until.getTime()) ||
      until <= now ||
      until.getTime() - now.getTime() > 365 * 86400000)
  )
    throw new AppError(400, 'INVALID_SNOOZE', CHANGE_REJECTED);
  const result = await mutate(userId, id, request.expectedActionRevision, async (tx, row) => {
    if (row.status !== 'PENDING') throw new AppError(409, 'ACTION_NOT_PENDING', CHANGE_REJECTED);
    if (row.snoozedUntil?.toISOString() === until?.toISOString()) return {};
    if (until) await suppressNotifications(tx, [id]);
    return { snoozedUntil: until };
  });
  if (!result) throw new AppError(404, 'NOT_FOUND', 'Not found');
  return result;
}
