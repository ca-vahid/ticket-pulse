/**
 * Assignment spread — the rules (QA 10-13 item 17).
 *
 * The AI pipeline decides every ticket on its own, so when several arrive or
 * are released together one person with the best skill match gets three, five
 * or fifteen within minutes: no decision sees the ones just made.
 *
 * Four rules, all deterministic, all settings (never constants in the code):
 *   A. count what was just assigned  — tickets automation gave a person in the
 *      last N minutes count as load for the next decision, saved or not;
 *   B. a cap                          — no more than `capCount` automatic
 *      assignments to one person in `capWindowMinutes`; the next ticket goes to
 *      the next-best candidate of the same run. When nobody else qualified is
 *      at work the cap gives way and the run says so;
 *   D. a new hire's set stays together — Workstation + Laptop/Desktop of ONE
 *      new hire go to one person and count once. Nothing else is batched;
 *   F. the overnight queue is released a few at a time, most urgent and oldest
 *      first, one decision at a time.
 *
 * Pure: no database, no clock of its own (callers pass `now`).
 */

export const MINUTE_MS = 60 * 1000;
export const SETTINGS_VERSION = 1;
/** The workspace these rules start ON in (IT). Every other workspace starts off. */
export const DEFAULT_ON_WORKSPACES = Object.freeze([1]);
export const HISTORY_LIMIT = 30;

export const LIMITS = Object.freeze({
  capCount: { min: 1, max: 20 },
  capWindowMinutes: { min: 1, max: 120 },
  recentWindowMinutes: { min: 1, max: 120 },
  staggerCount: { min: 1, max: 10 },
  staggerMinutes: { min: 2, max: 60 },
});

export const SETTING_FIELDS = Object.freeze([
  'enabled', 'countRecent', 'recentWindowMinutes', 'capEnabled', 'capCount', 'capWindowMinutes',
  'keepNewHireSet', 'staggerEnabled', 'staggerCount', 'staggerMinutes',
]);

/** Onboarding children that make one "set" for a new hire. Nothing else is ever batched. */
export const NEW_HIRE_SET_KEYS = Object.freeze(['laptop', 'workstation', 'desktop', 'nh_laptop', 'nh_workstation', 'nh_desktop']);

export const RULES = Object.freeze({
  NONE: 'none',
  CAP: 'cap',
  CAP_GAVE_WAY: 'cap_gave_way',
  NEW_HIRE_SET: 'new_hire_set',
});

const toBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
function toInt(value, { min, max }, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function defaultSettings(workspaceId = null) {
  return {
    enabled: DEFAULT_ON_WORKSPACES.includes(Number(workspaceId)),
    countRecent: true,
    recentWindowMinutes: 10,
    capEnabled: true,
    capCount: 3,
    capWindowMinutes: 10,
    keepNewHireSet: true,
    staggerEnabled: true,
    staggerCount: 2,
    staggerMinutes: 2,
  };
}

/** Whatever was stored (a JSON string, an object, nothing, rubbish) → a complete, in-range settings object. */
export function normalizeSettings(raw, workspaceId = null) {
  const base = defaultSettings(workspaceId);
  let stored = raw;
  if (typeof raw === 'string') {
    try { stored = JSON.parse(raw); } catch { stored = null; }
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  return {
    enabled: toBool(stored.enabled, base.enabled),
    countRecent: toBool(stored.countRecent, base.countRecent),
    recentWindowMinutes: toInt(stored.recentWindowMinutes, LIMITS.recentWindowMinutes, base.recentWindowMinutes),
    capEnabled: toBool(stored.capEnabled, base.capEnabled),
    capCount: toInt(stored.capCount, LIMITS.capCount, base.capCount),
    capWindowMinutes: toInt(stored.capWindowMinutes, LIMITS.capWindowMinutes, base.capWindowMinutes),
    keepNewHireSet: toBool(stored.keepNewHireSet, base.keepNewHireSet),
    staggerEnabled: toBool(stored.staggerEnabled, base.staggerEnabled),
    staggerCount: toInt(stored.staggerCount, LIMITS.staggerCount, base.staggerCount),
    staggerMinutes: toInt(stored.staggerMinutes, LIMITS.staggerMinutes, base.staggerMinutes),
    persisted: Object.keys(stored).length > 0,
    enabledSince: typeof stored.enabledSince === 'string' ? stored.enabledSince : null,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    history: Array.isArray(stored.history) ? stored.history.slice(0, HISTORY_LIMIT) : [],
  };
}

/**
 * A save: only known fields, every number checked (a bad one is an error the
 * admin sees, not a silent clamp), and one history line saying what changed.
 * @returns {{ next: object, changes: Array<{field, from, to}>, errors: string[] }}
 */
export function applyPatch(current, patch = {}, { by = null, now = new Date() } = {}) {
  const errors = [];
  const next = { ...current };
  const changes = [];
  for (const field of SETTING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch || {}, field)) continue;
    const value = patch[field];
    if (LIMITS[field]) {
      const n = Number(value);
      const { min, max } = LIMITS[field];
      if (!Number.isInteger(n) || n < min || n > max) {
        errors.push(`${field} must be a whole number from ${min} to ${max}`);
        continue;
      }
      if (n !== current[field]) changes.push({ field, from: current[field], to: n });
      next[field] = n;
    } else {
      if (typeof value !== 'boolean') {
        errors.push(`${field} must be true or false`);
        continue;
      }
      if (value !== current[field]) changes.push({ field, from: current[field], to: value });
      next[field] = value;
    }
  }
  if (errors.length) return { next: current, changes: [], errors };
  const at = now.toISOString();
  if (next.enabled && (!current.enabled || !current.enabledSince)) next.enabledSince = at;
  if (!next.enabled) next.enabledSince = null;
  next.updatedAt = at;
  next.updatedBy = by || null;
  next.history = changes.length
    ? [{ at, by: by || null, changes }, ...(current.history || [])].slice(0, HISTORY_LIMIT)
    : (current.history || []);
  next.persisted = true;
  return { next, changes, errors };
}

