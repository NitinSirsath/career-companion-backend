-- A log of every change of the status the user sees, for the Dashboard (owner, 27 Oct 2026).
-- New table, then a one-time fill for existing applications. No existing row changes and
-- nothing is sent to AI.

-- CreateEnum
CREATE TYPE "StatusChangeSource" AS ENUM ('AI', 'USER');

-- CreateTable
CREATE TABLE "status_changes" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "emailId" UUID,
    "source" "StatusChangeSource" NOT NULL,
    "fromStatus" "ApplicationStatus",
    "toStatus" "ApplicationStatus",
    "changedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "status_changes_applicationId_changedAt_idx" ON "status_changes"("applicationId", "changedAt");

-- CreateIndex
CREATE INDEX "status_changes_emailId_idx" ON "status_changes"("emailId");

-- AddForeignKey
ALTER TABLE "status_changes" ADD CONSTRAINT "status_changes_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_changes" ADD CONSTRAINT "status_changes_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Fill: replay each application's matched mails in the order they arrived, with the same rules
-- as inferState and canTransition in src/services/matcher.ts (the AI status only moves forward).
-- One AI row each time the AI status moved. Empty text counts as missing, as in the code.
WITH step AS (
    SELECT e."applicationId" AS app_id,
           e.id AS email_id,
           COALESCE(e."receivedAt", e."createdAt") AS at,
           CASE
               WHEN NULLIF(r."fakeOfferWarning", '') IS NOT NULL THEN NULL
               WHEN NULLIF(r."rejectionInfo", '') IS NOT NULL OR r.category = 'REJECTION' THEN 5
               WHEN NULLIF(r."offerInfo", '') IS NOT NULL OR r.category = 'OFFER' THEN 4
               WHEN NULLIF(r."interviewDate", '') IS NOT NULL OR r.category = 'INTERVIEW'
                    OR (NULLIF(r."interviewStage", '') IS NOT NULL
                        AND r.category IS DISTINCT FROM 'ASSESSMENT'
                        AND r.category IS DISTINCT FROM 'RECRUITER') THEN 3
               WHEN NULLIF(r."assessmentInfo", '') IS NOT NULL OR r.category = 'ASSESSMENT' THEN 2
               WHEN NULLIF(r."recruiterName", '') IS NOT NULL OR r.category = 'RECRUITER' THEN 1
               WHEN r.category = 'FOLLOW_UP' THEN 0
           END AS rank
    FROM "emails" e
    JOIN "ai_processing_results" r ON r."emailId" = e.id
    WHERE e."matchState" = 'MATCHED' AND e."applicationId" IS NOT NULL
),
running AS (
    SELECT app_id, email_id, at, rank,
           MAX(rank) OVER (PARTITION BY app_id ORDER BY at, email_id
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before_rank
    FROM step
    WHERE rank IS NOT NULL
),
names AS (
    SELECT * FROM (VALUES
        (0, 'APPLIED'), (1, 'RECRUITER_CONTACT'), (2, 'ASSESSMENT'),
        (3, 'INTERVIEW'), (4, 'OFFER'), (5, 'REJECTED')
    ) AS n(rank, status)
)
INSERT INTO "status_changes" ("id", "applicationId", "emailId", "source", "fromStatus", "toStatus", "changedAt")
SELECT gen_random_uuid(), r.app_id, r.email_id, 'AI',
       f.status::"ApplicationStatus", t.status::"ApplicationStatus", r.at
FROM running r
JOIN names t ON t.rank = r.rank
LEFT JOIN names f ON f.rank = r.before_rank
WHERE r.before_rank IS NULL OR r.rank > r.before_rank;

-- The user's own status, where they set one: one USER row at the time they set it.
INSERT INTO "status_changes" ("id", "applicationId", "source", "fromStatus", "toStatus", "changedAt")
SELECT gen_random_uuid(), a.id, 'USER', a."aiStatus", a."userStatus",
       COALESCE(a."userStatusSetAt", a."updatedAt")
FROM "applications" a
WHERE a."userStatus" IS NOT NULL AND a."userStatus" IS DISTINCT FROM a."aiStatus";
