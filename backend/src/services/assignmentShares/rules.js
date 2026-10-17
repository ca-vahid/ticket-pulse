import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { addDaysStr, safeZone, toDateStr } from '../urgentResponse/rules.js';

/**
 * Ticket shares — the rules (QA 10-16 item 4, proof of concept).
 *
 * A workspace admin gives people a whole-percent share of the tickets in some
 * categories. When a ticket in those categories arrives, the rule picks
 * whoever is furthest below their share this period. Best effort, close to the
 * percentages, never exact.
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
 * Whole numbers only: 10,000 units = one ticket, so ties are exact (floating
 * point changes tie results, plan S1b).
 *
 * Pure: no database, no clock of its own (callers pass `now`).
 */

export const SETTINGS_VERSION = 1;
export const UNIT = 10000;
export const HISTORY_LIMIT = 30;
export const MAX_MEMBERS = 30;
export const MAX_CATEGORIES = 60;
export const MODES = Object.freeze(['off', 'shadow', 'live']);
export const PERIODS = Object.freeze(['week', 'month']);
export const SETTING_FIELDS = Object.freeze(['mode', 'period', 'categoryIds', 'members']);

const positiveInt = (n) => Number.isInteger(n) && n > 0;

export function defaultSettings() {
  return { mode: 'off', period: 'week', categoryIds: [], members: [] };
}

function cleanMembers(list) {
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const techId = Number(m?.techId);
    const pct = Number(m?.pct);
    if (!positiveInt(techId) || seen.has(techId) || !Number.isInteger(pct) || pct < 1 || pct > 100) continue;
    seen.add(techId);
    out.push({ techId, pct });
  }
  return out.slice(0, MAX_MEMBERS);
}

function cleanCategoryIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(Number).filter(positiveInt))].slice(0, MAX_CATEGORIES);
}

/** Whatever was stored (a JSON string, an object, nothing, rubbish) → a complete settings object. */
export function normalizeSettings(raw) {
  const base = defaultSettings();
  let stored = raw;
  if (typeof raw === 'string') {
    try { stored = JSON.parse(raw); } catch { stored = null; }
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  return {
    mode: MODES.includes(stored.mode) ? stored.mode : base.mode,
    period: PERIODS.includes(stored.period) ? stored.period : base.period,
    categoryIds: cleanCategoryIds(stored.categoryIds),
    members: cleanMembers(stored.members),
    persisted: Object.keys(stored).length > 0,
    enabledSince: typeof stored.enabledSince === 'string' ? stored.enabledSince : null,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    history: Array.isArray(stored.history) ? stored.history.slice(0, HISTORY_LIMIT) : [],
  };
}

export const totalPct = (members) => (members || []).reduce((sum, m) => sum + (Number(m.pct) || 0), 0);

/**
 * Checks a full draft (mode, period, categoryIds, members). Every problem is a
 * plain sentence the admin sees. `validTechIds` / `validCategoryIds` (Sets)
 * are the workspace's own people and categories; omitted = not checked.
 */
export function validateDraft(draft, { validTechIds = null, validCategoryIds = null } = {}) {
  const errors = [];
  if (!MODES.includes(draft.mode)) errors.push('Mode must be Off, Shadow or Live');
  if (!PERIODS.includes(draft.period)) errors.push('Count tickets per week or per month');
  const rawMembers = Array.isArray(draft.members) ? draft.members : [];
  const ids = new Set();
  for (const m of rawMembers) {
    const techId = Number(m?.techId);
    const pct = Number(m?.pct);
    if (!positiveInt(techId)) { errors.push('Every share needs a person'); continue; }
    if (ids.has(techId)) errors.push('A person is on the list twice');
    ids.add(techId);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) errors.push('Each share must be a whole percent from 1 to 100');
    if (validTechIds && !validTechIds.has(techId)) errors.push('Someone on the list is not an active member of this workspace');
  }
  if (rawMembers.length > MAX_MEMBERS) errors.push(`No more than ${MAX_MEMBERS} people`);
  const total = totalPct(rawMembers);
  if (rawMembers.length && total !== 100) errors.push(`The shares must total 100% (now ${total}%)`);
  const cats = Array.isArray(draft.categoryIds) ? draft.categoryIds.map(Number) : [];
  if (cats.some((c) => !positiveInt(c))) errors.push('A category could not be read');
  if (validCategoryIds && cats.some((c) => positiveInt(c) && !validCategoryIds.has(c))) errors.push('A category is not one of this workspace’s categories');
  if (cats.length > MAX_CATEGORIES) errors.push(`No more than ${MAX_CATEGORIES} categories`);
  if (draft.mode !== 'off') {
    if (!rawMembers.length) errors.push('Add the people who share the tickets before switching it on');
    if (!cats.length) errors.push('Pick at least one category before switching it on');
  }
  return [...new Set(errors)];
}

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A save: only known fields, the whole draft checked, one history line.
 * @returns {{ next: object, changes: Array<{field, from, to}>, errors: string[] }}
 */