/** What is written to the settings store (no derived fields). */
export function toStored(settings) {
  const out = { v: SETTINGS_VERSION };
  for (const field of SETTING_FIELDS) out[field] = settings[field];
  out.enabledSince = settings.enabledSince || null;
  out.updatedAt = settings.updatedAt || null;
  out.updatedBy = settings.updatedBy || null;
  out.history = (settings.history || []).slice(0, HISTORY_LIMIT);
  return out;
}

export const isNewHireSetKey = (templateKey) => NEW_HIRE_SET_KEYS.includes(String(templateKey || '').trim().toLowerCase());

/** One unit of work against the cap: a new hire's set is one, every other ticket is its own. */
export function unitKeyFor(ticketId, { familyId = null, keepNewHireSet = true } = {}) {
  return keepNewHireSet && familyId ? `set:${Number(familyId)}` : `ticket:${Number(ticketId)}`;
}

/**
 * How much each person was just given: distinct units inside the window.
 * @param {Array<{techId, at: Date|number|string, unitKey?: string, ticketId?: number, saved?: boolean}>} events
 * @returns {Map<number, { count: number, units: Set<string>, notSaved: number }>}
 */
export function recentByTech(events, { now = new Date(), windowMinutes = 10, excludeTicketId = null } = {}) {
  const nowMs = new Date(now).getTime();
  const from = nowMs - windowMinutes * MINUTE_MS;
  const out = new Map();
  for (const event of events || []) {
    const techId = Number(event?.techId);
    const at = new Date(event?.at).getTime();
    if (!Number.isInteger(techId) || techId <= 0 || !Number.isFinite(at)) continue;
    if (at < from || at > nowMs + MINUTE_MS) continue;
    if (excludeTicketId !== null && Number(event.ticketId) === Number(excludeTicketId)) continue;
    const key = event.unitKey || `ticket:${Number(event.ticketId)}`;
    if (!out.has(techId)) out.set(techId, { count: 0, units: new Set(), unsavedUnits: new Set(), notSaved: 0 });
    const row = out.get(techId);
    if (!row.units.has(key)) { row.units.add(key); row.count += 1; }
    if (event.saved === false && !row.unsavedUnits.has(key)) { row.unsavedUnits.add(key); row.notSaved += 1; }
  }
  return out;
}

