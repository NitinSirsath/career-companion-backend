CREATE TYPE "RetiredReason" AS ENUM ('EMAIL_MOVED', 'EMAIL_UNLINKED');
ALTER TABLE "application_events" ADD COLUMN "retiredAt" TIMESTAMP(3), ADD COLUMN "retiredReason" "RetiredReason",
  ADD CONSTRAINT "event_retirement_pair" CHECK (("retiredAt" IS NULL) = ("retiredReason" IS NULL));
ALTER TABLE "actions" ADD COLUMN "retiredAt" TIMESTAMP(3), ADD COLUMN "retiredReason" "RetiredReason",
  ADD CONSTRAINT "action_retirement_pair" CHECK (("retiredAt" IS NULL) = ("retiredReason" IS NULL));
