-- What the app itself notes about a job mail when it is read (owner, 26 Nov 2026). Existing rows: not known, false.
-- bulkMail: sent as a mailing (it carries an unsubscribe header).
-- saysNoReply: its own text says that nobody reads a reply to it.
ALTER TABLE "ai_processing_results" ADD COLUMN "bulkMail" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ai_processing_results" ADD COLUMN "saysNoReply" BOOLEAN NOT NULL DEFAULT false;