const nameOf = (person) => person?.name || (person?.techId ? `Technician ${person.techId}` : 'the first choice');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The decision for one automatic assignment.
 *
 * @param {object} p
 * @param {object} p.settings        normalised settings
 * @param {{techId:number, name?:string}} p.pick  who the run wants to give it to
 * @param {string} p.unitKey         this ticket's unit
 * @param {Map} p.recent             recentByTech() over the cap window (this ticket excluded)
 * @param {Array<{techId, name?, eligible?: boolean, whyNot?: string}>} p.candidates
 *        the other people, best first: the run's own ranked list, then anybody
 *        else qualified. `eligible` false = cannot take it now (away, no seat, handed it back).
 * @param {{techId:number, name?:string}|null} p.setOwner  who already holds the other half of this new hire's set
 * @param {boolean} p.locked         another rule already chose this person (urgent response): count it, never move it
 * @returns {{ rule, techId, moved: boolean, sentence: string|null, from: object|null, to: object|null, recentCount: number, considered: Array }}
 */
export function decide({ settings, pick, unitKey, recent = new Map(), candidates = [], setOwner = null, locked = false } = {}) {
  const pickId = Number(pick?.techId) || null;
  const mine = recent.get(pickId) || { count: 0, units: new Set() };
  const keep = { rule: RULES.NONE, techId: pickId, moved: false, sentence: null, from: null, to: null, recentCount: mine.count, considered: [] };
  if (!settings?.enabled || !pickId) return keep;

  // D. The other half of this new hire's set already has an owner: same person, counted once.
  if (settings.keepNewHireSet && setOwner?.techId && !locked) {
    const ownerId = Number(setOwner.techId);
    if (ownerId === pickId) return keep;
    return {
      rule: RULES.NEW_HIRE_SET,
      techId: ownerId,
      moved: true,
      from: { techId: pickId, name: nameOf(pick) },
      to: { techId: ownerId, name: nameOf(setOwner) },
      recentCount: (recent.get(ownerId) || { count: 0 }).count,
      considered: [],
      sentence: `Kept with ${nameOf(setOwner)}, who has the other ticket of this new hire's set (the AI's first choice was ${nameOf(pick)}).`,
    };
  }

  if (!settings.capEnabled || locked) return keep;
  // Already counted (the second ticket of a set this person holds): no extra unit.
  if (mine.units?.has?.(unitKey)) return keep;
  if (mine.count < settings.capCount) return keep;

  const window = plural(settings.capWindowMinutes, 'minute');
  const considered = [];
  let chosen = null;
  for (const candidate of candidates) {
    const id = Number(candidate?.techId);
    if (!Number.isInteger(id) || id <= 0 || id === pickId) continue;
    if (considered.some((c) => c.techId === id)) continue;
    const theirs = recent.get(id) || { count: 0 };
    let whyNot = null;
    if (candidate.eligible === false) whyNot = candidate.whyNot || 'not available';
    else if (theirs.count >= settings.capCount) whyNot = 'also at the cap';
    considered.push({ techId: id, name: nameOf(candidate), whyNot, source: candidate.source || 'run' });
    if (!whyNot && !chosen) chosen = { techId: id, name: nameOf(candidate), source: candidate.source || 'run' };
  }

  if (!chosen) {
    return {
      ...keep,
      rule: RULES.CAP_GAVE_WAY,
      from: { techId: pickId, name: nameOf(pick) },
      to: { techId: pickId, name: nameOf(pick) },
      considered,
      sentence: `${nameOf(pick)} already got ${plural(mine.count, 'ticket')} from automation in the last ${window} (the cap is ${settings.capCount}), but nobody else qualified is at work, so the cap gave way.`,
    };
  }
  return {
    rule: RULES.CAP,
    techId: chosen.techId,
    moved: true,
    from: { techId: pickId, name: nameOf(pick) },
    to: { techId: chosen.techId, name: chosen.name },
    recentCount: mine.count,
    considered,
    sentence: `Given to ${chosen.name} instead of ${nameOf(pick)}: ${nameOf(pick)} already got ${plural(mine.count, 'ticket')} from automation in the last ${window} (the cap is ${settings.capCount}).`,
  };
}

