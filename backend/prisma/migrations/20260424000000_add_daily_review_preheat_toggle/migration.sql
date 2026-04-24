-- Per-workspace opt-in for the daily-review thread preheat. When the
-- regular 5-min sync runs, it only pulls FreshService activity + conversation
-- data for today's ticket cohort if this flag is true. Off by default so
-- workspaces that don't use Daily Review don't burn FS API budget on
-- conversation pulls they will never need.
ALTER TABLE "assignment_configs"
  ADD COLUMN "daily_review_preheat_enabled" BOOLEAN NOT NULL DEFAULT false;
