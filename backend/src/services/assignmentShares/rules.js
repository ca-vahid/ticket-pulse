import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { addDaysStr, safeZone, toDateStr } from '../urgentResponse/rules.js';
import { isAwayLeave } from '../../utils/leaveKinds.js';

/**
 * Ticket shares — the rules (QA 10-16 item 4; rules per category QA 11-26 #3–6).
 *
 * A workspace admin sets up one or more RULES. Each rule covers some
 * categories (no category in two rules) and says who takes those tickets:
 * people with a whole-percent share, internal groups with a share (split
 * evenly across the group's current members), and optionally "the rest,
 * split evenly" among a list of people. When a ticket in a rule's categories
 * arrives, the rule picks whoever is furthest below their share this period.
 * Best effort, close to the percentages, never exact. Each rule has its own
 * mode (Off / Shadow / Live) and counting period.
 *
 * The "earned ledger" (plans/WEIGHTED_DISTRIBUTION_PLAN.md §2–5), worked out
 * from tickets each time instead of a credits table:
 *   - every counted ticket earns each person who was in that day their share
 *     of one ticket (shares re-scaled over the people who were in);
 *   - a person's balance = what they earned − what they hold;
 *   - the next ticket goes to the highest balance among the people in now.
 * Nobody away: exactly QA's formula (share × (N+1) − count). Someone away:
 * they earn nothing for those days, so there is no catch-up when they return.
 *
 * A group (or the evenly split rest) is one "slot" holding its share: the
 * ticket's credit is first split across the slots that have someone in, by
 * their percent, then a slot's part is split evenly across its people who are
 * in. So the Juniors keep their 50% while one junior is away (the other
 * juniors take it); a group with nobody in earns nothing, like an away person.
 * A rule with only people (every rule stored before QA 11-26) has one slot per
 * person, which is exactly the arithmetic it always had.
 *
 * Working hours (QA 10-20 #4): a ticket never goes to someone whose working
 * day has not started (or has ended) while a teammate on the list is working.
 * They still earn their share of it, so they catch up once they start: Maria
 * in Fredericton takes the 06:00 Pacific tickets, and Josh in Calgary gets the
 * next ones when his day begins. Over the week the shares still line up.
 * Nobody on the list working (a 03:00 ticket): hours are ignored, as before.
 *
 * Whole numbers only: 10,000 units = one ticket, so ties are exact (floating
 * point changes tie results, plan S1b).
 *
 * Pure: no database, no clock of its own (callers pass `now`).
 */

export const SETTINGS_VERSION = 2;
export const RECORD_VERSION = 1;
export const UNIT = 10000;
/** History lines kept per rule (a line before rules counts as r1's), and overall. */
export const HISTORY_LIMIT = 30;
export const HISTORY_TOTAL_LIMIT = 200;
export const MAX_MEMBERS = 30;
export const MAX_GROUPS = 10;
export const MAX_REST = 30;
export const MAX_CATEGORIES = 60;
export const MAX_RULES = 20;
export const MAX_NAME = 80;
/** The id a settings object stored before rules (v1) gets for its one rule. */
export const LEGACY_RULE_ID = 'r1';
export const MODES = Object.freeze(['off', 'shadow', 'live']);
export const PERIODS = Object.freeze(['week', 'month']);
/** The fields of one rule an admin can change. */
export const RULE_FIELDS = Object.freeze(['name', 'mode', 'period', 'categoryIds', 'members', 'groups', 'rest']);
/** The v1 save body (one rule, people only). Still accepted: it changes the first rule. */
export const SETTING_FIELDS = Object.freeze(['mode', 'period', 'categoryIds', 'members']);
const RULE_ID = /^r\d{1,6}$/;

const positiveInt = (n) => Number.isInteger(n) && n > 0;
const asList = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : null);

export function defaultRule() {
  return {
    id: null, name: '', mode: 'off', period: 'week', categoryIds: [], members: [], groups: [], rest: { evenly: false, techIds: [] },
    enabledSince: null, updatedAt: null, updatedBy: null,
  };
}

export function defaultSettings() {
  return { v: SETTINGS_VERSION, seq: 0, rules: [], updatedAt: null, updatedBy: null, history: [] };
}

function cleanMembers(list) {
  const seen = new Set();
  const out = [];
  for (const m of asList(list)) {
    const techId = Number(m?.techId);
    const pct = Number(m?.pct);
    if (!positiveInt(techId) || seen.has(techId) || !Number.isInteger(pct) || pct < 1 || pct > 100) continue;
    seen.add(techId);
    out.push({ techId, pct });
  }
  return out.slice(0, MAX_MEMBERS);
}

function cleanGroups(list) {
  const seen = new Set();
  const out = [];
  for (const g of asList(list)) {
    const groupId = Number(g?.groupId);
    const pct = Number(g?.pct);
    if (!positiveInt(groupId) || seen.has(groupId) || !Number.isInteger(pct) || pct < 1 || pct > 100) continue;
    seen.add(groupId);
    out.push({ groupId, pct });
  }
  return out.slice(0, MAX_GROUPS);
}

function cleanRest(raw) {
  const techIds = [...new Set(asList(raw?.techIds).map(Number).filter(positiveInt))].slice(0, MAX_REST);
  return { evenly: raw?.evenly === true, techIds };
}

function cleanCategoryIds(list) {
  return [...new Set(asList(list).map(Number).filter(positiveInt))].slice(0, MAX_CATEGORIES);
}

/**
 * The last HISTORY_LIMIT lines of EACH rule (newest first), at most
 * HISTORY_TOTAL_LIMIT in all: editing one rule never pushes another rule's
 * lines out (a v1 workspace's earlier lines stay with r1).
 */
export function trimHistory(list) {
  const kept = [];
  const perRule = new Map();
  for (const h of asList(list)) {
    if (!h || typeof h !== 'object') continue;
    const key = typeof h.ruleId === 'string' ? h.ruleId : LEGACY_RULE_ID;
    const n = (perRule.get(key) || 0) + 1;
    perRule.set(key, n);
    if (n <= HISTORY_LIMIT) kept.push(h);
    if (kept.length >= HISTORY_TOTAL_LIMIT) break;
  }
  return kept;
}

const cleanName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '');
const ruleNumber = (id) => (typeof id === 'string' && RULE_ID.test(id) ? Number(id.slice(1)) : 0);