/** The small record kept on the run (`recommendation.spread`) — what the results page reads. */
export function recordFor(result, { unitKey = null, settings = null, now = new Date() } = {}) {
  return {
    v: SETTINGS_VERSION,
    at: new Date(now).toISOString(),
    rule: result?.rule || RULES.NONE,
    unit: unitKey,
    recent: result?.recentCount ?? 0,
    cap: settings ? { count: settings.capCount, minutes: settings.capWindowMinutes } : null,
    from: result?.from || null,
    to: result?.to || null,
    why: result?.sentence || null,
    considered: (result?.considered || []).slice(0, 8),
  };
}

// ---- F. the release of the queue ------------------------------------------------

const priorityOf = (run) => {
  const p = Number(run?.ticket?.assessedPriorityId) || Number(run?.ticket?.priority) || 0;
  return [1, 2, 3, 4].includes(p) ? p : 0;
};
const queuedAtOf = (run) => new Date(run?.queuedAt || run?.createdAt || 0).getTime() || 0;

/** Most urgent first, then the one that has waited longest. */
export function orderForRelease(runs) {
  return [...(runs || [])].sort((a, b) => priorityOf(b) - priorityOf(a) || queuedAtOf(a) - queuedAtOf(b) || (a.id || 0) - (b.id || 0));
}

/**
 * How many queued runs this tick may release: `staggerCount` every
 * `staggerMinutes`, counting what was released inside the current interval.
 * A few seconds of slack so a worker that ticks every 2 minutes is not held a
 * whole extra tick by a timer that fired early.
 */
export function releaseAllowance(settings, releasedAt = [], now = new Date()) {
  const nowMs = new Date(now).getTime();
  const from = nowMs - settings.staggerMinutes * MINUTE_MS + 10 * 1000;
  const used = (releasedAt || []).filter((t) => t > from && t <= nowMs).length;
  return Math.max(0, settings.staggerCount - used);
}

// ---- "how have they worked" -----------------------------------------------------

/** YYYY-MM-DD of an instant in a time zone. */
export function dayIn(date, timeZone = 'America/Vancouver') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
  } catch {
    return new Date(date).toISOString().slice(0, 10);
  }
}

/**
 * The largest number of units one person was given inside any `windowMinutes`.
 * @param {Array<{techId, at, unitKey?, ticketId?}>} assignments
 */
export function largestBurst(assignments, windowMinutes = 10) {
  const span = windowMinutes * MINUTE_MS;
  const byTech = new Map();
  for (const a of assignments || []) {
    const techId = Number(a?.techId);
    const at = new Date(a?.at).getTime();
    if (!techId || !Number.isFinite(at)) continue;
    if (!byTech.has(techId)) byTech.set(techId, []);
    byTech.get(techId).push({ at, key: a.unitKey || `ticket:${a.ticketId}` });
  }
  let largest = 0;
  for (const list of byTech.values()) {
    list.sort((x, y) => x.at - y.at);
    let start = 0;
    for (let end = 0; end < list.length; end += 1) {
      while (list[end].at - list[start].at > span) start += 1;
      const units = new Set();
      for (let i = start; i <= end; i += 1) units.add(list[i].key);
      if (units.size > largest) largest = units.size;
    }
  }
  return largest;
}

/**
 * The first release of the day: the queued runs claimed one after another
 * (no gap longer than `gapMinutes`) starting with the day's first claim.
 * @param {Array<{queuedAt, claimedAt}>} runs  the queued runs claimed that day
 */
export function releaseOfDay(runs, gapMinutes = 15) {
  const list = (runs || [])
    .map((r) => ({ claimed: new Date(r.claimedAt).getTime(), queued: new Date(r.queuedAt).getTime() }))
    .filter((r) => Number.isFinite(r.claimed))
    .sort((a, b) => a.claimed - b.claimed);
  if (!list.length) return { released: 0, minutes: 0, startedAt: null, longestHeldMinutes: 0 };
  const batch = [list[0]];
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].claimed - list[i - 1].claimed > gapMinutes * MINUTE_MS) break;
    batch.push(list[i]);
  }
  const first = batch[0].claimed;
  const last = batch[batch.length - 1].claimed;
  return {
    released: batch.length,
    minutes: Math.round((last - first) / MINUTE_MS),
    startedAt: new Date(first).toISOString(),
    // Held by the stagger: how long after the release began the last one started.
    longestHeldMinutes: Math.round((last - first) / MINUTE_MS),
  };
}

