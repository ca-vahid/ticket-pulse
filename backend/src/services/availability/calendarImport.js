/**
 * Accounting's shared calendar → Vacation Pulse (QA 11-16,
 * plans/ACCOUNTING_CALENDAR_SYNC_PLAN.md). The hourly calendar leave sync
 * (calendarLeaveService.sync) already reads and classifies the group
 * calendar; this turns the rows it classified into Vacation Pulse requests,
 * on the pattern of the Vacation Tracker import (_syncFromVacationTracker).
 *
 * - Mode per workspace in app settings (`calendar_vp_mode_ws<N>`):
 *   off (default) | shadow (writes nothing, records what it would do) | live.
 * - Only rows the classifier is sure of: isLeave, not held for review,
 *   category OFF or WFH. Tentative/placeholder and private events are skipped.
 * - Imported requests: approved, source 'shared_calendar', externalId
 *   'cal:' + sha256(Graph event id). No e-mails, approvals, Outlook events or
 *   Vacation Tracker write-back (those all skip any source but 'app').
 * - Never touches a request booked in Vacation Pulse; an event overlapping
 *   one for the same person is skipped. A request a person cancelled in
 *   Vacation Pulse stays cancelled. Graph listing nothing cancels nothing.
 */
import crypto from 'crypto';
import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import settingsRepository from '../settingsRepository.js';
import { workingDates, requestSize, holidayMatcher, toDay, dayKey, addDays } from './availabilityRules.js';

export const CAL_SOURCE = 'shared_calendar';
export const CAL_ACTOR = 'shared_calendar';
export const CAL_EXTERNAL_PREFIX = 'cal:';
export const CAL_IMPORT_MODES = ['off', 'shadow', 'live'];
export const CAL_IMPORT_STATUS_KEY = 'calendar_vp_import_status';
export const calImportModeKey = (workspaceId) => `calendar_vp_mode_ws${Number(workspaceId)}`;

const ACTIVE = ['approved', 'pending'];
const LIST_CAP = 50;
// A timed entry this long is a whole working day, not a half day.
const FULL_DAY_MINUTES = 6 * 60;
const HALF_DAY_MINUTES = 3 * 60;

const lc = (s) => String(s || '').trim().toLowerCase();
const num = (d) => ((d === null || d === undefined) ? 0 : Number(d));
const normalize = (value) => lc(value).replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function calendarExternalId(eventId) {
  return `${CAL_EXTERNAL_PREFIX}${crypto.createHash('sha256').update(String(eventId || '')).digest('hex')}`;
}

export function normalizeMode(value) {
  const v = lc(value);
  return CAL_IMPORT_MODES.includes(v) ? v : 'off';
}

// First match wins; anything else that is OFF is vacation.
const TYPE_KEYWORDS = [
  ['sick', /\bsick\b/],
  ['appointment', /\b(appointment|appt|doctor|dentist)\b/],
  ['training', /\b(training|class|course|conference)\b/],
  ['bereavement', /\bbereavement\b/],
  ['banked', /\b(banked|in lieu)\b/],
  ['unpaid', /\bunpaid\b/],
];

/** av_leave_types.key for a classified calendar row. */
export function leaveTypeKeyFor({ subject, category }) {
  if (category === 'WFH') return 'wfh';
  const s = normalize(subject);
  for (const [key, re] of TYPE_KEYWORDS) if (re.test(s)) return key;
  return 'vacation';
}

export function isTentativeEvent(event) {
  return /\b(tentative|placeholder)\b/i.test(String(event?.subject || '')) || lc(event?.showAs) === 'tentative';
}

export function isPrivateEvent(event) {
  return ['private', 'confidential'].includes(lc(event?.sensitivity));
}

