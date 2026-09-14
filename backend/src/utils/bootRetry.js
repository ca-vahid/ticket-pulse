/**
 * Boot-time retry for the database-dependent part of server initialisation.
 *
 * 14 Sep 2026, 07:20 UTC: Azure PostgreSQL restarted for maintenance. The app
 * crashed on the dropped connections (fine — the platform restarted it), but
 * the NEW container booted while the database was still coming back.
 * `initialize()` failed at its first query and gave up, so the sync scheduler,
 * the mirror, the mailbox ingest and the watchdogs never started. The HTTP
 * server kept serving, the database recovered a minute later, /health went
 * green — and four workspaces served seven-hour-old data until someone saw
 * the "sync is stale" banner. Only the webhook-fed IT workspace stayed fresh.
 *
 * A database that is unreachable AT BOOT is a transient condition, not a
 * configuration error. Retry with backoff before treating it as fatal.
 */

export const BOOT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 120_000, 120_000, 300_000];

/** True for the errors a database restart produces: connection refused/reset, Prisma cannot reach the server. */
export function isTransientDbError(error) {
  const name = error?.name || error?.originalError?.name || '';
  const message = String(error?.message || '') + ' ' + String(error?.originalError?.message || '');
  if (name === 'PrismaClientInitializationError' || error?.originalError?.name === 'PrismaClientInitializationError') return true;
  return /Can't reach database server|ECONNREFUSED|ECONNRESET|ETIMEDOUT|terminating connection|the database system is (starting|shutting) up|Connection terminated/i.test(message);
}

/**
 * Run `attempt` until it succeeds or the error stops looking transient.
 * `onRetry(attemptNo, delayMs, error)` is called before each wait.
 * Resolves true on success, false when retries are exhausted or a
 * non-transient error was thrown (that error is passed to `onGiveUp`).
 */
export async function retryBoot(attempt, { delays = BOOT_RETRY_DELAYS_MS, onRetry = () => {}, onGiveUp = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i += 1) {
    try {
      await attempt(i + 1);
      return true;
    } catch (error) {
      if (!isTransientDbError(error) || i >= delays.length) {
        onGiveUp(error, i + 1);
        return false;
      }
      onRetry(i + 1, delays[i], error);
      await sleep(delays[i]);
    }
  }
}
