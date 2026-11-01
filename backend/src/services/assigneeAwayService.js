/**
 * Who is away, for the people pickers (Vahid, 31 Oct 2026).
 *
 * "If I'm assigning a ticket to Sam and it's Monday and he's taken the week
 * off, I should get a warning that he is away and back on <date>. After hours
 * and weekends shouldn't matter: on Sunday, if Sam is back Monday, no nag; if
 * he is taking Monday off, I should get a notice." The same answer marks people
 * in the @mention list ("Away · back Mon 16 Nov"), where it never blocks.
 *
 * Rules:
 *  - Away = an approved FULL-DAY leave of category OFF in technician_leaves, the
 *    rows assignment and the owner-away reroute already read. Working from home,
 *    site visits and half days are not absences.
 *  - The day that counts is the next working moment: today while today is a
 *    working day and business hours have not ended, otherwise the next working
 *    day (business days and holidays from Settings → Business Hours; Mon–Fri
 *    17:00 when none are set).
 *  - One day off is enough (the reroute waits for two; a person picking an
 *    assignee wants to know about any day).
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';

const FALLBACK_TIMEZONE = 'America/Vancouver';
const LOOKAHEAD_DAYS = 120;
const CACHE_MS = 60 * 1000;

const addDay = (dateStr, n = 1) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayOfWeekOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();

function localParts(at, timeZone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  } catch {
    const iso = new Date(at).toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
}

/**
 * The absence that matters right now, or null.
 * @param {object} p
 * @param {Set<string>} p.offDates     'yyyy-MM-dd' days with an approved full-day OFF leave
 * @param {string} p.today            'yyyy-MM-dd' in the workspace's zone
 * @param {string} p.nowTime          'HH:mm' in the workspace's zone
 * @param {(d: string) => boolean} p.isWorkingDay
 * @param {(d: string) => string} p.endTimeOf  'HH:mm' business hours end on that day
 * @returns {null | { firstDay, lastDay, backOn, workingDaysAway, fromToday }}
 */
export function awayAtNextWorkingMoment({ offDates, today, nowTime, isWorkingDay, endTimeOf }) {
  let day = today;
  if (!isWorkingDay(day) || String(nowTime) >= String(endTimeOf(day) || '17:00')) {
    day = addDay(day);
    let guard = 0;
    while (!isWorkingDay(day) && guard < 21) { day = addDay(day); guard += 1; }
  }
  if (!offDates.has(day)) return null;
  const firstDay = day;
  let lastDay = day;
  let workingDaysAway = 0;
  let backOn = null;
  for (let i = 0; i < LOOKAHEAD_DAYS; i += 1) {
    if (isWorkingDay(day)) {
      if (!offDates.has(day)) { backOn = day; break; }
      workingDaysAway += 1;
      lastDay = day;
    }
    day = addDay(day);
  }
  return { firstDay, lastDay, backOn, workingDaysAway, fromToday: firstDay === today };
}

class AssigneeAwayService {
  constructor() {
    this._cache = new Map();
  }

  async _calendar(workspaceId) {
    const cal = await Promise.resolve()
      .then(async () => (await import('./businessCalendarService.js')).default.loadCalendar(workspaceId))
      .catch(() => null);
    if (cal?.byDay?.size) {
      return {
        timezone: cal.timezone || FALLBACK_TIMEZONE,
        isWorkingDay: (d) => cal.byDay.has(dayOfWeekOf(d)) && !cal.isHolidayDate(d),
        endTimeOf: (d) => cal.byDay.get(dayOfWeekOf(d))?.endTime || '17:00',
      };
    }
    const ws = await Promise.resolve()
      .then(() => prisma.workspace.findUnique({ where: { id: workspaceId }, select: { defaultTimezone: true } }))
      .catch(() => null);
    return {
      timezone: ws?.defaultTimezone || FALLBACK_TIMEZONE,
      isWorkingDay: (d) => { const dow = dayOfWeekOf(d); return dow >= 1 && dow <= 5; },
      endTimeOf: () => '17:00',
    };
  }

  /**
   * technicianId → absence, for everyone in the workspace who is away at the
   * next working moment. Cached for a minute. Never throws (an empty map).
   */
  async forWorkspace(workspaceId, { now = new Date() } = {}) {
    const key = Number(workspaceId);
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.map;
    const map = new Map();
    try {
      const { timezone, isWorkingDay, endTimeOf } = await this._calendar(key);
      const { date: today, time: nowTime } = localParts(now, timezone);
      const rows = await prisma.technicianLeave.findMany({
        where: {
          workspaceId: key,
          status: 'APPROVED',
          category: 'OFF',
          leaveDate: { gte: new Date(`${today}T00:00:00Z`), lte: new Date(`${addDay(today, LOOKAHEAD_DAYS + 21)}T00:00:00Z`) },
        },
        select: { technicianId: true, leaveDate: true, isFullDay: true },
        take: 5000,
      });
      const byTech = new Map();
      for (const r of rows) {
        if (r.isFullDay === false || !r.leaveDate) continue;
        if (!byTech.has(r.technicianId)) byTech.set(r.technicianId, new Set());
        byTech.get(r.technicianId).add(new Date(r.leaveDate).toISOString().slice(0, 10));
      }
      for (const [techId, offDates] of byTech) {
        const away = awayAtNextWorkingMoment({ offDates, today, nowTime, isWorkingDay, endTimeOf });
        if (away) map.set(techId, away);
      }
    } catch (err) {
      logger.warn(`Away lookup for workspace ${workspaceId} skipped (non-fatal): ${err.message}`);
    }
    this._cache.set(key, { at: Date.now(), map });
    return map;
  }

  /** The absence of one person, or null. */
  async forTechnician(workspaceId, technicianId, opts = {}) {
    const map = await this.forWorkspace(workspaceId, opts);
    return map.get(Number(technicianId)) || null;
  }
}

export default new AssigneeAwayService();
