import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { refreshRequesterEntraProfile } from './requesterProfileService.js';

// QA 09-25 #2: the 3-year IT history import created 217 requesters that were
// never looked up in Entra (26 of them Cambio Earth), because the lookup only
// runs when a person raises a ticket or their page is opened. This sweep looks
// up a few never-looked-up requesters on the company's own domains every half
// hour, so imported and synced people get their office and department too.

const SWEEP_EVERY_MS = 30 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000;
// A row we tried (found, missing or failed) is skipped for a day, so a row
// that keeps failing never blocks the rest of the queue (review S5).
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const BATCH = 40;
const PAUSE_MS = 250;

export function sweepDomains(env = process.env) {
  return String(env.REQUESTER_ENTRA_DOMAINS || 'bgcengineering.ca,cambioearth.com')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

class RequesterEntraSweepService {
  constructor() {
    this.timer = null;
    this.firstTimer = null;
    this.running = false;
    this.pauseMs = PAUSE_MS;
    // requester id -> ms of the last attempt (in memory; a restart retries).
    this.attempted = new Map();
  }

  recentlyAttemptedIds(now = Date.now()) {
    for (const [id, at] of this.attempted) {
      if (now - at >= RETRY_AFTER_MS) this.attempted.delete(id);
    }
    return [...this.attempted.keys()];
  }

  async sweepOnce({ limit = BATCH, now = Date.now() } = {}) {
    if (this.running) return { skipped: true };
    this.running = true;
    const out = { checked: 0, found: 0, missing: 0, failed: 0 };
    try {
      const domains = sweepDomains();
      if (!domains.length) return out;
      const skipIds = this.recentlyAttemptedIds(now);
      const rows = await Promise.resolve()
        .then(() => prisma.requester.findMany({
          where: {
            entraProfileSyncedAt: null,
            entraMissingAt: null,
            OR: domains.map((d) => ({ email: { endsWith: `@${d}`, mode: 'insensitive' } })),
            ...(skipIds.length ? { id: { notIn: skipIds } } : {}),
          },
          select: { id: true, email: true, entraProfileSyncedAt: true },
          orderBy: { id: 'desc' },
          take: limit,
        }))
        .catch((err) => {
          logger.warn('Requester Entra sweep: read failed', { error: err.message });
          return [];
        });
      for (const r of rows) {
        this.attempted.set(r.id, now);
        out.checked += 1;
        try {
          const res = await refreshRequesterEntraProfile(r);
          if (res?.entraProfileSyncedAt) out.found += 1;
          else if (res?.entraMissingAt) out.missing += 1;
        } catch (err) {
          out.failed += 1;
          logger.debug?.(`Requester Entra sweep: lookup failed for requester ${r.id}: ${err.message}`);
        }
        if (this.pauseMs) await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
      }
      if (out.checked) logger.info(`Requester Entra sweep: ${out.checked} looked up, ${out.found} found, ${out.missing} not in the directory${out.failed ? `, ${out.failed} failed` : ''}`);
      return out;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    // One pass shortly after boot, then every 30 min.
    this.firstTimer = setTimeout(() => { this.firstTimer = null; this.sweepOnce().catch(() => {}); }, FIRST_SWEEP_DELAY_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => { this.sweepOnce().catch(() => {}); }, SWEEP_EVERY_MS);
    this.timer.unref?.();
    logger.info('Requester Entra sweep started (first pass in 2 min, then every 30 min)');
  }

  stop() {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }
}

export default new RequesterEntraSweepService();
