/**
 * The one query behind every conversation view: job-related emails grouped by Gmail thread, with
 * where the newest request stands. Filtering and paging happen here, so a page is always full.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import type { ConversationFilters } from '../contracts/conversation';

type Db = Prisma.TransactionClient | typeof prisma;

export interface ConversationRow {
  /** The Gmail thread ID, or the email's own ID when Gmail gave no thread. */
  key: string;
  latestEmailId: string;
  lastReceivedAt: Date | null;
  category: string | null;
  /** The newest email that asks the user for something; null when none does. */
  requestEmailId: string | null;
  requestState: 'NONE' | 'OPEN' | 'REPLIED' | 'DONE';
  applicationId: string | null;
  mailCount: number;
  sentCount: number;
  lastSentAt: Date | null;
  isNew: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a conversation key has the shape of an email's own ID. */
export const isEmailId = (key: string) => UUID.test(key);

/** The stored emails of one conversation. */
export function conversationWhere(key: string): Prisma.EmailWhereInput {
  return UUID.test(key)
    ? { OR: [{ threadId: key }, { threadId: null, id: key }] }
    : { threadId: key };
}

/** The stored emails of several conversations. */
export function conversationsWhere(keys: string[]): Prisma.EmailWhereInput {
  return {
    OR: [
      { threadId: { in: keys } },
      { threadId: null, id: { in: keys.filter((key) => UUID.test(key)) } },
    ],
  };
}

const REQUEST_FILTER = { open: 'OPEN', replied: 'REPLIED', done: 'DONE', none: 'NONE' } as const;

function filterConditions(filters: ConversationFilters, pattern: string | null): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (pattern)
    conditions.push(
      Prisma.sql`(c.hit OR app."companyName" ILIKE ${pattern} OR app."jobTitle" ILIKE ${pattern})`,
    );
  if (filters.request)
    conditions.push(Prisma.sql`c."requestState" = ${REQUEST_FILTER[filters.request]}`);
  if (filters.category) conditions.push(Prisma.sql`c.category = ${filters.category}`);
  if (filters.unseen) conditions.push(Prisma.sql`c."isNew"`);
  if (filters.application === 'any') conditions.push(Prisma.sql`c."applicationId" IS NOT NULL`);
  else if (filters.application === 'none') conditions.push(Prisma.sql`c."applicationId" IS NULL`);
  else if (filters.application)
    conditions.push(Prisma.sql`c."applicationId" = ${filters.application}::uuid`);
  return conditions;
}

/**
 * Job-related emails grouped into conversations. A request is DONE when its application action
 * is finished, or, while it has no action, when the user marked it done; REPLIED when the user
 * sent a message after it, unless they reopened it later; otherwise OPEN.
 */
