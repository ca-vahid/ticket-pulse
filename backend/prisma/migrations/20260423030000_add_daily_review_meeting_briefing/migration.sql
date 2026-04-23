-- Persist an optional human-readable "meeting briefing" generated on-demand
-- from a completed daily review run. The briefing is a structured one-pager
-- (headline, narrative, key metrics, highlights, talking points, lookahead)
-- intended for the next-day operations standup. Stored as JSONB so the
-- shape can evolve without further migrations.
ALTER TABLE "assignment_daily_review_runs"
  ADD COLUMN "meeting_briefing" JSONB,
  ADD COLUMN "meeting_briefing_generated_at" TIMESTAMP(3),
  ADD COLUMN "meeting_briefing_tokens" INTEGER,
  ADD COLUMN "meeting_briefing_model" VARCHAR(100),
  ADD COLUMN "meeting_briefing_by" VARCHAR(255);