export function applyPatch(current, patch = {}, { by = null, now = new Date(), validTechIds = null, validCategoryIds = null } = {}) {
  const draft = {
    mode: current.mode,
    period: current.period,
    categoryIds: current.categoryIds,
    members: current.members,
  };
  for (const field of SETTING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, field)) draft[field] = patch[field];
  }
  const errors = validateDraft(draft, { validTechIds, validCategoryIds });
  if (errors.length) return { next: current, changes: [], errors };
  const next = {
    ...current,
    mode: draft.mode,
    period: draft.period,
    categoryIds: cleanCategoryIds(draft.categoryIds),
    members: cleanMembers(draft.members).sort((a, b) => b.pct - a.pct || a.techId - b.techId),
  };
  const changes = [];
  for (const field of SETTING_FIELDS) {
    if (!sameList(current[field], next[field])) changes.push({ field, from: current[field], to: next[field] });
  }
  const at = now.toISOString();
  if (next.mode !== 'off' && (current.mode === 'off' || !current.enabledSince)) next.enabledSince = at;
  if (next.mode === 'off') next.enabledSince = null;
  next.updatedAt = at;
  next.updatedBy = by || null;
  next.history = changes.length
    ? [{ at, by: by || null, changes }, ...(current.history || [])].slice(0, HISTORY_LIMIT)
    : (current.history || []);
  next.persisted = true;
  return { next, changes, errors: [] };
}

/** What is written to the settings store (no derived fields). */
export function toStored(settings) {
  return {
    v: SETTINGS_VERSION,
    mode: settings.mode,
    period: settings.period,
    categoryIds: settings.categoryIds || [],
    members: settings.members || [],
    enabledSince: settings.enabledSince || null,
    updatedAt: settings.updatedAt || null,
    updatedBy: settings.updatedBy || null,
    history: (settings.history || []).slice(0, HISTORY_LIMIT),
  };
}

/** Does the rule cover a ticket with this category / subcategory? A top category covers all its subcategories. */
export function categoryMatches(categoryIds, { categoryId = null, subcategoryId = null } = {}) {
  const set = new Set((categoryIds || []).map(Number));
  if (!set.size) return false;
  return (positiveInt(Number(categoryId)) && set.has(Number(categoryId)))
    || (positiveInt(Number(subcategoryId)) && set.has(Number(subcategoryId)));
}

// ---- periods ----------------------------------------------------------------

/**
 * The counting period `now` falls in, in the workspace's time zone. A week
 * starts Monday 00:00, a month on the 1st at 00:00.
 * @returns {{ key: string, start: Date, startDate: string }}
 */