/** One stored rule (or a draft) → a complete rule. */
export function normalizeRule(raw, fallbackId = null) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: typeof r.id === 'string' && RULE_ID.test(r.id) ? r.id : fallbackId,
    name: cleanName(r.name),
    mode: MODES.includes(r.mode) ? r.mode : 'off',
    period: PERIODS.includes(r.period) ? r.period : 'week',
    categoryIds: cleanCategoryIds(r.categoryIds),
    members: cleanMembers(r.members),
    groups: cleanGroups(r.groups),
    rest: cleanRest(r.rest),
    enabledSince: str(r.enabledSince),
    updatedAt: str(r.updatedAt),
    updatedBy: str(r.updatedBy),
  };
}

/**
 * Whatever was stored (a JSON string, an object, nothing, rubbish) → complete
 * v2 settings: `{ v: 2, seq, rules[], updatedAt, updatedBy, history[], persisted, fromV1 }`.
 *
 * A v1 object (no `rules`: `{ mode, period, categoryIds, members, enabledSince, … }`,
 * the shape every workspace saved before QA 11-26) is read as ONE rule, id
 * 'r1', carrying its mode, period, categories, people and enabledSince, no
 * groups and no rest. It decides exactly as it did. Nothing is rewritten
 * until an admin saves.
 */
export function normalizeSettings(raw) {
  let stored = raw;
  if (typeof raw === 'string') {
    try { stored = JSON.parse(raw); } catch { stored = null; }
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  const persisted = Object.keys(stored).length > 0;
  let rules = [];
  let fromV1 = false;
  if (Array.isArray(stored.rules)) {
    const list = stored.rules.slice(0, MAX_RULES).map((r) => normalizeRule(r, null));
    let top = Math.max(0, Number(stored.seq) || 0, ...list.map((r) => ruleNumber(r.id)));
    const seen = new Set();
    for (const rule of list) {
      if (!rule.id || seen.has(rule.id)) { top += 1; rule.id = `r${top}`; }
      seen.add(rule.id);
      rules.push(rule);
    }
  } else if (persisted) {
    fromV1 = true;
    const rule = normalizeRule({ ...stored, id: LEGACY_RULE_ID, name: '', groups: [], rest: null }, LEGACY_RULE_ID);
    const empty = rule.mode === 'off' && !rule.categoryIds.length && !rule.members.length;
    rules = empty ? [] : [rule];
  }
  const seq = Math.max(Number(stored.seq) || 0, ...rules.map((r) => ruleNumber(r.id)), fromV1 ? 1 : 0);
  return {
    v: SETTINGS_VERSION,
    seq,
    rules,
    persisted,
    fromV1,
    updatedAt: str(stored.updatedAt),
    updatedBy: str(stored.updatedBy),
    history: trimHistory(stored.history),
  };
}

export const totalPct = (list) => asList(list).reduce((sum, m) => sum + (Number(m?.pct) || 0), 0);
/** The percent named outright: people plus groups. */
export const explicitPct = (rule) => totalPct(rule?.members) + totalPct(rule?.groups);
export const restOn = (rule) => rule?.rest?.evenly === true && asList(rule.rest.techIds).length > 0;
/** What "the rest, split evenly" takes: 100 − the named percent. */
export const restPct = (rule) => (restOn(rule) ? Math.max(0, 100 - explicitPct(rule)) : 0);
export const hasShares = (rule) => asList(rule?.members).length > 0 || asList(rule?.groups).length > 0 || restOn(rule);
/** A rule that acts on tickets: on, with categories and someone to share them. */
export const ruleReady = (rule) => Boolean(rule && rule.mode !== 'off' && asList(rule.categoryIds).length && hasShares(rule));

/** A rule's name: what the admin typed, else its categories ("Vendor Invoices"). */
export function ruleLabel(rule, categoryNames = new Map()) {
  if (rule?.name) return rule.name;
  const names = asList(rule?.categoryIds).map((id) => categoryNames.get(Number(id))).filter(Boolean);
  if (!names.length) return 'New rule';
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

const joinWords = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/**
 * Checks one rule draft. Every problem is a plain sentence the admin sees.
 * `validTechIds` / `validCategoryIds` / `groups` (Map groupId → { name,
 * techIds }: the workspace's active internal groups with their current
 * members) are the workspace's own; omitted = not checked. `names` (Map
 * techId → name) names people in the messages.
 */
export function validateRule(draft, { validTechIds = null, validCategoryIds = null, groups = null, names = null } = {}) {
  const errors = [];
  const d = draft || {};
  const nameOf = (id) => names?.get(Number(id)) || `Technician ${id}`;
  if (!MODES.includes(d.mode)) errors.push('Mode must be Off, Shadow or Live');
  if (!PERIODS.includes(d.period)) errors.push('Count tickets per week or per month');
  const places = new Map();
  const place = (id, where) => places.set(id, [...(places.get(id) || []), where]);

  const rawMembers = asList(d.members);
  for (const m of rawMembers) {
    const techId = Number(m?.techId);
    const pct = Number(m?.pct);
    if (!positiveInt(techId)) { errors.push('Every share needs a person'); continue; }
    place(techId, 'named on their own');
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) errors.push('Each share must be a whole percent from 1 to 100');
    if (validTechIds && !validTechIds.has(techId)) errors.push('Someone on the list is not an active member of this workspace');
  }
  if (rawMembers.length > MAX_MEMBERS) errors.push(`No more than ${MAX_MEMBERS} people`);

  const rawGroups = asList(d.groups);
  const seenGroups = new Set();
  for (const g of rawGroups) {
    const groupId = Number(g?.groupId);
    const pct = Number(g?.pct);
    if (!positiveInt(groupId)) { errors.push('A group could not be read'); continue; }
    const info = groups?.get(groupId) || null;
    const groupName = info?.name || `Group ${groupId}`;
    if (seenGroups.has(groupId)) errors.push(`${groupName} is on this rule twice`);
    seenGroups.add(groupId);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) errors.push('Each share must be a whole percent from 1 to 100');
    if (groups && !info) errors.push('A group is not an active internal group of this workspace');
    for (const id of new Set(asList(info?.techIds).map(Number))) place(id, `in ${groupName}`);
  }
  if (rawGroups.length > MAX_GROUPS) errors.push(`No more than ${MAX_GROUPS} groups`);

  const evenly = d.rest?.evenly === true;
  const restIds = [...new Set(asList(d.rest?.techIds).map(Number))];
  if (evenly) {
    if (!restIds.length) errors.push('Pick the people who split the rest evenly');
    for (const id of restIds) {
      if (!positiveInt(id)) { errors.push('Every share needs a person'); continue; }
      place(id, 'in the rest');
      if (validTechIds && !validTechIds.has(id)) errors.push('Someone on the list is not an active member of this workspace');
    }
    if (restIds.length > MAX_REST) errors.push(`No more than ${MAX_REST} people in the rest`);
  }

  // A person may be in one place only: a group, on their own, or the rest.
  for (const [id, where] of places) {
    if (where.length < 2) continue;
    const distinct = [...new Set(where)];
    errors.push(distinct.length === 1
      ? `${nameOf(id)} is ${distinct[0]} twice`
      : `${nameOf(id)} is on this rule more than once (${joinWords(distinct)}). Keep each person in one place`);
  }

  const explicit = totalPct(rawMembers) + totalPct(rawGroups);
  const restCounts = evenly && restIds.length > 0;
  if (restCounts) {
    if (explicit >= 100) errors.push(`The named shares already make ${explicit}%, so nothing is left to split evenly. Lower a share or stop splitting the rest`);
  } else if ((rawMembers.length || rawGroups.length) && explicit !== 100) {
    errors.push(`The shares must total 100% (now ${explicit}%)`);
  }

  const cats = asList(d.categoryIds).map(Number);
  if (cats.some((c) => !positiveInt(c))) errors.push('A category could not be read');
  if (validCategoryIds && cats.some((c) => positiveInt(c) && !validCategoryIds.has(c))) errors.push('A category is not one of this workspace’s categories');
  if (cats.length > MAX_CATEGORIES) errors.push(`No more than ${MAX_CATEGORIES} categories`);
  if (d.mode !== 'off') {
    if (!rawMembers.length && !rawGroups.length && !restCounts) errors.push('Add the people who share the tickets before switching it on');
    if (!cats.length) errors.push('Pick at least one category before switching it on');
  }
  return [...new Set(errors)];
}

