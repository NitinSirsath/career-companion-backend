-- A provider that answers "busy, try again later" is a state of its own: it is not a limit on the
-- user's account (RATE_LIMITED) and not a call with no answer (PROVIDER_UNAVAILABLE). Additive only.
ALTER TYPE "AIAccessIssue" ADD VALUE 'PROVIDER_BUSY';
