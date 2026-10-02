-- HR lifecycle: Onboarding / Offboarding (plans/HR_LIFECYCLE_PLAN.md, QA 10-01 #8).
-- Additive only: new tables, nothing dropped or renamed. Ships disabled
-- (mode 'off' per workspace; no settings row = off).

CREATE TABLE IF NOT EXISTS "hr_lifecycle_settings" (
  "workspace_id" INTEGER NOT NULL,
  "mode" VARCHAR(10) NOT NULL DEFAULT 'off',
  "parent_assignee_tech_id" INTEGER,
  "templates" JSONB,
  "leave" JSONB,
  "office_change" JSONB,
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hr_lifecycle_settings_pkey" PRIMARY KEY ("workspace_id")
);

CREATE TABLE IF NOT EXISTS "hr_lifecycle_settings_changes" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "changed_by" VARCHAR(255),
  "changed_by_name" VARCHAR(255),
  "field" VARCHAR(200) NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hr_lifecycle_settings_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_hr_lifecycle_settings_changes_ws" ON "hr_lifecycle_settings_changes" ("workspace_id", "created_at");

CREATE TABLE IF NOT EXISTS "hr_lifecycle_families" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "parent_ticket_id" INTEGER,
  "person_name" VARCHAR(255) NOT NULL,
  "person_key" VARCHAR(255) NOT NULL,
  "person_email" VARCHAR(255),
  "employee_id" VARCHAR(40),
  "office" VARCHAR(120),
  "effective_date" DATE,
  "after_the_fact" BOOLEAN NOT NULL DEFAULT false,
  "status" VARCHAR(20) NOT NULL DEFAULT 'open',
  "template" VARCHAR(40) NOT NULL,
  "source_ticket_ids" JSONB NOT NULL DEFAULT '[]',
  "details" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMPTZ(6),
  CONSTRAINT "hr_lifecycle_families_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_hr_lifecycle_families_ws_status" ON "hr_lifecycle_families" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "idx_hr_lifecycle_families_ws_emp" ON "hr_lifecycle_families" ("workspace_id", "employee_id");
CREATE INDEX IF NOT EXISTS "idx_hr_lifecycle_families_ws_person" ON "hr_lifecycle_families" ("workspace_id", "person_key");

CREATE TABLE IF NOT EXISTS "hr_lifecycle_family_members" (
  "id" SERIAL NOT NULL,
  "family_id" INTEGER NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "role" VARCHAR(20) NOT NULL DEFAULT 'child',
  "template_key" VARCHAR(60),
  "title" VARCHAR(200),
  "due_offset_days" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hr_lifecycle_family_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hr_lifecycle_family_members_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "hr_lifecycle_families"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_hr_lifecycle_family_members" ON "hr_lifecycle_family_members" ("family_id", "ticket_id");
CREATE INDEX IF NOT EXISTS "idx_hr_lifecycle_family_members_ticket" ON "hr_lifecycle_family_members" ("ticket_id");

CREATE TABLE IF NOT EXISTS "hr_lifecycle_events" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER,
  "family_id" INTEGER,
  "mode" VARCHAR(10) NOT NULL,
  "notice_type" VARCHAR(40) NOT NULL,
  "subject" VARCHAR(500),
  "person" VARCHAR(255),
  "decision" VARCHAR(40) NOT NULL,
  "outcome" VARCHAR(20) NOT NULL,
  "summary" TEXT,
  "details" JSONB,
  "actor" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hr_lifecycle_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_hr_lifecycle_events_ws" ON "hr_lifecycle_events" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_hr_lifecycle_events_ticket" ON "hr_lifecycle_events" ("ticket_id");
