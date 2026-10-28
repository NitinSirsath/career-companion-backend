-- The Dashboard's AI tip (owner, 27 Oct 2026): one row per user. New table only.

-- CreateTable
CREATE TABLE "dashboard_ai_tips" (
    "userId" UUID NOT NULL,
    "text" TEXT,
    "model" TEXT,
    "provider" TEXT,
    "madeAt" TIMESTAMP(3),
    "numbersHash" TEXT,
    "triedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_ai_tips_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "dashboard_ai_tips" ADD CONSTRAINT "dashboard_ai_tips_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
