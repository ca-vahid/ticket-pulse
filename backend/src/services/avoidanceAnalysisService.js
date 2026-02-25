import { PrismaClient } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { FRESHSERVICE_TZ_TO_IANA } from '../config/constants.js';
import logger from '../utils/logger.js';

const prisma = new PrismaClient();

const PT_TIMEZONE = 'America/Los_Angeles';
const BUSINESS_CLOSE = '17:00';
const COVERAGE_END = '09:00';

const EASTERN_OFFICE_TIMEZONES = new Set([
  'America/Toronto',
  'America/New_York',
  'America/Halifax',
  'America/Moncton',
  'America/Glace_Bay',
  'America/Goose_Bay',
  'America/St_Johns',
]);

const IANA_ALIASES = {
  'America/Los_Angeles': 'America/Los_Angeles',
  'America/Vancouver': 'America/Vancouver',
  'America/Denver': 'America/Denver',
  'America/Chicago': 'America/Chicago',
  'America/New_York': 'America/New_York',
};

function toIANA(tz) {
  if (!tz) return PT_TIMEZONE;
  if (FRESHSERVICE_TZ_TO_IANA[tz]) return FRESHSERVICE_TZ_TO_IANA[tz];
  if (IANA_ALIASES[tz]) return IANA_ALIASES[tz];
  if (tz.includes('/')) return tz;
  return PT_TIMEZONE;
}

function localTimeToUTC(dateStr, timeStr, timezone) {
  const offset = formatInTimeZone(
    new Date(`${dateStr}T12:00:00Z`),
    timezone,
    'XXX',
  );
  return new Date(`${dateStr}T${timeStr}:00${offset}`);
}

function fmtDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getPreviousBusinessDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const dow = date.getDay();
  if (dow === 1) date.setDate(date.getDate() - 3);
  else if (dow === 0) date.setDate(date.getDate() - 2);
  else date.setDate(date.getDate() - 1);
  return fmtDate(date);
}

function isWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(y, m - 1, d, 12, 0, 0).getDay();
  return dow >= 1 && dow <= 5;
}

function getCoverageWindow(dateStr) {
  if (!isWeekday(dateStr)) return null;
  const prevBiz = getPreviousBusinessDay(dateStr);
  const windowStart = localTimeToUTC(prevBiz, BUSINESS_CLOSE, PT_TIMEZONE);
  const windowEnd = localTimeToUTC(dateStr, COVERAGE_END, PT_TIMEZONE);
  const extendedEnd = localTimeToUTC(dateStr, BUSINESS_CLOSE, PT_TIMEZONE);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const prevDow = dayNames[new Date(prevBiz + 'T12:00:00').getDay()];
  const curDow = dayNames[new Date(dateStr + 'T12:00:00').getDay()];
  const windowLabel = `${prevDow} ${prevBiz.slice(5)} 5pm → ${curDow} ${dateStr.slice(5)} 9am PT`;

  return { windowStart, windowEnd, extendedEnd, windowLabel };
}

