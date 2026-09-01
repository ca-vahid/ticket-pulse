-- Ticket.externalRef + workspace resubmission settings (Mega 08-31 Phase PA,
-- QA #4 — Power Apps resubmission upsert).
--
--  • tickets.external_ref: the caller's stable per-RECORD key (e.g. the
--    SharePoint item id behind a Power Apps form). POST /api/v1/tickets with a
--    ref that already exists in the workspace UPDATES that ticket instead of
--    creating a duplicate. Partial unique index: many NULLs, one ticket per
--    (workspace, ref).
--  • workspaces.api_resubmission_match_enabled / _window_days: the
--    flag-gated (default OFF) subject/requester heuristic used only while a
--    sender has not started sending externalRef yet.
--  • workspaces.external_ref_custom_field_key: zero-sender-change bridge —
--    derive the ref from a custom-field value the sender already posts
--    (ws5: power_app_record_id).
--
-- Idempotent; safe to re-apply. Apply to prod BEFORE deploying the code.
-- NOTE: ws5 has duplicate power_app_record_id groups — run
-- scripts/backfill-external-ref-ws5.mjs (winner = lowest id per group) AFTER
-- this migration; the index only ever sees one ref per group.
ALTER TABLE "tickets"
    ADD COLUMN IF NOT EXISTS "external_ref" VARCHAR(200);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_tickets_ws_external_ref"
    ON "tickets" ("workspace_id", "external_ref")
    WHERE "external_ref" IS NOT NULL;

ALTER TABLE "workspaces"
    ADD COLUMN IF NOT EXISTS "api_resubmission_match_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "workspaces"
    ADD COLUMN IF NOT EXISTS "api_resubmission_match_window_days" INTEGER NOT NULL DEFAULT 7;

ALTER TABLE "workspaces"
    ADD COLUMN IF NOT EXISTS "external_ref_custom_field_key" VARCHAR(60);
