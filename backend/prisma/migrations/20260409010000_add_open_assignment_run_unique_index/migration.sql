DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM assignment_pipeline_runs
    WHERE status IN ('queued', 'running')
    GROUP BY ticket_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create open-run unique index: duplicate queued/running runs exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS assignment_pipeline_runs_open_ticket_unique_idx
  ON assignment_pipeline_runs (ticket_id)
  WHERE status IN ('queued', 'running');
