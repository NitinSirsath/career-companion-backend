-- Dev mode mail sandbox: a mailbox per dev-mode user that stands in for Gmail.
-- Replaces the test inbox, whose table and made-up rows go.

-- Test-inbox rows carry "sim-" IDs, which no real Gmail ID can have.
DELETE FROM "outgoing_emails" WHERE "gmailMessageId" LIKE 'sim-%';
DELETE FROM "emails" WHERE "gmailMessageId" LIKE 'sim-%';

DROP TABLE "simulated_email_contents";

CREATE TABLE "sandbox_messages" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "threadId" TEXT NOT NULL,
    "historyId" INTEGER NOT NULL,
    "labelIds" TEXT[],
    "sender" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "referenceIds" TEXT,
    "body" TEXT NOT NULL,
    "internalDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandbox_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sandbox_messages_userId_historyId_key" ON "sandbox_messages"("userId", "historyId");

CREATE INDEX "sandbox_messages_userId_threadId_idx" ON "sandbox_messages"("userId", "threadId");

ALTER TABLE "sandbox_messages" ADD CONSTRAINT "sandbox_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