function minuteOf(value) {
  const m = String(value || '').match(/T(\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Graph start/end (local time, Prefer: outlook.timezone) → request dates.
 * All-day: end is exclusive. Timed: 6 h or more is a full day, 3 h or more
 * a morning/afternoon by its midpoint, shorter stays hours. A timed entry
 * running over several days covers those days in full.
 */
export function mapEventDates(event, halfDayPart = null) {
  const s = String(event?.start?.dateTime || '').slice(0, 10);
  const e = String(event?.end?.dateTime || '').slice(0, 10);
  if (!DATE_RE.test(s) || !DATE_RE.test(e)) return null;
  const nulls = { startMinute: null, endMinute: null };
  if (event.isAllDay) {
    let end = dayKey(addDays(e, -1));
    if (end < s) end = s;
    const dayPart = halfDayPart === 'AM' ? 'am' : halfDayPart === 'PM' ? 'pm' : 'full';
    return { startDate: s, endDate: end, dayPart, ...nulls };
  }
  const startMinute = minuteOf(event.start.dateTime);
  let endMinute = minuteOf(event.end.dateTime);
  if (startMinute === null || endMinute === null) return null;
  if (e > s) {
    if (endMinute === 0 && dayKey(addDays(s, 1)) === e) endMinute = 24 * 60; // ends at midnight
    else {
      const last = endMinute === 0 ? dayKey(addDays(e, -1)) : e;
      return { startDate: s, endDate: last < s ? s : last, dayPart: 'full', ...nulls };
    }
  }
  const length = endMinute - startMinute;
  if (!(length > 0)) return null;
  if (length >= FULL_DAY_MINUTES) return { startDate: s, endDate: s, dayPart: 'full', ...nulls };
  if (length >= HALF_DAY_MINUTES) {
    return { startDate: s, endDate: s, dayPart: (startMinute + endMinute) / 2 < 720 ? 'am' : 'pm', startMinute, endMinute };
  }
  return { startDate: s, endDate: s, dayPart: 'hours', startMinute, endMinute };
}

/**
 * One classified row (calendarLeaveService.classifyEvents) → what to import,
 * or why not. Pure: no database.
 */
export function planCalendarRow(row) {
  const event = row?.event || {};
  const name = row?.personAlias || row?.nameGuess || '';
  if (!event.id) return { skip: 'skipped_bad_event' };
  if (isTentativeEvent(event)) return { skip: 'skipped_tentative', name };
  if (isPrivateEvent(event)) return { skip: 'skipped_private' };
  if (row.category === 'IGNORED') return { skip: 'skipped_ignored' };
  if (!row.technicianId) return { skip: 'skipped_unmatched', name };
  if (row.requiresReview) return { skip: 'skipped_review', name };
  if (!row.isLeave) return { skip: 'skipped_ignored' };
  if (row.category !== 'OFF' && row.category !== 'WFH') return { skip: 'skipped_other' };
  const email = lc(row.technician?.email);
  if (!email) return { skip: 'skipped_no_email', name };
  const dates = mapEventDates(event, row.halfDayPart);
  if (!dates) return { skip: 'skipped_bad_dates', name };
  return {
    plan: {
      externalId: calendarExternalId(event.id),
      email,
      personName: row.technician?.name || name || email,
      typeKey: leaveTypeKeyFor({ subject: row.subject ?? event.subject, category: row.category }),
      ...dates,
    },
  };
}

/** Was this imported request last cancelled by a person, not by the import? */
export function cancelledByPerson(events) {
  const cancels = (events || []).filter((e) => e?.kind === 'cancelled');
  if (!cancels.length) return false;
  const last = cancels.reduce((a, b) => ((Number(b.id) || 0) >= (Number(a.id) || 0) ? b : a));
  return (last.details || {}).source !== CAL_SOURCE;
}

/** externalIds of imported requests a person cancelled in Vacation Pulse. Never throws unless strict. */
export async function cancelledHereExternalIds({ strict = false } = {}) {
  const rows = await Promise.resolve()
    .then(() => prisma.avRequest.findMany({
      where: { source: CAL_SOURCE, status: 'cancelled', externalId: { startsWith: CAL_EXTERNAL_PREFIX } },
      select: { externalId: true, events: { where: { kind: 'cancelled' }, select: { id: true, kind: true, details: true } } },
      take: 20000,
    }))
    .catch((err) => {
      if (strict) throw err;
      logger.warn(`Shared calendar import: could not read requests cancelled in Vacation Pulse (${err.message})`);
      return [];
    });
  return new Set((rows || []).filter((r) => cancelledByPerson(r.events)).map((r) => r.externalId));
}

export async function getCalendarImportMode(workspaceId) {
  try {
    return normalizeMode(await settingsRepository.get(calImportModeKey(workspaceId)));
  } catch {
    return 'off';
  }
}

export async function setCalendarImportMode(workspaceId, mode) {
  const value = normalizeMode(mode);
  await settingsRepository.set(calImportModeKey(workspaceId), value);
  return value;
}

export async function calendarImportStatusAll() {
  try {
    const raw = await settingsRepository.get(CAL_IMPORT_STATUS_KEY);
    if (!raw) return {};
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function recordStatus(workspaceId, entry) {
  try {
    const all = await calendarImportStatusAll();
    all[workspaceId] = { at: new Date().toISOString(), ...entry };
    await settingsRepository.set(CAL_IMPORT_STATUS_KEY, JSON.stringify(all));
  } catch (err) {
    logger.warn(`Shared calendar import: could not keep the status for workspace ${workspaceId}: ${err.message}`);
  }
}

const sameFields = (a, b) => a.leaveTypeId === b.leaveTypeId
  && dayKey(a.startDate) === dayKey(b.startDate) && dayKey(a.endDate) === dayKey(b.endDate)
  && a.dayPart === b.dayPart
  && (a.startMinute ?? null) === (b.startMinute ?? null) && (a.endMinute ?? null) === (b.endMinute ?? null);

const describe = (p, typeName) => ({ name: p.personName, type: typeName, start: p.startDate, end: p.endDate, dayPart: p.dayPart });

const running = new Set();

/**
 * Import one sync's classified rows. `av` is the availability service
 * (holidays and projection); injected so the two services never load each
 * other at start-up. Returns the summary it also keeps in app settings.
 */
export async function importCalendarRows(workspaceId, rows, {
  av, mode = null, windowStart, windowEnd, eventsListed = null,
} = {}) {
  const ws = Number(workspaceId);
  const runMode = mode ? normalizeMode(mode) : await getCalendarImportMode(ws);
  if (runMode === 'off') return { mode: 'off' };
  if (running.has(ws)) return { mode: runMode, skipped: 'running' };
  running.add(ws);
  try {
    const summary = await runImport(ws, rows || [], {
      av, live: runMode === 'live', windowStart, windowEnd, eventsListed: eventsListed ?? (rows || []).length,
    });
    const out = { mode: runMode, ok: true, ...summary };
    await recordStatus(ws, out);
    if (summary.counts.created || summary.counts.updated || summary.counts.cancelled) {
      logger.info(`Shared calendar import ws ${ws} (${runMode})`, summary.counts);
    }
    return out;
  } catch (err) {
    logger.warn(`Shared calendar import failed for workspace ${ws}: ${err.message}`);
    await recordStatus(ws, { mode: runMode, ok: false, error: String(err.message || err).slice(0, 300) });
    return { mode: runMode, ok: false, error: err.message };
  } finally {
    running.delete(ws);
  }
}

async function runImport(ws, rows, { av, live, windowStart, windowEnd, eventsListed }) {
  const counts = {
    created: 0, updated: 0, cancelled: 0, unchanged: 0,
    skipped_tentative: 0, skipped_private: 0, skipped_ignored: 0, skipped_other: 0, skipped_unmatched: 0,
    skipped_review: 0, skipped_no_email: 0, skipped_bad_dates: 0, skipped_bad_event: 0, skipped_no_type: 0,
    skipped_app_booked: 0, skipped_cancelled_here: 0, skipped_duplicate: 0,
  };
  const unmatched = new Map(); // alias text -> events
  const tentative = [];
  const would = { create: [], update: [], cancel: [] };
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };

  // 1. Plan every row (pure).
  const plans = [];
  const skipReasonByExternalId = new Map();
  for (const row of rows) {
    const res = planCalendarRow(row);
    if (res.plan) { plans.push(res.plan); continue; }
    bump(res.skip);
    if (row?.event?.id) skipReasonByExternalId.set(calendarExternalId(row.event.id), res.skip);
    if (res.skip === 'skipped_unmatched' && res.name) unmatched.set(res.name, (unmatched.get(res.name) || 0) + 1);
    if (res.skip === 'skipped_tentative' && tentative.length < LIST_CAP) {
      tentative.push({ name: res.name || null, date: String(row.event?.start?.dateTime || '').slice(0, 10) || null, subject: String(row.subject || row.event?.subject || '').slice(0, 120) });
    }
  }

  // 2. What is already there.
  const techEmails = [...new Set((await prisma.technician.findMany({ where: { workspaceId: ws }, select: { email: true }, take: 2000 }))
    .map((t) => lc(t.email)).filter(Boolean))];
  const planEmails = [...new Set(plans.map((p) => p.email))];
  const emails = [...new Set([...techEmails, ...planEmails])];
  const [typesRows, peopleRows, existingRows, otherRows, holidays] = await Promise.all([
    prisma.avLeaveType.findMany({ where: { key: { in: ['vacation', 'sick', 'wfh', 'training', 'appointment', 'bereavement', 'banked', 'unpaid'] } } }),
    prisma.avPerson.findMany({ where: { email: { in: planEmails } }, select: { email: true, name: true, workdays: true, dailyHours: true } }),
    prisma.avRequest.findMany({
      where: { source: CAL_SOURCE, email: { in: emails } },
      select: {
        id: true, email: true, externalId: true, leaveTypeId: true, startDate: true, endDate: true, dayPart: true, startMinute: true, endMinute: true, status: true,
        events: { where: { kind: 'cancelled' }, select: { id: true, kind: true, details: true } },
      },
      take: 20000,
    }),
    prisma.avRequest.findMany({
      where: { source: { not: CAL_SOURCE }, email: { in: planEmails }, status: { in: ACTIVE } },
      select: { email: true, startDate: true, endDate: true },
      take: 20000,
    }),
    av?._holidays ? av._holidays() : [],
  ]);
  const typeByKey = new Map(typesRows.filter((t) => t.isActive !== false).map((t) => [t.key, t]));
  const people = new Map(peopleRows.map((p) => [lc(p.email), p]));
  const existing = new Map(existingRows.filter((r) => r.externalId).map((r) => [r.externalId, r]));
  const isHoliday = holidayMatcher(holidays || []);
  const booked = new Map();
  for (const r of otherRows) {
    const k = lc(r.email);
    if (!booked.has(k)) booked.set(k, []);
    booked.get(k).push({ start: dayKey(r.startDate), end: dayKey(r.endDate) });
  }

  // Keep the one with a live request first, so duplicates settle the same way every run.
  plans.sort((a, b) => {
    const aa = ACTIVE.includes(existing.get(a.externalId)?.status) ? 0 : 1;
    const bb = ACTIVE.includes(existing.get(b.externalId)?.status) ? 0 : 1;
    return aa - bb || a.externalId.localeCompare(b.externalId);
  });

  // 3. Create / update.
  const kept = new Set();
  const seenSlots = new Set();
  for (const p of plans) {
    const mine = existing.get(p.externalId);
    if (mine && mine.status === 'cancelled' && cancelledByPerson(mine.events)) { kept.add(p.externalId); bump('skipped_cancelled_here'); continue; }
    const type = typeByKey.get(p.typeKey) || typeByKey.get('vacation');
    if (!type) { bump('skipped_no_type'); continue; }
    const slot = `${p.email}|${p.startDate}|${p.endDate}|${type.id}|${p.dayPart}|${p.startMinute ?? ''}`;
    if (seenSlots.has(slot)) { bump('skipped_duplicate'); continue; }
    seenSlots.add(slot);
    if ((booked.get(p.email) || []).some((b) => b.start <= p.endDate && b.end >= p.startDate)) {
      // Booked in Vacation Pulse: that one wins; an earlier import is left alone.
      if (mine) kept.add(p.externalId);
      bump('skipped_app_booked');
      continue;
    }
    kept.add(p.externalId);
    const person = people.get(p.email) || {};
    const dates = workingDates({ startDate: p.startDate, endDate: p.endDate, workdays: person.workdays, isHoliday });
    const size = requestSize({ dates, dayPart: p.dayPart, startMinute: p.startMinute, endMinute: p.endMinute, dailyHours: num(person.dailyHours) || 8 });
    const fields = {
      email: p.email, leaveTypeId: type.id, startDate: toDay(p.startDate), endDate: toDay(p.endDate), dayPart: p.dayPart,
      startMinute: p.startMinute, endMinute: p.endMinute, days: size.days, hours: size.hours,
    };
    if (mine) {
      if (mine.status === 'approved' && sameFields(mine, fields)) { bump('unchanged'); continue; }
      bump('updated');
      if (would.update.length < LIST_CAP) would.update.push(describe(p, type.name));
      if (!live) continue;
      const row = await prisma.avRequest.update({
        where: { id: mine.id },
        data: {
          ...fields, status: 'approved', decidedBy: CAL_ACTOR, decidedAt: new Date(),
          events: { create: { kind: 'synced_update', actor: CAL_ACTOR, details: { source: CAL_SOURCE, from: { start: dayKey(mine.startDate), end: dayKey(mine.endDate), status: mine.status } } } },
        },
      });
      await av?.unproject?.(row).catch(() => null);
      await av?.project?.(row).catch(() => null);
      continue;
    }
    bump('created');
    if (would.create.length < LIST_CAP) would.create.push(describe(p, type.name));
    if (!live) continue;
    if (!people.has(p.email)) {
      const created = await prisma.avPerson.create({ data: { email: p.email, name: p.personName || p.email.split('@')[0] } }).catch(() => null);
      if (created) people.set(p.email, created);
    }
    const request = await prisma.avRequest.create({
      data: {
        ...fields,
        status: 'approved', decidedBy: CAL_ACTOR, decidedAt: new Date(), source: CAL_SOURCE, externalId: p.externalId,
        decision: { outcome: 'approved', reason: 'From the shared calendar', fired: [] },
        createdBy: CAL_ACTOR,
        events: { create: { kind: 'imported', actor: CAL_ACTOR, details: { source: CAL_SOURCE, leaveType: type.name } } },
      },
    });
    await av?.project?.(request).catch(() => null);
  }

  // 4. Gone from the calendar, or no longer importable: cancel, within the window.
  const wStart = windowStart ? dayKey(windowStart) : null;
  const wEnd = windowEnd ? dayKey(windowEnd) : null;
  const candidates = [...existing.values()].filter((r) => ACTIVE.includes(r.status) && !kept.has(r.externalId)
    && (!wStart || dayKey(r.startDate) >= wStart) && (!wEnd || dayKey(r.startDate) <= wEnd));
  let guard = false;
  if (candidates.length && !eventsListed) {
    guard = true;
    logger.warn(`Shared calendar import ws ${ws}: the calendar listed no events; not cancelling ${candidates.length} imported request(s)`);
  } else {
    for (const r of candidates) {
      const why = skipReasonByExternalId.get(r.externalId);
      const reason = why ? `No longer imported (${why.replace(/^skipped_/, '').replace(/_/g, ' ')})` : 'No longer on the shared calendar';
      bump('cancelled');
      if (would.cancel.length < LIST_CAP) would.cancel.push({ email: r.email, start: dayKey(r.startDate), end: dayKey(r.endDate), reason });
      if (!live) continue;
      const row = await prisma.avRequest.update({
        where: { id: r.id },
        data: { status: 'cancelled', events: { create: { kind: 'cancelled', actor: CAL_ACTOR, details: { reason, source: CAL_SOURCE } } } },
      });
      await av?.unproject?.(row).catch(() => null);
    }
  }

  return {
    counts,
    unmatched: [...unmatched.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, LIST_CAP).map(([name, events]) => ({ name, events })),
    tentative,
    would: live ? undefined : would,
    window: { from: wStart, to: wEnd },
    eventsListed,
    guard,
  };
}
