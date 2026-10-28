-- A formatted reply sent from the app in dev mode keeps its HTML part (owner, 25 Oct 2026).
-- A new nullable column only: no existing row changes.
ALTER TABLE "sandbox_messages" ADD COLUMN "html" TEXT;
