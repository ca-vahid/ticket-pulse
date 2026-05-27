-- Promote existing OpenAI workspace model settings to the current approved default.
UPDATE "llm_configs"
SET "model" = 'gpt-5.5'
WHERE "model" IN ('gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano');

UPDATE "ai_provider_settings"
SET "primary_model" = 'gpt-5.5'
WHERE "primary_provider" = 'openai'
  AND "primary_model" IN ('gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano');

UPDATE "ai_provider_settings"
SET "fallback_model" = 'gpt-5.5'
WHERE "fallback_provider" = 'openai'
  AND "fallback_model" IN ('gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano');

ALTER TABLE "llm_configs"
  ALTER COLUMN "model" SET DEFAULT 'gpt-5.5';

ALTER TABLE "ai_provider_settings"
  ALTER COLUMN "fallback_model" SET DEFAULT 'gpt-5.5';
