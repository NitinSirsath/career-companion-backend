-- BYO AI (ADR-0001), AI-05. Additive: two new tables and three nullable/defaulted columns.
-- The only change to existing rows is the documented provenance backfill below.
BEGIN;

-- CreateEnum
CREATE TYPE "AIAccessIssue" AS ENUM ('KEY_REJECTED', 'ACCOUNT_OR_BILLING', 'MODEL_UNAVAILABLE', 'KEY_UNREADABLE', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE');

-- AlterTable
ALTER TABLE "ai_operations" ADD COLUMN "provider" TEXT,
ADD COLUMN "model" TEXT,
ADD COLUMN "approvedRetries" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "ai_operations_approvedRetries_check" CHECK ("approvedRetries" >= 0);

-- Every call made before this migration went to the hosted Gemini key; the model was not recorded.
UPDATE "ai_operations" SET "provider" = 'gemini' WHERE "attempts" > 0;

-- CreateTable
CREATE TABLE "ai_configurations" (
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "fastModel" TEXT,
    "detailedModel" TEXT,
    "accessIssue" "AIAccessIssue",
    "accessIssueModel" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "consentDisclosure" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_configurations_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "ai_configurations_provider_check" CHECK ("provider" <> ''),
    CONSTRAINT "ai_configurations_encryptedApiKey_check" CHECK ("encryptedApiKey" LIKE 'v1:%'),
    CONSTRAINT "ai_configurations_counters_check" CHECK ("consecutiveFailures" >= 0 AND "revision" >= 0)
);

-- CreateTable
CREATE TABLE "ai_usage_days" (
    "userId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "verifications" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_days_pkey" PRIMARY KEY ("userId","day"),
    CONSTRAINT "ai_usage_days_counters_check" CHECK ("calls" >= 0 AND "inputTokens" >= 0 AND "outputTokens" >= 0 AND "verifications" >= 0),
    CONSTRAINT "ai_usage_days_day_check" CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$')
);

-- AddForeignKey
ALTER TABLE "ai_configurations" ADD CONSTRAINT "ai_configurations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_days" ADD CONSTRAINT "ai_usage_days_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
