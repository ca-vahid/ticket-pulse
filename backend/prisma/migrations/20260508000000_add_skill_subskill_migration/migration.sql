-- Ticket Pulse-owned Skills/Subskills migration support.
-- Freshservice remains a mirror through two custom dropdown fields.

ALTER TABLE "workspaces"
  ADD COLUMN "tp_skill_custom_field" VARCHAR(100) NOT NULL DEFAULT 'tp_skill',
  ADD COLUMN "tp_subskill_custom_field" VARCHAR(100) NOT NULL DEFAULT 'tp_subskill';

ALTER TABLE "tickets"
  ADD COLUMN "tp_skill" VARCHAR(120),
  ADD COLUMN "tp_subskill" VARCHAR(120);

CREATE INDEX "tickets_tp_skill_idx" ON "tickets"("tp_skill");
CREATE INDEX "tickets_tp_subskill_idx" ON "tickets"("tp_subskill");

CREATE TABLE "skill_hierarchy_drafts" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
  "source" VARCHAR(40) NOT NULL DEFAULT 'manual',
  "state" JSONB NOT NULL,
  "mappings" JSONB,
  "warnings" JSONB,
  "created_by" VARCHAR(255),
  "updated_by" VARCHAR(255),
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "skill_hierarchy_drafts_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE
);

CREATE INDEX "skill_hierarchy_drafts_workspace_status_idx"
  ON "skill_hierarchy_drafts"("workspace_id", "status");

CREATE INDEX "skill_hierarchy_drafts_created_at_idx"
  ON "skill_hierarchy_drafts"("created_at");
