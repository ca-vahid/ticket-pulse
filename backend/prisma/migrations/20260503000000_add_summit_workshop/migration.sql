CREATE TABLE "summit_workshop_sessions" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'active',
  "state" JSONB NOT NULL,
  "baseline_state" JSONB NOT NULL,
  "active_version" INTEGER NOT NULL DEFAULT 1,
  "vote_token" VARCHAR(80),
  "vote_enabled" BOOLEAN NOT NULL DEFAULT false,
  "vote_expires_at" TIMESTAMP(3),
  "last_saved_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "summit_workshop_sessions_vote_token_key" ON "summit_workshop_sessions"("vote_token");
CREATE INDEX "summit_workshop_sessions_workspace_id_idx" ON "summit_workshop_sessions"("workspace_id");
CREATE INDEX "summit_workshop_sessions_status_idx" ON "summit_workshop_sessions"("status");
CREATE INDEX "summit_workshop_sessions_vote_token_idx" ON "summit_workshop_sessions"("vote_token");

ALTER TABLE "summit_workshop_sessions"
  ADD CONSTRAINT "summit_workshop_sessions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "summit_workshop_snapshots" (
  "id" SERIAL PRIMARY KEY,
  "session_id" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "label" VARCHAR(160),
  "snapshot_type" VARCHAR(30) NOT NULL DEFAULT 'manual',
  "state" JSONB NOT NULL,
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "summit_workshop_snapshots_session_id_idx" ON "summit_workshop_snapshots"("session_id");
CREATE INDEX "summit_workshop_snapshots_created_at_idx" ON "summit_workshop_snapshots"("created_at");

ALTER TABLE "summit_workshop_snapshots"
  ADD CONSTRAINT "summit_workshop_snapshots_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "summit_workshop_sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "summit_workshop_participants" (
  "id" SERIAL PRIMARY KEY,
  "session_id" INTEGER NOT NULL,
  "participant_key" VARCHAR(80) NOT NULL,
  "display_name" VARCHAR(120) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "summit_workshop_participants_participant_key_key" ON "summit_workshop_participants"("participant_key");
CREATE INDEX "summit_workshop_participants_session_id_idx" ON "summit_workshop_participants"("session_id");

ALTER TABLE "summit_workshop_participants"
  ADD CONSTRAINT "summit_workshop_participants_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "summit_workshop_sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "summit_workshop_votes" (
  "id" SERIAL PRIMARY KEY,
  "session_id" INTEGER NOT NULL,
  "participant_id" INTEGER NOT NULL,
  "item_id" VARCHAR(120) NOT NULL,
  "item_type" VARCHAR(30) NOT NULL,
  "item_label" VARCHAR(255) NOT NULL,
  "vote_type" VARCHAR(40) NOT NULL,
  "value" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "summit_workshop_votes_participant_id_item_id_vote_type_key" ON "summit_workshop_votes"("participant_id", "item_id", "vote_type");
CREATE INDEX "summit_workshop_votes_session_id_idx" ON "summit_workshop_votes"("session_id");
CREATE INDEX "summit_workshop_votes_item_id_idx" ON "summit_workshop_votes"("item_id");
CREATE INDEX "summit_workshop_votes_vote_type_idx" ON "summit_workshop_votes"("vote_type");

ALTER TABLE "summit_workshop_votes"
  ADD CONSTRAINT "summit_workshop_votes_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "summit_workshop_sessions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "summit_workshop_votes"
  ADD CONSTRAINT "summit_workshop_votes_participant_id_fkey"
  FOREIGN KEY ("participant_id") REFERENCES "summit_workshop_participants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
