-- CreateEnum
CREATE TYPE "AgendaState" AS ENUM ('TENTATIVE', 'CONFIRMED', 'CANCELLED', 'COMPLETED');

-- AlterTable
ALTER TABLE "ai_processing_results" ADD COLUMN     "scheduleCandidates" JSONB;

-- CreateTable
CREATE TABLE "agenda_items" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "emailId" UUID NOT NULL,
    "candidateKey" TEXT NOT NULL,
    "extractionVersion" TEXT NOT NULL,
    "suggestion" JSONB NOT NULL,
    "userTiming" JSONB,
    "precision" TEXT NOT NULL,
    "date" TEXT,
    "instant" TIMESTAMP(3),
    "state" "AgendaState" NOT NULL DEFAULT 'TENTATIVE',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "decisionSourceId" UUID,
    "retiredAt" TIMESTAMP(3),
    "retiredReason" "RetiredReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agenda_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agenda_items_userId_state_date_idx" ON "agenda_items"("userId", "state", "date");

-- CreateIndex
CREATE UNIQUE INDEX "agenda_items_applicationId_emailId_candidateKey_key" ON "agenda_items"("applicationId", "emailId", "candidateKey");

-- AddForeignKey
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "emails"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE agenda_items ADD CONSTRAINT agenda_retirement_pair CHECK (("retiredAt" IS NULL) = ("retiredReason" IS NULL));
ALTER TABLE agenda_items ADD CONSTRAINT agenda_precision CHECK (
  (precision = 'DATE' AND date IS NOT NULL AND instant IS NULL) OR
  (precision = 'DATETIME' AND date IS NOT NULL AND instant IS NOT NULL) OR
  (precision = 'UNRESOLVED' AND date IS NULL AND instant IS NULL));
ALTER TABLE agenda_items ADD CONSTRAINT agenda_revision CHECK (revision >= 0);
CREATE FUNCTION enforce_agenda_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM applications a JOIN emails e ON e."userId"=a."userId"
    WHERE a.id=NEW."applicationId" AND e.id=NEW."emailId" AND a."userId"=NEW."userId")
  THEN RAISE EXCEPTION 'Agenda ownership mismatch' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW."userId"<>OLD."userId" OR NEW."applicationId"<>OLD."applicationId" OR NEW."emailId"<>OLD."emailId" OR NEW.suggestion<>OLD.suggestion OR NEW."candidateKey"<>OLD."candidateKey")
  THEN RAISE EXCEPTION 'Agenda source is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agenda_ownership BEFORE INSERT OR UPDATE ON agenda_items FOR EACH ROW EXECUTE FUNCTION enforce_agenda_ownership();
