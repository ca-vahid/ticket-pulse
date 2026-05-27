ALTER TABLE "assignment_configs"
  ALTER COLUMN "llm_model" SET DEFAULT 'claude-sonnet-4-6';

UPDATE "assignment_configs"
SET "llm_model" = 'claude-sonnet-4-6'
WHERE "llm_model" = 'claude-sonnet-4-6-20260217';
