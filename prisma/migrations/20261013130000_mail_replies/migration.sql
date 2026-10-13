-- Replies the user sent from the app: the reply's own ID, so the same reply is never sent twice.
-- No mail text. Additive only.
CREATE TABLE "mail_replies" (
    "userId" UUID NOT NULL,
    "id" UUID NOT NULL,
    "threadId" TEXT NOT NULL,
    "gmailMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_replies_pkey" PRIMARY KEY ("userId","id")
);

ALTER TABLE "mail_replies" ADD CONSTRAINT "mail_replies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