/** v1 name, kept for callers: one rule's checks. */
export const validateDraft = validateRule;

/**
 * A category may be in one rule only: the same category, or a top category in
 * one rule and one of its subcategories in another, is an overlap.
 * @param {Map<number, number|null>} parentOf  category id → its top category id
 */
export function overlapErrors(rule, others, { parentOf = new Map(), categoryNames = new Map() } = {}) {
  const errors = [];
  const catName = (id) => categoryNames.get(Number(id)) || `category ${id}`;
  const top = (id) => parentOf.get(Number(id)) || null;
  for (const other of others || []) {
    for (const c of asList(rule?.categoryIds).map(Number)) {
      const hit = asList(other.categoryIds).map(Number).find((o) => o === c || top(o) === c || top(c) === o);
      if (!hit) continue;
      const what = hit === c ? catName(c) : (top(hit) === c ? `${catName(c)} › ${catName(hit)}` : `${catName(hit)} › ${catName(c)}`);
      errors.push(`“${ruleLabel(rule, categoryNames)}” and “${ruleLabel(other, categoryNames)}” both cover ${what}. A category can be in one rule only`);
      break;
    }
  }
  return errors;
}

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function finishRule(draft, id) {
  const rule = normalizeRule({ ...draft, id }, id);
  rule.members.sort((a, b) => b.pct - a.pct || a.techId - b.techId);
  rule.groups.sort((a, b) => b.pct - a.pct || a.groupId - b.groupId);
  rule.rest = { evenly: rule.rest.evenly && rule.rest.techIds.length > 0, techIds: [...rule.rest.techIds].sort((a, b) => a - b) };
  return rule;
}

/**
 * A save: one rule added or changed (`{ rule: {...} }`, no id = a new rule),
 * one removed (`{ removeRuleId }`), or the v1 body (`{ mode, period,
 * categoryIds, members }`), which changes the first rule. The whole rule is
 * checked, and against the other rules' categories. One history line, naming
 * the rule.
 * @returns {{ next: object, changes: Array<{field, from, to}>, errors: string[], ruleId: string|null }}
 */
export function applyPatch(current, patch = {}, {
  by = null, now = new Date(), validTechIds = null, validCategoryIds = null, groups = null, names = null,
  parentOf = new Map(), categoryNames = new Map(),
} = {}) {
  const rules = current?.rules || [];
  const at = now.toISOString();
  const label = (r) => ruleLabel(r, categoryNames);
  const refuse = (errors) => ({ next: current, changes: [], errors, ruleId: null });
  const p = patch && typeof patch === 'object' ? patch : {};

  if (Object.prototype.hasOwnProperty.call(p, 'removeRuleId')) {
    const target = rules.find((r) => r.id === p.removeRuleId);
    if (!target) return refuse(['That rule is not there any more. Refresh the page']);
    const changes = [{ field: 'rule', from: label(target), to: 'removed' }];
    return {
      next: {
        ...current,
        rules: rules.filter((r) => r.id !== target.id),
        updatedAt: at,
        updatedBy: by || null,
        history: trimHistory([{ at, by: by || null, ruleId: target.id, rule: label(target), changes }, ...(current.history || [])]),
        persisted: true,
      },
      changes,
      errors: [],
      ruleId: null,
    };
  }

  let input;
  let existing;
  if (p.rule && typeof p.rule === 'object' && !Array.isArray(p.rule)) {
    input = p.rule;
    existing = input.id ? rules.find((r) => r.id === input.id) || null : null;
    if (input.id && !existing) return refuse(['That rule is not there any more. Refresh the page']);
  } else {
    input = p;
    existing = rules[0] || null;
  }
  if (!existing && rules.length >= MAX_RULES) return refuse([`No more than ${MAX_RULES} rules`]);

  const before = existing || defaultRule();
  const draft = { ...before };
  const fields = input === p ? SETTING_FIELDS : RULE_FIELDS;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) draft[field] = input[field];
  }
  const errors = validateRule(draft, { validTechIds, validCategoryIds, groups, names });
  if (errors.length) return refuse(errors);

  const seq = Number(current?.seq) || 0;
  const id = existing ? existing.id : (rules.length === 0 && seq === 0 ? LEGACY_RULE_ID : `r${seq + 1}`);
  const rule = finishRule(draft, id);
  const overlap = overlapErrors(rule, rules.filter((r) => r.id !== id), { parentOf, categoryNames });
  if (overlap.length) return refuse(overlap);

  const changes = [];
  if (!existing) changes.push({ field: 'rule', from: null, to: 'added' });
  for (const field of RULE_FIELDS) {
    if (!sameList(before[field], rule[field])) changes.push({ field, from: before[field], to: rule[field] });
  }
  if (rule.mode !== 'off' && (before.mode === 'off' || !before.enabledSince)) rule.enabledSince = at;
  else if (rule.mode === 'off') rule.enabledSince = null;
  else rule.enabledSince = before.enabledSince;
  rule.updatedAt = at;
  rule.updatedBy = by || null;

  const nextRules = existing ? rules.map((r) => (r.id === id ? rule : r)) : [...rules, rule];
  const next = {
    ...current,
    v: SETTINGS_VERSION,
    seq: Math.max(seq, ruleNumber(id)),
    rules: nextRules,
    updatedAt: at,
    updatedBy: by || null,
    history: changes.length
      ? trimHistory([{ at, by: by || null, ruleId: id, rule: label(rule), changes }, ...(current?.history || [])])
      : (current?.history || []),
    persisted: true,
  };
  return { next, changes, errors: [], ruleId: id };
}

