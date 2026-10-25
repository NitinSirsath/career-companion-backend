-- AI reads the whole conversation (owner decisions, 24 Oct 2026): each ask says how the user does
-- it, a newer mail or the user's reply can close an older ask, and a closed ask keeps why.
-- New nullable columns and an empty list only: no existing row changes.

-- CreateEnum
CREATE TYPE "AskKind" AS ENUM ('REPLY_BY_MAIL', 'OUTSIDE_MAIL');

-- CreateEnum
CREATE TYPE "RequestClosedReason" AS ENUM ('REPLACED_BY_MAIL', 'CONFIRMED_BY_MAIL', 'YOUR_REPLY', 'YOU_SAID_DONE', 'APPLICATION_CLOSED');

-- AlterTable
ALTER TABLE "ai_processing_results" ADD COLUMN     "askKind" "AskKind",
ADD COLUMN     "replyChoices" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "requestClosedAt" TIMESTAMP(3),
ADD COLUMN     "requestClosedByMessageId" TEXT,
ADD COLUMN     "requestClosedReason" "RequestClosedReason";
