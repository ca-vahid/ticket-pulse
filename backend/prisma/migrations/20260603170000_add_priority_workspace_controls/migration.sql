ALTER TABLE "assignment_configs"
  ADD COLUMN "priority_assessment_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "priority_writeback_enabled" BOOLEAN NOT NULL DEFAULT true;
