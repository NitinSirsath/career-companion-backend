-- The other people on a sandbox mail (its Cc header), so a reply to all can be tried in dev mode.
-- Additive only: every sandbox mail written before this change has nobody in Cc.
ALTER TABLE "sandbox_messages" ADD COLUMN "cc" TEXT;
