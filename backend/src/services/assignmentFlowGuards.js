const RETRYABLE_PIPELINE_STATUSES = new Set([
  'failed',
  'cancelled',
  'skipped_stale',
  'superseded',
  'failed_schema_validation',
]);

export function shouldCloseNoiseDismissedRun(run) {
  return (run?.recommendation?.recommendations?.length || 0) === 0;
}

export function shouldTriggerAssignmentForLatestRun(latestRun) {
  if (!latestRun) {
    return true;
  }

  if (latestRun.status === 'queued' || latestRun.status === 'running') {
    return false;
  }

  if (latestRun.status === 'completed') {
    return false;
  }

  return RETRYABLE_PIPELINE_STATUSES.has(latestRun.status);
}
