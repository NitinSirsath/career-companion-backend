-- S6-01: dedicated optimistic-concurrency token for manual status corrections.
-- Additive only: existing rows receive 0; stored statuses and timestamps are untouched.
-- Rollback keeps this column (no destructive down migration).
ALTER TABLE "applications" ADD COLUMN "userStatusRevision" INTEGER NOT NULL DEFAULT 0;
