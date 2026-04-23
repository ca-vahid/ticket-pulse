-- Persist live progress for the daily review on the run row itself so a
-- polling client (e.g. the frontend on Azure App Service, where the
-- 230-second request timeout makes long-lived SSE unreliable) can render
-- the same step-by-step UI that the in-request SSE stream used to provide.
ALTER TABLE "assignment_daily_review_runs"
  ADD COLUMN "progress" JSONB,
  ADD COLUMN "progress_updated_at" TIMESTAMP(3);
