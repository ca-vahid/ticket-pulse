/**
 * Site visits name the place (25 Nov 2026), and one visit counts once.
 *
 * Pure helpers, no database:
 *   - siteFieldsFor: the "Which office?" answer a booking carries (an office
 *     from av_offices, or a short "Other site" text), validated;
 *   - sitePlaceOf / siteLabel: "Site visit · Toronto";
 *   - projectionSiteFields: what the dashboard rows (technician_leaves) get;
 *   - officeFromNote: which office a free-text note names (the backfill);
 *   - the de-duplication rules for a visit booked both in Vacation Tracker and
 *     in Vacation Pulse: findAppTwin (the import), collapseCalendarEntries (the
 *     wallchart / overview), sameLeaveKind + collapseLeaveRows (the rows the
 *     assigner reads).
 */
import { ValidationError } from '../../utils/errors.js';
import { isSiteVisitLeave } from '../../utils/leaveKinds.js';
import { toDay, dayKey } from './availabilityRules.js';

const lc = (s) => String(s ?? '').trim().toLowerCase();
export const SITE_LOCATION_MAX = 160;

/** True when this Vacation Pulse leave type is a site visit (availability ONSITE). */
export const isSiteVisitType = (type) => String(type?.availability || '').toUpperCase() === 'ONSITE';

const blank = (v) => v === undefined || v === null || v === '';

/**
 * The site fields a booking gets: { siteOfficeId, siteLocation }.
 *
 * - Not a site-visit type: both null (a type change away from a site visit clears them).
 * - siteOfficeId given: must be an active office (an edit may keep the
 *   office it already had, even if that office was retired since).
 * - siteLocation given ("Other site…"): trimmed, at most 160 characters.
 * - Neither: refused when `required` (a new booking, or an edit that touches
 *   the type or the dates); otherwise the booking keeps what it had.
 */
export function siteFieldsFor({ leaveType, input = {}, offices = [], existing = null, required = true }) {
  if (!isSiteVisitType(leaveType)) return { siteOfficeId: null, siteLocation: null };
  const officeRaw = input.siteOfficeId;
  const text = String(input.siteLocation ?? '').replace(/\s+/g, ' ').trim();
  if (!blank(officeRaw) && officeRaw !== 'other') {
    const id = Number(officeRaw);
    const office = Number.isInteger(id) ? offices.find((o) => o.id === id) : null;
    const keeping = existing && existing.siteOfficeId === id;
    if (!office || (office.isActive === false && !keeping)) throw new ValidationError('Pick one of the offices, or "Other site"');
    return { siteOfficeId: id, siteLocation: null };
  }
  if (text) {
    if (text.length > SITE_LOCATION_MAX) throw new ValidationError(`Keep the site to ${SITE_LOCATION_MAX} characters`);
    return { siteOfficeId: null, siteLocation: text };
  }
  if (required) {
    throw new ValidationError(officeRaw === 'other' ? 'Say which site you are visiting' : 'Pick which office the site visit is at (or "Other site")');
  }
  return { siteOfficeId: existing?.siteOfficeId ?? null, siteLocation: existing?.siteLocation ?? null };
}

/**
 * Does this edit have to answer "Which office?" again? Only when it changes
 * the type or the dates (a note-only change of an older booking stays valid).
 */
export function editTouchesTypeOrDates(before, after) {
  return Number(before.leaveTypeId) !== Number(after.leaveTypeId)
    || dayKey(before.startDate) !== dayKey(after.startDate)
    || dayKey(before.endDate) !== dayKey(after.endDate);
}

/** The place a booking names: the office's name, else the "Other site" text, else null. */
export function sitePlaceOf(request, officeById = null) {
  if (!request) return null;
  if (request.siteOffice?.name) return request.siteOffice.name;
  if (request.siteOfficeId && officeById) {
    const o = officeById instanceof Map ? officeById.get(request.siteOfficeId) : officeById[request.siteOfficeId];
    if (o?.name) return o.name;
  }
  const text = String(request.siteLocation || '').trim();
  return text || null;
}

/** "Site visit · Toronto"; just the type name when no place is known. */
export function siteLabel(typeName, place) {
  const name = String(typeName || 'Time away');
  return place ? `${name} · ${place}` : name;
}

/**
 * What a projected dashboard row carries: the office name and its time zone,
 * or the "Other site" text with no time zone. Nothing for other types.
 */
