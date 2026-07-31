-- Correction feedback loop v1: structured reason code for manual reassignments
-- away from an AI pick ('wrong_skill' | 'load_balancing' | 'availability' | 'other').
ALTER TABLE "assignment_corrections" ADD COLUMN IF NOT EXISTS "reason_code" VARCHAR(30);
