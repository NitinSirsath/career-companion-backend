-- The AI reads the user's own replies (owner decisions, 17 and 24 Oct 2026): each sent message
-- notes whether the AI read it to see which open asks it settles. The text is never stored.
-- New nullable columns and a zero count only: no existing row changes.

-- CreateEnum
CREATE TYPE "ReplyReadState" AS ENUM ('WAITING', 'READ', 'NOT_READ');

-- AlterTable
ALTER TABLE "outgoing_emails" ADD COLUMN     "replyReadAt" TIMESTAMP(3),
ADD COLUMN     "replyReadState" "ReplyReadState",
ADD COLUMN     "replyReadTries" INTEGER NOT NULL DEFAULT 0;
