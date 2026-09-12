-- CreateEnum
CREATE TYPE "EmailRelevanceState" AS ENUM ('UNPROCESSED', 'RELEVANT', 'IRRELEVANT');

-- CreateEnum
CREATE TYPE "EmailMatchState" AS ENUM ('UNMATCHED', 'MATCHED', 'AMBIGUOUS', 'IGNORED');

-- CreateTable
CREATE TABLE "emails" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "threadId" TEXT,
    "subject" TEXT,
    "sender" TEXT,
    "receivedAt" TIMESTAMP(3),
    "relevanceState" "EmailRelevanceState" NOT NULL DEFAULT 'UNPROCESSED',
    "matchState" "EmailMatchState" NOT NULL DEFAULT 'UNMATCHED',
    "applicationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "emails_userId_idx" ON "emails"("userId");

-- CreateIndex
CREATE INDEX "emails_userId_relevanceState_idx" ON "emails"("userId", "relevanceState");

-- CreateIndex
CREATE UNIQUE INDEX "emails_userId_gmailMessageId_key" ON "emails"("userId", "gmailMessageId");

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
