-- COM-19: Add googleId/name to User, create GmailConnection entity
-- Migration: add_googleid_to_user_and_gmail_connection

-- CreateEnum
CREATE TYPE "GmailConnectionStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "GmailSyncStatus" AS ENUM ('IDLE', 'SYNCING', 'FAILED');

-- AlterTable
-- googleId is nullable: existing dev-seeded users have no Google identity yet.
-- Populated in Sprint 3 when Google Sign-In is introduced.
ALTER TABLE "users" ADD COLUMN "googleId" TEXT,
ADD COLUMN "name" TEXT;

-- CreateTable
-- accessToken and refreshToken are stored as AES-256-GCM ciphertext.
-- They are NEVER stored in plaintext. Encryption is applied at the
-- application layer before write, decryption at the application layer
-- after read. Raw token values must never appear in logs or API responses.
CREATE TABLE "gmail_connections" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "gmailEmail" TEXT NOT NULL,
    "status" "GmailConnectionStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "syncStatus" "GmailSyncStatus" NOT NULL DEFAULT 'IDLE',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "lastHistoryId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gmail_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gmail_connections_userId_key" ON "gmail_connections"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");

-- AddForeignKey
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
