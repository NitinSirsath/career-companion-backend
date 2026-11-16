-- New Gmail connections read 7 days back on their first sync (owner, 15 Nov 2026); saved
-- connections keep their own choice.
-- AlterTable
ALTER TABLE "gmail_connections" ALTER COLUMN "syncLookbackDays" SET DEFAULT 7;
