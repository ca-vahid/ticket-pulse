// v3.8.91: per-workspace assignment fast-sync cadence helpers (pure).
/** Fast-sync cadence guard: integer minutes, 1..30 (anything else → 1). */
export function clampFastSyncInterval(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(30, n);
}

/**
 * Scheduled FULL syncs: every N minutes, but each workspace on its own minute
 * inside the window (workspace id mod N). Five workspaces used to fire in the
 * same minute (`*\/5`) — :00, :05, :10 … — and each burst put ~90 requests on
 * the shared FreshService limiter, drawing 429s with Retry-After up to 18 s and
 * 90 s queue timeouts for the mirror and thread fetches (22 Sep 2026, ~110
 * timeouts an hour in business hours). Spread, the same work costs nothing
 * extra and never lands on itself. Cadence per workspace is unchanged.
 *
 * The minutes are written out (`1,6,11,…,56`), never as a stepped range:
 * node-cron 3.0.3 expands `1-59/5` to the multiples of 5 inside 1–59, ignoring
 * the start — so 3.9.67's `1-59/5` … `4-59/5` all fired on :05, :10 … together
 * (the stagger never took effect) and skipped :00 (23 Sep 2026).
 */
export function fullSyncCronExpression(intervalMinutes, workspaceId = 0) {
  const every = Math.trunc(Number(intervalMinutes));
  const n = Number.isFinite(every) && every >= 1 && every <= 60 ? every : 5;
  const id = Math.max(0, Math.trunc(Number(workspaceId) || 0));
  if (n === 1) return '* * * * *';
  const minutes = [];
  for (let m = id % n; m < 60; m += n) minutes.push(m);
  return `${minutes.join(',')} * * * *`;
}

/** node-cron expression (with seconds) for "every N minutes at :SS". */
export function fastSyncCronExpression(everyMinutes, secondOffset = 0) {
  const every = clampFastSyncInterval(everyMinutes);
  const sec = Math.max(0, Math.min(59, Math.trunc(Number(secondOffset) || 0)));
  return every === 1 ? `${sec} * * * * *` : `${sec} */${every} * * * *`;
}
