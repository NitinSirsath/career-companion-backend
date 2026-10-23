-- A user can connect several AI providers, and one of them is active (owner, 22 Oct 2026). The
-- active one stays in ai_configurations, so every existing setup keeps working unchanged. Each
-- other connected provider has one row here: at most one key per provider.

CREATE TABLE "ai_saved_providers" (
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "fastModel" TEXT,
    "detailedModel" TEXT,
    "accessIssue" "AIAccessIssue",
    "accessIssueModel" TEXT,
    "accessFailure" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "consentDisclosure" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_saved_providers_pkey" PRIMARY KEY ("userId","provider"),
    CONSTRAINT "ai_saved_providers_provider_check" CHECK ("provider" <> ''),
    CONSTRAINT "ai_saved_providers_encryptedApiKey_check" CHECK ("encryptedApiKey" LIKE 'v1:%')
);

ALTER TABLE "ai_saved_providers" ADD CONSTRAINT "ai_saved_providers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
