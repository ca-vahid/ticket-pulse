/**
 * Time-zone fit — the rules (QA 11-17 item 1).
 *
 * Remote work went to whoever the AI scored highest, wherever they sit: a
 * requester in Santiago (UTC−3) got an agent in Vancouver, five hours behind,
 * while someone in Toronto with close enough skill was on the list. For work
 * that is not tied to a site, a closer time zone now decides between people
 * whose skill is close:
 *   1. Only when the requester's time zone is known (not the FreshService
 *      "Pacific" default), the AI did not route for a site, and the AI's pick
 *      is 3 hours or more from the requester.
 *   2. Only people the AI listed, scored within 0.15 of its pick, holding the
 *      ticket's own skill (not just the parent category) at the needed level
 *      or above and at most one level below the pick's.
 *   3. Never someone on leave, who handed this ticket back, with a routing
 *      note, or assignable-only. Never someone off shift while the pick is
 *      at work.
 *   4. The closest time zone wins, and only when it is at least 2 hours
 *      closer than the pick. Ties go to the higher score.
 *
 * Pure: no database, no clock of its own (callers pass `now`).
 */
import { applyPatch as levelApplyPatch, levelNum, normalizeLevel, toStored as levelToStored } from '../assignmentLevelMatch/rules.js';
import { formatUtcOffset, placeOfZone, utcOffsetMinutes } from './requesterTimezone.js';

export const MODES = Object.freeze(['off', 'shadow', 'live']);
export const HISTORY_LIMIT = 30;
export const SCORE_MARGIN = 0.15;
/** The pick must be at least this far from the requester before anything is considered. */
export const MIN_GAP_MINUTES = 3 * 60;
/** The other person must be at least this much closer than the pick. */
export const MIN_GAIN_MINUTES = 2 * 60;

export const OUTCOMES = Object.freeze({
  MOVED: 'moved',               // someone closer with close skill
  KEPT: 'kept',                 // the pick is far, but nobody fits better
  CLOSE: 'close_enough',        // the pick is under 3 h from the requester
  NO_TIMEZONE: 'no_timezone',   // the requester's time zone is unknown or only the default
  SITE_BOUND: 'site_bound',     // the AI routed for a place: location decides, not time zone
  NO_PICK: 'no_pick',           // the pick is not on the AI's list or has no time zone
});

export function defaultSettings() {
  return { mode: 'off' };
}

