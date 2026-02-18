-- AlterTable
ALTER TABLE "auto_responses" ADD COLUMN "config_version_used" INTEGER;

-- CreateTable
CREATE TABLE "llm_configs" (
    "id" SERIAL NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "classification_prompt" TEXT NOT NULL,
    "response_prompt" TEXT NOT NULL,
    "signature_block" TEXT,
    "fallback_message" TEXT,
    "tone_presets" JSONB,
    "base_response_minutes" INTEGER NOT NULL DEFAULT 30,
    "per_ticket_delay_minutes" INTEGER NOT NULL DEFAULT 10,
    "after_hours_message" TEXT,
    "holiday_message" TEXT,
    "override_rules" JSONB,
    "domain_whitelist" JSONB,
    "domain_blacklist" JSONB,
    "created_by" VARCHAR(255),
    "published_by" VARCHAR(255),
    "published_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_config_history" (
    "id" SERIAL NOT NULL,
    "config_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "config_snapshot" JSONB NOT NULL,
    "changed_by" VARCHAR(255),
    "change_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_config_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_configs_status_idx" ON "llm_configs"("status");

-- CreateIndex
CREATE INDEX "llm_configs_version_idx" ON "llm_configs"("version");

-- CreateIndex
CREATE INDEX "llm_config_history_config_id_idx" ON "llm_config_history"("config_id");

-- CreateIndex
CREATE INDEX "llm_config_history_created_at_idx" ON "llm_config_history"("created_at");

