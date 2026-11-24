/**
 * Level match — the rules (Vahid, 26 Oct 2026).
 *
 * The AI ranked the most skilled person first on every ticket, so the expert
 * in a subcategory got all of it — even "add a Claude seat", which anyone
 * trained can do (Monday: Alexey 12, Soheil 1). Higher levels exist for
 * HARDER requests, not for every request in the subcategory.
 *
 * So the AI now judges the level THIS request needs (basic … expert) and the
 * code picks the person:
 *   1. Everyone the AI recommended who holds the ticket's skill at that level
 *      or above qualifies. Exact-subcategory skill beats parent-category skill.
 *   2. Among those, extra skill gives no edge: fewest tickets received today
 *      wins, then fewest open tickets, then the AI's own order — but never
 *      someone with 5+ more open tickets than a qualified AI pick unless
 *      their day is lighter by 2+ (QA 11-23 item 1).
 *   3. People on leave, off shift (while someone qualified is on shift), who
 *      already rejected this ticket, or who carry a routing note are never
 *      promoted. The AI's own pick is always allowed to stay.
 * The pool is the AI's recommendation list on purpose: those are people it
 * already judged fit for location, presence and history.
 *
 * Pure: no database, no clock of its own (callers pass `now`).
 */

export const LEVELS = Object.freeze(['basic', 'intermediate', 'advanced', 'expert']);
export const MODES = Object.freeze(['off', 'shadow', 'live']);
/** The workspace that starts in Shadow (IT). Every other workspace starts off. */
export const DEFAULT_SHADOW_WORKSPACES = Object.freeze([1]);
export const HISTORY_LIMIT = 30;
/**
 * Fitness floor: only people the AI scored within this much of its first
 * choice can be promoted. The AI's score carries what the rule cannot see —
 * role, seniority, location, history — so a manager listed as a distant
 * back-up is never handed a seat request just for having a light day.
 */
export const SCORE_MARGIN = 0.15;

export const OUTCOMES = Object.freeze({
  KEPT: 'kept',          // the AI's pick is already the right person
  MOVED: 'moved',        // someone qualified with less load gets it
  NO_LEVEL: 'no_level',  // the AI did not judge a level — nothing to do
  NO_SKILL: 'no_skill',  // the ticket has no category, or nobody listed holds it
});

export function levelNum(level) {
  const i = LEVELS.indexOf(String(level || '').trim().toLowerCase());
  return i === -1 ? 0 : i + 1;
}

export function normalizeLevel(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return LEVELS.includes(v) ? v : null;
}

export function defaultSettings(workspaceId = null) {
  return { mode: DEFAULT_SHADOW_WORKSPACES.includes(Number(workspaceId)) ? 'shadow' : 'off' };
}

/** Whatever was stored (JSON string, object, nothing) → a complete settings object. */
export function normalizeSettings(raw, workspaceId = null) {
  const base = defaultSettings(workspaceId);
  let stored = raw;
  if (typeof raw === 'string') {
    try { stored = JSON.parse(raw); } catch { stored = null; }
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  return {
    mode: MODES.includes(stored.mode) ? stored.mode : base.mode,
    persisted: Object.keys(stored).length > 0,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
    updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy : null,
    history: Array.isArray(stored.history) ? stored.history.slice(0, HISTORY_LIMIT) : [],
  };
}

/** @returns {{ next, changes, errors }} */
export function applyPatch(current, patch = {}, { by = null, now = new Date() } = {}) {
  if (patch.mode === undefined) return { next: current, changes: [], errors: ['Nothing to change.'] };
  if (!MODES.includes(patch.mode)) return { next: current, changes: [], errors: [`mode must be one of ${MODES.join(', ')}`] };
  if (patch.mode === current.mode) return { next: current, changes: [], errors: [] };
  const at = now.toISOString();
  const changes = [{ field: 'mode', from: current.mode, to: patch.mode }];
  return {
    next: {
      ...current,
      mode: patch.mode,
      persisted: true,
      updatedAt: at,
      updatedBy: by || null,
      history: [{ at, by: by || null, changes }, ...(current.history || [])].slice(0, HISTORY_LIMIT),
    },
    changes,
    errors: [],
  };
}

export function toStored(settings) {
  return { mode: settings.mode, updatedAt: settings.updatedAt, updatedBy: settings.updatedBy, history: settings.history || [] };
}

/** HH:MM in a time zone at `now`, as minutes since midnight. */
function localMinutes(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  } catch {
    return null;
  }
}

