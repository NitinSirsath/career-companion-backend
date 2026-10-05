-- COM-125 relevance batch ledger. Additive only.
CREATE TYPE "AIBatchStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'REFUSED', 'FAILED', 'UNKNOWN');

CREATE TABLE "ai_batches" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "operation" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "status" "AIBatchStatus" NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_batches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_batches_userId_createdAt_idx" ON "ai_batches"("userId", "createdAt");
ALTER TABLE "ai_batches" ADD CONSTRAINT "ai_batches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_operations" ADD COLUMN "batchId" UUID;
CREATE INDEX "ai_operations_batchId_idx" ON "ai_operations"("batchId");
ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ai_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
