-- CreateTable
CREATE TABLE "technicians" (
    "id" SERIAL NOT NULL,
    "freshservice_id" BIGINT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255),
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'America/Los_Angeles',
    "location" VARCHAR(100),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "technicians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" SERIAL NOT NULL,
    "freshservice_ticket_id" BIGINT NOT NULL,
    "subject" TEXT,
    "status" VARCHAR(50) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "assigned_tech_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL,
    "assigned_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    "is_self_picked" BOOLEAN NOT NULL DEFAULT false,
    "assigned_by" VARCHAR(255),
    "workspace_name" VARCHAR(100),

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_activities" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "activityType" VARCHAR(50) NOT NULL,
    "performed_by" VARCHAR(255) NOT NULL,
    "performed_at" TIMESTAMP(3) NOT NULL,
    "details" JSONB,

    CONSTRAINT "ticket_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" SERIAL NOT NULL,
    "syncType" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "records_processed" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "technicians_freshservice_id_key" ON "technicians"("freshservice_id");

-- CreateIndex
CREATE INDEX "technicians_freshservice_id_idx" ON "technicians"("freshservice_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_freshservice_ticket_id_key" ON "tickets"("freshservice_ticket_id");

-- CreateIndex
CREATE INDEX "tickets_assigned_tech_id_idx" ON "tickets"("assigned_tech_id");

-- CreateIndex
CREATE INDEX "tickets_created_at_idx" ON "tickets"("created_at");

-- CreateIndex
CREATE INDEX "tickets_status_idx" ON "tickets"("status");

-- CreateIndex
CREATE INDEX "tickets_workspace_name_idx" ON "tickets"("workspace_name");

-- CreateIndex
CREATE INDEX "ticket_activities_ticket_id_idx" ON "ticket_activities"("ticket_id");

-- CreateIndex
CREATE INDEX "ticket_activities_performed_at_idx" ON "ticket_activities"("performed_at");

-- CreateIndex
CREATE UNIQUE INDEX "app_settings_key_key" ON "app_settings"("key");

-- CreateIndex
CREATE INDEX "sync_logs_started_at_idx" ON "sync_logs"("started_at");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigned_tech_id_fkey" FOREIGN KEY ("assigned_tech_id") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;
