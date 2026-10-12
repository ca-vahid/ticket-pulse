/**
 * The dial (plans/KNOWLEDGE_SIMPLIFY_PLAN.md sections 5 and 6): what Auto-help
 * may do with an answer in a category, by day and by night, and how sure one
 * answer is.
 *
 *   level   off      never drafts here
 *           draft    the answer is recorded and shown on the ticket (old "shadow")
 *           suggest  a ready reply waits for an agent to send or edit ("approve")
 *           send     sends by itself when the answer is sure ("auto")
 *
 *   rows    knowledge_category_policies, one optional row per category.
 *           categoryId 0 is the workspace default. A NULL field inherits:
 *           subcategory -> top category -> default -> built-in (draft / draft).
 *
 *   band    high | medium | low, from things the run can observe (the "enough
 *           to answer" check, how well the best article matched, whether that
 *           article was checked and is in date, the model's own score against
 *           the bar). The model's own score alone never makes an answer sure.
 *
 *   act     the band moves an answer DOWN the dial, never up: high keeps the
 *           category's level, medium takes one step down, low is recorded only.
 *
 *   earned  "send" is locked until the category meets the readiness bar on its
 *           own reviewed answers (autoHelpOutcomes.READINESS), and never opens
 *           for a category marked "always checked by a person".
 *
 * Reads fail soft to the built-in default (draft): a broken table can never
 * make Auto-help send.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { READINESS, evaluateReadiness, readinessEvidence } from './autoHelpOutcomes.js';

export const LEVELS = Object.freeze(['off', 'draft', 'suggest', 'send']);
export const BANDS = Object.freeze(['high', 'medium', 'low']);
export const DEFAULT_LEVEL = 'draft';
export const DEFAULT_BAR = 0.85;
export const MIN_BAR = 0.5;
export const MAX_BAR = 0.99;
/** The workspace default row. */
export const DEFAULT_CATEGORY_ID = 0;
/** The run mode each level maps to (the delivery and follow-up code reads modes). */
export const LEVEL_MODE = Object.freeze({ off: null, draft: 'shadow', suggest: 'approve', send: 'auto' });
export const LEVEL_LABELS = Object.freeze({
  off: 'Off',
  draft: 'Draft only',
  suggest: 'Suggest to agent',
  send: 'Send when sure',
});
/** How far above the relevance floor the best cited article must score to count as a strong match. */
export const STRONG_MATCH_SCORE = 0.45;
const MAX_NOTES = 4000;
const MAX_STAY_QUIET = 20;
const MAX_STAY_QUIET_CHARS = 300;
const ROWS_CACHE_MS = 30 * 1000;
const READINESS_CACHE_MS = 10 * 60 * 1000;
/**
 * Calibration (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 6): once a category
 * has at least this many judged "sure" answers, fewer than this share right
 * means "sure" stopped meaning sure there, and sure answers are treated as
 * "fairly sure" (one level down) until the numbers recover.
 */
export const CALIBRATION_MIN_JUDGED = 10;
export const CALIBRATION_MIN_RIGHT_PCT = 80;
export const CALIBRATION_DAYS = 90;
const CALIBRATION_CACHE_MS = 10 * 60 * 1000;

/**
 * What people said about a run, as right / not right / unknown. Pure.
 * A review verdict wins; otherwise what the agent did with the suggestion.
 */
export function judgedOf(run) {
  if (run?.reviewVerdict === 'good') return 'right';
  if (run?.reviewVerdict) return 'not_right';
  if (run?.decision === 'agent_sent') return 'right';
  if (run?.decision === 'agent_edited_sent' || run?.decision === 'agent_dismissed') return 'not_right';
  return null;
}

/** Pure: is "sure" still reliable, given { judged, right } for the high band? */
export function highReliable({ judged = 0, right = 0 } = {}) {
  if (Number(judged) < CALIBRATION_MIN_JUDGED) return true;
  return (Number(right) / Number(judged)) * 100 >= CALIBRATION_MIN_RIGHT_PCT;
}

