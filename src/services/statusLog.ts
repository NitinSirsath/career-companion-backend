import { ApplicationStatus, Prisma, StatusChangeSource } from '@prisma/client';

type StatusPair = { aiStatus: ApplicationStatus | null; userStatus: ApplicationStatus | null };

/**
 * Records a change of the status the user sees (`userStatus ?? aiStatus`). A change the user's own
 * status hides (the AI moves on under it) is not a change for them, so it writes no row.
 */
export async function recordStatusChange(
  tx: Prisma.TransactionClient,
  change: {
    applicationId: string;
    before: StatusPair;
    after: StatusPair;
    source: StatusChangeSource;
    changedAt: Date;
    emailId?: string | null;
  },
) {
  const fromStatus = change.before.userStatus ?? change.before.aiStatus;
  const toStatus = change.after.userStatus ?? change.after.aiStatus;
  if (fromStatus === toStatus) return;
  await tx.statusChange.create({
    data: {
      applicationId: change.applicationId,
      emailId: change.emailId ?? null,
      source: change.source,
      fromStatus,
      toStatus,
      changedAt: change.changedAt,
    },
  });
}

/** The mail left these applications: the steps it brought there no longer count. */
export async function retireStatusChangesOfEmail(
  tx: Prisma.TransactionClient,
  emailId: string,
  applicationIds: string[],
) {
  if (!applicationIds.length) return;
  await tx.statusChange.updateMany({
    where: { emailId, applicationId: { in: applicationIds }, retiredAt: null },
    data: { retiredAt: new Date() },
  });
}
