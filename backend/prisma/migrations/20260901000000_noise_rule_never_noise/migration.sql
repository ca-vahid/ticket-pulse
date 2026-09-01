-- NoiseRule.mode: 'noise' (default, existing behavior — subject regex marks
-- tickets as noise) vs 'never_noise' (deterministic veto — tickets matching
-- the rule can NEVER be auto-dismissed by the AI pipeline, regardless of
-- prompt or model). Mega 08-31 Phase NT (NT-1).
-- Idempotent; safe to re-apply. Apply to prod BEFORE deploying the code.
ALTER TABLE "noise_rules"
    ADD COLUMN IF NOT EXISTS "mode" VARCHAR(20) NOT NULL DEFAULT 'noise';

CREATE INDEX IF NOT EXISTS "noise_rules_mode_idx" ON "noise_rules"("mode");