export const SEND_LOCKED_MESSAGE = 'This category has not earned "Send when sure" yet: it needs enough reviewed answers first';
export const SEND_ALWAYS_CHECKED_MESSAGE = 'A category that is always checked by a person can go as far as "Suggest to agent", never "Send when sure"';

function lockError(message, code, details = null) {
  const err = new ValidationError(message);
  err.code = code;
  if (details) err.details = details;
  return err;
}

// ---------- pure ----------

/** One step down the dial (send -> suggest -> draft); draft and off stay. */
export function stepDown(level) {
  if (level === 'send') return 'suggest';
  if (level === 'suggest') return 'draft';
  return LEVELS.includes(level) ? level : DEFAULT_LEVEL;
}

/** The level one answer actually gets: the band moves it down, never up. */
export function applyBand(level, band) {
  if (!LEVELS.includes(level)) return DEFAULT_LEVEL;
  if (level === 'off') return 'off';
  if (band === 'high') return level;
  if (band === 'medium') return stepDown(level);
  return 'draft';
}

function cleanLevel(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (!LEVELS.includes(value)) throw new ValidationError(`${field} must be one of: ${LEVELS.join(', ')}`);
  return value;
}

function cleanList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_STAY_QUIET_CHARS);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_STAY_QUIET) break;
  }
  return out;
}

/** Validated row fields. `undefined` = not sent (leave as is); `null` = inherit. */
export function normalizePolicyInput(input = {}) {
  const data = {};
  if (input.dayLevel !== undefined) data.dayLevel = cleanLevel(input.dayLevel, 'dayLevel');
  if (input.nightLevel !== undefined) data.nightLevel = cleanLevel(input.nightLevel, 'nightLevel');
  if (input.bar !== undefined) {
    if (input.bar === null || input.bar === '') {
      data.bar = null;
    } else {
      const n = Number(input.bar);
      if (!Number.isFinite(n) || n < MIN_BAR || n > MAX_BAR) throw new ValidationError(`The bar must be between ${MIN_BAR} and ${MAX_BAR}`);
      data.bar = Math.round(n * 100) / 100;
    }
  }
  if (input.alwaysChecked !== undefined) data.alwaysChecked = input.alwaysChecked === null ? null : input.alwaysChecked === true;
  if (input.notes !== undefined) data.notes = String(input.notes ?? '').trim().slice(0, MAX_NOTES) || null;
  if (input.stayQuietWhen !== undefined) data.stayQuietWhen = cleanList(input.stayQuietWhen);
  return data;
}

/**
 * The dial for one ticket: each field from the nearest row that sets it.
 * `rows` are this workspace's policy rows. Pure.
 * @returns {{ dayLevel, nightLevel, bar, alwaysChecked, notes: string[], stayQuietWhen: string[], from: object }}
 */
export function resolvePolicy(rows = [], { categoryId = null, subcategoryId = null } = {}) {
  const byId = new Map((rows || []).map((r) => [Number(r.categoryId), r]));
  const chain = [
    subcategoryId ? { row: byId.get(Number(subcategoryId)), from: 'subcategory' } : null,
    categoryId ? { row: byId.get(Number(categoryId)), from: 'category' } : null,
    { row: byId.get(DEFAULT_CATEGORY_ID), from: 'default' },
  ].filter((c) => c && c.row);
  const pick = (field, fallback) => {
    for (const c of chain) {
      const v = c.row[field];
      if (v !== null && v !== undefined) return { value: v, from: c.from };
    }
    return { value: fallback, from: 'builtin' };
  };
  const day = pick('dayLevel', DEFAULT_LEVEL);
  const night = pick('nightLevel', DEFAULT_LEVEL);
  const bar = pick('bar', DEFAULT_BAR);
  const checked = pick('alwaysChecked', false);
  // Notes and stay-quiet rules add up from the general to the specific.
  const ordered = [...chain].reverse();
  const notes = ordered.map((c) => String(c.row.notes || '').trim()).filter(Boolean);
  const stayQuietWhen = cleanList(ordered.flatMap((c) => (Array.isArray(c.row.stayQuietWhen) ? c.row.stayQuietWhen : [])));
  return {
    dayLevel: LEVELS.includes(day.value) ? day.value : DEFAULT_LEVEL,
    nightLevel: LEVELS.includes(night.value) ? night.value : DEFAULT_LEVEL,
    bar: Number.isFinite(Number(bar.value)) ? Number(bar.value) : DEFAULT_BAR,
    alwaysChecked: checked.value === true,
    notes,
    stayQuietWhen,
    from: { dayLevel: day.from, nightLevel: night.from, bar: bar.from, alwaysChecked: checked.from },
  };
}

