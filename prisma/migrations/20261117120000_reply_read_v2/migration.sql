-- Reading the user's replies, v2 (owner, 17 Nov 2026): a reply can decline an ask or ask the other
-- side a question, and a reply that says the user no longer wants the job asks to close the
-- application. New replies only: replies read before keep what they had.
-- AlterEnum
ALTER TYPE "RequestClosedReason" ADD VALUE 'YOU_DECLINED';

-- AlterEnum
ALTER TYPE "ReplyReadState" ADD VALUE 'ASKED_BACK';

-- CreateEnum
CREATE TYPE "DeclineAnswer" AS ENUM ('CLOSED', 'KEPT_OPEN');

-- AlterTable
ALTER TABLE "outgoing_emails" ADD COLUMN "replyReadVersion" TEXT;

-- AlterTable
ALTER TABLE "applications" ADD COLUMN "declinedAt" TIMESTAMP(3),
ADD COLUMN "declineAnswer" "DeclineAnswer",
ADD COLUMN "declineAnsweredAt" TIMESTAMP(3);
