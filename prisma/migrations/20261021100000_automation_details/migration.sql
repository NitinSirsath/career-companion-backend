-- Full automation details (ADR-0002 amendment, 21 Oct 2026): each submission also keeps the
-- apply page link, the resume file name and the submitted answers; jobs the automation did not
-- apply to are kept apart from applications and never become one.

-- CreateEnum
CREATE TYPE "NotSubmittedOutcome" AS ENUM ('SKIPPED', 'NEEDS_USER');

-- AlterTable
ALTER TABLE "external_submissions" ADD COLUMN     "applyUrl" TEXT,
ADD COLUMN     "resumeFilename" TEXT,
ADD COLUMN     "submittedAnswers" JSONB;

-- CreateTable
CREATE TABLE "not_submitted_jobs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "source" "ExternalSubmissionSource" NOT NULL,
    "sourceRecordRef" TEXT NOT NULL,
    "outcome" "NotSubmittedOutcome" NOT NULL,
    "platform" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "jobUrl" TEXT,
    "reason" TEXT NOT NULL,
    "loggedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenId" UUID,

    CONSTRAINT "not_submitted_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "not_submitted_jobs_userId_loggedAt_idx" ON "not_submitted_jobs"("userId", "loggedAt");

-- CreateIndex
CREATE INDEX "not_submitted_jobs_userId_receivedAt_idx" ON "not_submitted_jobs"("userId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "not_submitted_jobs_userId_source_sourceRecordRef_key" ON "not_submitted_jobs"("userId", "source", "sourceRecordRef");

-- AddForeignKey
ALTER TABLE "not_submitted_jobs" ADD CONSTRAINT "not_submitted_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "not_submitted_jobs" ADD CONSTRAINT "not_submitted_jobs_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "integration_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
