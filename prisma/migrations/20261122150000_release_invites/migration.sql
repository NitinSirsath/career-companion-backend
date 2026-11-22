-- Get an invite for the release (owner, 22 Nov 2026): requests from the sign-in page while the beta is full.
-- CreateEnum
CREATE TYPE "InviteSource" AS ENUM ('FRIEND', 'LINKEDIN', 'X', 'YOUTUBE', 'SEARCH', 'OTHER');

-- CreateTable
CREATE TABLE "release_invites" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "source" "InviteSource" NOT NULL,
    "otherSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "release_invites_email_key" ON "release_invites"("email");

-- CreateIndex
CREATE INDEX "release_invites_createdAt_idx" ON "release_invites"("createdAt");
