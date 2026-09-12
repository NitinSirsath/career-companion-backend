-- CreateEnum
CREATE TYPE "MatchConfirmationSource" AS ENUM ('AI_AUTO', 'USER_CONFIRMED');

-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "matchConfirmedBy" "MatchConfirmationSource";

-- CreateTable
CREATE TABLE "application_events" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "emailId" UUID,
    "type" TEXT NOT NULL,
    "oldState" "ApplicationStatus",
    "newState" "ApplicationStatus",
    "description" TEXT,
    "provenance" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actions" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "emailId" UUID,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "deadline" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "application_events_applicationId_idx" ON "application_events"("applicationId");

-- CreateIndex
CREATE INDEX "application_events_emailId_idx" ON "application_events"("emailId");

-- CreateIndex
CREATE INDEX "actions_applicationId_idx" ON "actions"("applicationId");

-- CreateIndex
CREATE INDEX "actions_emailId_idx" ON "actions"("emailId");

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE SET NULL ON UPDATE CASCADE;
