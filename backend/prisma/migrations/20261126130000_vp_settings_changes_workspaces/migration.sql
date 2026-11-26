-- Vacation Pulse settings history privacy (26 Nov 2026): every workspace a
-- change is about (a person's workspaces, a scoped rule's people), so a
-- workspace admin reads only the rows of the workspaces they administer.
-- [0] marks a change about people of no workspace (super admins only); an
-- empty list with no workspace_id is a company-wide change.
-- Additive: a NOT NULL column with a constant default is a metadata-only
-- change on PostgreSQL 11+ (no table rewrite). Safe to run twice.

ALTER TABLE "av_settings_changes" ADD COLUMN IF NOT EXISTS "workspace_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
