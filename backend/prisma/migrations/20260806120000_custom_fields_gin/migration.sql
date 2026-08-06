-- Custom Fields Activation Phase 2 (views/filtering).
-- 1) GIN index over tickets.custom_fields so JSONB containment probes on the
--    queue's cf_* filters stay cheap as the table grows (jsonb_path_ops = the
--    compact operator class for @>-style lookups).
-- 2) Rider: custom_field_definitions.is_featured — the ONE per-workspace
--    definition surfaced as a quiet chip on queue rows and in the peek
--    Details (single-featured enforced in customFieldService.updateDefinition).
-- Idempotent; safe to re-apply.
CREATE INDEX IF NOT EXISTS "idx_tickets_custom_fields_gin"
    ON "tickets" USING GIN ("custom_fields" jsonb_path_ops);

ALTER TABLE "custom_field_definitions"
    ADD COLUMN IF NOT EXISTS "is_featured" BOOLEAN NOT NULL DEFAULT false;
