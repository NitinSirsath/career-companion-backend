BEGIN;

-- Stop if legacy duplicates exist. Reconcile them explicitly; never delete user work in a migration.
CREATE UNIQUE INDEX "application_events_applicationId_emailId_type_key" ON "application_events"("applicationId", "emailId", "type");
CREATE UNIQUE INDEX "actions_applicationId_emailId_type_key" ON "actions"("applicationId", "emailId", "type");

-- Ownership is inherited through parent records. Reject cross-owner links even
-- if a future service forgets its application-level check.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM emails e JOIN applications a ON a.id=e."applicationId" WHERE e."userId"<>a."userId") OR
     EXISTS (SELECT 1 FROM actions x JOIN emails e ON e.id=x."emailId" JOIN applications a ON a.id=x."applicationId" WHERE e."userId"<>a."userId") OR
     EXISTS (SELECT 1 FROM application_events x JOIN emails e ON e.id=x."emailId" JOIN applications a ON a.id=x."applicationId" WHERE e."userId"<>a."userId")
  THEN RAISE EXCEPTION 'Cross-owner legacy records require reconciliation'; END IF;
END $$;

CREATE FUNCTION enforce_email_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."applicationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM applications WHERE id=NEW."applicationId" AND "userId"=NEW."userId"
  ) THEN RAISE EXCEPTION 'Email/application ownership mismatch' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND NEW."userId"<>OLD."userId" THEN
    RAISE EXCEPTION 'Email ownership is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_ownership BEFORE INSERT OR UPDATE ON emails FOR EACH ROW EXECUTE FUNCTION enforce_email_ownership();

CREATE FUNCTION enforce_domain_email_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."emailId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM emails e JOIN applications a ON e."userId"=a."userId"
    WHERE e.id=NEW."emailId" AND a.id=NEW."applicationId"
  ) THEN RAISE EXCEPTION 'Domain/email ownership mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER action_email_ownership BEFORE INSERT OR UPDATE ON actions FOR EACH ROW EXECUTE FUNCTION enforce_domain_email_ownership();
CREATE TRIGGER event_email_ownership BEFORE INSERT OR UPDATE ON application_events FOR EACH ROW EXECUTE FUNCTION enforce_domain_email_ownership();

CREATE FUNCTION prevent_application_owner_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."userId"<>OLD."userId" THEN RAISE EXCEPTION 'Application ownership is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_ownership BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION prevent_application_owner_change();

COMMIT;
