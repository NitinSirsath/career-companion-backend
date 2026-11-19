-- Reanalyze (owner, 19 Nov 2026): the user asks the AI to read a conversation again.
-- CreateEnum
CREATE TYPE "ReanalysisState" AS ENUM ('QUEUED', 'RUNNING', 'SAVED', 'STOPPED');

-- AlterEnum
ALTER TYPE "RetiredReason" ADD VALUE 'REANALYZED';

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "declineNotedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "reanalysis_runs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID,
    "keys" TEXT[],
    "savedKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "state" "ReanalysisState" NOT NULL DEFAULT 'QUEUED',
    "stopReason" TEXT,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "gone" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "reanalysis_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reanalysis_runs_userId_createdAt_idx" ON "reanalysis_runs"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "reanalysis_runs" ADD CONSTRAINT "reanalysis_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
