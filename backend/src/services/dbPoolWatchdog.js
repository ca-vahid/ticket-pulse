/**
 * Prisma connection-pool watchdog (17 Sep 2026 incident).
 *
 * At 23:10 UTC the new container booted on the exact second of the :10 sync
 * tick while the previous container was still mid-sync; every request then
 * failed with P2024 ("Timed out fetching a new connection from the connection
 * pool") for six minutes although Postgres showed the app's connections IDLE.
 * The pool had wedged inside the process and only a restart cleared it —
 * nothing on the platform watches /health for that.
 *
 * This probes the pool every `intervalMs`; after `failuresToExit` consecutive
 * pool timeouts (60 s by default) it logs loudly and exits so the platform
 * restarts the container. Real database outages take a different path: the
 * boot retry loop handles a DB that is down at start-up, and a query failing
 * for any reason other than the pool resets the counter.
 */
import logger from '../utils/logger.js';

export function isPoolTimeout(error) {
  if (!error) return false;
  if (error.code === 'P2024') return true;
  return /Timed out fetching a new connection from the connection pool/i.test(String(error.message || ''));
}

export class DbPoolWatchdog {
  constructor({ prisma, intervalMs = 15_000, failuresToExit = 4, probeTimeoutMs = 12_000, exit = (code) => process.exit(code), log = logger } = {}) {
    this.prisma = prisma;
    this.intervalMs = intervalMs;
    this.failuresToExit = failuresToExit;
    this.probeTimeoutMs = probeTimeoutMs;
    this.exit = exit;
    this.log = log;
    this.consecutive = 0;
    this._timer = null;
    this._ticking = false;
  }

  start() {
    this.stop();
    this._timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    this._timer.unref?.();
    this.log.info(`DB pool watchdog armed (probe every ${Math.round(this.intervalMs / 1000)} s, exit after ${this.failuresToExit} consecutive pool timeouts)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async tick() {
    if (this._ticking) return this.consecutive;
    this._ticking = true;
    try {
      await Promise.race([
        this.prisma.$queryRawUnsafe('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Timed out fetching a new connection from the connection pool (watchdog probe)'), { code: 'P2024' })), this.probeTimeoutMs).unref?.()),
      ]);
      if (this.consecutive > 0) this.log.info(`DB pool watchdog: pool recovered after ${this.consecutive} timeout(s)`);
      this.consecutive = 0;
    } catch (error) {
      if (isPoolTimeout(error)) {
        this.consecutive += 1;
        this.log.warn(`DB pool watchdog: pool timeout ${this.consecutive}/${this.failuresToExit}`);
        if (this.consecutive >= this.failuresToExit) {
          this.log.error(`DB pool watchdog: connection pool wedged for ${this.consecutive} consecutive probes — exiting so the container restarts`);
          this.stop();
          this.exit(1);
        }
      } else {
        // A different failure (network, auth, DB down) is somebody else's incident; do not count it.
        this.consecutive = 0;
      }
    } finally {
      this._ticking = false;
    }
    return this.consecutive;
  }
}

export default DbPoolWatchdog;
