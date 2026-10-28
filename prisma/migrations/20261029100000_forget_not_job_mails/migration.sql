-- Mails that are not about a job keep only their Gmail ids, date and decision (owner, 26 Oct
-- 2026). Clears what was kept before. Deletes nothing and sends nothing to AI.
UPDATE "emails"
SET "subject" = NULL, "sender" = NULL, "processingErrorDetails" = NULL
WHERE "relevanceState" = 'IRRELEVANT';
