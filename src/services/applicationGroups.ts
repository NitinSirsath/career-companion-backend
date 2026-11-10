import { ApplicationStatus, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApplicationFilters, ApplicationGroupsResponse } from '../contracts';

/** A NorthList Apply submission that is linked to, or created, an application. */
export const SETTLED = {
  matchState: { in: ['LINKED', 'CREATED'] },
} satisfies Prisma.ExternalSubmissionWhereInput;

// A reply is any status but APPLIED: a "we got your application" mail is not a reply.
const REPLY_STATUSES = [
  'RECRUITER_CONTACT',
  'ASSESSMENT',
  'INTERVIEW',
  'OFFER',
  'REJECTED',
  'CLOSED',
] satisfies ApplicationStatus[];

/** NorthList Apply applications that replied, or that are waiting (owner, 2026-11-10). */
function applyReplyFilter(reply: 'replied' | 'waiting'): Prisma.ApplicationWhereInput {
  if (reply === 'replied') {
    return {
      OR: [
        { userStatus: { in: REPLY_STATUSES } },
        { userStatus: null, aiStatus: { in: REPLY_STATUSES } },
      ],
    };
  }
  // Spelled out: NOT over nullable columns would drop the rows with no status.
  return {
    OR: [
      { userStatus: 'APPLIED' },
      { userStatus: null, aiStatus: null },
      { userStatus: null, aiStatus: 'APPLIED' },
    ],
  };
}

/** progress: all but NorthList Apply applications that are waiting; apply: those sent by it. */
export function groupFilters(
  userId: string,
  filters: Pick<ApplicationFilters, 'submittedVia' | 'group' | 'reply'>,
): Prisma.ApplicationWhereInput[] {
  const settled = { userId, ...SETTLED } satisfies Prisma.ExternalSubmissionWhereInput;
  const viaApply = {
    externalSubmissions: { some: settled },
  } satisfies Prisma.ApplicationWhereInput;
  return [
    ...(filters.submittedVia || filters.group === 'apply' || filters.reply ? [viaApply] : []),
    ...(filters.reply ? [applyReplyFilter(filters.reply)] : []),
    ...(filters.group === 'progress'
      ? [{ OR: [{ externalSubmissions: { none: settled } }, applyReplyFilter('replied')] }]
      : []),
  ];
}

export function archiveFilter(
  archive: ApplicationFilters['archive'],
): Prisma.ApplicationWhereInput {
  if (archive === 'all') return {};
  return { archivedAt: archive === 'archived' ? { not: null } : null };
}

/** Counts for the Applications switch and the NorthList Apply reply bar (owner, 2026-11-10). */
export async function countApplicationGroups(
  userId: string,
  archive: ApplicationFilters['archive'],
): Promise<ApplicationGroupsResponse> {
  const count = (filters: Pick<ApplicationFilters, 'group' | 'reply'>) =>
    prisma.application.count({
      where: { userId, ...archiveFilter(archive), AND: groupFilters(userId, filters) },
    });
  const [inProgress, total, replied] = await Promise.all([
    count({ group: 'progress' }),
    count({ group: 'apply' }),
    count({ group: 'apply', reply: 'replied' }),
  ]);
  return { inProgress, apply: { total, replied, waiting: total - replied } };
}
