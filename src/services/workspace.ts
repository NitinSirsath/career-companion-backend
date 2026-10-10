import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import {
  WorkspaceActionsResponseSchema,
  WorkspaceReviewResponseSchema,
  WorkspaceBucket,
} from '../contracts';
import { serializeAction } from './action';
import { createPaginatedResponse } from '../utils/pagination';

/** All time predicates run in PostgreSQL against one instant and repeatable-read snapshot.
 * Prisma timestamps are UTC-encoded timestamp-without-time-zone; DATE components stay UTC.
 */
export async function readWorkspaceActions(
  userId: string,
  {
    bucket,
    timeZone,
    limit,
    offset,
  }: { bucket: WorkspaceBucket; timeZone: string; limit: number; offset: number },
  now = new Date(),
) {
  const instant = now.toISOString();
  const eligible = Prisma.sql`WITH clock AS (
    SELECT ${instant}::timestamptz AS instant,
      (${instant}::timestamptz AT TIME ZONE ${timeZone})::date AS today
  ), eligible AS (
    SELECT a.*, CASE
      WHEN a."snoozedUntil" > (c.instant AT TIME ZONE 'UTC') THEN 'snoozed'
      WHEN a.deadline IS NULL THEN 'undated'
      WHEN a."deadlinePrecision" = 'DATE' THEN CASE
        WHEN a.deadline::date < c.today THEN 'overdue'
        WHEN a.deadline::date = c.today THEN 'today' ELSE 'later' END
      WHEN a.deadline < (c.instant AT TIME ZONE 'UTC') THEN 'overdue'
      WHEN (a.deadline AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::date = c.today THEN 'today'
      ELSE 'later' END AS bucket
    FROM actions a JOIN applications app ON app.id = a."applicationId" CROSS JOIN clock c
    WHERE app."userId" = ${userId}::uuid AND a.status = 'PENDING' AND a."retiredAt" IS NULL AND app."archivedAt" IS NULL
  )`;
  return prisma.$transaction(
    async (tx) => {
      const [summary] = await tx.$queryRaw<
        Array<{
          overdue: number;
          today: number;
          later: number;
          undated: number;
          totalPending: number;
          snoozed: number;
          nextTransitionAt: Date | null;
        }>
      >(Prisma.sql`${eligible}
      SELECT COUNT(*) FILTER (WHERE bucket = 'overdue')::int AS overdue,
        COUNT(*) FILTER (WHERE bucket = 'today')::int AS today,
        COUNT(*) FILTER (WHERE bucket = 'later')::int AS later,
        COUNT(*) FILTER (WHERE bucket = 'undated')::int AS undated,
        COUNT(*) FILTER (WHERE bucket = 'snoozed')::int AS snoozed,
        COUNT(*)::int AS "totalPending",
        LEAST(
          MIN("snoozedUntil" AT TIME ZONE 'UTC') FILTER (WHERE bucket='snoozed'),
          MIN(deadline AT TIME ZONE 'UTC' + interval '1 millisecond') FILTER (
            WHERE "deadlinePrecision" IS DISTINCT FROM 'DATE'
            AND deadline >= (${instant}::timestamptz AT TIME ZONE 'UTC')),
          CASE WHEN COUNT(deadline) > 0 THEN
            (((SELECT today FROM clock) + 1)::timestamp AT TIME ZONE ${timeZone}) END
        ) AS "nextTransitionAt"
      FROM eligible`);
      const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`${eligible}
      SELECT id FROM eligible WHERE ((${bucket} = 'all' AND bucket <> 'snoozed') OR bucket = ${bucket})
      ORDER BY CASE bucket WHEN 'overdue' THEN 0 WHEN 'today' THEN 1 WHEN 'later' THEN 2 ELSE 3 END,
        deadline ASC NULLS LAST, "createdAt" ASC, id ASC
      LIMIT ${limit + 1} OFFSET ${offset}`);
      const rows = await tx.action.findMany({
        where: { id: { in: ids.map((row) => row.id) }, application: { userId } },
        include: {
          application: { select: { companyName: true, jobTitle: true } },
          email: { select: { subject: true, sender: true, threadId: true, gmailMessageId: true } },
        },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const items = ids.map(({ id }) => {
        const row = byId.get(id)!;
        return serializeAction(row);
      });
      const { nextTransitionAt, ...counts } = summary;
      return WorkspaceActionsResponseSchema.parse({
        ...createPaginatedResponse(items, limit, offset),
        counts,
        generatedAt: instant,
        timeZone,
        nextTransitionAt: nextTransitionAt?.toISOString() ?? null,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function readWorkspaceReview(userId: string, now = new Date()) {
  const [unmatched, ambiguous, pendingSubmissions] = await prisma.$transaction(
    [
      // Same eligibility as getUnmatchedEmails / getAmbiguousMatches.
      prisma.email.count({
        where: { userId, relevanceState: 'RELEVANT', matchState: 'UNMATCHED' },
      }),
      prisma.email.count({ where: { userId, matchState: 'AMBIGUOUS' } }),
      prisma.externalSubmission.count({ where: { userId, matchState: 'NEEDS_REVIEW' } }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return WorkspaceReviewResponseSchema.parse({
    generatedAt: now.toISOString(),
    unmatched,
    ambiguous,
    pendingSubmissions,
  });
}