/**
 * How sure one drafted answer is, from what the run can observe.
 * @param {object} e
 *   sufficient        'yes' | 'partial' | 'no' (the "enough to answer" check)
 *   droppedSteps      number of draft steps the check removed
 *   gateDecision      the run's gate (playbook_only / partial_context are never sure)
 *   modelConfidence   the drafting model's own 0..1 score
 *   bar               the category's bar
 *   citedArticles     [{ id, score, stale, checked }] articles the answer cites
 *   citedTickets      number of verified solutions cited
 *   triage            'yes' | 'unclear' (self-service verdict of the triage check)
 *   researchOnly      true when nothing matched up front and the model dug with tools
 *   stayQuietConfirmedTwice  false when the drafting step left the stay-quiet answer out
 * @returns {{ band: 'high'|'medium'|'low', misses: Array<{ key, label }> }}
 */
export function confidenceBand(e = {}) {
  const misses = [];
  const miss = (key, label) => misses.push({ key, label });
  const articles = Array.isArray(e.citedArticles) ? e.citedArticles : [];
  const hard = e.gateDecision === 'playbook_only';
  if (e.sufficient !== 'yes' || Number(e.droppedSteps) > 0 || e.gateDecision === 'partial_context') {
    miss('partial', 'The knowledge covers only part of the request');
  }
  const conf = e.modelConfidence;
  if (conf === null || conf === undefined || Number(conf) < Number(e.bar ?? DEFAULT_BAR)) miss('below_bar', 'The answer\'s own confidence is under the bar');
  if (!articles.length) {
    miss('no_article', Number(e.citedTickets) > 0 ? 'The answer rests on solved tickets, not on an article' : 'The answer cites no article');
  } else {
    const best = Math.max(...articles.map((a) => Number(a.score) || 0));
    if (best < STRONG_MATCH_SCORE) miss('weak_match', 'The best article is only a loose match');
    if (articles.some((a) => a.stale === true)) miss('review_overdue', 'An article it uses is past its review date');
    if (articles.some((a) => a.checked !== true)) miss('not_checked', 'An article it uses has not been checked by a person');
  }
  if (e.triage === 'unclear') miss('triage_unclear', 'It was not clear the requester can do this themselves');
  if (e.researchOnly === true) miss('research_only', 'Nothing matched at first; the answer came from a wider search');
  if (e.stayQuietConfirmedTwice === false) miss('stay_quiet_once', 'Only the answer check confirmed that no stay-quiet rule applies');
  const band = hard || misses.length >= 2 ? 'low' : misses.length === 1 ? 'medium' : 'high';
  return { band, misses };
}

/**
 * What a drafted answer may do right now. Pure.
 *   policy     resolvePolicy() result
 *   afterHours boolean
 *   band       confidenceBand().band
 *   ready      the category met the readiness bar
 *   eligible   the run's own auto-send eligibility (grounded, not partial, at the bar)
 * @returns {{ level, mode, ceiling, reason }}
 */
export function decideAction({ policy, afterHours = false, band = 'low', ready = false, eligible = false } = {}) {
  const ceiling = afterHours ? policy.nightLevel : policy.dayLevel;
  if (ceiling === 'off') return { level: 'off', mode: null, ceiling, reason: 'category_off' };
  let level = applyBand(ceiling, band);
  let reason = band === 'high' ? 'as_set' : band === 'medium' ? 'one_step_down' : 'recorded_only';
  // "Send" is earned and never for an always-checked category; anything
  // short of fully eligible is suggested to an agent instead.
  if (level === 'send' && (policy.alwaysChecked || !ready || !eligible)) {
    level = 'suggest';
    reason = policy.alwaysChecked ? 'always_checked' : !ready ? 'not_earned' : 'not_eligible';
  }
  return { level, mode: LEVEL_MODE[level], ceiling, reason };
}

