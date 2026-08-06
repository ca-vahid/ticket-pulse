-- Custom-field definitions gain a provenance marker (FR 08-05 #1, Phase 1a):
-- 'manual' = created by an admin in Settings -> Ticket Ops -> Custom fields;
-- 'api'    = auto-provisioned by API intake (unknown key on a create payload).
-- The Settings manager surfaces the badge so API-born definitions can be
-- curated (relabel / retype / deactivate) after the fact.
-- Idempotent; safe to re-apply.
ALTER TABLE "custom_field_definitions"
    ADD COLUMN IF NOT EXISTS "source" VARCHAR(10) NOT NULL DEFAULT 'manual';