/** What is written to the settings store (no derived fields). Always v2. */
export function toStored(settings) {
  return {
    v: SETTINGS_VERSION,
    seq: Number(settings?.seq) || 0,
    rules: (settings?.rules || []).map((r) => ({
      id: r.id,
      name: r.name || '',
      mode: r.mode,
      period: r.period,
      categoryIds: r.categoryIds || [],
      members: r.members || [],
      groups: r.groups || [],
      rest: { evenly: r.rest?.evenly === true, techIds: r.rest?.techIds || [] },
      enabledSince: r.enabledSince || null,
      updatedAt: r.updatedAt || null,
      updatedBy: r.updatedBy || null,
    })),
    updatedAt: settings?.updatedAt || null,
    updatedBy: settings?.updatedBy || null,
    history: trimHistory(settings?.history),
  };
}

/** Does the rule cover a ticket with this category / subcategory? A top category covers all its subcategories. */
export function categoryMatches(categoryIds, { categoryId = null, subcategoryId = null } = {}) {
  const set = new Set((categoryIds || []).map(Number));
  if (!set.size) return false;
  return (positiveInt(Number(categoryId)) && set.has(Number(categoryId)))
    || (positiveInt(Number(subcategoryId)) && set.has(Number(subcategoryId)));
}

/** The rule that acts on a ticket: the one switched on whose categories cover it (categories never overlap). */
export function ruleFor(settings, ticket = {}) {
  return (settings?.rules || []).find((r) => ruleReady(r) && categoryMatches(r.categoryIds, ticket)) || null;
}

// ---- periods ----------------------------------------------------------------

/**
 * The counting period `now` falls in, in the workspace's time zone. A week
 * starts Monday 00:00, a month on the 1st at 00:00.
 * @returns {{ key: string, start: Date, startDate: string }}
 */
export function periodOf(now, period = 'week', timeZone = 'America/Vancouver') {
  const tz = safeZone(timeZone);
  const [dateStr, isoDay] = formatInTimeZone(now, tz, 'yyyy-MM-dd i').split(' ');
  let startDate;
  let key;
  if (period === 'month') {
    startDate = `${dateStr.slice(0, 7)}-01`;
    key = dateStr.slice(0, 7);
  } else {
    startDate = addDaysStr(dateStr, -(Number(isoDay) - 1));
    key = `week of ${startDate}`;
  }
  return { key, start: fromZonedTime(`${startDate}T00:00:00`, tz), startDate };
}

// ---- who is out --------------------------------------------------------------

function leaveWindow(leave) {
  const start = Number.isInteger(leave.startMinute) ? leave.startMinute : null;
  const end = Number.isInteger(leave.endMinute) ? leave.endMinute : null;
  if (start !== null && end !== null && end > start) return { start, end };
  if (leave.halfDayPart === 'AM') return { start: 0, end: 720 };
  if (leave.halfDayPart === 'PM') return { start: 720, end: 1440 };
  return { start: 0, end: 1440 };
}

/**
 * Is a person on approved leave at an instant? WFH, IGNORED and site visits
 * (work at another site) are not leave. A part-day leave counts only during
 * its hours (workspace time).
 */
export function onLeaveAt(leaves, at, timeZone = 'America/Vancouver') {
  const tz = safeZone(timeZone);
  const [dateStr, hh, mm] = formatInTimeZone(at, tz, 'yyyy-MM-dd HH mm').split(' ');
  const minutes = Number(hh) * 60 + Number(mm);
  return (leaves || []).some((l) => {
    if (!l || !isAwayLeave(l)) return false;
    if (l.status && String(l.status).toUpperCase() !== 'APPROVED') return false;
    if (toDateStr(l.date ?? l.leaveDate) !== dateStr) return false;
    if (l.isFullDay !== false) return true;
    const w = leaveWindow(l);
    return minutes >= w.start && minutes < w.end;
  });
}

// ---- working hours -----------------------------------------------------------

const DEFAULT_START = 9 * 60;
const DEFAULT_END = 17 * 60;

function minutesOf(hhmm, fallback) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes < 24 * 60 ? minutes : fallback;
}

/**
 * Is this person inside their working day at an instant? Their own time
 * zone and hours (09:00–17:00 when not set, the same default the assignment
 * AI uses), Monday to Friday. An end before the start is an overnight shift.
 */
export function workingAt(person = {}, at = new Date(), fallbackZone = 'America/Vancouver') {
  const tz = safeZone(person?.timezone || fallbackZone);
  const [isoDay, hh, mm] = formatInTimeZone(at, tz, 'i HH mm').split(' ');
  if (Number(isoDay) >= 6) return false;
  const now = Number(hh) * 60 + Number(mm);
  const start = minutesOf(person?.workStartTime, DEFAULT_START);
  const end = minutesOf(person?.workEndTime, DEFAULT_END);
  if (end <= start) return now >= start || now < end;
  return now >= start && now < end;
}

// ---- days away, for the report (QA 11-06 #4) ------------------------------------

/** Past share of working days at or above which a person's absence is flagged. */
export const AWAY_HEAVY_SHARE = 0.25;
export const AWAY_AHEAD_DAYS = 14;

