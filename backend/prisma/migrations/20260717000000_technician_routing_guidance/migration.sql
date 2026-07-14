-- Standing per-technician instruction surfaced to the assignment AI on
-- every run (QA 07-14: reduced-capacity agents kept winning on low load).
ALTER TABLE "technicians" ADD COLUMN "routing_guidance" TEXT;