function conversationsCte(userId: string, hit: Prisma.Sql, onlyKey: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    WITH relevant AS (
      SELECT e.id, e."receivedAt", e."applicationId", e."matchState", e."seenAt",
             e."requestUserState", e."requestUserStateAt",
             COALESCE(e."threadId", e.id::text) AS key,
             r.category::text AS category,
             (COALESCE(r."actionRequired", FALSE) OR COALESCE(r."followUpRequired", FALSE)) AS asks,
             ${hit} AS hit
      FROM emails e
      LEFT JOIN ai_processing_results r ON r."emailId" = e.id
      WHERE e."userId" = ${userId}::uuid AND e."relevanceState" = 'RELEVANT' ${onlyKey}
    ),
    latest AS (
      SELECT DISTINCT ON (key) key, id AS "latestEmailId", "receivedAt" AS "lastReceivedAt"
      FROM relevant
      ORDER BY key, "receivedAt" DESC NULLS LAST, id DESC
    ),
    request AS (
      SELECT DISTINCT ON (key) key, id AS "requestEmailId", "receivedAt" AS "requestAt",
             "requestUserState", "requestUserStateAt"
      FROM relevant
      WHERE asks
      ORDER BY key, "receivedAt" DESC NULLS LAST, id DESC
    ),
    linked AS (
      SELECT DISTINCT ON (key) key, "applicationId"
      FROM relevant
      WHERE "matchState" = 'MATCHED' AND "applicationId" IS NOT NULL
      ORDER BY key, "receivedAt" DESC NULLS LAST, id DESC
    ),
    totals AS (
      SELECT key, COUNT(*)::int AS "mailCount", BOOL_OR("seenAt" IS NULL) AS "isNew",
             BOOL_OR(hit) AS hit,
             (ARRAY_AGG(category ORDER BY "receivedAt" DESC NULLS LAST, id DESC)
               FILTER (WHERE category IS NOT NULL))[1] AS category
      FROM relevant
      GROUP BY key
    ),
    sent AS (
      SELECT "threadId" AS key, MAX("sentAt") AS "lastSentAt", COUNT(*)::int AS "sentCount"
      FROM outgoing_emails
      WHERE "userId" = ${userId}::uuid
      GROUP BY "threadId"
    ),
    conversations AS (
      SELECT l.key, l."latestEmailId", l."lastReceivedAt", t.category, q."requestEmailId",
             k."applicationId", t."mailCount", t."isNew", t.hit, s."lastSentAt",
             COALESCE(s."sentCount", 0) AS "sentCount",
             CASE
               WHEN q."requestEmailId" IS NULL THEN 'NONE'
               WHEN a.status IN ('COMPLETED', 'DISMISSED') THEN 'DONE'
               WHEN a.status IS NULL AND q."requestUserState" = 'DONE' THEN 'DONE'
               WHEN s."lastSentAt" > q."requestAt" AND NOT COALESCE(
                 q."requestUserState" = 'OPEN' AND q."requestUserStateAt" > s."lastSentAt", FALSE
               ) THEN 'REPLIED'
               ELSE 'OPEN'
             END AS "requestState"
      FROM latest l
      JOIN totals t ON t.key = l.key
      LEFT JOIN request q ON q.key = l.key
      LEFT JOIN linked k ON k.key = l.key
      LEFT JOIN sent s ON s.key = l.key
      LEFT JOIN LATERAL (
        SELECT status FROM actions
        WHERE "emailId" = q."requestEmailId" AND "retiredAt" IS NULL
        ORDER BY "updatedAt" DESC, id DESC
        LIMIT 1
      ) a ON TRUE
    )`;
}

/**
 * When the user replied to each of these emails' requests: the newest message they sent in the
 * thread after the request arrived and before the conversation's next request did. For the newest
 * request that is the mail list's rule; an earlier one keeps the reply it got. A request the user
 * reopened after that reply has none.
 */
export async function repliedRequests(
  db: Db,
  userId: string,
  emails: { id: string; threadId: string | null }[],
): Promise<Map<string, Date>> {
  if (!emails.length) return new Map();
  const keys = [...new Set(emails.map((email) => email.threadId ?? email.id))];
  const rows = await db.$queryRaw<{ id: string; repliedAt: Date }[]>`
    WITH requests AS (
      SELECT e.id, e."threadId", e."receivedAt", e."requestUserState", e."requestUserStateAt",
             LEAD(e."receivedAt") OVER (
               PARTITION BY COALESCE(e."threadId", e.id::text)
               ORDER BY e."receivedAt" ASC NULLS FIRST, e.id ASC
             ) AS "nextRequestAt"
      FROM emails e
      JOIN ai_processing_results r ON r."emailId" = e.id
      WHERE e."userId" = ${userId}::uuid AND e."relevanceState" = 'RELEVANT'
        AND COALESCE(e."threadId", e.id::text) = ANY(${keys}::text[])
        AND (COALESCE(r."actionRequired", FALSE) OR COALESCE(r."followUpRequired", FALSE))
    )
    SELECT q.id, MAX(o."sentAt") AS "repliedAt"
    FROM requests q
    JOIN outgoing_emails o ON o."userId" = ${userId}::uuid AND o."threadId" = q."threadId"
      AND o."sentAt" > q."receivedAt"
      AND (q."nextRequestAt" IS NULL OR o."sentAt" < q."nextRequestAt")
    WHERE q.id = ANY(${emails.map((email) => email.id)}::uuid[])
    GROUP BY q.id, q."requestUserState", q."requestUserStateAt"
    HAVING NOT COALESCE(
      q."requestUserState" = 'OPEN' AND q."requestUserStateAt" > MAX(o."sentAt"), FALSE
    )`;
  return new Map(rows.map((row) => [row.id, row.repliedAt]));
}

/** One row per conversation, filtered, sorted and paged. */
export async function conversationRows(
  db: Db,
  userId: string,
  filters: ConversationFilters & { key?: string },
  page: { limit: number; offset: number } = { limit: 1, offset: 0 },
): Promise<ConversationRow[]> {
  // ILIKE treats %, _ and backslash as pattern characters: keep them literal.
  const pattern = filters.q ? `%${filters.q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const hit = pattern
    ? Prisma.sql`(e.subject ILIKE ${pattern} OR e.sender ILIKE ${pattern} OR r."companyName" ILIKE ${pattern} OR r."jobTitle" ILIKE ${pattern})`
    : Prisma.sql`TRUE`;
  const onlyKey = filters.key
    ? Prisma.sql`AND COALESCE(e."threadId", e.id::text) = ${filters.key}`
    : Prisma.empty;
  const conditions = filterConditions(filters, pattern);
  const where = conditions.length
    ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
    : Prisma.empty;
  const attentionFirst =
    filters.sort === 'newest' ? Prisma.empty : Prisma.sql`(c."requestState" = 'OPEN') DESC,`;

  return db.$queryRaw<ConversationRow[]>`
    ${conversationsCte(userId, hit, onlyKey)}
    SELECT c.key, c."latestEmailId", c."lastReceivedAt", c.category, c."requestEmailId",
           c."requestState", c."applicationId", c."mailCount", c."sentCount", c."lastSentAt",
           c."isNew"
    FROM conversations c
    LEFT JOIN applications app ON app.id = c."applicationId"
    ${where}
    ORDER BY ${attentionFirst} c."lastReceivedAt" DESC NULLS LAST, c.key DESC
    LIMIT ${page.limit} OFFSET ${page.offset}`;
}
