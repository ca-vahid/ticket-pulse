import logger from '../utils/logger.js';

/**
 * In-memory rolling aggregate of client realtime telemetry (realtime plan
 * Phase 3). The client samples ~10% of sessions (plus every terminal-offline
 * transition) and fire-and-forgets small reports to POST /api/sse/telemetry;
 * this service keeps per-day counters so the Settings "Realtime health" block
 * can show support how often transports are degrading — without a migration,
 * a table, or any durable PII.
 *
 * Deliberately migration-free: the aggregate resets on process restart, which
 * is fine — it is a support signal, not an audit log.
 */

// Event vocabulary the client may report. Anything else is dropped.
export const TELEMETRY_EVENT_TYPES = ['downgrade', 'offline', 'offline-terminal'];

// Bound memory: days kept (today + yesterday) and distinct users per day.
export const TELEMETRY_DAYS_KEPT = 2;
export const TELEMETRY_MAX_USERS_PER_DAY = 200;
export const TELEMETRY_TOP_USERS = 5;

/** 'adrian.lo@bgcengineering.ca' → 'adr…@bgcengineering.ca' (support hint,
 *  not an identity dump — team-safe surface shows truncated emails only). */
export function truncateEmail(email) {
  const raw = String(email || '').trim().toLowerCase();
  if (!raw) return null;
  const at = raw.indexOf('@');
  if (at === -1) return `${raw.slice(0, 3)}…`;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const localPart = local.length <= 3 ? local : `${local.slice(0, 3)}…`;
  return `${localPart}@${domain}`;
}

function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

function emptyDay(date) {
  return {
    date,
    counts: { downgrade: 0, offline: 0, offlineTerminal: 0 },
    downgradesByTransport: { longpoll: 0, shortpoll: 0 },
    churnMax: 0,
    reports: 0,
    users: new Map(), // lowercased email -> event count
  };
}

class RealtimeTelemetryService {
  constructor() {
    this.days = new Map(); // dayKey -> aggregate
  }

  _day(now = Date.now()) {
    const key = dayKey(now);
    if (!this.days.has(key)) {
      this.days.set(key, emptyDay(key));
      // Prune anything older than the kept window (keys sort lexically).
      const keys = [...this.days.keys()].sort();
      while (keys.length > TELEMETRY_DAYS_KEPT) {
        this.days.delete(keys.shift());
      }
    }
    return this.days.get(key);
  }

  /**
   * Record one client report. Never throws — telemetry must not be able to
   * break anything. Unknown types/transports are dropped or normalized.
   */
  record({ userEmail = null, type, transport = null, churn = null } = {}, now = Date.now()) {
    try {
      if (!TELEMETRY_EVENT_TYPES.includes(type)) return false;
      const day = this._day(now);
      day.reports += 1;

      if (type === 'downgrade') {
        day.counts.downgrade += 1;
        if (transport === 'longpoll' || transport === 'shortpoll') {
          day.downgradesByTransport[transport] += 1;
        }
      } else if (type === 'offline') {
        day.counts.offline += 1;
      } else {
        day.counts.offlineTerminal += 1;
      }

      const churnNum = Number(churn);
      if (Number.isFinite(churnNum) && churnNum > day.churnMax) {
        day.churnMax = Math.round(churnNum);
      }

      const email = String(userEmail || '').trim().toLowerCase();
      if (email && (day.users.has(email) || day.users.size < TELEMETRY_MAX_USERS_PER_DAY)) {
        day.users.set(email, (day.users.get(email) || 0) + 1);
      }
      return true;
    } catch (error) {
      logger.debug(`Realtime telemetry record failed: ${error.message}`);
      return false;
    }
  }

  _summarizeDay(day) {
    if (!day) return null;
    const topUsers = [...day.users.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TELEMETRY_TOP_USERS)
      .map(([email, events]) => ({ user: truncateEmail(email), events }));
    return {
      date: day.date,
      reports: day.reports,
      downgrades: day.counts.downgrade,
      downgradesByTransport: { ...day.downgradesByTransport },
      offline: day.counts.offline,
      offlineTerminal: day.counts.offlineTerminal,
      churnMax: day.churnMax,
      affectedUsers: day.users.size,
      topUsers,
    };
  }

  /** Admin summary for the Settings "Realtime health" block. */
  summary(now = Date.now()) {
    const todayKey = dayKey(now);
    const yesterdayKey = dayKey(now - 24 * 60 * 60 * 1000);
    return {
      sampling: 'Reports are sampled from ~10% of sessions (terminal offline is always reported) — treat counts as an indicator, not a census.',
      today: this._summarizeDay(this.days.get(todayKey)) || this._summarizeDay(emptyDay(todayKey)),
      yesterday: this._summarizeDay(this.days.get(yesterdayKey)),
    };
  }

  /** Test hook. */
  _reset() {
    this.days.clear();
  }
}

export default new RealtimeTelemetryService();
export { RealtimeTelemetryService };
