import { prisma } from '../db/prisma';
import { ArchiveApplication } from '../contracts/application';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { AppError, CHANGE_REJECTED } from '../errors';
import { getApplication } from './application';
import { suppressNotifications } from './notificationSuppression';
export async function archiveApplication(userId: string, id: string, request: ArchiveApplication) {
  return prisma.$transaction(async (tx) => {
    await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
    await tx.$queryRaw`SELECT id FROM applications WHERE id=${id}::uuid AND "userId"=${userId}::uuid FOR UPDATE`;
    const row = await tx.application.findFirst({ where: { id, userId } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Not found');
    if (row.archiveRevision !== request.expectedArchiveRevision)
      throw new AppError(409, 'REVISION_CONFLICT', CHANGE_REJECTED);
    if (Boolean(row.archivedAt) !== request.archived) {
      await tx.application.update({
        where: { id },
        data: {
          archivedAt: request.archived ? new Date() : null,
          archiveRevision: { increment: 1 },
        },
      });
      if (request.archived) {
        const actions = await tx.action.findMany({
          where: { applicationId: id, status: 'PENDING' },
          select: { id: true },
        });
        await suppressNotifications(
          tx,
          actions.map((a) => a.id),
        );
      }
    }
    return getApplication(userId, id, tx);
  });
}