/**
 * The calendar dates of the report window and of the days coming up, in the
 * workspace's zone: the last `pastDays` dates ending today, and the
 * `aheadDays` dates after today.
 * @returns {{ today:string, past:string[], ahead:string[] }}
 */
export function awayWindows(now, timeZone = 'America/Vancouver', { pastDays = 14, aheadDays = AWAY_AHEAD_DAYS } = {}) {
  const today = formatInTimeZone(now, safeZone(timeZone), 'yyyy-MM-dd');
  const past = [];
  for (let i = pastDays - 1; i >= 0; i -= 1) past.push(addDaysStr(today, -i));
  const ahead = [];
  for (let i = 1; i <= aheadDays; i += 1) ahead.push(addDaysStr(today, i));
  return { today, past, ahead };
}

/**
 * The days a person is away on some dates: the leave the rule itself treats
 * as out (approved; WFH and IGNORED are not away), the same rows as "Out now".
 * A part-day leave counts as half a day; several rows on one date count once.
 * @param {Array} leaves  rows with leaveDate|date, category, status, isFullDay
 * @param {string[]} dates  'yyyy-MM-dd' — pass working days only
 * @returns {{ days:number, dates: Array<{date:string, half:boolean}> }}
 */
export function awayDays(leaves, dates) {
  const span = new Set(dates || []);
  const weight = new Map();
  for (const l of leaves || []) {
    if (!l || !isAwayLeave(l)) continue;
    if (l.status && String(l.status).toUpperCase() !== 'APPROVED') continue;
    const date = toDateStr(l.date ?? l.leaveDate);
    if (!date || !span.has(date)) continue;
    weight.set(date, Math.max(weight.get(date) || 0, l.isFullDay === false ? 0.5 : 1));
  }
  const list = [...weight].sort(([a], [b]) => a.localeCompare(b)).map(([date, w]) => ({ date, half: w < 1 }));
  return { days: list.reduce((sum, d) => sum + (d.half ? 0.5 : 1), 0), dates: list };
}

/**
 * Days away per report row, in the window and coming up, plus the counts the
 * sentence under the table needs. Working days only (the caller filters).
 * @param {object} p
 * @param {Array<{techId, pct, gotPct}>} p.rows  summarizeReport() rows
 * @param {Map<number, Array>} p.leavesByTech
 * @param {string[]} p.pastDates   working days in the report window
 * @param {string[]} p.aheadDates  working days coming up
 * @returns {{ rows: Array, belowShareWithAway:number, awaySoon:number }}
 */
export function summarizeAway({ rows = [], leavesByTech = new Map(), pastDates = [], aheadDates = [] } = {}) {
  const heavy = (days, of) => of > 0 && days / of >= AWAY_HEAVY_SHARE;
  let belowShareWithAway = 0;
  let awaySoon = 0;
  const out = rows.map((r) => {
    const leaves = leavesByTech.get(Number(r.techId)) || [];
    const past = awayDays(leaves, pastDates);
    const ahead = awayDays(leaves, aheadDates);
    if (past.days > 0 && r.gotPct !== null && r.gotPct !== undefined && r.gotPct < r.pct) belowShareWithAway += 1;
    if (ahead.days > 0) awaySoon += 1;
    return {
      ...r,
      away: {
        past: { ...past, heavy: heavy(past.days, pastDates.length) },
        ahead: { ...ahead, from: ahead.dates[0]?.date || null, heavy: heavy(ahead.days, aheadDates.length) },
      },
    };
  });
  return { rows: out, belowShareWithAway, awaySoon };
}

// ---- who takes a rule's tickets: slots -------------------------------------------

const round1 = (n) => Math.round(n * 10) / 10;
const KIND_RANK = { person: 0, group: 1, rest: 2 };
/** Largest share first, then people before groups before the rest, then the lower id. */
const slotOrder = (a, b) => b.pct - a.pct || (KIND_RANK[a.kind] ?? 0) - (KIND_RANK[b.kind] ?? 0) || a.id - b.id;

/** A people-only list as slots: one per person (the v1 arithmetic). */
export const slotsFromMembers = (members) => asList(members).map((m) => ({
  key: `p${m.techId}`, kind: 'person', id: m.techId, pct: m.pct, techIds: [m.techId],
}));

/**
 * A rule → the slots its credit is split over and the people who can take
 * its tickets.
 *
 * @param {object} rule
 * @param {object} ctx
 * @param {Map<number, {name, techIds}>} ctx.groups  the rule's groups with their CURRENT members
 * @param {Set<number>|null} ctx.activeIds  people who can take tickets; group and rest members outside it are left out
 *   (a person named on their own stays, and is "not active" for the pick, as always)
 * @param {Map<number,string>} ctx.names
 * @returns {{ slots, people: Array<{techId, pct, slotKey, group?}>, empty: Array<{kind, id, name, pct}>, warnings: string[] }}
 *   `pct` on a person is their part, to one decimal (a group's 50% across 3 = 16.7).
 */
export function expandRule(rule, { groups = new Map(), activeIds = null, names = new Map() } = {}) {
  const slots = [];
  const people = [];
  const empty = [];
  const warnings = [];
  const taken = new Map();
  const nameOf = (id) => names.get(Number(id)) || `Technician ${id}`;
  const usable = (id) => !activeIds || activeIds.has(id);

  for (const m of asList(rule?.members)) {
    if (taken.has(m.techId)) continue;
    const key = `p${m.techId}`;
    slots.push({ key, kind: 'person', id: m.techId, pct: m.pct, techIds: [m.techId] });
    people.push({ techId: m.techId, pct: m.pct, slotKey: key });
    taken.set(m.techId, 'named on their own');
  }

  const takeSlot = (kind, id, name, pct, ids) => {
    const fresh = [];
    for (const techId of [...new Set(ids)].sort((a, b) => a - b)) {
      if (!positiveInt(techId) || !usable(techId)) continue;
      if (taken.has(techId)) {
        warnings.push(`${nameOf(techId)} is ${kind === 'rest' ? 'in the rest' : `in ${name}`} and also ${taken.get(techId)}, so is counted once, ${taken.get(techId)}.`);
        continue;
      }
      fresh.push(techId);
    }
    if (!fresh.length) return false;
    const key = kind === 'rest' ? 'rest' : `g${id}`;
    slots.push({ key, kind, id, name, pct, techIds: fresh });
    const part = round1(pct / fresh.length);
    for (const techId of fresh) {
      people.push({ techId, pct: part, slotKey: key, ...(kind === 'group' ? { group: name } : { rest: true }) });
      taken.set(techId, kind === 'rest' ? 'in the rest' : `in ${name}`);
    }
    return true;
  };

  for (const g of asList(rule?.groups)) {
    const info = groups.get(g.groupId) || null;
    const name = info?.name || `Group ${g.groupId}`;
    if (!takeSlot('group', g.groupId, name, g.pct, asList(info?.techIds).map(Number))) {
      empty.push({ kind: 'group', id: g.groupId, name, pct: g.pct });
      warnings.push(info
        ? `${name} has nobody who can take tickets right now, so its ${g.pct}% goes to the others until someone joins.`
        : `${name} is not an active internal group any more, so its ${g.pct}% goes to the others.`);
    }
  }

  if (restOn(rule)) {
    const pct = restPct(rule);
    if (pct > 0 && !takeSlot('rest', 0, 'The rest', pct, asList(rule.rest.techIds).map(Number))) {
      empty.push({ kind: 'rest', id: 0, name: 'The rest', pct });
      warnings.push(`Nobody in the rest can take tickets right now, so its ${pct}% goes to the others.`);
    }
  }
  return { slots, people, empty, warnings };
}

