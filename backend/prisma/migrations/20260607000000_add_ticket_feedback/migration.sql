-- First-party satisfaction feedback (custom CSAT replacement).
-- Adds per-workspace feedback page settings and per-ticket feedback submissions.

-- CreateTable
CREATE TABLE "public_feedback_settings" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "headline" VARCHAR(160),
    "subtext" VARCHAR(400),
    "thank_you_message" VARCHAR(400),
    "comment_enabled" BOOLEAN NOT NULL DEFAULT true,
    "comment_prompt" VARCHAR(200),
    "label1" VARCHAR(40),
    "label2" VARCHAR(40),
    "label3" VARCHAR(40),
    "label4" VARCHAR(40),
    "label5" VARCHAR(40),
    "image1" TEXT,
    "image2" TEXT,
    "image3" TEXT,
    "image4" TEXT,
    "image5" TEXT,
    "brand_name" VARCHAR(120),
    "logo_data_url" TEXT,
    "logo_alt_text" VARCHAR(160),
    "trademark_text" VARCHAR(300),
    "accent_color" VARCHAR(24),
    "updated_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_feedback_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_feedback" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "link_id" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "normalized_score" INTEGER NOT NULL,
    "comment" TEXT,
    "ip_hash" VARCHAR(64),
    "user_agent" VARCHAR(500),
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "public_feedback_settings_workspace_id_key" ON "public_feedback_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "public_feedback_settings_workspace_id_idx" ON "public_feedback_settings"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_feedback_ticket_id_key" ON "ticket_feedback"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_feedback_link_id_key" ON "ticket_feedback"("link_id");

-- CreateIndex
CREATE INDEX "ticket_feedback_workspace_id_submitted_at_idx" ON "ticket_feedback"("workspace_id", "submitted_at");

-- AddForeignKey
ALTER TABLE "public_feedback_settings" ADD CONSTRAINT "public_feedback_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_feedback" ADD CONSTRAINT "ticket_feedback_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_feedback" ADD CONSTRAINT "ticket_feedback_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_feedback" ADD CONSTRAINT "ticket_feedback_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "public_ticket_status_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
