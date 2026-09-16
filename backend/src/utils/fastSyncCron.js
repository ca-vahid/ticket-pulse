// v3.8.91: per-workspace assignment fast-sync cadence helpers (pure).
/** Fast-sync cadence guard: integer minutes, 1..30 (anything else → 1). */
export function clampFastSyncInterval(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(30, n);
}

/** node-cron expression (with seconds) for "every N minutes at :SS". */
export function fastSyncCronExpression(everyMinutes, secondOffset = 0) {
  const every = clampFastSyncInterval(everyMinutes);
  const sec = Math.max(0, Math.min(59, Math.trunc(Number(secondOffset) || 0)));
  return every === 1 ? `${sec} * * * * *` : `${sec} */${every} * * * *`;
}
