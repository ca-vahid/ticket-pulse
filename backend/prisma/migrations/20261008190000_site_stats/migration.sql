-- Site stats (Settings -> Site stats, super admins only). Additive: six new
-- tables, nothing existing is touched. Indexes are created inline because the
-- tables are new and empty.

CREATE TABLE IF NOT EXISTS "usage_events" (
    "id" SERIAL NOT NULL,
    "event_uuid" VARCHAR(40) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email" VARCHAR(255) NOT NULL,
    "workspace_id" INTEGER NOT NULL DEFAULT 0,
    "visit_id" VARCHAR(40),
    "kind" VARCHAR(10) NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "section" VARCHAR(80) NOT NULL DEFAULT '',
    "engaged_seconds" INTEGER NOT NULL DEFAULT 0,
    "open_seconds" INTEGER NOT NULL DEFAULT 0,
    "app_version" VARCHAR(30),
    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "usage_events_event_uuid_key" ON "usage_events"("event_uuid");
CREATE INDEX IF NOT EXISTS "usage_events_occurred_at_idx" ON "usage_events"("occurred_at");
CREATE INDEX IF NOT EXISTS "usage_events_email_occurred_at_idx" ON "usage_events"("email", "occurred_at");

CREATE TABLE IF NOT EXISTS "usage_sign_ins" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" VARCHAR(20) NOT NULL,
    "outcome" VARCHAR(20) NOT NULL,
    "browser" VARCHAR(20),
    "device" VARCHAR(20),
    CONSTRAINT "usage_sign_ins_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "usage_sign_ins_at_idx" ON "usage_sign_ins"("at");
CREATE INDEX IF NOT EXISTS "usage_sign_ins_email_at_idx" ON "usage_sign_ins"("email", "at");

CREATE TABLE IF NOT EXISTS "usage_daily_users" (
    "id" SERIAL NOT NULL,
    "day" DATE NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "engaged_seconds" INTEGER NOT NULL DEFAULT 0,
    "open_seconds" INTEGER NOT NULL DEFAULT 0,
    "page_views" INTEGER NOT NULL DEFAULT 0,
    "actions" INTEGER NOT NULL DEFAULT 0,
    "first_at" TIMESTAMP(3) NOT NULL,
    "last_at" TIMESTAMP(3) NOT NULL,
    "hours_mask" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "usage_daily_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "usage_daily_users_day_email_key" ON "usage_daily_users"("day", "email");
CREATE INDEX IF NOT EXISTS "usage_daily_users_email_day_idx" ON "usage_daily_users"("email", "day");

CREATE TABLE IF NOT EXISTS "usage_daily_user_items" (
    "id" SERIAL NOT NULL,
    "day" DATE NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "workspace_id" INTEGER NOT NULL DEFAULT 0,
    "kind" VARCHAR(10) NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "section" VARCHAR(80) NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,
    "engaged_seconds" INTEGER NOT NULL DEFAULT 0,
    "open_seconds" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "usage_daily_user_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "usage_daily_user_items_uq" ON "usage_daily_user_items"("day", "email", "workspace_id", "kind", "key", "section");
CREATE INDEX IF NOT EXISTS "usage_daily_user_items_day_kind_idx" ON "usage_daily_user_items"("day", "kind");

CREATE TABLE IF NOT EXISTS "usage_people" (
    "email" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sign_in_at" TIMESTAMP(3),
    "sign_in_count" INTEGER NOT NULL DEFAULT 0,
    "browser" VARCHAR(20),
    "device" VARCHAR(20),
    "viewport" VARCHAR(20),
    CONSTRAINT "usage_people_pkey" PRIMARY KEY ("email")
);

CREATE TABLE IF NOT EXISTS "usage_stats_views" (
    "id" SERIAL NOT NULL,
    "viewer_email" VARCHAR(255) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "view" VARCHAR(40) NOT NULL,
    CONSTRAINT "usage_stats_views_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "usage_stats_views_at_idx" ON "usage_stats_views"("at");
