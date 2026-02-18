-- Add GPT-5.1 runtime settings to llm_configs
ALTER TABLE "llm_configs"
  ADD COLUMN "model" VARCHAR(100) NOT NULL DEFAULT 'gpt-5.1',
  ADD COLUMN "reasoning_effort" VARCHAR(20) NOT NULL DEFAULT 'none',
  ADD COLUMN "verbosity" VARCHAR(20) NOT NULL DEFAULT 'medium',
  ADD COLUMN "max_output_tokens" INTEGER NOT NULL DEFAULT 800;

