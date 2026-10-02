-- Automation submissions through MCP (ADR-0002), MCP-01. Additive only: two new tables, three
-- enums and one nullable column. No existing row is changed.
BEGIN;

-- CreateEnum
CREATE TYPE "ExternalSubmissionSource" AS ENUM ('AUTOMATION');

-- CreateEnum
CREATE TYPE "ExternalSubmissionMatchState" AS ENUM ('NEEDS_REVIEW', 'LINKED', 'CREATED', 'IGNORED');

-- CreateEnum
CREATE TYPE "SubmissionResolvedBy" AS ENUM ('AUTOMATIC', 'USER');

-- AlterTable
ALTER TABLE "application_events" ADD COLUMN "externalSubmissionId" UUID;

-- CreateTable
CREATE TABLE "integration_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "displayPrefix" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'submissions:write',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "integration_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "integration_tokens_name_check" CHECK (char_length("name") BETWEEN 1 AND 100),
    CONSTRAINT "integration_tokens_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "integration_tokens_displayPrefix_check" CHECK ("displayPrefix" LIKE 'ccmcp\_%'),
    CONSTRAINT "integration_tokens_scope_check" CHECK ("scope" = 'submissions:write'),
    CONSTRAINT "integration_tokens_expiresAt_check" CHECK ("expiresAt" > "createdAt")
);

-- CreateTable
CREATE TABLE "external_submissions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "source" "ExternalSubmissionSource" NOT NULL,
    "sourceRecordRef" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "jobUrl" TEXT,
    "portalJobId" TEXT,
    "destinationHost" TEXT,
    "discoverySource" TEXT,
    "location" TEXT,
    "workMode" TEXT,
    "confirmationText" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenId" UUID,
    "matchState" "ExternalSubmissionMatchState" NOT NULL,
    "resolvedBy" "SubmissionResolvedBy",
    "applicationId" UUID,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "external_submissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_submissions_sourceRecordRef_check" CHECK ("sourceRecordRef" ~ '^\d{4}-\d{2}-\d{2}/\d{2}:\d{2}:\d{2}$'),
    CONSTRAINT "external_submissions_confirmationText_check" CHECK (char_length("confirmationText") <= 300),
    -- resolvedBy and resolvedAt are set together, exactly when the match is settled. Deliberately
    -- no CHECK on applicationId: its SetNull foreign key would make application/user deletion fail.
    CONSTRAINT "external_submissions_resolution_check" CHECK (
      ("matchState" = 'NEEDS_REVIEW') = ("resolvedBy" IS NULL) AND ("resolvedBy" IS NULL) = ("resolvedAt" IS NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_tokens_tokenHash_key" ON "integration_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "integration_tokens_userId_createdAt_idx" ON "integration_tokens"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "external_submissions_userId_matchState_idx" ON "external_submissions"("userId", "matchState");

-- CreateIndex
CREATE INDEX "external_submissions_userId_receivedAt_idx" ON "external_submissions"("userId", "receivedAt");

-- CreateIndex
CREATE INDEX "external_submissions_applicationId_idx" ON "external_submissions"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "external_submissions_userId_source_sourceRecordRef_key" ON "external_submissions"("userId", "source", "sourceRecordRef");

-- CreateIndex
CREATE UNIQUE INDEX "application_events_externalSubmissionId_key" ON "application_events"("externalSubmissionId");

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_externalSubmissionId_fkey" FOREIGN KEY ("externalSubmissionId") REFERENCES "external_submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_submissions" ADD CONSTRAINT "external_submissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_submissions" ADD CONSTRAINT "external_submissions_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "integration_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_submissions" ADD CONSTRAINT "external_submissions_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ownership, following 20260926110000_domain_integrity. Reject cross-owner links even if a future
-- service forgets its own check. A link is checked when it is set or changed, so the SetNull
-- foreign keys fired by an application, token or user deletion never trip these triggers.
CREATE FUNCTION enforce_submission_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW."userId"<>OLD."userId" THEN
    RAISE EXCEPTION 'Submission ownership is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW."applicationId" IS NOT NULL
     AND (TG_OP='INSERT' OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId")
     AND NOT EXISTS (SELECT 1 FROM applications WHERE id=NEW."applicationId" AND "userId"=NEW."userId")
  THEN RAISE EXCEPTION 'Submission/application ownership mismatch' USING ERRCODE='23514'; END IF;
  IF NEW."tokenId" IS NOT NULL
     AND (TG_OP='INSERT' OR NEW."tokenId" IS DISTINCT FROM OLD."tokenId")
     AND NOT EXISTS (SELECT 1 FROM integration_tokens WHERE id=NEW."tokenId" AND "userId"=NEW."userId")
  THEN RAISE EXCEPTION 'Submission/token ownership mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER submission_ownership BEFORE INSERT OR UPDATE ON external_submissions FOR EACH ROW EXECUTE FUNCTION enforce_submission_ownership();

CREATE FUNCTION enforce_event_submission_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."externalSubmissionId" IS NOT NULL
     AND (TG_OP='INSERT' OR NEW."externalSubmissionId" IS DISTINCT FROM OLD."externalSubmissionId"
          OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId")
     AND NOT EXISTS (
       SELECT 1 FROM external_submissions s JOIN applications a ON s."userId"=a."userId"
       WHERE s.id=NEW."externalSubmissionId" AND a.id=NEW."applicationId")
  THEN RAISE EXCEPTION 'Event/submission ownership mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_submission_ownership BEFORE INSERT OR UPDATE ON application_events FOR EACH ROW EXECUTE FUNCTION enforce_event_submission_ownership();

-- A token's owner cannot change either; otherwise a submission's token link could become cross-owner.
CREATE FUNCTION prevent_integration_token_owner_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."userId"<>OLD."userId" THEN RAISE EXCEPTION 'Integration token ownership is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_token_ownership BEFORE UPDATE ON integration_tokens FOR EACH ROW EXECUTE FUNCTION prevent_integration_token_owner_change();

COMMIT;
