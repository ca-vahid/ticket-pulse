import { formatInTimeZone } from 'date-fns-tz';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { getDateColumnMonthDay } from '../utils/timezone.js';

/**
 * Business-calendar math for calendar-aware SLAs (Phase SLA, QA 08-17 #9:
 * "does the SLA timer stop over the weekends?").
 *
 * Walks forward day by day, consuming SLA minutes only inside each enabled
 * day's [startTime, endTime) window in the workspace timezone, skipping
 * disabled days and holidays. Built on the SAME per-workspace calendar the
 * auto-responder already uses (business_hours + holidays tables, managed in
 * Settings → Business Hours & Holidays) and on availabilityService's proven
 * offset math: local instants are built from `yyyy-MM-dd HH:mm` + the zone
 * offset formatInTimeZone(…, 'XXX') reports at NOON of that local day —
 * DST-safe without hand-rolled offset arithmetic (transitions happen around
 * 02:00, never near noon).
 *
 * Fallback contract (never throws, never blocks ticket creation):
 *  - zero enabled business-hour rows → pure wall-clock
 *  - walk exceeds MAX_WALK_DAYS      → pure wall-clock (logged)
 */

const FALLBACK_TIMEZONE = 'America/Los_Angeles';
// Hard cap on the day walk. 400 days of zero business capacity means the
// calendar is misconfigured (e.g. every day is a recurring holiday) — fall
// back to wall-clock rather than looping forever.
export const MAX_WALK_DAYS = 400;

const wallClock = (from, minutes) => new Date(from.getTime() + minutes * 60 * 1000);

/** Pure calendar-date helpers on 'yyyy-MM-dd' strings (no zone involved). */
const nextDateStr = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const dayOfWeekOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=Sun

class BusinessCalendarService {
  /**
   * Load the workspace's calendar ONCE for a computation batch: enabled
   * business-hour rows keyed by dayOfWeek, the effective timezone, and ALL
   * enabled holidays (workspace-scoped + shared) folded into two lookup sets
   * — a single query instead of one isHoliday round-trip per walked day.
   * Returns null when the workspace has no enabled business-hour days
   * (callers fall back to wall-clock).
   */
  async loadCalendar(workspaceId) {
    const hours = await prisma.businessHour.findMany({
      where: { workspaceId, isEnabled: true },
      orderBy: { dayOfWeek: 'asc' },
    });
    if (!hours.length) return null;

    // Timezone: first enabled row's timezone (the Settings UI keeps them
    // uniform), falling back to the workspace default, then the app default.
    let timezone = hours[0].timezone || null;
    if (!timezone) {
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { defaultTimezone: true },
      }).catch(() => null);
      timezone = ws?.defaultTimezone || FALLBACK_TIMEZONE;
    }

    // One batched holiday fetch for the whole walk range. Holiday tables are
    // small (a few dozen rows/yr), so "the batch" is simply every enabled row
    // in scope; exact dates match on the DATE column's UTC 'yyyy-MM-dd'
    // (Prisma represents @db.Date as UTC midnight — same convention
    // availabilityService.isHoliday relies on via getLocalDateBounds), and
    // recurring rows match on 'MM-dd'.
    const holidayRows = await prisma.holiday.findMany({
      where: {
        isEnabled: true,
        OR: [{ workspaceId }, { workspaceId: null }],
      },
      select: { date: true, isRecurring: true },
    });
    const exactHolidays = new Set();
    const recurringHolidays = new Set();
    for (const row of holidayRows) {
      if (row.isRecurring) {
        const monthDay = getDateColumnMonthDay(row.date);
        if (monthDay) recurringHolidays.add(monthDay);
      } else if (row.date) {
        exactHolidays.add(new Date(row.date).toISOString().slice(0, 10));
      }
    }

    return {
      timezone,
      byDay: new Map(hours.map((h) => [h.dayOfWeek, h])),
      isHolidayDate: (dateStr) => exactHolidays.has(dateStr) || recurringHolidays.has(dateStr.slice(5)),
    };
  }

  /**
   * Add `minutes` of BUSINESS time to `from`. Pass a preloaded `calendar`
   * (from loadCalendar) when computing several targets for one workspace —
   * dueDatesFor does — so the rows are fetched once.
   */
  async addBusinessMinutes(from, minutes, { workspaceId, calendar = undefined } = {}) {
    const start = new Date(from);
    const remainingTotal = Number(minutes) || 0;
    const cal = calendar !== undefined ? calendar : await this.loadCalendar(workspaceId);
    if (!cal) return wallClock(start, remainingTotal); // zero enabled days → wall-clock

    let remaining = remainingTotal;
    let dateStr = formatInTimeZone(start, cal.timezone, 'yyyy-MM-dd');

    for (let day = 0; day < MAX_WALK_DAYS; day++) {
      const hour = cal.byDay.get(dayOfWeekOf(dateStr));
      if (hour && !cal.isHolidayDate(dateStr)) {
        // availabilityService's offset trick: the zone offset at noon of the
        // local day is stable (DST flips at ~02:00), so local HH:mm converts
        // to an exact UTC instant without manual offset math.
        const offset = formatInTimeZone(new Date(`${dateStr}T12:00:00Z`), cal.timezone, 'XXX');
        const windowStartUtc = new Date(`${dateStr}T${hour.startTime}:00${offset}`);
        const windowEndUtc = new Date(`${dateStr}T${hour.endTime}:00${offset}`);
        // Only the FIRST day clamps to `from`; later days always open at
        // startTime (the walk advances by calendar date, not by instant).
        const cursor = day === 0 && start > windowStartUtc ? start : windowStartUtc;
        if (windowEndUtc > cursor) {
          const availableMinutes = (windowEndUtc.getTime() - cursor.getTime()) / 60000;
          if (remaining <= availableMinutes) {
            return new Date(cursor.getTime() + remaining * 60000);
          }
          remaining -= availableMinutes;
        }
      }
      dateStr = nextDateStr(dateStr);
    }

    logger.warn('businessCalendarService: walk exceeded cap — wall-clock fallback', {
      workspaceId, minutes: remainingTotal, capDays: MAX_WALK_DAYS,
    });
    return wallClock(start, remainingTotal);
  }

  /**
   * First instant at/after `from` that is inside business hours (identity
   * when `from` already is). Same fallbacks as addBusinessMinutes.
   */
  async nextBusinessInstant(from, { workspaceId, calendar = undefined } = {}) {
    return this.addBusinessMinutes(from, 0, { workspaceId, calendar });
  }
}

const businessCalendarService = new BusinessCalendarService();
export default businessCalendarService;
