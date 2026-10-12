-- Knowledge library, contribution and review (plans/KNOWLEDGE_SIMPLIFY_PLAN.md,
-- phases 2-4). Additive only. Apply to production BEFORE the merge.

-- An article is "checked" once a person with the skill confirmed it (or two
-- agents reused it unchanged). "needs_look" = doubtful: out of automatic answers.
ALTER TABLE "knowledge_articles" ADD COLUMN IF NOT EXISTS "confidence" VARCHAR(20) NOT NULL DEFAULT 'not_checked';
ALTER TABLE "knowledge_articles" ADD COLUMN IF NOT EXISTS "checked_by" VARCHAR(255);
ALTER TABLE "knowledge_articles" ADD COLUMN IF NOT EXISTS "checked_at" TIMESTAMPTZ(6);
ALTER TABLE "knowledge_articles" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
-- Articles someone already verified by hand are checked.
UPDATE "knowledge_articles" SET "confidence" = 'checked', "checked_at" = "last_verified_at", "checked_by" = COALESCE("owner_email", "updated_by")
  WHERE "last_verified_at" IS NOT NULL AND "confidence" = 'not_checked';

-- Every saved version of an article: safe edits, one-click restore.
CREATE TABLE IF NOT EXISTS "knowledge_article_versions" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "article_id" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "title" VARCHAR(300) NOT NULL,
  "body_html" TEXT NOT NULL DEFAULT '',
  "status" VARCHAR(20) NOT NULL,
  "category_id" INTEGER,
  "subcategory_id" INTEGER,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "changed_by" VARCHAR(255),
  "change_note" TEXT,
  "suggestion_id" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_knowledge_article_versions_article" ON "knowledge_article_versions" ("article_id", "version");

-- What happened to an article in use: quoted, marked good / partly / wrong,
-- rewritten before sending, flagged, a search that found nothing, an ask at close.
CREATE TABLE IF NOT EXISTS "knowledge_signals" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "kind" VARCHAR(30) NOT NULL,
  "article_id" INTEGER,
  "section_index" INTEGER,
  "category_id" INTEGER,
  "ticket_id" INTEGER,
  "run_id" INTEGER,
  "actor" VARCHAR(255),
  "note" TEXT,
  "meta" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_knowledge_signals_ws_article" ON "knowledge_signals" ("workspace_id", "article_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_knowledge_signals_ws_kind" ON "knowledge_signals" ("workspace_id", "kind", "created_at");
CREATE INDEX IF NOT EXISTS "idx_knowledge_signals_actor" ON "knowledge_signals" ("workspace_id", "actor", "kind", "created_at");

-- The inbox: everything that needs a person, in one shape.
CREATE TABLE IF NOT EXISTS "knowledge_suggestions" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "kind" VARCHAR(30) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'open',
  "article_id" INTEGER,
  "other_article_id" INTEGER,
  "category_id" INTEGER,
  "subcategory_id" INTEGER,
  "title" VARCHAR(300) NOT NULL,
  "why" TEXT,
  "proposed" JSONB,
  "evidence" JSONB,
  "impact" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "source" VARCHAR(30) NOT NULL DEFAULT 'person',
  "assigned_to" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "dedupe_key" VARCHAR(200),
  "created_by" VARCHAR(255),
  "decided_by" VARCHAR(255),
  "decided_at" TIMESTAMPTZ(6),
  "decision_note" TEXT,
  "result_article_id" INTEGER,
  "snoozed_until" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_knowledge_suggestions_ws_dedupe" ON "knowledge_suggestions" ("workspace_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "idx_knowledge_suggestions_ws_status" ON "knowledge_suggestions" ("workspace_id", "status", "impact");
CREATE INDEX IF NOT EXISTS "idx_knowledge_suggestions_article" ON "knowledge_suggestions" ("article_id", "status");

-- Workspace settings for contribution and the nightly review.
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "publish_level" VARCHAR(20) NOT NULL DEFAULT 'intermediate';
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "check_level" VARCHAR(20) NOT NULL DEFAULT 'advanced';
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "ask_at_close" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "ask_daily_cap" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "steward_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "steward_state" JSONB;
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "inbox_weekly_cap" INTEGER NOT NULL DEFAULT 5;
