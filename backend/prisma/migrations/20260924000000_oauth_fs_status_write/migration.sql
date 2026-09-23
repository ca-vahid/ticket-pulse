-- Public API status changes on FreshService-born tickets (23 Sep 2026):
-- per-client opt-in, off by default. Additive.
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "fs_status_write" BOOLEAN NOT NULL DEFAULT false;
