import { Prisma } from '@prisma/client';
/** Durable suppression prevents a delayed queue delivery or match replay after restore/wake.
 * Already claimed deliveries are rechecked before send; an external send in flight cannot retract. */
export async function suppressNotifications(tx: Prisma.TransactionClient, ids: string[]) {
  if (!ids.length) return;
  await tx.notificationDelivery.createMany({
    data: ids.map((actionId) => ({
      actionId,
      provider: 'DISCORD' as const,
      status: 'FAILED_PERMANENT' as const,
      errorDetails: 'USER_SUPPRESSED',
    })),
    skipDuplicates: true,
  });
  await tx.notificationDelivery.updateMany({
    where: {
      actionId: { in: ids },
      provider: 'DISCORD',
      claimedAt: null,
      status: { in: ['PENDING', 'FAILED_RETRYABLE'] },
    },
    data: { status: 'FAILED_PERMANENT', errorDetails: 'USER_SUPPRESSED' },
  });
}
