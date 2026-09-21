-- Alert correlation (20 Sep 2026): pair rules + storm grouping for machine alerts. Additive.
CREATE TABLE IF NOT EXISTS "alert_correlation_rules" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" TEXT,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "sender_pattern" TEXT NOT NULL,
  "fired_pattern" TEXT NOT NULL,
  "cleared_pattern" TEXT,
  "followup_pattern" TEXT,
  "pair_window_minutes" INTEGER NOT NULL DEFAULT 360,
  "pair_action" VARCHAR(20) NOT NULL DEFAULT 'resolve',
  "orphan_cleared_action" VARCHAR(20) NOT NULL DEFAULT 'resolve',
  "storm_enabled" BOOLEAN NOT NULL DEFAULT true,
  "storm_window_minutes" INTEGER NOT NULL DEFAULT 60,
  "storm_min_count" INTEGER NOT NULL DEFAULT 3,
  "resolution_reason" VARCHAR(40) NOT NULL DEFAULT 'benign_expected',
  "skip_ai" BOOLEAN NOT NULL DEFAULT true,
  "match_count" INTEGER NOT NULL DEFAULT 0,
  "last_matched_at" TIMESTAMP(3),
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_correlation_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "alert_correlation_rules_workspace_id_is_enabled_idx" ON "alert_correlation_rules"("workspace_id", "is_enabled");
