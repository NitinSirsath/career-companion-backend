-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "archiveRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "actions" ADD COLUMN     "actionRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "clientRequestId" UUID,
ADD COLUMN     "creationPayloadHash" TEXT,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "snoozedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "actions_clientRequestId_key" ON "actions"("clientRequestId");


ALTER TABLE actions ADD CONSTRAINT action_revision_positive CHECK ("actionRevision">=0);
ALTER TABLE actions ADD CONSTRAINT action_personal_origin CHECK (origin IS NULL OR origin='EMAIL' OR (origin='USER' AND "emailId" IS NULL AND "clientRequestId" IS NOT NULL AND "creationPayloadHash" IS NOT NULL AND type='USER_FOLLOW_UP'));
ALTER TABLE actions ADD CONSTRAINT action_receipt_pair CHECK (("clientRequestId" IS NULL)=("creationPayloadHash" IS NULL));
ALTER TABLE applications ADD CONSTRAINT archive_revision_positive CHECK ("archiveRevision">=0);
CREATE FUNCTION preserve_action_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."clientRequestId" IS NOT NULL AND (NEW."clientRequestId" IS DISTINCT FROM OLD."clientRequestId" OR NEW."creationPayloadHash" IS DISTINCT FROM OLD."creationPayloadHash" OR NEW."applicationId"<>OLD."applicationId" OR NEW.origin IS DISTINCT FROM OLD.origin)
 THEN RAISE EXCEPTION 'Personal creation receipt is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER action_receipt_immutable BEFORE UPDATE ON actions FOR EACH ROW EXECUTE FUNCTION preserve_action_receipt();
