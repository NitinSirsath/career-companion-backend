BEGIN;

-- CreateEnum
CREATE TYPE "AIOperationStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'RETRYABLE', 'FAILED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "gmail_connections" ADD COLUMN     "syncClaim" TEXT,
ADD COLUMN     "syncError" TEXT,
ADD COLUMN     "syncLeaseUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "notification_deliveries" ADD COLUMN     "claimedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ai_operations" (
    "id" UUID NOT NULL,
    "emailId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "AIOperationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "errorCode" TEXT,
    "retryAfter" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_call_budgets" (
    "day" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "cooldownUntil" TIMESTAMP(3),

    CONSTRAINT "ai_call_budgets_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE INDEX "ai_operations_status_retryAfter_idx" ON "ai_operations"("status", "retryAfter");

-- CreateIndex
CREATE UNIQUE INDEX "ai_operations_emailId_operation_version_key" ON "ai_operations"("emailId", "operation", "version");

-- AddForeignKey
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
