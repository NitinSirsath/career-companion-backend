-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "processingErrorCategory" TEXT,
ADD COLUMN     "processingErrorDetails" TEXT,
ADD COLUMN     "processingErrorStage" TEXT,
ADD COLUMN     "processingFailedAt" TIMESTAMP(3),
ADD COLUMN     "processingRetryable" BOOLEAN;