export function periodOf(now, period = 'week', timeZone = 'America/Los_Angeles') {
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
 * Is a person on approved leave at an instant? WFH and IGNORED are not leave.
 * A part-day leave counts only during its hours (workspace time).
 */
export function onLeaveAt(leaves, at, timeZone = 'America/Los_Angeles') {
  const tz = safeZone(timeZone);
  const [dateStr, hh, mm] = formatInTimeZone(at, tz, 'yyyy-MM-dd HH mm').split(' ');
  const minutes = Number(hh) * 60 + Number(mm);
  return (leaves || []).some((l) => {
    if (!l || ['WFH', 'IGNORED'].includes(String(l.category || '').toUpperCase())) return false;
    if (l.status && String(l.status).toUpperCase() !== 'APPROVED') return false;
    if (toDateStr(l.date ?? l.leaveDate) !== dateStr) return false;
    if (l.isFullDay !== false) return true;
    const w = leaveWindow(l);
    return minutes >= w.start && minutes < w.end;
  });
}

// ---- the ledger --------------------------------------------------------------

/**
 * One ticket's credit, split over the people who were in: whole units that
 * add up to exactly one ticket. The rounding remainder goes to the largest
 * share (then the lower id), so the split is deterministic.
 * @returns {Map<number, number>} techId → units
 */
export function splitCredit(eligible) {
  const list = (eligible || []).filter((m) => m && m.pct > 0);
  const out = new Map();
  if (!list.length) return out;
  const sum = list.reduce((s, m) => s + m.pct, 0);
  let given = 0;
  for (const m of list) {
    const units = Math.floor((UNIT * m.pct) / sum);
    out.set(m.techId, units);
    given += units;
  }
  const first = [...list].sort((a, b) => b.pct - a.pct || a.techId - b.techId)[0];
  out.set(first.techId, out.get(first.techId) + (UNIT - given));
  return out;
}

/**
 * Earned and held, per person, over the counted tickets of the period.
 *
 * @param {object} p
 * @param {Array<{techId, pct}>} p.members
 * @param {Array<{holderId:number, at:Date|string}>} p.tickets  counted tickets (held by a member)
 * @param {Map<number, Array>} p.leavesByTech
 * @param {string} p.timeZone
 * @returns {Map<number, {earned:number, count:number}>}
 */
export function buildLedger({ members = [], tickets = [], leavesByTech = new Map(), timeZone } = {}) {
  const ledger = new Map(members.map((m) => [m.techId, { earned: 0, count: 0 }]));
  for (const t of tickets) {
    const at = new Date(t.at);
    const eligible = members.filter((m) => {
      const leaves = leavesByTech.get(m.techId);
      return !leaves?.length || !onLeaveAt(leaves, at, timeZone);
    });
    for (const [techId, units] of splitCredit(eligible)) ledger.get(techId).earned += units;
    const holder = ledger.get(Number(t.holderId));
    if (holder) holder.count += 1;
  }
  return ledger;
}

/**
 * The pick for the next ticket.
 *
 * @param {object} p
 * @param {Array<{techId, pct, name?}>} p.members
 * @param {Map} p.ledger           buildLedger()
 * @param {Map<number,string>} p.out  techId → why they cannot take it now (on leave, not active, handed it back)
 * @param {Map<number, number>} p.lastAssignedAt  techId → ms of their latest assignment in the workspace (missing = never)
 * @returns {{ techId:number|null, scores: Array<{techId, pct, score, earnedNext, count, out:string|null}> }}
 */
export function pickNext({ members = [], ledger = new Map(), out = new Map(), lastAssignedAt = new Map() } = {}) {
  const eligible = members.filter((m) => !out.has(m.techId));
  const credit = splitCredit(eligible);
  const scores = members.map((m) => {
    const row = ledger.get(m.techId) || { earned: 0, count: 0 };
    const add = credit.get(m.techId) || 0;
    return {
      techId: m.techId,
      pct: m.pct,
      count: row.count,
      earnedNext: row.earned + add,
      score: row.earned + add - UNIT * row.count,
      out: out.get(m.techId) || null,
    };
  });
  const candidates = scores.filter((s) => !s.out);
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
export function previewSequence({ members = [], ledger = new Map(), out = new Map(), lastAssignedAt = new Map(), count = 10, now = new Date() } = {}) {
  const work = new Map([...ledger].map(([id, row]) => [id, { ...row }]));
  for (const m of members) if (!work.has(m.techId)) work.set(m.techId, { earned: 0, count: 0 });
  const last = new Map(lastAssignedAt);
  const picks = [];
  const eligible = members.filter((m) => !out.has(m.techId));
  const credit = splitCredit(eligible);
  for (let i = 0; i < count; i += 1) {
    const { techId } = pickNext({ members, ledger: work, out, lastAssignedAt: last });
    if (!techId) break;
    picks.push(techId);
    for (const [id, units] of credit) work.get(id).earned += units;
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
 */
export function decide({ settings, ledger, out = new Map(), lastAssignedAt = new Map(), names = new Map(), aiPick = null } = {}) {
  const members = settings?.members || [];
  const { techId, scores } = pickNext({ members, ledger, out, lastAssignedAt });
  const people = scores.map((s) => ({
    techId: s.techId,
    name: nameOf(names, s.techId),
    pct: s.pct,
    count: s.count,
    target: oneDecimal(s.earnedNext),
    out: s.out,
  }));
  const aiId = Number(aiPick?.techId) || null;
  const when = periodWord(settings?.period);
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
  const reason = `furthest below their share ${when} (${mine.count} against about ${mine.target})`;
  return {
    techId,
    people,
    agreesWithAi: aiId === techId,
    reason,
    sentence: `${mine.name} is ${reason}.`,
  };
}

/** The small record kept on the run (`recommendation.share`) — what the Shares tab reads. */
export function recordFor(result, { settings, mode, applied = false, period = null, aiPick = null, now = new Date() } = {}) {
  return {
    v: SETTINGS_VERSION,
    at: new Date(now).toISOString(),
    mode,
    applied: applied === true,
    period: period ? { kind: settings?.period || 'week', key: period.key, start: period.start.toISOString() } : null,
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
 * @param {Array<{techId, pct}>} p.members
 * @param {Array<{id, holderId:number|null}>} p.tickets  tickets in the chosen categories created in the window
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

export default {
  UNIT, MODES, PERIODS, SETTING_FIELDS,
  defaultSettings, normalizeSettings, validateDraft, applyPatch, toStored, totalPct, categoryMatches,
  periodOf, onLeaveAt, splitCredit, buildLedger, pickNext, previewSequence, decide, recordFor, promoteSuggestion, summarizeReport,
};
