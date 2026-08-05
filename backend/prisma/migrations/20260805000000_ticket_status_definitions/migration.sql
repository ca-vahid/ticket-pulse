-- Workspace custom ticket statuses (QA 08-04 #12, Phase 8a): per-workspace
-- status vocabulary. Every status maps to one of the 4 canonical BASE statuses
-- (Open/Pending/Resolved/Closed) so lifecycle logic (SLA, terminal, episodes)
-- keeps working for custom labels. System rows (the 4 canonical) are seeded
-- per workspace: rename/recolor allowed, base fixed, retire blocked.
-- Idempotent; safe to re-apply.
CREATE TABLE IF NOT EXISTS "ticket_status_definitions" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "base_status" VARCHAR(10) NOT NULL,
    "color" VARCHAR(20),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_status_definitions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_status_definitions_base_status_check"
        CHECK ("base_status" IN ('Open', 'Pending', 'Resolved', 'Closed'))
);

DO $$ BEGIN
    ALTER TABLE "ticket_status_definitions"
        ADD CONSTRAINT "ticket_status_definitions_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ticket_status_definitions_workspace_id_name_key"
    ON "ticket_status_definitions"("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "ticket_status_definitions_workspace_id_is_active_idx"
    ON "ticket_status_definitions"("workspace_id", "is_active");

-- Seed the 4 canonical statuses for EVERY existing workspace (base = self,
-- system-locked). Colors match the queue's existing status pill tones.
INSERT INTO "ticket_status_definitions"
    ("workspace_id", "name", "base_status", "color", "sort_order", "is_system", "is_active")
SELECT w."id", s."name", s."name", s."color", s."sort_order", true, true
FROM "workspaces" w
CROSS JOIN (VALUES
    ('Open', 'blue', 0),
    ('Pending', 'amber', 1),
    ('Resolved', 'emerald', 2),
    ('Closed', 'slate', 3)
) AS s("name", "color", "sort_order")
ON CONFLICT ("workspace_id", "name") DO NOTHING;
