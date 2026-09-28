-- Simorgh Phase C (27 Sep 2026): a short "why" for the latest alert occurrence
-- (e.g. "same persistence rule, signed IT tooling on bgc2744"). Additive.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "last_occurrence_summary" VARCHAR(300);
