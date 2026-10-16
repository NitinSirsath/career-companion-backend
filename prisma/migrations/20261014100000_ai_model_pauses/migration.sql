-- Each model pauses on its own: a busy Gemini 3.8 Flash no longer stops Gemini 3.5 Flash-Lite.
-- Key, billing and model problems stay on the user's configuration.

CREATE TABLE "ai_model_pauses" (
    "userId" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "reason" "AIAccessIssue" NOT NULL,
    "resumesAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "testEmailId" UUID,
    "testStartedAt" TIMESTAMP(3),
    "testResult" TEXT,

    CONSTRAINT "ai_model_pauses_pkey" PRIMARY KEY ("userId","model"),
    CONSTRAINT "ai_model_pauses_model_check" CHECK ("model" <> ''),
    CONSTRAINT "ai_model_pauses_counters_check" CHECK ("consecutiveFailures" >= 0)
);

ALTER TABLE "ai_model_pauses" ADD CONSTRAINT "ai_model_pauses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ai_configurations"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Today's single pause and its failure count move onto the user's current Detailed model. A
-- configuration with no Detailed model follows the catalog's recommended one.
INSERT INTO "ai_model_pauses" ("userId", "model", "reason", "resumesAt", "consecutiveFailures")
SELECT "userId", "model", "reason", "cooldownUntil", "consecutiveFailures"
FROM (
    SELECT "userId",
           COALESCE("detailedModel", CASE "provider"
               WHEN 'gemini' THEN 'gemini-3.8-flash'
               WHEN 'openai' THEN 'gpt-5-mini'
               WHEN 'anthropic' THEN 'claude-haiku-4-5-20251001'
           END) AS "model",
           CASE WHEN "accessIssue" IN ('RATE_LIMITED', 'PROVIDER_BUSY', 'PROVIDER_UNAVAILABLE')
               THEN "accessIssue"
               ELSE 'RATE_LIMITED'::"AIAccessIssue"
           END AS "reason",
           "cooldownUntil",
           "consecutiveFailures"
    FROM "ai_configurations"
    WHERE "cooldownUntil" IS NOT NULL
       OR "consecutiveFailures" > 0
       OR "accessIssue" IN ('RATE_LIMITED', 'PROVIDER_BUSY', 'PROVIDER_UNAVAILABLE')
) AS "moved"
WHERE "model" IS NOT NULL;

UPDATE "ai_configurations" SET "accessIssue" = NULL, "accessIssueModel" = NULL
WHERE "accessIssue" IN ('RATE_LIMITED', 'PROVIDER_BUSY', 'PROVIDER_UNAVAILABLE');

-- The counters check covered the failure count too. It is made again for the revision alone.
ALTER TABLE "ai_configurations" DROP CONSTRAINT "ai_configurations_counters_check";

ALTER TABLE "ai_configurations" DROP COLUMN "consecutiveFailures",
DROP COLUMN "cooldownUntil";

ALTER TABLE "ai_configurations" ADD CONSTRAINT "ai_configurations_counters_check" CHECK ("revision" >= 0);