function rowView(row) {
  if (!row) return null;
  return {
    categoryId: Number(row.categoryId),
    dayLevel: row.dayLevel ?? null,
    nightLevel: row.nightLevel ?? null,
    bar: row.bar ?? null,
    alwaysChecked: row.alwaysChecked ?? null,
    notes: row.notes || '',
    stayQuietWhen: Array.isArray(row.stayQuietWhen) ? row.stayQuietWhen : [],
    updatedBy: row.updatedBy || null,
    updatedAt: row.updatedAt || null,
  };
}

// ---------- service ----------

class KnowledgeAnswerPolicyService {
  _rowsCache = new Map();

  _readinessCache = new Map();

  _calibrationCache = new Map();

  clearCache(workspaceId = null) {
    if (workspaceId === null) { this._rowsCache.clear(); this._readinessCache.clear(); this._calibrationCache.clear(); return; }
    this._rowsCache.delete(Number(workspaceId));
    this._calibrationCache.delete(Number(workspaceId));
    for (const key of [...this._readinessCache.keys()]) if (key.startsWith(`${Number(workspaceId)}:`)) this._readinessCache.delete(key);
  }

  /** This workspace's policy rows (cached 30 s). Never throws: no rows = built-in defaults. */
  async rows(workspaceId, { fresh = false } = {}) {
    const ws = Number(workspaceId);
    const now = Date.now();
    const hit = this._rowsCache.get(ws);
    if (!fresh && hit && now - hit.at < ROWS_CACHE_MS) return hit.rows;
    const rows = await Promise.resolve()
      .then(() => prisma.knowledgeCategoryPolicy.findMany({ where: { workspaceId: ws }, take: 2000 }))
      .catch((err) => { logger.warn(`Answer policy rows unavailable (ws ${ws}): ${err.message}`); return []; });
    this._rowsCache.set(ws, { at: now, rows: rows || [] });
    return rows || [];
  }

  /** The dial for one ticket ({ internalCategoryId, internalSubcategoryId }). */
  async resolveForTicket(workspaceId, ticket) {
    const rows = await this.rows(workspaceId);
    return resolvePolicy(rows, { categoryId: ticket?.internalCategoryId ?? null, subcategoryId: ticket?.internalSubcategoryId ?? null });
  }

  /**
   * Has a top category earned "Send when sure"? From its own runs' reviews and
   * agent sends (never test or backtest runs). Never throws: no evidence = not met.
   */
  async categoryReadiness(workspaceId, categoryId, { alwaysChecked = false } = {}) {
    const ws = Number(workspaceId);
    const cat = Number(categoryId) || null;
    const rows = cat ? await Promise.resolve()
      .then(() => prisma.autoHelpRun.findMany({
        where: { workspaceId: ws, categoryId: cat, OR: [{ reviewVerdict: { not: null } }, { decision: { not: null } }] },
        select: { reviewVerdict: true, reviewedAt: true, decision: true, outcome: true, trigger: true, playbookVersion: true },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      }))
      .catch(() => []) : [];
    return evaluateReadiness({ ...readinessEvidence(rows || [], {}), sensitive: alwaysChecked === true }, READINESS);
  }

