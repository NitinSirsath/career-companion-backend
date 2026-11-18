-- Messages from the Admin page (owner, 18 Nov 2026).
-- CreateTable
CREATE TABLE "owner_messages" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "text" TEXT NOT NULL,
    "alertsSent" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "owner_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_message_dismissals" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_message_dismissals_pkey" PRIMARY KEY ("messageId","userId")
);

-- CreateIndex
CREATE INDEX "owner_messages_createdAt_idx" ON "owner_messages"("createdAt");

-- CreateIndex
CREATE INDEX "owner_message_dismissals_userId_idx" ON "owner_message_dismissals"("userId");

-- AddForeignKey
ALTER TABLE "owner_messages" ADD CONSTRAINT "owner_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_message_dismissals" ADD CONSTRAINT "owner_message_dismissals_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "owner_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_message_dismissals" ADD CONSTRAINT "owner_message_dismissals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
