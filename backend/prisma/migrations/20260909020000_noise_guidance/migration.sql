-- Per-workspace noise guidance for the assignment prompt (QA 09-05, option 2).
-- Null = use the built-in guidance, so every existing workspace is unchanged.
ALTER TABLE "assignment_configs"
  ADD COLUMN IF NOT EXISTS "noise_guidance" TEXT;