  /**
   * Per top category and band: how many answers people judged, and how many
   * of those were right. Map-like object { [categoryId]: { high, medium, low: { judged, right } } }.
   * Test and backtest runs never count. Never throws.
   */
  async calibration(workspaceId, { now = Date.now() } = {}) {
    const ws = Number(workspaceId);
    const hit = this._calibrationCache.get(ws);
    if (hit && now - hit.at < CALIBRATION_CACHE_MS) return hit.value;
    const rows = await Promise.resolve()
      .then(() => prisma.autoHelpRun.findMany({
        where: {
          workspaceId: ws, trigger: 'categorized', confidenceBand: { not: null }, categoryId: { not: null },
          createdAt: { gte: new Date(now - CALIBRATION_DAYS * 86400e3) },
          OR: [{ reviewVerdict: { not: null } }, { decision: { not: null } }],
        },
        select: { categoryId: true, confidenceBand: true, reviewVerdict: true, decision: true },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      }))
      .catch(() => []);
    const value = {};
    for (const r of rows || []) {
      const judged = judgedOf(r);
      if (!judged || !BANDS.includes(r.confidenceBand)) continue;
      const cat = value[r.categoryId] || (value[r.categoryId] = { high: { judged: 0, right: 0 }, medium: { judged: 0, right: 0 }, low: { judged: 0, right: 0 } });
      cat[r.confidenceBand].judged += 1;
      if (judged === 'right') cat[r.confidenceBand].right += 1;
    }
    this._calibrationCache.set(ws, { at: now, value });
    return value;
  }

  /** Is a "sure" answer in this category still to be trusted as sure? Fails soft to yes (the other locks still hold). */
  async highIsReliable(workspaceId, categoryId) {
    const table = await this.calibration(workspaceId).catch(() => ({}));
    return highReliable(table?.[Number(categoryId)]?.high);
  }

  async cachedCategoryReadiness(workspaceId, categoryId, { alwaysChecked = false, now = Date.now() } = {}) {
    const key = `${Number(workspaceId)}:${Number(categoryId) || 0}:${alwaysChecked ? 1 : 0}`;
    const hit = this._readinessCache.get(key);
    if (hit && now - hit.at < READINESS_CACHE_MS) return hit.value;
    const value = await this.categoryReadiness(workspaceId, categoryId, { alwaysChecked });
    this._readinessCache.set(key, { at: now, value });
    return value;
  }

