-- AlterTable: Add requester information fields
ALTER TABLE "tickets" ADD COLUMN "requester_name" VARCHAR(255),
ADD COLUMN "requester_email" VARCHAR(255),
ADD COLUMN "requester_id" BIGINT;

-- AlterTable: Add description fields
ALTER TABLE "tickets" ADD COLUMN "description" TEXT,
ADD COLUMN "description_text" TEXT;

-- AlterTable: Add additional time tracking fields
ALTER TABLE "tickets" ADD COLUMN "closed_at" TIMESTAMP(3),
ADD COLUMN "due_by" TIMESTAMP(3),
ADD COLUMN "fr_due_by" TIMESTAMP(3);

-- AlterTable: Add metadata fields
ALTER TABLE "tickets" ADD COLUMN "source" INTEGER,
ADD COLUMN "category" VARCHAR(255),
ADD COLUMN "sub_category" VARCHAR(255),
ADD COLUMN "department" VARCHAR(255),
ADD COLUMN "is_escalated" BOOLEAN DEFAULT false;

-- CreateIndex: Add index on requester_id for faster lookups
CREATE INDEX "tickets_requester_id_idx" ON "tickets"("requester_id");
