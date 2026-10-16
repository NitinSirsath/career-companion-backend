-- The exact error for the screens: each AI step keeps its last failure and when each counted try
-- was sent, a model's pause the failure that set it, and the configuration the failure behind a
-- key, billing or model problem. Older rows have none and are shown by their stored kind.

ALTER TABLE "ai_operations" ADD COLUMN     "lastFailure" JSONB,
ADD COLUMN     "triedAt" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[];

ALTER TABLE "ai_configurations" ADD COLUMN     "accessFailure" JSONB;

ALTER TABLE "ai_model_pauses" ADD COLUMN     "lastFailure" JSONB;
