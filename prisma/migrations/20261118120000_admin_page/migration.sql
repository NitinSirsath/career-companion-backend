-- Admin page (owner, 18 Nov 2026): last active time and account suspension.
ALTER TABLE "users" ADD COLUMN "lastActiveAt" TIMESTAMP(3),
ADD COLUMN "suspendedAt" TIMESTAMP(3),
ADD COLUMN "suspendReason" TEXT,
ADD COLUMN "resumeRequest" TEXT,
ADD COLUMN "resumeRequestedAt" TIMESTAMP(3);
