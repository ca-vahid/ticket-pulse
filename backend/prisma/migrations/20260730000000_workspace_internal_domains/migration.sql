-- External-requester flagging (QA 07-27 #4): per-workspace list of internal /
-- trusted email domains. Tickets whose requester email domain is outside the
-- list get an "External" badge (derived at read time — no ticket column).
-- Empty list (the default) disables flagging for that workspace.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "internal_domains" TEXT[] NOT NULL DEFAULT '{}';
