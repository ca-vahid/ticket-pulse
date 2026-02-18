-- Add CSAT (Customer Satisfaction) fields to tickets table
ALTER TABLE "tickets" ADD COLUMN "csat_response_id" BIGINT;
ALTER TABLE "tickets" ADD COLUMN "csat_score" INTEGER;
ALTER TABLE "tickets" ADD COLUMN "csat_total_score" INTEGER;
ALTER TABLE "tickets" ADD COLUMN "csat_rating_text" VARCHAR(50);
ALTER TABLE "tickets" ADD COLUMN "csat_overall_rating" INTEGER;
ALTER TABLE "tickets" ADD COLUMN "csat_feedback" TEXT;
ALTER TABLE "tickets" ADD COLUMN "csat_submitted_at" TIMESTAMP(3);

-- Create indexes for CSAT fields
CREATE INDEX "tickets_csat_score_idx" ON "tickets"("csat_score");
CREATE INDEX "tickets_csat_submitted_at_idx" ON "tickets"("csat_submitted_at");

