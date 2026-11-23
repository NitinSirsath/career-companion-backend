-- One-click setup of NorthList Apply (owner, 23 Nov 2026): short-lived, single-use setup codes swapped for an integration token.
-- CreateTable
CREATE TABLE "setup_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "setup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "setup_codes_codeHash_key" ON "setup_codes"("codeHash");

-- CreateIndex
CREATE INDEX "setup_codes_userId_createdAt_idx" ON "setup_codes"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "setup_codes" ADD CONSTRAINT "setup_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
