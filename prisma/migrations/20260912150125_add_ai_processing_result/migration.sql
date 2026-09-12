-- CreateEnum
CREATE TYPE "AIProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AIRelevanceDecision" AS ENUM ('RELEVANT', 'IRRELEVANT', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "EmailCategory" AS ENUM ('RECRUITER', 'INTERVIEW', 'ASSESSMENT', 'OFFER', 'REJECTION', 'FOLLOW_UP', 'NEWSLETTER', 'SPAM');

-- CreateTable
CREATE TABLE "ai_processing_results" (
    "id" UUID NOT NULL,
    "emailId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "contractVersion" TEXT NOT NULL,
    "processingStatus" "AIProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "relevanceDecision" "AIRelevanceDecision",
    "category" "EmailCategory",
    "confidence" DOUBLE PRECISION,
    "deterministic" BOOLEAN NOT NULL DEFAULT false,
    "companyName" TEXT,
    "jobTitle" TEXT,
    "recruiterName" TEXT,
    "recruiterEmail" TEXT,
    "interviewStage" TEXT,
    "interviewType" TEXT,
    "interviewDate" TEXT,
    "interviewTime" TEXT,
    "assessmentInfo" TEXT,
    "assessmentDeadline" TEXT,
    "offerInfo" TEXT,
    "rejectionInfo" TEXT,
    "actionRequired" BOOLEAN,
    "requestedAction" TEXT,
    "actionDeadline" TEXT,
    "followUpRequired" BOOLEAN,
    "followUpDate" TEXT,
    "extractionConfidence" DOUBLE PRECISION,
    "provenance" TEXT,
    "errorCategory" TEXT,
    "errorDetails" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_processing_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_processing_results_emailId_key" ON "ai_processing_results"("emailId");

-- CreateIndex
CREATE INDEX "ai_processing_results_emailId_idx" ON "ai_processing_results"("emailId");

-- CreateIndex
CREATE INDEX "ai_processing_results_processingStatus_idx" ON "ai_processing_results"("processingStatus");

-- AddForeignKey
ALTER TABLE "ai_processing_results" ADD CONSTRAINT "ai_processing_results_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