const toMinutes = (hhmm, fallback) => {
  const [h, m] = String(hhmm || fallback).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

/** Is the person inside their working hours at `now`? Unknown → true (never exclude on a guess). */
export function onShiftAt(person, now, fallbackTimeZone = 'America/Vancouver') {
  const minutes = localMinutes(now, person.timezone || fallbackTimeZone);
  if (minutes === null) return true;
  const start = toMinutes(person.workStartTime, '09:00');
  const end = toMinutes(person.workEndTime, '17:00');
  return end <= start ? (minutes >= start || minutes < end) : (minutes >= start && minutes < end);
}

/**
 * The person's best skill for this ticket: exact subcategory (priority 2) over
 * the parent category (priority 1). Same rule as find_matching_agents.
 * `broad` marks a parent-category skill on a ticket that has a subcategory: a
 * broad "Security: expert" says nothing about firewall firmware, so it never
 * earns a move (27 Oct 2026, #65201 bounced back as a competency mismatch).
 * @param {Array<{categoryId:number, level:string}>} skills
 */
export function skillFor(skills, { categoryId = null, subcategoryId = null } = {}) {
  const exact = subcategoryId ? skills.find((s) => s.categoryId === subcategoryId) : null;
  if (exact) return { level: normalizeLevel(exact.level), num: levelNum(exact.level), priority: 2 };
  const parent = categoryId ? skills.find((s) => s.categoryId === categoryId) : null;
  if (parent) {
    const skill = { level: normalizeLevel(parent.level), num: levelNum(parent.level), priority: 1 };
    return subcategoryId ? { ...skill, broad: true } : skill;
  }
  return null;
}

/**
 * The decision.
 * @param {object} input
 * @param {string|null} input.requiredLevel  what the AI judged this request needs
 * @param {number} input.aiPickId            who the AI (and earlier rules) chose
 * @param {Array} input.candidates           the AI's list, in its order:
 *   { techId, techName, rank, score, skill: {level,num,priority}|null, today, open,
 *     onLeave, onShift, rejectedThisTicket, routingNote, assignableOnly }
 * @param {number} [input.scoreMargin]       see SCORE_MARGIN
 * @param {number} [input.openGap]           see OPEN_LOAD_GAP
 * @param {number} [input.todayOverride]     see TODAY_GAP_OVERRIDE
 * @returns {{ outcome, techId, techName, from, requiredLevel, considered, sentence,
 *   moveReason?, skipped?, skipReason? }}
 */
export function decide({
  requiredLevel, aiPickId, candidates = [], scoreMargin = SCORE_MARGIN, openGap = OPEN_LOAD_GAP, todayOverride = TODAY_GAP_OVERRIDE,
}) {
  const need = normalizeLevel(requiredLevel);
  const pick = candidates.find((c) => c.techId === aiPickId) || null;
  const base = {
    techId: aiPickId, techName: pick?.techName || null, from: { techId: aiPickId, techName: pick?.techName || null },
    requiredLevel: need, considered: [],
  };
  if (!need) return { ...base, outcome: OUTCOMES.NO_LEVEL, sentence: null };

  const needNum = levelNum(need);
  const scores = candidates.map((c) => Number(c.score)).filter(Number.isFinite);
  const topScore = scores.length ? Math.max(...scores) : null;
  const closeEnough = (c) => topScore === null || !Number.isFinite(Number(c.score)) || Number(c.score) >= topScore - scoreMargin - 1e-9;
  const promotable = (c) => c.techId === aiPickId
    || (!c.onLeave && !c.rejectedThisTicket && !c.assignableOnly && !String(c.routingNote || '').trim() && !c.skill?.broad && closeEnough(c));
  let pool = candidates.filter((c) => c.skill && c.skill.num >= needNum && promotable(c));
  if (!pool.length) return { ...base, outcome: OUTCOMES.NO_SKILL, sentence: null };

  // Exact-subcategory skill first; parent-category skill only when nobody exact qualifies.
  // An AI pick who meets the level stays in the running whatever the tier: the
  // rule moves a qualified pick only to someone with a lighter day (27 Oct,
  // #65257 left Seifeddine at 1 today for Anton at 3 and came straight back).
  const bestPriority = Math.max(...pool.map((c) => c.skill.priority));
  pool = pool.filter((c) => c.skill.priority === bestPriority || c.techId === aiPickId);
  // Off-shift people only when nobody qualified is at work (the AI's pick may always stay).
  if (pool.some((c) => c.onShift)) pool = pool.filter((c) => c.onShift || c.techId === aiPickId);

  const ordered = [...pool].sort((a, b) => (a.today - b.today) || (a.open - b.open) || (a.rank - b.rank));
  const pickInPool = pool.find((c) => c.techId === aiPickId);

  // Open load counts too (QA 11-23 item 1, TP-1042): one ticket fewer today
  // never outweighs a much heavier queue. Someone carrying OPEN_LOAD_GAP or
  // more open tickets than a qualified AI pick is passed over unless their
  // day is lighter by TODAY_GAP_OVERRIDE or more. Only against a pick who
  // meets the level — a pick who does not is moved for skill, not for load.
  const skipped = [];
  let chosen = null;
  for (const c of ordered) {
    const skip = pickInPool && c.techId !== aiPickId ? loadSkip(c, pickInPool, { openGap, todayOverride }) : null;
    if (!skip) { chosen = c; break; }
    skipped.push(skip);
  }
  chosen = chosen || pickInPool || ordered[0];
  // A tie with the AI's own pick keeps the AI's pick.
  if (pickInPool && pickInPool.today === chosen.today && pickInPool.open === chosen.open) chosen = pickInPool;

  const considered = ordered.map((c) => ({ techId: c.techId, techName: c.techName, level: c.skill.level, today: c.today, open: c.open }));
  const skipFields = skipped.length ? { skipped, skipReason: skipped[0].reason } : { skipped: [], skipReason: null };
  if (chosen.techId === aiPickId) {
    const who = chosen.techName || 'the AI’s pick';
    return {
      ...base, outcome: OUTCOMES.KEPT, considered, moveReason: null, ...skipFields,
      sentence: skipped.length
        ? `Needs ${need}; kept with ${who}: ${skipped[0].sentenceTail}.`
        : `Needs ${need}; ${who} qualifies and has the lightest load today (${chosen.today} today, ${chosen.open} open).`,
    };
  }
  const { moveReason, sentence } = moveSentence({ need, chosen, pick: pickInPool ? pick : null, pickAny: pick });
  return {
    ...base,
    outcome: OUTCOMES.MOVED,
    techId: chosen.techId,
    techName: chosen.techName,
    considered,
    moveReason,
    ...skipFields,
    sentence,
  };
}

/** Open-load gap that blocks a move (QA 11-23 item 1). */
export const OPEN_LOAD_GAP = 5;
/** …unless the other person's day is lighter by at least this many tickets. */
export const TODAY_GAP_OVERRIDE = 2;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Why `c` may not take the ticket from the qualified pick, or null. */
function loadSkip(c, pick, { openGap = OPEN_LOAD_GAP, todayOverride = TODAY_GAP_OVERRIDE } = {}) {
  const openMore = c.open - pick.open;
  const todayFewer = pick.today - c.today;
  if (openMore < openGap || todayFewer >= todayOverride) return null;
  const fewer = todayFewer > 0 ? `only ${todayFewer} fewer today` : 'no fewer today';
  const sentenceTail = `${c.techName || 'the other person'} has ${plural(openMore, 'more open ticket', 'more open tickets')} and ${fewer}`;
  return {
    techId: c.techId, techName: c.techName, open: c.open, today: c.today, openMore, todayFewer,
    reason: `kept: ${sentenceTail}`,
    sentenceTail,
  };
}

/** "Both advanced in Teams" / "Priya Nair is expert, Eli Park advanced in Teams". */
function levelsPhrase(chosen, pick) {
  const a = chosen.skill || {};
  const b = pick.skill || {};
  const sameName = Boolean(a.name && a.name === b.name);
  const where = (s) => (s.name ? ` in ${s.name}` : '');
  if (a.level === b.level && (sameName || (!a.name && !b.name))) return `Both ${a.level}${sameName ? ` in ${a.name}` : ''}`;
  if (sameName) return `${chosen.techName} is ${a.level}, ${pick.techName} ${b.level} in ${a.name}`;
  return `${chosen.techName} is ${a.level}${where(a)}, ${pick.techName} ${b.level || 'unrated'}${where(b)}`;
}

/**
 * The move sentence gives the REAL reason (QA 11-23 item 2). "Extra skill is
 * not needed" only when the new person's level really is lower than the pick's.
 * @returns {{ moveReason: 'pick_below_level'|'less_skill_needed'|'lighter_day'|'fewer_open', sentence }}
 */
function moveSentence({ need, chosen, pick, pickAny }) {
  const to = chosen.techName;
  if (!pick) {
    const was = pickAny
      ? `${pickAny.techName} (${pickAny.skill?.level || 'no skill'}, ${pickAny.today} today, ${pickAny.open} open)`
      : 'the AI’s pick';
    return {
      moveReason: 'pick_below_level',
      sentence: `Needs ${need}: ${to} (${chosen.skill.level}, ${chosen.today} today, ${chosen.open} open) instead of ${was}, who does not hold this skill at that level.`,
    };
  }
  if (chosen.skill.num < (pick.skill?.num || 0)) {
    return {
      moveReason: 'less_skill_needed',
      sentence: `Needs ${need}: ${to} (${chosen.skill.level}, ${chosen.today} today, ${chosen.open} open) instead of ${pick.techName} (${pick.skill.level}, ${pick.today} today, ${pick.open} open) — extra skill is not needed for this request.`,
    };
  }
  const levels = levelsPhrase(chosen, pick);
  if (chosen.today < pick.today) {
    return {
      moveReason: 'lighter_day',
      sentence: `Lighter day: ${to} (${chosen.today} today) instead of ${pick.techName} (${pick.today} today). ${levels}; ${to} has ${chosen.open} open, ${pick.techName} ${pick.open}.`,
    };
  }
  return {
    moveReason: 'fewer_open',
    sentence: `Fewer open tickets: ${to} (${chosen.open} open) instead of ${pick.techName} (${pick.open} open). ${levels}; both have ${chosen.today} today.`,
  };
}