// ---- the ledger --------------------------------------------------------------

/**
 * One ticket's credit, in whole units. First split across the slots with
 * someone in, by percent (the rounding remainder to the largest share, then
 * people before groups, then the lower id), then a slot's part evenly across
 * its people who are in. Deterministic.
 *
 * Inside a group or the rest, every member gets exactly the same whole number
 * of units and the few left over (fewer than the members) are dropped, not
 * handed to the lowest id: otherwise the lowest id would always be a unit
 * ahead, exact ties would never happen, and "least recently assigned" could
 * never decide between members (review of QA 11-26). The cost is under
 * n/10,000 of a ticket per ticket. A one-person slot (every rule stored before
 * QA 11-26) has no remainder, so its arithmetic is exactly what it was: the
 * units add up to one ticket.
 * @param {Array} slots  expandRule().slots (or slotsFromMembers)
 * @param {(techId:number) => boolean} isIn  who is in for this ticket
 * @returns {Map<number, number>} techId → units
 */
export function creditSplit(slots, isIn = () => true) {
  const live = [];
  for (const s of slots || []) {
    if (!s || !(s.pct > 0)) continue;
    const ids = asList(s.techIds).filter((id) => isIn(id));
    if (ids.length) live.push({ ...s, ids });
  }
  const out = new Map();
  if (!live.length) return out;
  const sum = live.reduce((t, s) => t + s.pct, 0);
  const units = new Map();
  let given = 0;
  for (const s of live) {
    const u = Math.floor((UNIT * s.pct) / sum);
    units.set(s.key, u);
    given += u;
  }
  const first = [...live].sort(slotOrder)[0];
  units.set(first.key, units.get(first.key) + (UNIT - given));
  for (const s of live) {
    const each = Math.floor(units.get(s.key) / s.ids.length);
    for (const id of s.ids) out.set(id, (out.get(id) || 0) + each);
  }
  return out;
}

/**
 * v1 helper, kept: one ticket's credit over a people-only list.
 * @returns {Map<number, number>} techId → units
 */
export function splitCredit(eligible) {
  return creditSplit(slotsFromMembers(asList(eligible).filter((m) => m && m.pct > 0)));
}

const peopleOf = (members, slots) => (members?.length
  ? members
  : (slots || []).flatMap((s) => s.techIds.map((techId) => ({ techId, pct: s.pct / s.techIds.length }))));

/**
 * Earned and held, per person, over the counted tickets of the period.
 *
 * @param {object} p
 * @param {Array<{techId, pct}>} p.members  the people (expandRule().people)
 * @param {Array} [p.slots]  expandRule().slots; omitted = one slot per person
 * @param {Array<{holderId:number, at:Date|string}>} p.tickets  counted tickets (held by someone on the rule)
 * @param {Map<number, Array>} p.leavesByTech
 * @param {string} p.timeZone
 * @returns {Map<number, {earned:number, count:number}>}
 */
export function buildLedger({ members = [], slots = null, tickets = [], leavesByTech = new Map(), timeZone } = {}) {
  const list = peopleOf(members, slots);
  const split = slots || slotsFromMembers(list);
  const ledger = new Map(list.map((m) => [m.techId, { earned: 0, count: 0 }]));
  for (const t of tickets) {
    const at = new Date(t.at);
    const isIn = (id) => {
      const leaves = leavesByTech.get(id);
      return !leaves?.length || !onLeaveAt(leaves, at, timeZone);
    };
    for (const [techId, units] of creditSplit(split, isIn)) {
      if (!ledger.has(techId)) ledger.set(techId, { earned: 0, count: 0 });
      ledger.get(techId).earned += units;
    }
    const holder = ledger.get(Number(t.holderId));
    if (holder) holder.count += 1;
  }
  return ledger;
}

/**
 * The pick for the next ticket.
 *
 * @param {object} p
 * @param {Array<{techId, pct, name?, group?}>} p.members  the people (expandRule().people)
 * @param {Array} [p.slots]  expandRule().slots; omitted = one slot per person
 * @param {Map} p.ledger           buildLedger()
 * @param {Map<number,string>} p.out  techId → why they cannot take it now (on leave, not active, handed it back)
 * @param {Map<number,string>} p.notWorking  techId → outside their working hours now: they earn, but do not take it
 * @param {Map<number, number>} p.lastAssignedAt  techId → ms of their latest assignment in the workspace (missing = never)
 * @returns {{ techId:number|null, scores: Array<{techId, pct, score, earnedNext, count, out:string|null}> }}
 */
