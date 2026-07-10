-- Prompt-caching token accounting (cache writes cost 1.25x input, cache
-- reads 0.1x) — needed for accurate cost reporting and to verify savings.
ALTER TABLE "ai_provider_attempts" ADD COLUMN "cache_creation_input_tokens" INTEGER;
ALTER TABLE "ai_provider_attempts" ADD COLUMN "cache_read_input_tokens" INTEGER;