/**
 * Everything the results page shows, from plain rows.
 *
 * @param {Array<{id, ticketId, techId, at, queuedAt, claimedAt, spread}>} runs  automatic assignments in the period
 * @param {Array<{queuedAt, claimedAt}>} queuedRuns  every queued run released in the period
 * No person is ranked anywhere: counts are per rule and per day.
 */
export function summarize(runs, queuedRuns, { settings, timeZone = 'America/Vancouver', days = 30, now = new Date() } = {}) {
  const windowMinutes = settings?.capWindowMinutes || 10;
  const capCount = settings?.capCount || 3;
  const dayMap = new Map();
  const day = (key) => {
    if (!dayMap.has(key)) dayMap.set(key, { day: key, assignments: 0, moved: 0, keptTogether: 0, gaveWay: 0, largestBurst: 0, rulesOn: false, released: 0, releaseMinutes: 0, _runs: [], _queued: [] });
    return dayMap.get(key);
  };
  // Every day of the period is on the line, also the quiet ones.
  for (let i = days - 1; i >= 0; i -= 1) day(dayIn(new Date(new Date(now).getTime() - i * 24 * 60 * MINUTE_MS), timeZone));

  const totals = { assignments: 0, moved: 0, keptTogether: 0, gaveWay: 0, guarded: 0 };
  for (const run of runs || []) {
    const key = dayIn(run.at, timeZone);
    if (!dayMap.has(key)) continue;
    const d = day(key);
    const spread = run.spread && typeof run.spread === 'object' ? run.spread : null;
    d.assignments += 1;
    totals.assignments += 1;
    d._runs.push({ techId: run.techId, at: run.at, ticketId: run.ticketId, unitKey: spread?.unit || `ticket:${run.ticketId}` });
    if (spread) { d.rulesOn = true; totals.guarded += 1; }
    if (spread?.rule === RULES.CAP) { d.moved += 1; totals.moved += 1; }
    if (spread?.rule === RULES.NEW_HIRE_SET) { d.keptTogether += 1; totals.keptTogether += 1; }
    if (spread?.rule === RULES.CAP_GAVE_WAY) { d.gaveWay += 1; totals.gaveWay += 1; }
  }
  for (const run of queuedRuns || []) {
    const key = dayIn(run.claimedAt, timeZone);
    if (dayMap.has(key)) day(key)._queued.push(run);
  }

  const perDay = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => {
    const release = releaseOfDay(d._queued);
    const rest = { ...d };
    delete rest._runs;
    delete rest._queued;
    return { ...rest, largestBurst: largestBurst(d._runs, windowMinutes), released: release.released, releaseMinutes: release.minutes };
  });

  const side = (list) => {
    const active = list.filter((d) => d.assignments > 0);
    return {
      days: active.length,
      assignments: active.reduce((sum, d) => sum + d.assignments, 0),
      largestBurst: active.reduce((max, d) => Math.max(max, d.largestBurst), 0),
      daysOverCap: active.filter((d) => d.largestBurst > capCount).length,
    };
  };
  const releaseSide = (list) => {
    const withRelease = list.filter((d) => d.released > 1);
    const tickets = withRelease.reduce((sum, d) => sum + d.released, 0);
    return {
      days: withRelease.length,
      tickets,
      averageMinutes: withRelease.length ? Math.round(withRelease.reduce((sum, d) => sum + d.releaseMinutes, 0) / withRelease.length) : 0,
      longestMinutes: withRelease.reduce((max, d) => Math.max(max, d.releaseMinutes), 0),
    };
  };
  const before = perDay.filter((d) => !d.rulesOn);
  const after = perDay.filter((d) => d.rulesOn);
  return {
    days,
    windowMinutes,
    capCount,
    totals,
    perDay,
    before: { ...side(before), release: releaseSide(before) },
    after: { ...side(after), release: releaseSide(after) },
    rulesFirstSeen: after[0]?.day || null,
  };
}

export default {
  RULES, LIMITS, SETTING_FIELDS, NEW_HIRE_SET_KEYS, DEFAULT_ON_WORKSPACES,
  defaultSettings, normalizeSettings, applyPatch, toStored, isNewHireSetKey, unitKeyFor, recentByTech, decide, recordFor,
  orderForRelease, releaseAllowance, dayIn, largestBurst, releaseOfDay, summarize,
};
