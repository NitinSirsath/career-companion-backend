-- Guided first run (owner, 22 Nov 2026): the step a new user reached, and when the run was done.
ALTER TABLE "users" ADD COLUMN "onboardingStep" TEXT NOT NULL DEFAULT 'welcome',
ADD COLUMN "onboardingDoneAt" TIMESTAMP(3);

-- Accounts made before the first run existed never see it.
UPDATE "users" SET "onboardingDoneAt" = CURRENT_TIMESTAMP;
