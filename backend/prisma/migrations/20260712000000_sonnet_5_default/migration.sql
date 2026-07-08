-- Sonnet 4.6 -> Sonnet 5 upgrade (claude-sonnet-5, launched 2026-06-30).
-- New defaults point at Sonnet 5; existing saved selections are migrated in
-- place. Sonnet 4.6 remains a valid, selectable model for opt-back.

ALTER TABLE "assignment_configs" ALTER COLUMN "llm_model" SET DEFAULT 'claude-sonnet-5';
ALTER TABLE "ai_provider_settings" ALTER COLUMN "primary_model" SET DEFAULT 'claude-sonnet-5';

UPDATE "assignment_configs" SET "llm_model" = 'claude-sonnet-5' WHERE "llm_model" = 'claude-sonnet-4-6';
UPDATE "ai_provider_settings" SET "primary_model" = 'claude-sonnet-5' WHERE "primary_model" = 'claude-sonnet-4-6';
UPDATE "ai_provider_settings" SET "fallback_model" = 'claude-sonnet-5' WHERE "fallback_model" = 'claude-sonnet-4-6';
