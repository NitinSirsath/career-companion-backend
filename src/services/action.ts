import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { prisma } from '../db/prisma';
import {
  ActionWithContextResponseSchema,
  CreateFollowUp,
  EditFollowUp,
  SnoozeAction,
} from '../contracts';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { AppError, CHANGE_REJECTED } from '../errors';
import { suppressNotifications } from './notificationSuppression';

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
const deadlineData = (value: CreateFollowUp['deadline']) => ({
  deadline: value
    ? new Date(value.precision === 'DATE' ? `${value.value}T00:00:00.000Z` : value.value)
    : null,
  deadlinePrecision: value?.precision ?? null,
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
export class ActionService {
  static async getUserActions(userId: string, status?: string, limit = 20, offset = 0) {
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
  static async updateActionStatus(userId: string, id: string, status: string, revision?: number) {
    return mutate(userId, id, revision, async (_tx, row) =>
      row.status === status
        ? {}
        : { status, ...(status !== 'PENDING' ? { snoozedUntil: null } : {}) },
    );
  }
  static async createFollowUp(userId: string, applicationId: string, request: CreateFollowUp) {
    const dates = deadlineData(request.deadline);
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          applicationId,
          description: request.description,
          deadline: dates.deadline?.toISOString() ?? null,
          precision: dates.deadlinePrecision,
        }),
      )
      .digest('hex');
    const replay = (row: ActionRow) => {
      if (row.creationPayloadHash !== hash)
        throw new AppError(409, 'REQUEST_CONFLICT', CHANGE_REJECTED);
      return serializeAction(row);
    };
    try {
      return await prisma.$transaction(async (tx) => {
        await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
        const existing = await tx.action.findUnique({
          where: { clientRequestId: request.clientRequestId },
          include: context,
        });
        if (existing) {
          if (!(await tx.application.findFirst({ where: { id: existing.applicationId, userId } })))
            throw new AppError(404, 'NOT_FOUND', 'Not found');
          return replay(existing);
        }
        await lockApplication(tx, userId, applicationId);
        return serializeAction(
          await tx.action.create({
            data: {
              applicationId,
              origin: 'USER',
              type: 'USER_FOLLOW_UP',
              description: request.description,
              clientRequestId: request.clientRequestId,
              creationPayloadHash: hash,
              ...dates,
            },
            include: context,
          }),
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.action.findFirst({
          where: { clientRequestId: request.clientRequestId, application: { userId } },
          include: context,
        });
        if (!existing) throw new AppError(404, 'NOT_FOUND', 'Not found');
        return replay(existing);
      }
      throw error;
    }
  }
  static async byRequest(userId: string, clientRequestId: string) {
    const row = await prisma.action.findFirst({
      where: { clientRequestId, application: { userId } },
      include: context,
    });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Not found');
    return serializeAction(row);
  }
  static async editFollowUp(userId: string, id: string, request: EditFollowUp) {
    const result = await mutate(userId, id, request.expectedActionRevision, async (_tx, row) => {
      if (row.origin !== 'USER' || row.emailId)
        throw new AppError(409, 'EMAIL_EVIDENCE_READ_ONLY', CHANGE_REJECTED);
      const dates = deadlineData(request.deadline);
      if (
        row.description === request.description &&
        row.deadline?.toISOString() === dates.deadline?.toISOString() &&
        row.deadlinePrecision === dates.deadlinePrecision
      )
        return {};
      return { description: request.description, ...dates };
    });
    if (!result) throw new AppError(404, 'NOT_FOUND', 'Not found');
    return result;
  }
  static async snooze(userId: string, id: string, request: SnoozeAction, now = new Date()) {
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
}