export function pickNext({ members = [], slots = null, ledger = new Map(), out = new Map(), notWorking = new Map(), lastAssignedAt = new Map() } = {}) {
  const list = peopleOf(members, slots);
  const credit = creditSplit(slots || slotsFromMembers(list), (id) => !out.has(id));
  const scores = list.map((m) => {
    const row = ledger.get(m.techId) || { earned: 0, count: 0 };
    const add = credit.get(m.techId) || 0;
    return {
      techId: m.techId,
      pct: m.pct,
      ...(m.group ? { group: m.group } : {}),
      ...(m.rest ? { rest: true } : {}),
      count: row.count,
      earnedNext: row.earned + add,
      score: row.earned + add - UNIT * row.count,
      out: out.get(m.techId) || null,
      notWorking: out.has(m.techId) ? null : (notWorking.get(m.techId) || null),
    };
  });
  const available = scores.filter((s) => !s.out);
  // People outside their hours wait while someone on the list is working.
  const working = available.filter((s) => !s.notWorking);
  const candidates = working.length ? working : available;
  if (!candidates.length) return { techId: null, scores };
  const last = (id) => (lastAssignedAt.has(id) ? lastAssignedAt.get(id) : -Infinity);
  candidates.sort((a, b) => b.score - a.score
    || b.pct - a.pct
    || last(a.techId) - last(b.techId)
    || a.techId - b.techId);
  return { techId: candidates[0].techId, scores };
}

/**
 * "The next N tickets would go to …": N picks in a row from the state now,
 * each one counted before the next (the same people out throughout).
 * @returns {number[]} techIds (shorter when nobody is in)
 */
export function previewSequence({ members = [], slots = null, ledger = new Map(), out = new Map(), notWorking = new Map(), lastAssignedAt = new Map(), count = 10, now = new Date() } = {}) {
  const list = peopleOf(members, slots);
  const split = slots || slotsFromMembers(list);
  const work = new Map([...ledger].map(([id, row]) => [id, { ...row }]));
  for (const m of list) if (!work.has(m.techId)) work.set(m.techId, { earned: 0, count: 0 });
  const last = new Map(lastAssignedAt);
  const picks = [];
  const credit = creditSplit(split, (id) => !out.has(id));
  for (let i = 0; i < count; i += 1) {
    const { techId } = pickNext({ members: list, slots: split, ledger: work, out, notWorking, lastAssignedAt: last });
    if (!techId) break;
    picks.push(techId);
    for (const [id, units] of credit) {
      if (!work.has(id)) work.set(id, { earned: 0, count: 0 });
      work.get(id).earned += units;
    }
    work.get(techId).count += 1;
    last.set(techId, new Date(now).getTime() + i + 1);
  }
  return picks;
}

const oneDecimal = (units) => Math.round((units / UNIT) * 10) / 10;
const nameOf = (names, id) => names.get(Number(id)) || `Technician ${id}`;
const periodWord = (period) => (period === 'month' ? 'this month' : 'this week');

/**
 * The whole decision for one ticket, with the sentences people read.
 * The sentences never list everyone's counts (agents can see suggestions);
 * the counts ride in the record, which only reviewers see.
 *
 * `rule` (or the v1 `settings`) gives the period; `members` / `slots` come
 * from expandRule() (omitted = the rule's own people, one slot each).
 */
export function decide({
  settings = null, rule = null, members = null, slots = null, ledger, out = new Map(), notWorking = new Map(),
  lastAssignedAt = new Map(), names = new Map(), aiPick = null,
} = {}) {
  const source = rule || settings;
  const list = members || source?.members || [];
  const { techId, scores } = pickNext({ members: list, slots, ledger, out, notWorking, lastAssignedAt });
  const people = scores.map((s) => ({
    techId: s.techId,
    name: nameOf(names, s.techId),
    pct: s.pct,
    ...(s.group ? { group: s.group } : {}),
    ...(s.rest ? { rest: true } : {}),
    count: s.count,
    target: oneDecimal(s.earnedNext),
    out: s.out,
    ...(s.notWorking ? { notWorking: s.notWorking } : {}),
  }));
  const aiId = Number(aiPick?.techId) || null;
  const when = periodWord(source?.period);
  if (!techId) {
    return {
      techId: null,
      people,
      agreesWithAi: false,
      sentence: 'Nobody on the share list is in, so the AI’s pick stands.',
      reason: null,
    };
  }
  const mine = people.find((p) => p.techId === techId);
  const whose = mine.group ? `their part of the ${mine.group} share` : (mine.rest ? 'their part of the evenly split rest' : 'their share');
  const reason = `furthest below ${whose} ${when} (${mine.count} against about ${mine.target})`;
  return {
    techId,
    people,
    agreesWithAi: aiId === techId,
    reason,
    sentence: `${mine.name} is ${reason}.`,
  };
}

/** The small record kept on the run (`recommendation.share`) — what the Shares tab reads. */
export function recordFor(result, { settings = null, rule = null, mode, applied = false, period = null, aiPick = null, now = new Date() } = {}) {
  const source = rule || settings;
  return {
    v: RECORD_VERSION,
    at: new Date(now).toISOString(),
    mode,
    applied: applied === true,
    ...(rule?.id ? { ruleId: rule.id } : {}),
    period: period ? { kind: source?.period || 'week', key: period.key, start: period.start.toISOString() } : null,
    pick: result?.techId ? { techId: result.techId, name: (result.people || []).find((p) => p.techId === result.techId)?.name || null } : null,
    aiPick: aiPick?.techId ? { techId: Number(aiPick.techId), name: aiPick.techName || aiPick.name || null } : null,
    agreesWithAi: result?.agreesWithAi === true,
    people: (result?.people || []).slice(0, 30),
    why: result?.sentence || null,
  };
}

/**
 * Live in a suggest-only workspace: the rule's pick becomes rank 1 and the
 * AI's own list follows (its first choice second). The rule's person keeps
 * the AI's notes on them, if the AI listed them.
 */
export function promoteSuggestion(recommendations, { techId, techName, reason, aiPick }) {
  const list = Array.isArray(recommendations) ? recommendations : [];
  const id = Number(techId);
  const theirs = list.find((r) => Number(r?.techId) === id) || null;
  const rest = list.filter((r) => Number(r?.techId) !== id);
  const aiName = aiPick?.techName || aiPick?.name || null;
  const note = `Share rule: ${reason}.${aiName && Number(aiPick?.techId) !== id ? ` The AI’s own first choice was ${aiName}.` : ''}`;
  const first = {
    ...(theirs || {}),
    rank: 1,
    techId: id,
    techName: techName || theirs?.techName || `Technician ${id}`,
    score: Number.isFinite(Number(theirs?.score)) ? Number(theirs.score) : (Number(list[0]?.score) || 0),
    reasoning: theirs?.reasoning ? `${note} ${theirs.reasoning}` : note,
    source: 'share_rule',
  };
  return [first, ...rest.map((r, i) => ({ ...r, rank: i + 2 }))];
}

