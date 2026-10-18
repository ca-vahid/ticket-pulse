-- BC stopped changing its clocks on 1 Nov 2026 (permanent UTC-7). America/Los_Angeles
-- still falls back, so new rows default to America/Vancouver. Defaults only; existing
-- rows are moved by scripts/migrate-timezone-vancouver.mjs.
ALTER TABLE "workspaces" ALTER COLUMN "default_timezone" SET DEFAULT 'America/Vancouver';
ALTER TABLE "technicians" ALTER COLUMN "timezone" SET DEFAULT 'America/Vancouver';
ALTER TABLE "business_hours" ALTER COLUMN "timezone" SET DEFAULT 'America/Vancouver';
