-- Categories overhaul: per-parent name uniqueness.
--
-- Replaces the global-per-workspace unique on competency_categories(workspace_id, name)
-- with two partial unique indexes:
--   * top-level categories stay unique per workspace, and
--   * subcategories are unique per (workspace, parent) — the same subcategory
--     name (e.g. "Quebec") may now exist under different parents.
--
-- Safe on existing data: rows were globally unique before this migration, so
-- both partial indexes apply cleanly. Idempotent (IF EXISTS / IF NOT EXISTS)
-- so a partial or replayed run converges to the same state.
--
-- NOTE: Prisma cannot express partial unique indexes, so schema.prisma carries
-- no @@unique for this — these two indexes are the source of truth. Unique
-- violations still surface as Prisma error P2002; with raw indexes the
-- constraint is identified by index name (see meta/message), which
-- competencyRepository matches explicitly.

DROP INDEX IF EXISTS "competency_categories_workspace_id_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "competency_categories_ws_name_toplevel_key"
  ON "competency_categories"("workspace_id", "name")
  WHERE "parent_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "competency_categories_ws_parent_name_key"
  ON "competency_categories"("workspace_id", "parent_id", "name")
  WHERE "parent_id" IS NOT NULL;
