-- Quick notes (QA 07-06 #12): canned internal notes, optionally scoped to
-- top-level internal categories, insertable from the composer's note mode.

CREATE TABLE IF NOT EXISTS "quick_notes" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "body_html" TEXT,
    "body_text" TEXT NOT NULL,
    "internal_category_ids" INTEGER[] NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quick_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "quick_notes_workspace_id_is_active_idx"
    ON "quick_notes"("workspace_id", "is_active");

DO $$ BEGIN
    ALTER TABLE "quick_notes"
        ADD CONSTRAINT "quick_notes_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