  async _categories(workspaceId) {
    return Promise.resolve()
      .then(() => prisma.competencyCategory.findMany({
        where: { workspaceId: Number(workspaceId), isActive: true },
        select: { id: true, name: true, parentId: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        take: 2000,
      }))
      .catch(() => []);
  }

  /**
   * The Answering screen: the default row, then every top category with its
   * subcategories. Each entry carries its own row (what was set there), the
   * resolved dial, and for top categories the evidence toward "send".
   */
  async list(workspaceId) {
    const ws = Number(workspaceId);
    const calibration = await this.calibration(ws).catch(() => ({}));
    const [rows, cats, articleCounts, runCounts] = await Promise.all([
      this.rows(ws, { fresh: true }).catch(() => []),
      this._categories(ws),
      Promise.resolve()
        .then(() => prisma.knowledgeArticle.groupBy({ by: ['categoryId'], where: { workspaceId: ws, status: 'published' }, _count: true }))
        .catch(() => []),
      Promise.resolve()
        .then(() => prisma.autoHelpRun.groupBy({
          by: ['categoryId', 'status'],
          where: { workspaceId: ws, trigger: 'categorized', categoryId: { not: null }, createdAt: { gte: new Date(Date.now() - 30 * 86400e3) } },
          _count: true,
        }))
        .catch(() => []),
    ]);
    const byId = new Map((rows || []).map((r) => [Number(r.categoryId), r]));
    const articles = new Map((articleCounts || []).map((r) => [Number(r.categoryId) || 0, Number(r._count) || 0]));
    const runs = new Map();
    for (const r of runCounts || []) {
      const key = Number(r.categoryId);
      const cur = runs.get(key) || { drafted: 0, answered: 0, total: 0 };
      const n = Number(r._count) || 0;
      cur.total += n;
      if (['drafted', 'staged', 'sent'].includes(r.status)) cur.answered += n;
      runs.set(key, cur);
    }
    const tops = (cats || []).filter((c) => c.parentId === null);
    const categories = [];
    for (const top of tops) {
      const resolved = resolvePolicy(rows, { categoryId: top.id });
      const readiness = await this.cachedCategoryReadiness(ws, top.id, { alwaysChecked: resolved.alwaysChecked });
      categories.push({
        id: top.id,
        name: top.name,
        own: rowView(byId.get(top.id)),
        resolved,
        readiness,
        // How often "sure" was right here, and whether it still counts as sure.
        calibration: calibration[top.id] || null,
        highReliable: highReliable(calibration[top.id]?.high),
        articles: articles.get(top.id) || 0,
        runs30: runs.get(top.id) || { drafted: 0, answered: 0, total: 0 },
        subcategories: (cats || []).filter((c) => c.parentId === top.id).map((sub) => ({
          id: sub.id,
          name: sub.name,
          own: rowView(byId.get(sub.id)),
          resolved: resolvePolicy(rows, { categoryId: top.id, subcategoryId: sub.id }),
        })),
      });
    }
    return {
      levels: LEVELS.map((value) => ({ value, label: LEVEL_LABELS[value] })),
      defaults: { level: DEFAULT_LEVEL, bar: DEFAULT_BAR },
      readinessBar: READINESS,
      calibrationBar: { minJudged: CALIBRATION_MIN_JUDGED, minRightPct: CALIBRATION_MIN_RIGHT_PCT, days: CALIBRATION_DAYS },
      default: { own: rowView(byId.get(DEFAULT_CATEGORY_ID)), resolved: resolvePolicy(rows, {}) },
      categories,
    };
  }

  /**
   * Set (or clear back to "inherit") a category's row. categoryId 0 = the
   * workspace default. "send" is refused for an always-checked category and
   * until the top category met the readiness bar.
   */
  async upsert(workspaceId, categoryId, input = {}, actor = null) {
    const ws = Number(workspaceId);
    const cat = Number(categoryId);
    if (!Number.isInteger(cat) || cat < 0) throw new ValidationError('Unknown category');
    const data = normalizePolicyInput(input);
    let topId = null;
    if (cat !== DEFAULT_CATEGORY_ID) {
      const row = await Promise.resolve()
        .then(() => prisma.competencyCategory.findFirst({ where: { id: cat, workspaceId: ws }, select: { id: true, parentId: true } }))
        .catch(() => null);
      if (!row) throw new NotFoundError('Category not found in this workspace');
      topId = row.parentId || row.id;
    }
    const rows = await this.rows(ws, { fresh: true });
    const existing = rows.find((r) => Number(r.categoryId) === cat) || null;
    const merged = { ...(existing || { categoryId: cat }), ...data };
    const others = rows.filter((r) => Number(r.categoryId) !== cat);
    const resolved = cat === DEFAULT_CATEGORY_ID
      ? resolvePolicy([...others, merged], {})
      : resolvePolicy([...others, merged], topId === cat ? { categoryId: cat } : { categoryId: topId, subcategoryId: cat });
    const wantsSend = [data.dayLevel, data.nightLevel].includes('send');
    if (wantsSend) {
      // The default row covers every category, earned or not: it can never send.
      if (cat === DEFAULT_CATEGORY_ID) throw lockError('"Send when sure" is set per category, once that category has earned it', 'knowledge_send_default');
      if (resolved.alwaysChecked) throw lockError(SEND_ALWAYS_CHECKED_MESSAGE, 'knowledge_send_always_checked');
      const readiness = await this.categoryReadiness(ws, topId, { alwaysChecked: false });
      if (!readiness.met) throw lockError(SEND_LOCKED_MESSAGE, 'knowledge_send_not_earned', { readiness });
    }
    // Marking a category "always checked" pulls an existing "send" back to "suggest".
    if (data.alwaysChecked === true) {
      if (merged.dayLevel === 'send') data.dayLevel = 'suggest';
      if (merged.nightLevel === 'send') data.nightLevel = 'suggest';
    }
    const by = actor?.email || actor?.name || null;
    await prisma.knowledgeCategoryPolicy.upsert({
      where: { workspaceId_categoryId: { workspaceId: ws, categoryId: cat } },
      create: { workspaceId: ws, categoryId: cat, ...data, updatedBy: by },
      update: { ...data, updatedBy: by },
    });
    this.clearCache(ws);
    logger.info(`Answer policy (ws ${ws}, category ${cat}) set by ${by || 'unknown'}: ${JSON.stringify(data)}`);
    return this.list(ws);
  }
}

const knowledgeAnswerPolicy = new KnowledgeAnswerPolicyService();
export default knowledgeAnswerPolicy;
