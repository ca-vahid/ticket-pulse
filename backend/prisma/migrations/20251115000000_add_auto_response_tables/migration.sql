-- CreateTable
CREATE TABLE "business_hours" (
    "id" SERIAL NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" VARCHAR(5) NOT NULL,
    "endTime" VARCHAR(5) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'America/Los_Angeles',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "date" DATE NOT NULL,
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "country" VARCHAR(2),
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_responses" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER,
    "freshservice_ticket_id" BIGINT,
    "sender_email" VARCHAR(255) NOT NULL,
    "sender_name" VARCHAR(255),
    "classification" VARCHAR(50) NOT NULL,
    "severity" VARCHAR(20),
    "is_after_hours" BOOLEAN NOT NULL DEFAULT false,
    "is_holiday" BOOLEAN NOT NULL DEFAULT false,
    "estimated_wait_minutes" INTEGER,
    "queue_length" INTEGER,
    "active_agent_count" INTEGER,
    "response_generated" TEXT,
    "response_sent" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMP(3),
    "llm_model" VARCHAR(50),
    "llm_tokens_used" INTEGER,
    "raw_email_body" TEXT,
    "webhook_payload" JSONB,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "business_hours_dayOfWeek_idx" ON "business_hours"("dayOfWeek");

-- CreateIndex
CREATE INDEX "holidays_date_idx" ON "holidays"("date");

-- CreateIndex
CREATE INDEX "auto_responses_freshservice_ticket_id_idx" ON "auto_responses"("freshservice_ticket_id");

-- CreateIndex
CREATE INDEX "auto_responses_created_at_idx" ON "auto_responses"("created_at");

-- CreateIndex
CREATE INDEX "auto_responses_sender_email_idx" ON "auto_responses"("sender_email");