/** Whatever was stored (JSON string, object, nothing) → a complete settings object. Starts off everywhere. */
export function normalizeSettings(raw) {
  const base = defaultSettings();
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

/** Same patch rules as Level match: mode only, with a history line. */
export const applyPatch = levelApplyPatch;
export const toStored = levelToStored;

/** "5 h", "2.5 h". */
export function formatGap(minutes) {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'they';

/**
 * The decision.
 * @param {object} input
 * @param {{timezone:string, confidence:string, place?:string}|null} input.requester
 * @param {boolean} input.siteBound           the AI matched agents to a place
 * @param {string|null} input.requiredLevel   what the AI judged this request needs (when Level match asked)
 * @param {number} input.aiPickId
 * @param {Array} input.candidates  the AI's list, in its order:
 *   { techId, techName, rank, score, timezone, skill: {level,num,priority,broad?}|null,
 *     onLeave, onShift, rejectedThisTicket, routingNote, assignableOnly }
 * @param {Date} input.now
 * @returns {{ outcome, techId, techName, from, requester, considered, parts }}
 */
export function decide({
  requester = null, siteBound = false, requiredLevel = null, aiPickId, candidates = [], now = new Date(),
  scoreMargin = SCORE_MARGIN, minGapMinutes = MIN_GAP_MINUTES, minGainMinutes = MIN_GAIN_MINUTES,
}) {
  const pick = candidates.find((c) => c.techId === aiPickId) || null;
  const base = {
    techId: aiPickId,
    techName: pick?.techName || null,
    from: { techId: aiPickId, techName: pick?.techName || null },
    requester: null,
    considered: [],
    parts: null,
  };
  if (!requester?.timezone || requester.confidence === 'low') return { ...base, outcome: OUTCOMES.NO_TIMEZONE };
  const reqOffset = utcOffsetMinutes(requester.timezone, now);
  if (reqOffset === null) return { ...base, outcome: OUTCOMES.NO_TIMEZONE };
  const requesterOut = {
    timezone: requester.timezone,
    place: requester.place || placeOfZone(requester.timezone),
    offset: formatUtcOffset(reqOffset),
    source: requester.source || null,
  };
  if (siteBound) return { ...base, requester: requesterOut, outcome: OUTCOMES.SITE_BOUND };

  const gapOf = (c) => {
    const off = c?.timezone ? utcOffsetMinutes(c.timezone, now) : null;
    if (off === null) return null;
    // Clock distance wraps around the day: UTC+10 and UTC−8 are 6 h apart, not 18.
    const d = Math.abs(off - reqOffset) % 1440;
    return Math.min(d, 1440 - d);
  };
  const pickGap = gapOf(pick);
  if (!pick || pickGap === null) return { ...base, requester: requesterOut, outcome: OUTCOMES.NO_PICK };
  const pickOut = { techId: pick.techId, techName: pick.techName, place: placeOfZone(pick.timezone), gap: pickGap };
  if (pickGap < minGapMinutes) return { ...base, requester: requesterOut, outcome: OUTCOMES.CLOSE, parts: { requester: requesterOut, pick: pickOut } };

  const need = normalizeLevel(requiredLevel);
  const needNum = need ? levelNum(need) : 0;
  const pickNum = pick.skill?.num || 0;
  const pickScore = Number(pick.score);
  const scoreOk = (c) => !Number.isFinite(pickScore) || !Number.isFinite(Number(c.score)) || Number(c.score) >= pickScore - scoreMargin - 1e-9;
  const eligible = (c) => c.techId !== aiPickId
    && !c.onLeave && !c.rejectedThisTicket && !c.assignableOnly && !String(c.routingNote || '').trim()
    && c.skill && !c.skill.broad && c.skill.num > 0
    && c.skill.num >= needNum && c.skill.num >= pickNum - 1
    && scoreOk(c)
    && (c.onShift !== false || pick.onShift === false);

  const pool = candidates
    .filter(eligible)
    .map((c) => ({ c, gap: gapOf(c) }))
    .filter((x) => x.gap !== null && x.gap <= pickGap - minGainMinutes)
    .sort((a, b) => (a.gap - b.gap) || ((Number(b.c.score) || 0) - (Number(a.c.score) || 0)) || ((a.c.rank || 0) - (b.c.rank || 0)));

  const considered = pool.map(({ c, gap }) => ({
    techId: c.techId, techName: c.techName, timezone: c.timezone, gapMinutes: gap, level: c.skill?.level || null, score: Number.isFinite(Number(c.score)) ? Number(c.score) : null,
  }));
  if (!pool.length) {
    return { ...base, requester: requesterOut, outcome: OUTCOMES.KEPT, considered, parts: { requester: requesterOut, pick: pickOut } };
  }
  const chosen = pool[0];
  return {
    ...base,
    outcome: OUTCOMES.MOVED,
    techId: chosen.c.techId,
    techName: chosen.c.techName,
    requester: requesterOut,
    considered,
    parts: {
      requester: requesterOut,
      pick: pickOut,
      to: { techId: chosen.c.techId, techName: chosen.c.techName, place: placeOfZone(chosen.c.timezone), gap: chosen.gap },
    },
  };
}

/**
 * The sentence on the run.
 * moved:  "Time zone: the requester is in Santiago (UTC−3); Dana Fox in Toronto is 2 h away, Eli Park in Vancouver 5 h, so Dana was put first."
 * kept:   "Time zone: the requester is in Santiago (UTC−3) and Eli Park in Vancouver is 5 h away; nobody with close enough skill is 2 h closer."
 */
export function sentenceFor(result, { applied = false } = {}) {
  const p = result?.parts;
  if (!p?.requester || !p.pick) return null;
  const who = `the requester is in ${p.requester.place} (${p.requester.offset})`;
  if (result.outcome === OUTCOMES.MOVED && p.to) {
    const verb = applied ? 'was put first' : 'would be put first';
    return `Time zone: ${who}; ${p.to.techName} in ${p.to.place} is ${formatGap(p.to.gap)} away, ${p.pick.techName} in ${p.pick.place} ${formatGap(p.pick.gap)}, so ${firstName(p.to.techName)} ${verb}.`;
  }
  if (result.outcome === OUTCOMES.KEPT) {
    return `Time zone: ${who} and ${p.pick.techName} in ${p.pick.place} is ${formatGap(p.pick.gap)} away; nobody with close enough skill is ${formatGap(MIN_GAIN_MINUTES)} closer.`;
  }
  return null;
}
