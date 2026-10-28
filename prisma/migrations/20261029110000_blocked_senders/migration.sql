-- Companies whose new mail the app does not read (owner, 26 Oct 2026). Additive only.

-- CreateEnum
CREATE TYPE "BlockSource" AS ENUM ('DELETE', 'MENU');

-- CreateTable
CREATE TABLE "blocked_senders" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "source" "BlockSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_senders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blocked_senders_userId_domain_key" ON "blocked_senders"("userId", "domain");

-- AddForeignKey
ALTER TABLE "blocked_senders" ADD CONSTRAINT "blocked_senders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
