-- Allow multiple daily review runs per (workspace, reviewDate) so each
-- "Run Daily Review" click produces a fresh, identifiable run row instead
-- of overwriting the canonical row in place. The previous unique index
-- was the reason the UI kept showing "Run #1" for every rerun.
DROP INDEX IF EXISTS "assignment_daily_review_runs_workspace_id_review_date_key";

CREATE INDEX IF NOT EXISTS "assignment_daily_review_runs_workspace_id_review_date_idx"
ON "assignment_daily_review_runs"("workspace_id", "review_date");
