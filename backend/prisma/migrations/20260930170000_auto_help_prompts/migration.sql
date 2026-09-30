-- Knowledge → Settings → Prompts (30 Sep 2026): versioned, editable guidance
-- for Auto-help's three prompts (answer writing, playbook choice, answer
-- check). Additive: a new table only. No row = the built-in default.
CREATE TABLE IF NOT EXISTS "auto_help_prompt_versions" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "key" VARCHAR(20) NOT NULL,
  "version" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
  "body" TEXT NOT NULL,
  "notes" TEXT,
  "created_by" VARCHAR(255),
  "published_by" VARCHAR(255),
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "auto_help_prompt_versions_workspace_id_key_version_key" ON "auto_help_prompt_versions"("workspace_id", "key", "version");
CREATE INDEX IF NOT EXISTS "auto_help_prompt_versions_workspace_id_key_status_idx" ON "auto_help_prompt_versions"("workspace_id", "key", "status");

-- Auto-help e-mail signature (30 Sep 2026): pasted HTML appended to every
-- Auto-help answer. signature_with: when an agent sends the answer, use this
-- signature instead of theirs ('replace') or after theirs ('both').
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "signature_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "signature_html" TEXT;
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "signature_text" TEXT;
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "signature_spacing" VARCHAR(10) NOT NULL DEFAULT 'tight';
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "signature_with" VARCHAR(10) NOT NULL DEFAULT 'replace';
