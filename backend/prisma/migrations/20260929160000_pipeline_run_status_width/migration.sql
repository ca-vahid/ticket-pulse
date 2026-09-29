-- 29 Sep 2026: "failed_schema_validation" (24 chars) never fit status VARCHAR(20);
-- the save failed with P2000 and the run was marked a database error instead.
-- Widening a varchar is metadata-only in PostgreSQL (no table rewrite); the
-- lock timeout keeps a busy table from queueing behind it.
SET lock_timeout = '10s';
ALTER TABLE "assignment_pipeline_runs" ALTER COLUMN "status" TYPE VARCHAR(40);
