/**
 * Availability rules engine (plans/AVAILABILITY_TRACKER_PLAN.md, Oct 2026).
 *
 * Pure and deterministic: no database, no LLM. Every decision lists the rules
 * that fired so "why was this auto-approved / sent for approval / refused" is
 * always answerable. A rule = scope + leave types + condition + outcome; it
 * fires when its condition MATCHES:
 *
 *   always          — every request in scope
 *   advance_notice  — starts sooner than minDaysAhead or later than maxDaysAhead
 *   capacity        — more than `max` people (incl. this one) out with these
 *                     types in the same office / group / company per day|week
 *   duration        — longer than maxDays (working days)
 *   blackout        — overlaps from..to
 *   balance         — not enough balance left (allowNegativeDays grace)
 *   past_dated      — starts before today
 *
 * Order: refuse > needs_approval > auto_approve > group auto-approve > the
 * leave type's own "needs approval" default. warn rules never decide.
 */

export const RULE_KINDS = ['always', 'advance_notice', 'capacity', 'duration', 'blackout', 'balance', 'past_dated'];
export const RULE_OUTCOMES = ['auto_approve', 'needs_approval', 'refuse', 'warn'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' (or Date) → UTC midnight Date. */
export function toDay(value) {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function dayKey(d) {
  return toDay(d).toISOString().slice(0, 10);
}

export function addDays(d, n) {
  return new Date(toDay(d).getTime() + n * DAY_MS);
}

export function daysBetween(a, b) {
  return Math.round((toDay(b).getTime() - toDay(a).getTime()) / DAY_MS);
}

/** ISO weekday 1..7 (Mon..Sun). */
export function isoWeekday(d) {
  const w = toDay(d).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Monday of the ISO week containing d, as 'YYYY-MM-DD'. */
export function weekKey(d) {
  return dayKey(addDays(d, 1 - isoWeekday(d)));
}

/**
 * Holiday lookup: rows of { date, isRecurring, isEnabled }. Recurring rows
 * match on month-day in any year.
 */
export function holidayMatcher(holidays = []) {
  const exact = new Set();
  const recurring = new Set();
  for (const h of holidays) {
    if (h?.isEnabled === false) continue;
    const k = dayKey(h.date);
    if (h.isRecurring) recurring.add(k.slice(5));
    else exact.add(k);
  }
  return (d) => {
    const k = dayKey(d);
    return exact.has(k) || recurring.has(k.slice(5));
  };
}

/** The working dates (as 'YYYY-MM-DD') a request covers for this person. */
export function workingDates({ startDate, endDate, workdays = [1, 2, 3, 4, 5], isHoliday = () => false }) {
  const out = [];
  const start = toDay(startDate);
  const end = toDay(endDate);
  if (!start || !end || end < start) return out;
  const days = new Set((Array.isArray(workdays) && workdays.length ? workdays : [1, 2, 3, 4, 5]).map(Number));
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (days.has(isoWeekday(d)) && !isHoliday(d)) out.push(dayKey(d));
  }
  return out;
}

/**
 * Days and hours a request is worth.
 * dayPart: full | am | pm | hours. Hours requests use start/endMinute per day.
 */
export function requestSize({ dates, dayPart = 'full', startMinute = null, endMinute = null, dailyHours = 8 }) {
  const n = dates.length;
  const hoursPerDay = Number(dailyHours) || 8;
  if (dayPart === 'am' || dayPart === 'pm') {
    return { days: round2(n * 0.5), hours: round2(n * hoursPerDay * 0.5) };
  }
  if (dayPart === 'hours') {
    const per = Math.max(0, (Number(endMinute) - Number(startMinute)) / 60);
    const hours = round2(per * n);
    return { days: round2(hours / hoursPerDay), hours };
  }
  return { days: n, hours: round2(n * hoursPerDay) };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/** Does this rule apply to this person and leave type? */
export function ruleApplies(rule, { person, leaveTypeId, groupIds = [] }) {
  if (rule?.isActive === false) return false;
  const types = Array.isArray(rule.leaveTypeIds) ? rule.leaveTypeIds.map(Number) : null;
  if (types && types.length && !types.includes(Number(leaveTypeId))) return false;
  const ref = (rule.scopeRef === null || rule.scopeRef === undefined) ? null : String(rule.scopeRef);
  switch (rule.scopeType || 'company') {
  case 'company': return true;
  case 'office': return (ref !== null && ref !== undefined) && String(person?.officeId ?? '') === ref;
  case 'group': return (ref !== null && ref !== undefined) && groupIds.map(String).includes(ref);
  case 'person': return (ref !== null && ref !== undefined) && String(person?.email || '').toLowerCase() === ref.toLowerCase();
  default: return false;
  }
}

/**
 * Evaluate one condition. Returns { match, detail } — detail is the human
 * sentence shown to the requester and stored on the decision.
 *
 * ctx: {
 *   today, startDate, endDate, dates, days,
 *   capacity: (rule) => [{ window:'YYYY-MM-DD'|week, others:number }],
 *   remaining: number | null   (balance left before this request)
 * }
 */
export function evaluateCondition(rule, ctx) {
  const c = rule.condition || {};
  switch (c.kind) {
  case 'always':
    return { match: true, detail: null };
  case 'advance_notice': {
    const ahead = daysBetween(ctx.today, ctx.startDate);
    if ((c.maxDaysAhead !== null && c.maxDaysAhead !== undefined) && ahead > Number(c.maxDaysAhead)) {
      return { match: true, detail: `It starts ${ahead} days from now; the limit is ${Number(c.maxDaysAhead)} days ahead.` };
    }
    if ((c.minDaysAhead !== null && c.minDaysAhead !== undefined) && ahead < Number(c.minDaysAhead)) {
      return { match: true, detail: `It starts in ${Math.max(0, ahead)} day${ahead === 1 ? '' : 's'}; at least ${Number(c.minDaysAhead)} days' notice is needed.` };
    }
    return { match: false, detail: null };
  }
  case 'capacity': {
    const max = Number(c.max);
    if (!Number.isFinite(max)) return { match: false, detail: null };
    const windows = (ctx.capacity ? ctx.capacity(rule) : []) || [];
    const over = windows.find((w) => w.others + 1 > max);
    if (!over) return { match: false, detail: null };
    const where = c.scope === 'group' ? 'your group' : c.scope === 'company' ? 'the company' : 'your office';
    const when = c.window === 'day' ? `on ${over.window}` : `in the week of ${over.window}`;
    return { match: true, detail: `${over.others} other${over.others === 1 ? ' is' : 's are'} already booked in ${where} ${when} (limit ${max}).` };
  }
  case 'duration': {
    const max = Number(c.maxDays);
    if (Number.isFinite(max) && ctx.days > max) {
      return { match: true, detail: `It is ${ctx.days} working days; the limit is ${max}.` };
    }
    return { match: false, detail: null };
  }
  case 'blackout': {
    const from = toDay(c.from);
    const to = toDay(c.to);
    if (from && to && toDay(ctx.startDate) <= to && toDay(ctx.endDate) >= from) {
      return { match: true, detail: `It overlaps a blackout period (${dayKey(from)} to ${dayKey(to)})${c.label ? `: ${c.label}` : ''}.` };
    }
    return { match: false, detail: null };
  }
  case 'balance': {
    if ((ctx.remaining === null || ctx.remaining === undefined)) return { match: false, detail: null };
    const grace = Number(c.allowNegativeDays || 0);
    if (ctx.remaining - ctx.days < -grace) {
      return { match: true, detail: `You have ${ctx.remaining} day${ctx.remaining === 1 ? '' : 's'} left; this needs ${ctx.days}.` };
    }
    return { match: false, detail: null };
  }
  case 'past_dated':
    if (toDay(ctx.startDate) < toDay(ctx.today)) return { match: true, detail: 'It starts in the past.' };
    return { match: false, detail: null };
  default:
    return { match: false, detail: null };
  }
}

/**
 * Decide a request.
 * @returns {{ outcome: 'approved'|'pending'|'refused', fired: Array, warnings: Array, reason: string }}
 */
export function decide({ rules = [], leaveType, person, groupIds = [], groupAutoApprove = false, ctx }) {
  const fired = [];
  const sorted = [...rules].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || (a.id ?? 0) - (b.id ?? 0));
  for (const rule of sorted) {
    if (!ruleApplies(rule, { person, leaveTypeId: leaveType.id, groupIds })) continue;
    const { match, detail } = evaluateCondition(rule, ctx);
    if (!match) continue;
    fired.push({
      ruleId: rule.id ?? null,
      name: rule.name,
      outcome: rule.outcome,
      message: [rule.message, detail].filter(Boolean).join(' ') || null,
    });
  }
  const warnings = fired.filter((f) => f.outcome === 'warn');
  const refuse = fired.find((f) => f.outcome === 'refuse');
  if (refuse) return { outcome: 'refused', fired, warnings, reason: refuse.message || `Not allowed by "${refuse.name}".` };
  const needs = fired.find((f) => f.outcome === 'needs_approval');
  if (needs) return { outcome: 'pending', fired, warnings, reason: needs.message || `Needs approval: "${needs.name}".` };
  const auto = fired.find((f) => f.outcome === 'auto_approve');
  if (auto) return { outcome: 'approved', fired, warnings, reason: auto.message || `Auto-approved by "${auto.name}".` };
  if (groupAutoApprove) return { outcome: 'approved', fired, warnings, reason: 'Auto-approved: your approval group auto-approves this type.' };
  if (leaveType.requiresApproval) return { outcome: 'pending', fired, warnings, reason: `${leaveType.name} needs approval.` };
  return { outcome: 'approved', fired, warnings, reason: `${leaveType.name} doesn't need approval.` };
}

/**
 * Leave year containing d, given the month the year starts (1 = January).
 * Returns the calendar year in which that leave year STARTS.
 */
export function leaveYearOf(d, yearStartMonth = 1) {
  const day = toDay(d);
  const m = day.getUTCMonth() + 1;
  return m >= yearStartMonth ? day.getUTCFullYear() : day.getUTCFullYear() - 1;
}

export function leaveYearRange(year, yearStartMonth = 1) {
  const start = new Date(Date.UTC(year, yearStartMonth - 1, 1));
  const end = addDays(new Date(Date.UTC(year + 1, yearStartMonth - 1, 1)), -1);
  return { start, end };
}

/**
 * Entitlement for a leave year from a balance policy:
 *   { annualDays, tenureTiers:[{afterYears, days}], prorate, eligibleAfterDays }
 * Tenure = completed years of service at the leave year's start.
 */
export function entitlementFor(policy, { startDate = null, year, yearStartMonth = 1 }) {
  if (!policy) return 0;
  const { start: yStart, end: yEnd } = leaveYearRange(year, yearStartMonth);
  let days = Number(policy.annualDays || 0);
  const hire = startDate ? toDay(startDate) : null;
  if (hire && Array.isArray(policy.tenureTiers)) {
    let years = yStart.getUTCFullYear() - hire.getUTCFullYear();
    const anniversary = new Date(Date.UTC(yStart.getUTCFullYear(), hire.getUTCMonth(), hire.getUTCDate()));
    if (anniversary > yStart) years -= 1;
    for (const tier of [...policy.tenureTiers].sort((a, b) => a.afterYears - b.afterYears)) {
      if (years >= Number(tier.afterYears)) days = Number(tier.days);
    }
  }
  if (hire && policy.eligibleAfterDays) {
    const eligibleFrom = addDays(hire, Number(policy.eligibleAfterDays));
    if (eligibleFrom > yEnd) return 0;
  }
  if (hire && policy.prorate && hire > yStart && hire <= yEnd) {
    const total = daysBetween(yStart, yEnd) + 1;
    const left = daysBetween(hire, yEnd) + 1;
    days = Math.round(days * (left / total) * 2) / 2; // nearest half day
  }
  return days;
}