// ---- the Shadow report ---------------------------------------------------------

/**
 * Per person: their share, the tickets they actually got in the window, and
 * how often the rule's pick matched who really got the ticket. Ordered by
 * share, never by count (no leaderboards).
 *
 * @param {object} p
 * @param {Array<{techId, pct, slotKey?, group?}>} p.members  the people (expandRule().people)
 * @param {Array<{id, holderId:number|null}>} p.tickets  tickets in the rule's categories created in the window
 * @param {Array<{ticketId, share:object, holderId:number|null, aiTechId?:number|null}>} p.runs  latest run with a share record per ticket
 * @param {Map<number,string>} p.names
 */
export function summarizeReport({ members = [], tickets = [], runs = [], names = new Map() } = {}) {
  const memberIds = new Set(members.map((m) => m.techId));
  const got = new Map(members.map((m) => [m.techId, 0]));
  let toMembers = 0;
  let outside = 0;
  let unassigned = 0;
  for (const t of tickets) {
    const holder = Number(t.holderId) || null;
    if (!holder) unassigned += 1;
    else if (memberIds.has(holder)) { toMembers += 1; got.set(holder, got.get(holder) + 1); }
    else outside += 1;
  }
  const picked = new Map(members.map((m) => [m.techId, { picked: 0, matched: 0 }]));
  let compared = 0;
  let agreed = 0;
  let aiCompared = 0;
  let aiAgreed = 0;
  let noPick = 0;
  for (const r of runs) {
    const holder = Number(r.holderId) || null;
    const pick = Number(r.share?.pick?.techId) || null;
    if (!pick) { noPick += 1; continue; }
    if (!holder) continue;
    compared += 1;
    if (pick === holder) agreed += 1;
    const row = picked.get(pick);
    if (row) { row.picked += 1; if (pick === holder) row.matched += 1; }
    const ai = Number(r.share?.aiPick?.techId ?? r.aiTechId) || null;
    if (ai) { aiCompared += 1; if (ai === holder) aiAgreed += 1; }
  }
  const rows = [...members]
    .sort((a, b) => b.pct - a.pct || nameOf(names, a.techId).localeCompare(nameOf(names, b.techId)))
    .map((m) => ({
      techId: m.techId,
      name: nameOf(names, m.techId),
      pct: m.pct,
      ...(m.slotKey ? { slotKey: m.slotKey } : {}),
      ...(m.group ? { group: m.group } : {}),
      ...(m.inactive ? { inactive: true } : {}),
      got: got.get(m.techId),
      gotPct: toMembers ? Math.round((got.get(m.techId) / toMembers) * 100) : null,
      rulePicked: picked.get(m.techId).picked,
      ruleMatched: picked.get(m.techId).matched,
    }));
  return {
    rows,
    totals: { tickets: tickets.length, toMembers, outside, unassigned, runs: runs.length, compared, agreed, aiCompared, aiAgreed, noPick },
  };
}

/**
 * The report or preview rows arranged the way the page shows them (QA 11-26
 * #4): each group as one subtotal row (its share against what it got) with
 * its members underneath, then the people named on their own, then the
 * evenly split rest. Inside a group or the rest, people are by name; people
 * on their own keep the rows' order (by share). Never by count.
 *
 * @param {object} expanded  expandRule()
 * @param {Array<{techId, slotKey?}>} rows  per-person rows (summarizeReport() or preview counts)
 * @param {object} opts
 * @param {string[]} opts.sum   numeric fields to add up for a subtotal ('got', 'count', 'target', …)
 * @param {number|null} opts.toMembers  when set, a subtotal gets gotPct from its 'got'
 * @returns {Array<{kind:'group'|'people'|'rest', id?, name?, pct?, empty?, rows}>}
 */
export function sectionsFor(expanded, rows = [], { sum = [], toMembers = null } = {}) {
  const bySlot = new Map();
  for (const r of rows) {
    const key = r.slotKey || `p${r.techId}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(r);
  }
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
  const subtotal = (list) => {
    const out = {};
    for (const f of sum) out[f] = round1(list.reduce((t, r) => t + (Number(r[f]) || 0), 0));
    if (toMembers !== null && sum.includes('got')) out.gotPct = toMembers ? Math.round((out.got / toMembers) * 100) : null;
    return out;
  };
  const slots = expanded?.slots || [];
  const groupSlots = [
    ...slots.filter((s) => s.kind === 'group').map((s) => ({ kind: 'group', id: s.id, name: s.name, pct: s.pct, key: s.key })),
    ...(expanded?.empty || []).filter((e) => e.kind === 'group').map((e) => ({ ...e, key: `g${e.id}`, empty: true })),
  ].sort((a, b) => b.pct - a.pct || String(a.name).localeCompare(String(b.name)));
  const sections = [];
  for (const g of groupSlots) {
    const list = [...(bySlot.get(g.key) || [])].sort(byName);
    sections.push({ kind: 'group', id: g.id, name: g.name, pct: g.pct, ...(g.empty ? { empty: true } : {}), ...subtotal(list), rows: list });
  }
  const own = rows.filter((r) => (r.slotKey || `p${r.techId}`).startsWith('p'));
  if (own.length) sections.push({ kind: 'people', rows: own });
  const restSlot = slots.find((s) => s.kind === 'rest') || (expanded?.empty || []).find((e) => e.kind === 'rest') || null;
  if (restSlot) {
    const list = [...(bySlot.get('rest') || [])].sort(byName);
    sections.push({ kind: 'rest', name: 'The rest, split evenly', pct: restSlot.pct, ...(list.length ? {} : { empty: true }), ...subtotal(list), rows: list });
  }
  return sections;
}

export default {
  UNIT, MODES, PERIODS, SETTING_FIELDS, RULE_FIELDS, LEGACY_RULE_ID,
  defaultSettings, defaultRule, normalizeSettings, normalizeRule, validateDraft, validateRule, overlapErrors, applyPatch, toStored,
  totalPct, explicitPct, restOn, restPct, hasShares, ruleReady, ruleLabel, ruleFor, categoryMatches,
  periodOf, onLeaveAt, workingAt, awayWindows, awayDays, summarizeAway,
  slotsFromMembers, expandRule, creditSplit, splitCredit, buildLedger, pickNext, previewSequence, decide, recordFor, promoteSuggestion,
  summarizeReport, sectionsFor,
};
