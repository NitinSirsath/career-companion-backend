-- Mail-first conversations. Additive only.

-- The user's own answer to what an email asks for.
CREATE TYPE "EmailRequestState" AS ENUM ('DONE', 'OPEN');

ALTER TABLE "emails" ADD COLUMN "seenAt" TIMESTAMP(3),
ADD COLUMN "requestUserState" "EmailRequestState",
ADD COLUMN "requestUserStateAt" TIMESTAMP(3);

-- New mails only: every email stored before this change counts as already seen.
UPDATE "emails" SET "seenAt" = CURRENT_TIMESTAMP;

CREATE INDEX "emails_userId_threadId_idx" ON "emails"("userId", "threadId");

-- Messages the user sent in conversations we hold: IDs and time only, never content.
CREATE TABLE "outgoing_emails" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outgoing_emails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outgoing_emails_userId_gmailMessageId_key" ON "outgoing_emails"("userId", "gmailMessageId");

CREATE INDEX "outgoing_emails_userId_threadId_idx" ON "outgoing_emails"("userId", "threadId");

ALTER TABLE "outgoing_emails" ADD CONSTRAINT "outgoing_emails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