export function projectionSiteFields(request, type, office = null) {
  if (!isSiteVisitType(type)) return { siteLocation: null, siteTimezone: null };
  if (office && request.siteOfficeId === office.id) {
    return { siteLocation: String(office.name).slice(0, SITE_LOCATION_MAX), siteTimezone: office.timezone || null };
  }
  const text = String(request.siteLocation || '').trim();
  return { siteLocation: text ? text.slice(0, SITE_LOCATION_MAX) : null, siteTimezone: null };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which office a note names: a case-insensitive whole-word match on the office
 * name ("Toronto", "toronto office visit", "Toronto site visit with Sam").
 * The longest name wins when one contains another ("North Vancouver" over
 * "Vancouver"); two unrelated offices in one note is ambiguous → null.
 */
export function officeFromNote(note, offices = []) {
  const text = String(note || '');
  if (!text.trim()) return null;
  const hits = [];
  for (const o of offices) {
    const name = String(o?.name || '').trim();
    if (!name) continue;
    const pattern = escapeRe(name).replace(/\s+/g, '\\s+');
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}($|[^\\p{L}\\p{N}])`, 'iu').test(text)) hits.push(o);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.name.length - a.name.length);
  const [best, ...rest] = hits;
  return rest.every((o) => lc(best.name).includes(lc(o.name))) ? best : null;
}

// ---------------------------------------------------------------- de-duplication

const overlaps = (a, b) => toDay(a.startDate) <= toDay(b.endDate) && toDay(b.startDate) <= toDay(a.endDate);
const covers = (outer, inner) => toDay(outer.startDate) <= toDay(inner.startDate) && toDay(outer.endDate) >= toDay(inner.endDate);
const fromVt = (r) => r.source === 'vacation_tracker';

/**
 * The import's skip rule: the Vacation Pulse booking (not from Vacation
 * Tracker, approved or waiting) of the same person and leave type whose dates
 * overlap this Vacation Tracker leave. Exact same dates first.
 */
export function findAppTwin(fields, appRequests = []) {
  const same = appRequests.filter((r) => !fromVt(r) && ['approved', 'pending'].includes(r.status)
    && lc(r.email) === lc(fields.email) && Number(r.leaveTypeId) === Number(fields.leaveTypeId) && overlaps(r, fields));
  if (!same.length) return null;
  return same.find((r) => dayKey(r.startDate) === dayKey(fields.startDate) && dayKey(r.endDate) === dayKey(fields.endDate)) || same[0];
}

/**
 * Calendar entries (wallchart, overview, out today): an entry imported from
 * Vacation Tracker that a Vacation Pulse booking of the same person and type
 * already covers is the same visit — it is dropped. A partly overlapping one
 * stays (it covers days the booking does not).
 */
export function collapseCalendarEntries(entries = []) {
  const own = entries.filter((e) => !fromVt(e));
  return entries.filter((e) => {
    if (!fromVt(e)) return true;
    return !own.some((o) => lc(o.email) === lc(e.email) && Number(o.leaveTypeId) === Number(e.leaveTypeId) && e.leaveTypeId !== null && e.leaveTypeId !== undefined
      && (o.status === e.status || o.status === 'approved') && covers(o, e));
  });
}

/** The Vacation Pulse type a Vacation Tracker type name imports as (exact name, type name, then contains). */
export function avTypeForVtName(vtName, types = []) {
  const name = lc(vtName);
  const names = (t) => (Array.isArray(t.vtLeaveTypeNames) ? t.vtLeaveTypeNames.map(lc) : []);
  return types.find((t) => names(t).includes(name))
    || types.find((t) => lc(t.name) === name)
    || types.find((t) => names(t).some((n) => n && name.includes(n)))
    || null;
}

export const isAppRow = (row) => String(row?.vtLeaveId || '').startsWith('av:');
const isCalendarRow = (row) => String(row?.vtLeaveId || '').startsWith('graph:');
/** A dashboard row the Vacation Tracker leave sync wrote ('leaveRequest-…'). */
export const isVtRow = (row) => !isAppRow(row) && !isCalendarRow(row);

/**
 * Is this Vacation Tracker row the same kind of leave as this Vacation Pulse
 * row? By the Vacation Pulse type the Vacation Tracker name maps to; with no
 * mapping, by category and site visit.
 */
export function sameLeaveKind(vtRow, appRow, avTypes = []) {
  const mapped = avTypeForVtName(vtRow.leaveTypeName, avTypes);
  if (mapped) return lc(mapped.name) === lc(appRow.leaveTypeName);
  return String(vtRow.category || '').toUpperCase() === String(appRow.category || '').toUpperCase()
    && isSiteVisitLeave(vtRow) === isSiteVisitLeave(appRow);
}

const rowDay = (row) => (row.leaveDate ? dayKey(row.leaveDate) : '');

/**
 * Pairs of dashboard rows where a Vacation Tracker row repeats a Vacation
 * Pulse row: same person, same day, same kind. [{ vtRow, appRow }].
 */
export function duplicateLeavePairs(rows = [], avTypes = []) {
  const app = new Map();
  for (const r of rows) {
    if (!isAppRow(r)) continue;
    const k = `${r.technicianId}|${rowDay(r)}`;
    if (!app.has(k)) app.set(k, []);
    app.get(k).push(r);
  }
  const pairs = [];
  for (const r of rows) {
    if (!isVtRow(r)) continue;
    const twin = (app.get(`${r.technicianId}|${rowDay(r)}`) || []).find((a) => sameLeaveKind(r, a, avTypes));
    if (twin) pairs.push({ vtRow: r, appRow: twin });
  }
  return pairs;
}

/**
 * The rows one person has on one day, each visit once: rows of the same kind
 * (category, site visit, full / half day) collapse to one, the Vacation Pulse
 * row first (it carries the site office).
 */
export function collapseLeaveRows(rows = []) {
  const sorted = [...rows].sort((a, b) => Number(isAppRow(b)) - Number(isAppRow(a)));
  const seen = new Set();
  const out = [];
  for (const r of sorted) {
    const key = [
      r.technicianId, rowDay(r), String(r.category || '').toUpperCase(), isSiteVisitLeave(r) ? 'site' : '',
      r.isFullDay === false ? `half:${r.halfDayPart || ''}` : 'full',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export default {
  isSiteVisitType, siteFieldsFor, editTouchesTypeOrDates, sitePlaceOf, siteLabel, projectionSiteFields, officeFromNote,
  findAppTwin, collapseCalendarEntries, avTypeForVtName, sameLeaveKind, duplicateLeavePairs, collapseLeaveRows,
};
