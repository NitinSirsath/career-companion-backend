import { NotificationProviderType, Prisma } from '@prisma/client';

/** Every channel a notification goes out on: Discord and push alerts. */
const PROVIDERS = Object.values(NotificationProviderType);

/** Durable suppression prevents a delayed queue delivery or match replay after restore/wake.
 * Already claimed deliveries are rechecked before send; an external send in flight cannot retract. */
export async function suppressNotifications(tx: Prisma.TransactionClient, ids: string[]) {
  if (!ids.length) return;
  await tx.notificationDelivery.createMany({
    data: ids.flatMap((actionId) =>
      PROVIDERS.map((provider) => ({
        actionId,
        provider,
        status: 'FAILED_PERMANENT' as const,
        errorDetails: 'USER_SUPPRESSED',
      })),
    ),
    skipDuplicates: true,
  });
  await tx.notificationDelivery.updateMany({
    where: {
      actionId: { in: ids },
      provider: { in: PROVIDERS },
      claimedAt: null,
      status: { in: ['PENDING', 'FAILED_RETRYABLE'] },
    },
    data: { status: 'FAILED_PERMANENT', errorDetails: 'USER_SUPPRESSED' },
  });
}
