-- The free AI (owner, 24 Oct 2026). A setup of the provider 'career-companion' runs on Career
-- Companion's own OpenRouter key, so it holds no key. Every other setup still holds a sealed key.
ALTER TABLE "ai_configurations" ALTER COLUMN "encryptedApiKey" DROP NOT NULL;
ALTER TABLE "ai_configurations" ADD CONSTRAINT "ai_configurations_key_owner_check"
    CHECK (("provider" = 'career-companion') = ("encryptedApiKey" IS NULL));

ALTER TABLE "ai_saved_providers" ALTER COLUMN "encryptedApiKey" DROP NOT NULL;
ALTER TABLE "ai_saved_providers" ADD CONSTRAINT "ai_saved_providers_key_owner_check"
    CHECK (("provider" = 'career-companion') = ("encryptedApiKey" IS NULL));

-- One pause per model of the free AI, shared by every user on it.
CREATE TABLE "free_ai_pauses" (
    "model" TEXT NOT NULL,
    "reason" "AIAccessIssue" NOT NULL,
    "resumesAt" TIMESTAMP(3) NOT NULL,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 1,
    "lastFailure" JSONB,
    "alertedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "free_ai_pauses_pkey" PRIMARY KEY ("model"),
    CONSTRAINT "free_ai_pauses_model_check" CHECK ("model" <> '')
);
