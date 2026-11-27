/**
 * Keeps AI statuses in step with today's rule on what a mail shows (owner, 27 Nov 2026): the offer
 * and test details of a confirmation or a recruiter's mail are not a step (`DESCRIBES_THE_JOB`).
 * Every hour and when the server starts, an application such a mail gave an Assessment or an Offer
 * gets its AI status and its history worked out again from its mails, as Reanalyze does, so the
 * status lists and the Dashboard show what the mails show. Safe to run again: an application in
 * step writes nothing.
 */
import { prisma } from '../db/prisma';
import { lockUser, LOCK_NAMESPACE } from '../utils/advisoryLock';
import { logEvent } from '../utils/log';
import { DESCRIBES_THE_JOB } from './matcher';
import { rebuildAiStatus } from './reanalysisSave';

/** The steps a mail's offer or test details alone used to give. */
const DETAIL_STEPS = ['ASSESSMENT', 'OFFER'] as const;

/** Returns how many applications now show another status. */
export async function tidyAllStatuses() {
  const describesTheJob = { category: { in: [...DESCRIBES_THE_JOB] } };
  const apps = await prisma.application.findMany({
    where: {
      OR: [
        // A step in the history that such a mail gave.
        {
          statusChanges: {
            some: {
              source: 'AI',
              retiredAt: null,
              toStatus: { in: [...DETAIL_STEPS] },
              email: { aiProcessingResult: { is: describesTheJob } },
            },
          },
        },
        // The AI status, also when the user's own status hides it and no history row was written.
        {
          aiStatus: { in: [...DETAIL_STEPS] },
          emails: {
            some: {
              matchState: 'MATCHED',
              aiProcessingResult: {
                is: {
                  ...describesTheJob,
                  OR: [{ offerInfo: { not: null } }, { assessmentInfo: { not: null } }],
                },
              },
            },
          },
        },
      ],
    },
    select: { id: true, userId: true },
  });
  let changed = 0;
  for (const { id, userId } of apps) {
    const shown = await prisma.$transaction(async (tx) => {
      // The lock matching uses, so a mail linked meanwhile is not undone.
      await lockUser(tx, LOCK_NAMESPACE.emailMatches, userId);
      const app = await tx.application.findUnique({ where: { id } });
      return !!app && (await rebuildAiStatus(tx, app, new Date()));
    });
    if (shown) changed++;
  }
  if (changed) logEvent('statuses_rebuilt', { changed });
  return changed;
}