function getWeekdaysInRange(rangeStart, rangeEnd) {
  const dates = [];
  const seen = new Set();
  const cursor = new Date(rangeStart);
  for (let i = 0; i < 14 && cursor <= rangeEnd; i++) {
    const dateStr = formatInTimeZone(cursor, PT_TIMEZONE, 'yyyy-MM-dd');
    if (isWeekday(dateStr) && !seen.has(dateStr)) {
      seen.add(dateStr);
      dates.push(dateStr);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function slimTicket(t) {
  return {
    id: t.id,
    freshserviceTicketId: t.freshserviceTicketId ? Number(t.freshserviceTicketId) : null,
    subject: t.subject,
    priority: t.priority,
    status: t.status,
    createdAt: t.createdAt,
    ticketCategory: t.ticketCategory || null,
    assignedTechId: t.assignedTechId,
    assignedTechName: t.assignedTech?.name || null,
    firstAssignedAt: t.firstAssignedAt,
    isSelfPicked: t.isSelfPicked,
    assignedBy: t.assignedBy,
    requesterName: t.requester?.name || null,
  };
}

async function loadTicketsFull(start, end) {
  return prisma.ticket.findMany({
    where: { createdAt: { gte: start, lte: end } },
    select: {
      id: true,
      freshserviceTicketId: true,
      subject: true,
      priority: true,
      status: true,
      createdAt: true,
      ticketCategory: true,
      assignedTechId: true,
      firstAssignedAt: true,
      isSelfPicked: true,
      assignedBy: true,
      requester: { select: { name: true } },
      assignedTech: { select: { id: true, name: true } },
    },
  });
}

async function loadTicketsSlim(start, end) {
  return prisma.ticket.findMany({
    where: { createdAt: { gte: start, lte: end } },
    select: { id: true, createdAt: true, assignedTechId: true },
  });
}

function emptyResult(applicable, reason) {
  return { applicable, reason, days: [], totals: { eligible: 0, picked: 0, notPicked: 0 } };
}

function filterEligible(allTickets, windowStart, windowEnd) {
  return allTickets.filter(t => {
    const created = new Date(t.createdAt);
    return created >= windowStart && created <= windowEnd;
  });
}

// ── Detail-level (full ticket lists) ──────────────────────────────

function analyzeDayFull(techId, allTickets, win, extendedTickets) {
  const eligible = filterEligible(allTickets, win.windowStart, win.windowEnd);
  const extended = extendedTickets
    ? filterEligible(extendedTickets, win.windowEnd, win.extendedEnd)
    : [];
  return {
    windowLabel: win.windowLabel,
    windowStart: win.windowStart.toISOString(),
    windowEnd: win.windowEnd.toISOString(),
    extendedEnd: win.extendedEnd ? win.extendedEnd.toISOString() : null,
    tickets: eligible.map(t => ({
      ...slimTicket(t),
      pickedByTech: t.assignedTechId === techId,
    })),
    extendedTickets: extended.map(t => ({
      ...slimTicket(t),
      pickedByTech: t.assignedTechId === techId,
    })),
  };
}

export async function computeTechnicianAvoidanceDetail(tech, rangeStart, _rangeEnd) {
  const techTz = toIANA(tech.timezone);
  if (!EASTERN_OFFICE_TIMEZONES.has(techTz)) {
    return emptyResult(false, 'outside_eastern_focus');
  }

  const dateStr = formatInTimeZone(rangeStart, PT_TIMEZONE, 'yyyy-MM-dd');
  const win = getCoverageWindow(dateStr);
  if (!win) return emptyResult(true, 'weekend');

  const [coverageTickets, extendedTickets] = await Promise.all([
    loadTicketsFull(win.windowStart, win.windowEnd),
    loadTicketsFull(win.windowEnd, win.extendedEnd),
  ]);
  const day = analyzeDayFull(tech.id, coverageTickets, win, extendedTickets);
  const picked = day.tickets.filter(t => t.pickedByTech).length;

  return {
    applicable: true,
    reason: null,
    days: [{ date: dateStr, ...day }],
    totals: { eligible: day.tickets.length, picked, notPicked: day.tickets.length - picked },
  };
}

export async function computeTechnicianAvoidanceWeeklyDetail(tech, weekStart, weekEnd, _timezone) {
  const techTz = toIANA(tech.timezone);
  if (!EASTERN_OFFICE_TIMEZONES.has(techTz)) {
    return emptyResult(false, 'outside_eastern_focus');
  }

  const weekdays = getWeekdaysInRange(weekStart, weekEnd);
  const windows = weekdays.map(d => ({ date: d, ...getCoverageWindow(d) })).filter(w => w.windowStart);
  if (windows.length === 0) return emptyResult(true, 'no_weekdays');

  const earliest = new Date(Math.min(...windows.map(w => w.windowStart.getTime())));
  const latestExtended = new Date(Math.max(...windows.map(w => w.extendedEnd.getTime())));
  const allTickets = await loadTicketsFull(earliest, latestExtended);

  const days = [];
  let tE = 0, tP = 0;

  for (const win of windows) {
    const day = analyzeDayFull(tech.id, allTickets, win, allTickets);
    const picked = day.tickets.filter(t => t.pickedByTech).length;
    tE += day.tickets.length;
    tP += picked;
    days.push({ date: win.date, ...day });
  }

  return {
    applicable: true,
    reason: null,
    days,
    totals: { eligible: tE, picked: tP, notPicked: tE - tP },
  };
}

// ── Dashboard-level (counts only, single DB query) ────────────────

export async function computeDashboardAvoidance(technicians, rangeStart, _rangeEnd) {
  const dateStr = formatInTimeZone(rangeStart, PT_TIMEZONE, 'yyyy-MM-dd');
  const win = getCoverageWindow(dateStr);
  const results = {};

  if (!win) {
    for (const tech of technicians) {
      results[tech.id] = emptyResult(EASTERN_OFFICE_TIMEZONES.has(toIANA(tech.timezone)), 'weekend');
    }
    return results;
  }

  const allTickets = await loadTicketsSlim(win.windowStart, win.windowEnd);
  const eligible = filterEligible(allTickets, win.windowStart, win.windowEnd);
  const eligibleCount = eligible.length;

  for (const tech of technicians) {
    try {
      const techTz = toIANA(tech.timezone);
      if (!EASTERN_OFFICE_TIMEZONES.has(techTz)) {
        results[tech.id] = emptyResult(false, 'outside_eastern_focus');
        continue;
      }
      const picked = eligible.filter(t => t.assignedTechId === tech.id).length;
      results[tech.id] = {
        applicable: true,
        reason: null,
        days: [],
        totals: { eligible: eligibleCount, picked, notPicked: eligibleCount - picked },
      };
    } catch (err) {
      logger.error(`Coverage analysis failed for tech ${tech.id}:`, err);
      results[tech.id] = emptyResult(false, 'error');
    }
  }
  return results;
}

export async function computeWeeklyDashboardAvoidance(technicians, weekStart, weekEnd, _timezone) {
  const weekdays = getWeekdaysInRange(weekStart, weekEnd);
  const windows = weekdays.map(d => ({ date: d, ...getCoverageWindow(d) })).filter(w => w.windowStart);
  const results = {};

  if (windows.length === 0) {
    for (const tech of technicians) {
      results[tech.id] = emptyResult(EASTERN_OFFICE_TIMEZONES.has(toIANA(tech.timezone)), 'no_weekdays');
    }
    return results;
  }

  const earliest = new Date(Math.min(...windows.map(w => w.windowStart.getTime())));
  const latest = new Date(Math.max(...windows.map(w => w.windowEnd.getTime())));
  const allTickets = await loadTicketsSlim(earliest, latest);

  const perDay = windows.map(w => filterEligible(allTickets, w.windowStart, w.windowEnd));
  const totalEligible = perDay.reduce((s, d) => s + d.length, 0);

  for (const tech of technicians) {
    try {
      const techTz = toIANA(tech.timezone);
      if (!EASTERN_OFFICE_TIMEZONES.has(techTz)) {
        results[tech.id] = emptyResult(false, 'outside_eastern_focus');
        continue;
      }
      let picked = 0;
      for (const dayEligible of perDay) {
        picked += dayEligible.filter(t => t.assignedTechId === tech.id).length;
      }
      results[tech.id] = {
        applicable: true,
        reason: null,
        days: [],
        totals: { eligible: totalEligible, picked, notPicked: totalEligible - picked },
      };
    } catch (err) {
      logger.error(`Weekly coverage analysis failed for tech ${tech.id}:`, err);
      results[tech.id] = emptyResult(false, 'error');
    }
  }
  return results;
}

export default {
  computeDashboardAvoidance,
  computeWeeklyDashboardAvoidance,
  computeTechnicianAvoidanceDetail,
  computeTechnicianAvoidanceWeeklyDetail,
};
