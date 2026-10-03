-- Availability (plans/AVAILABILITY_TRACKER_PLAN.md, 3 Oct 2026): new tables only; additive.
-- CreateTable
CREATE TABLE IF NOT EXISTS "av_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "year_start_month" INTEGER NOT NULL DEFAULT 1,
    "outlook_events_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_replies_enabled" BOOLEAN NOT NULL DEFAULT false,
    "purpose_notice" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "av_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "av_offices" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "province" VARCHAR(10),
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'America/Vancouver',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "av_offices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "av_people" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "office_id" INTEGER,
    "start_date" DATE,
    "workdays" JSONB,
    "daily_hours" DECIMAL(4,2) NOT NULL DEFAULT 8,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "av_people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "av_leave_types" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "icon" VARCHAR(40),
    "color" VARCHAR(20) NOT NULL DEFAULT 'blue',
    "unit" VARCHAR(10) NOT NULL DEFAULT 'day',
    "allow_half_days" BOOLEAN NOT NULL DEFAULT true,
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "availability" VARCHAR(10) NOT NULL DEFAULT 'OFF',
    "visibility" VARCHAR(10) NOT NULL DEFAULT 'public',
    "requires_note" BOOLEAN NOT NULL DEFAULT false,
    "allow_past_dated" BOOLEAN NOT NULL DEFAULT false,
    "tracks_balance" BOOLEAN NOT NULL DEFAULT false,
    "balance_policy" JSONB,
    "vt_leave_type_names" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "av_leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "av_approval_groups" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "auto_approve_type_ids" JSONB,
    "require_all" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "av_approval_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "av_approval_group_members" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "av_approval_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "av_approval_group_approvers" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "is_delegate" BOOLEAN NOT NULL DEFAULT false,
    "delegate_from" DATE,
    "delegate_until" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "av_approval_group_approvers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "av_rules" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "scope_type" VARCHAR(10) NOT NULL DEFAULT 'company',
    "scope_ref" VARCHAR(255),
    "leave_type_ids" JSONB,
    "condition" JSONB NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "message" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "av_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "av_requests" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "leave_type_id" INTEGER NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "day_part" VARCHAR(8) NOT NULL DEFAULT 'full',
    "start_minute" INTEGER,
    "end_minute" INTEGER,
    "days" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "hours" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "decision" JSONB,
    "decided_by" VARCHAR(255),
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "source" VARCHAR(20) NOT NULL DEFAULT 'app',
    "external_id" VARCHAR(255),
    "wants_outlook_event" BOOLEAN NOT NULL DEFAULT false,
    "wants_auto_reply" BOOLEAN NOT NULL DEFAULT false,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "av_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "av_request_events" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "actor" VARCHAR(255),
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "av_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "av_balance_adjustments" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "leave_type_id" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "days" DECIMAL(7,2) NOT NULL,
    "note" TEXT,
    "actor" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "av_balance_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "av_offices_name_key" ON "av_offices"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "av_people_office_id_idx" ON "av_people"("office_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "av_people_email_key" ON "av_people"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "av_leave_types_key_key" ON "av_leave_types"("key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "av_approval_groups_name_key" ON "av_approval_groups"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "av_approval_group_members_email_idx" ON "av_approval_group_members"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "av_approval_group_members_group_id_email_key" ON "av_approval_group_members"("group_id", "email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "av_approval_group_approvers_email_idx" ON "av_approval_group_approvers"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "av_approval_group_approvers_group_id_email_key" ON "av_approval_group_approvers"("group_id", "email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "av_rules_is_active_idx" ON "av_rules"("is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "av_requests_email_start_date_idx" ON "av_requests"("email", "start_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "av_requests_status_start_date_idx" ON "av_requests"("status", "start_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "av_requests_start_date_end_date_idx" ON "av_requests"("start_date", "end_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "av_requests_external_id_idx" ON "av_requests"("external_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "av_request_events_request_id_idx" ON "av_request_events"("request_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "av_balance_adjustments_email_year_idx" ON "av_balance_adjustments"("email", "year");

-- AddForeignKey
ALTER TABLE "av_people" ADD CONSTRAINT "av_people_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "av_offices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "av_approval_group_members" ADD CONSTRAINT "av_approval_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "av_approval_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "av_approval_group_approvers" ADD CONSTRAINT "av_approval_group_approvers_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "av_approval_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "av_request_events" ADD CONSTRAINT "av_request_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "av_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
