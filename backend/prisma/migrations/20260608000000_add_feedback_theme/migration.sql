-- Per-workspace feedback page visual theme selection (defaults to 'earth').
ALTER TABLE "public_feedback_settings" ADD COLUMN "theme" VARCHAR(24) DEFAULT 'earth';
