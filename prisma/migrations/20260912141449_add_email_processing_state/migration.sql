-- CreateEnum
CREATE TYPE "EmailProcessingState" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "processingState" "EmailProcessingState" NOT NULL DEFAULT 'PENDING';
