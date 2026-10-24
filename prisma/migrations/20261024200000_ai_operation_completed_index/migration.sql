-- AI reading status (owner decision, 24 Oct 2026): the speed of the mail reader is the mails it
-- finished in the last 5 minutes, for all users together. This index keeps that count small.

-- CreateIndex
CREATE INDEX "ai_operations_completedAt_idx" ON "ai_operations"("completedAt");
