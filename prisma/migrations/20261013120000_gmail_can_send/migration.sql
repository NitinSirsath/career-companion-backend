-- Whether the saved Google grant also allows sending mail. Additive only: every connection made
-- before this change was granted reading only, so it starts as false.
ALTER TABLE "gmail_connections" ADD COLUMN "canSend" BOOLEAN NOT NULL DEFAULT false;
