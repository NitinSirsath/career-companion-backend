-- Portal accounts (owner, 21 Nov 2026): the company-portal account NorthList Apply used, sent with
-- an application. The password is stored sealed (PORTAL_CREDENTIAL_ENCRYPTION_KEY).
-- CreateEnum
CREATE TYPE "PortalAccountMadeBy" AS ENUM ('NORTHLIST_APPLY', 'USER');

-- AlterTable
ALTER TABLE "external_submissions" ADD COLUMN     "portalAccountId" UUID;

-- CreateTable
CREATE TABLE "portal_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "companyKey" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "signInUrl" TEXT NOT NULL,
    "signInHost" TEXT NOT NULL,
    "loginEmail" TEXT NOT NULL,
    "passwordSealed" TEXT,
    "emailVerified" BOOLEAN,
    "madeBy" "PortalAccountMadeBy",
    "createdOn" DATE,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portal_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portal_accounts_userId_signInHost_companyKey_key" ON "portal_accounts"("userId", "signInHost", "companyKey");

-- AddForeignKey
ALTER TABLE "external_submissions" ADD CONSTRAINT "external_submissions_portalAccountId_fkey" FOREIGN KEY ("portalAccountId") REFERENCES "portal_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_accounts" ADD CONSTRAINT "portal_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
