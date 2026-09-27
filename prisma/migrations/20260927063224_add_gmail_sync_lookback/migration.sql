-- AlterTable
ALTER TABLE "gmail_connections" ADD COLUMN     "lastSyncedLookbackDays" INTEGER,
ADD COLUMN     "syncLookbackDays" INTEGER NOT NULL DEFAULT 1;
