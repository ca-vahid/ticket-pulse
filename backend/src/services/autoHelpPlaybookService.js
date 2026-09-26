/**
 * Auto-help playbooks + per-workspace settings (Auto-help P0,
 * plans/AUTO_HELP_PLAN.md).
 *
 * A playbook is "how we answer this kind of request": the category (and
 * optionally subcategories) it covers, keyword include/exclude rules, the
 * instructions the model follows, which read-only tools it may call, which
 * knowledge it may quote, and the follow-up rhythm used once sending exists.
 *
 * P0 is shadow-only: every playbook is stored with mode 'shadow' and any
 * attempt to save approve/auto is refused with MODE_LOCKED_MESSAGE.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { AUTO_HELP_TOOL_NAMES } from './autoHelpTools.js';
import { containsWordForm as containsWord } from '../utils/wordMatch.js';

export const AUTO_HELP_MODES = Object.freeze(['shadow', 'approve', 'auto']);
export const P0_MODE = 'shadow';
export const MODE_LOCKED_MESSAGE = 'Approve and auto modes come in the next phase';
export const ON_SILENCE = Object.freeze(['resolve', 'leave_open']);
// {{days}} is filled from followUp.closeAfterBusinessDays ("2 business days").
export const DEFAULT_NUDGE_TEXT = 'Hope that sorted it out. If we don\'t hear back, we\'ll close this ticket in {{days}} — just reply if you still need a hand.';
export const DEFAULT_FOLLOW_UP = Object.freeze({
  nudgeAfterBusinessDays: 2,
  closeAfterBusinessDays: 2,
  nudgeText: DEFAULT_NUDGE_TEXT,
  onSilence: 'resolve',
});
export const DEFAULT_DISCLOSURE_TEXT = 'This is an automated first answer from the {{workspace}} team. Reply any time to reach a person.';
export const DEFAULT_KB_SCOPE = Object.freeze({ mode: 'all', tags: [], includeVerifiedSolutions: true });
export const DEFAULT_ALLOWED_TOOLS = Object.freeze(['search_knowledge', 'get_article', 'get_ticket_details']);

const MAX_KEYWORDS = 30;
const MAX_INSTRUCTIONS = 8000;
// Fields whose change makes a different playbook (runs record the version).
const VERSIONED_FIELDS = ['name', 'categoryId', 'subcategoryIds', 'match', 'instructions', 'instructionsAreSource', 'allowedTools', 'kbScope', 'minConfidence', 'followUp', 'onHelp'];

function modeLockedError() {
  const err = new ValidationError(MODE_LOCKED_MESSAGE);
  err.code = 'auto_help_mode_locked';
  return err;
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanWords(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(/[\n,]/);
  const out = [];
  for (const item of raw) {
    const w = String(item || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (w && !out.some((x) => x.toLowerCase() === w.toLowerCase())) out.push(w);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeFollowUp(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const nudgeText = String(src.nudgeText ?? '').trim().slice(0, 2000);
  return {
    nudgeAfterBusinessDays: clampInt(src.nudgeAfterBusinessDays, 1, 30, DEFAULT_FOLLOW_UP.nudgeAfterBusinessDays),
    closeAfterBusinessDays: clampInt(src.closeAfterBusinessDays, 1, 30, DEFAULT_FOLLOW_UP.closeAfterBusinessDays),
    nudgeText: nudgeText || DEFAULT_FOLLOW_UP.nudgeText,
    onSilence: ON_SILENCE.includes(src.onSilence) ? src.onSilence : DEFAULT_FOLLOW_UP.onSilence,
  };
}

function businessDays(n) {
  return `${n} business day${n === 1 ? '' : 's'}`;
}

/** The check-in message with {{days}} filled from closeAfterBusinessDays. */
export function renderNudgeText(followUp) {
  const fu = normalizeFollowUp(followUp);
  return fu.nudgeText.replace(/\{\{\s*days\s*\}\}/gi, businessDays(fu.closeAfterBusinessDays));
}

export function normalizeKbScope(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const tags = cleanWords(src.tags);
  return {
    mode: src.mode === 'tags' && tags.length ? 'tags' : 'all',
    tags,
    includeVerifiedSolutions: src.includeVerifiedSolutions !== false,
  };
}

export function normalizeMatch(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { keywords: cleanWords(src.keywords), excludeKeywords: cleanWords(src.excludeKeywords) };
}

/** Validated create/update data. Throws the mode-lock error for approve/auto. */
export function normalizePlaybookInput(input = {}, { partial = false } = {}) {
  const data = {};
  if (input.mode !== undefined && input.mode !== null && input.mode !== P0_MODE) {
    if (!AUTO_HELP_MODES.includes(input.mode)) throw new ValidationError(`mode must be one of: ${AUTO_HELP_MODES.join(', ')}`);
    throw modeLockedError();
  }
  data.mode = P0_MODE;
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new ValidationError('Give the playbook a name');
    data.name = name.slice(0, 200);
  }
  if (!partial || input.enabled !== undefined) data.enabled = input.enabled === true;
  if (!partial || input.categoryId !== undefined) data.categoryId = intOrNull(input.categoryId);
  if (!partial || input.subcategoryIds !== undefined) {
    data.subcategoryIds = [...new Set((Array.isArray(input.subcategoryIds) ? input.subcategoryIds : []).map(intOrNull).filter(Boolean))];
  }
  if (!partial || input.match !== undefined) data.match = normalizeMatch(input.match);
  if (!partial || input.instructions !== undefined) data.instructions = String(input.instructions ?? '').trim().slice(0, MAX_INSTRUCTIONS);
  if (!partial || input.instructionsAreSource !== undefined) data.instructionsAreSource = input.instructionsAreSource === true;
  if (!partial || input.allowedTools !== undefined) {
    const tools = Array.isArray(input.allowedTools) ? input.allowedTools : [...DEFAULT_ALLOWED_TOOLS];
    data.allowedTools = [...new Set(tools.map(String).filter((t) => AUTO_HELP_TOOL_NAMES.includes(t)))];
  }
  if (!partial || input.kbScope !== undefined) data.kbScope = normalizeKbScope(input.kbScope);
  if (!partial || input.minConfidence !== undefined) {
    const n = Number(input.minConfidence ?? 0.8);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new ValidationError('minConfidence must be between 0 and 1');
    data.minConfidence = Math.round(n * 100) / 100;
  }
  if (!partial || input.followUp !== undefined) data.followUp = normalizeFollowUp(input.followUp);
  if (!partial || input.onHelp !== undefined) {
    const onHelp = String(input.onHelp ?? 'assign_normally').trim();
    if (onHelp !== 'assign_normally' && !/^group:\d+$/.test(onHelp)) throw new ValidationError('onHelp must be assign_normally or group:<id>');
    data.onHelp = onHelp;
  }
  if (!partial || input.priority !== undefined) data.priority = clampInt(input.priority, 0, 1000, 100);
  if (data.enabled && data.categoryId === null) throw new ValidationError('Pick a category before switching the playbook on');
  return data;
}

/** API shape with defaults filled in (rows written before a field existed). */
export function playbookView(row) {
  if (!row) return null;
  return {
    ...row,
    mode: P0_MODE,
    instructionsAreSource: row.instructionsAreSource === true,
    match: normalizeMatch(row.match),
    kbScope: normalizeKbScope(row.kbScope),
    followUp: normalizeFollowUp(row.followUp),
    allowedTools: Array.isArray(row.allowedTools) ? row.allowedTools : [],
    subcategoryIds: Array.isArray(row.subcategoryIds) ? row.subcategoryIds : [],
  };
}

// Legal footers under a signature ("If you received this in error…") are not
// the request: without this cut, "error" in BGC's own disclaimer kept the
// install playbook off a plain "please install Bluebeam" ticket (QA 09-25).
const DISCLAIMER_START = /^.*\b(?:privacy policy|confidentiality notice|disclaimer:|the information (?:transmitted|contained) (?:herein|in this)|this (?:e-?mail|message|communication)(?: and any attachments)? (?:is|are|may be|may contain) (?:confidential|intended|privileged)|if you (?:have )?received this (?:e-?mail |message |communication )?in error)/im;

/** Subject + description, minus a trailing legal disclaimer. Exported for tests. */
export function matchText(ticket) {
  const body = String(ticket?.descriptionText || ticket?.description || '');
  const cut = body.search(DISCLAIMER_START);
  return `${ticket?.subject || ''}\n${cut > 0 ? body.slice(0, cut) : body}`;
}

function haystack(ticket) {
  return matchText(ticket);
}

/**
 * Why a playbook does or does not fit a ticket. Pure.
 * @returns {{ matches: boolean, reason: string }}
 */
export function explainMatch(playbook, ticket, { ignoreEnabled = false } = {}) {
  const pb = playbookView(playbook);
  if (!ignoreEnabled && !pb.enabled) return { matches: false, reason: 'Playbook is off' };
  if (!pb.categoryId) return { matches: false, reason: 'Playbook has no category' };
  if (Number(ticket?.internalCategoryId) !== pb.categoryId) return { matches: false, reason: 'Different category' };
  if (pb.subcategoryIds.length && !pb.subcategoryIds.includes(Number(ticket?.internalSubcategoryId))) {
    return { matches: false, reason: 'Subcategory not covered' };
  }
  const text = haystack(ticket);
  const { keywords, excludeKeywords } = pb.match;
  // Whole words only, case-insensitive: "app" never matches "approval".
  if (keywords.length && !keywords.some((k) => containsWord(text, k))) {
    return { matches: false, reason: 'None of the keywords appear' };
  }
  const excluded = excludeKeywords.find((k) => containsWord(text, k));
  if (excluded) return { matches: false, reason: `Excluded word "${excluded}" appears` };
  return { matches: true, reason: 'Matches' };
}

/**
 * The playbook that answers this ticket: enabled, category equal, subcategory
 * covered (or none listed), keyword rules pass. Highest priority wins; ties
 * go to the older playbook (lower id). Pure.
 */
export function matchPlaybook(ticket, playbooks = []) {
  const fits = (playbooks || []).filter((pb) => explainMatch(pb, ticket).matches);
  fits.sort((a, b) => (Number(b.priority ?? 100) - Number(a.priority ?? 100)) || (a.id - b.id));
  return fits[0] || null;
}

class AutoHelpPlaybookService {
  async list(workspaceId) {
    const ws = Number(workspaceId);
    const [rows, lastRuns] = await Promise.all([
      Promise.resolve().then(() => prisma.autoHelpPlaybook.findMany({ where: { workspaceId: ws }, orderBy: [{ priority: 'desc' }, { id: 'asc' }] }))
        .catch((err) => { logger.warn(`Auto-help playbook list failed (ws ${ws}): ${err.message}`); return []; }),
      Promise.resolve().then(() => prisma.autoHelpRun.groupBy({
        by: ['playbookId'],
        where: { workspaceId: ws, playbookId: { not: null } },
        _max: { createdAt: true },
        _count: { _all: true },
      })).catch(() => []),
    ]);
    const byId = new Map((lastRuns || []).map((r) => [r.playbookId, { lastRunAt: r._max?.createdAt || null, runCount: r._count?._all || 0 }]));
    return rows.map((r) => ({ ...playbookView(r), lastRunAt: byId.get(r.id)?.lastRunAt || null, runCount: byId.get(r.id)?.runCount || 0 }));
  }

  async get(workspaceId, id) {
    const row = await Promise.resolve()
      .then(() => prisma.autoHelpPlaybook.findFirst({ where: { id: Number(id), workspaceId: Number(workspaceId) } }))
      .catch(() => null);
    if (!row) throw new NotFoundError('Playbook not found');
    return playbookView(row);
  }

  async create(workspaceId, input, actor = null) {
    const data = normalizePlaybookInput(input);
    const row = await prisma.autoHelpPlaybook.create({
      data: {
        ...data,
        workspaceId: Number(workspaceId),
        version: 1,
        createdBy: actor?.email || actor?.name || null,
        updatedBy: actor?.email || actor?.name || null,
      },
    });
    return playbookView(row);
  }

  async update(workspaceId, id, input, actor = null) {
    const existing = await this.get(workspaceId, id);
    const data = normalizePlaybookInput(input, { partial: true });
    const merged = { ...existing, ...data };
    if (merged.enabled && !merged.categoryId) throw new ValidationError('Pick a category before switching the playbook on');
    const changed = VERSIONED_FIELDS.some((f) => data[f] !== undefined && JSON.stringify(data[f]) !== JSON.stringify(existing[f]));
    const row = await prisma.autoHelpPlaybook.update({
      where: { id: existing.id },
      data: {
        ...data,
        ...(changed ? { version: (existing.version || 1) + 1 } : {}),
        updatedBy: actor?.email || actor?.name || null,
      },
    });
    return playbookView(row);
  }

  async remove(workspaceId, id) {
    const existing = await this.get(workspaceId, id);
    await prisma.autoHelpPlaybook.delete({ where: { id: existing.id } });
    return { id: existing.id, deleted: true };
  }

  /** Enabled playbooks of the workspace, then matchPlaybook. */
  async matchForTicket(workspaceId, ticket) {
    const rows = await Promise.resolve()
      .then(() => prisma.autoHelpPlaybook.findMany({ where: { workspaceId: Number(workspaceId), enabled: true } }))
      .catch((err) => { logger.warn(`Auto-help playbook match failed (ws ${workspaceId}): ${err.message}`); return []; });
    const hit = matchPlaybook(ticket, rows);
    return hit ? playbookView(hit) : null;
  }

  // ---------- settings ----------

  async getSettings(workspaceId) {
    const row = await Promise.resolve()
      .then(() => prisma.autoHelpSettings.findUnique({ where: { workspaceId: Number(workspaceId) } }))
      .catch(() => null);
    return {
      workspaceId: Number(workspaceId),
      enabled: row?.enabled === true,
      disclosureEnabled: row ? row.disclosureEnabled !== false : true,
      disclosureText: row?.disclosureText || DEFAULT_DISCLOSURE_TEXT,
      mode: P0_MODE,
      updatedBy: row?.updatedBy || null,
      updatedAt: row?.updatedAt || null,
    };
  }

  async updateSettings(workspaceId, input = {}, actor = null) {
    if (input.mode !== undefined && input.mode !== null && input.mode !== P0_MODE) throw modeLockedError();
    const data = {};
    if (input.enabled !== undefined) data.enabled = input.enabled === true;
    if (input.disclosureEnabled !== undefined) data.disclosureEnabled = input.disclosureEnabled !== false;
    if (input.disclosureText !== undefined) {
      const text = String(input.disclosureText ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
      data.disclosureText = text || null;
    }
    data.updatedBy = actor?.email || actor?.name || null;
    const ws = Number(workspaceId);
    await prisma.autoHelpSettings.upsert({
      where: { workspaceId: ws },
      create: { workspaceId: ws, ...data },
      update: data,
    });
    return this.getSettings(ws);
  }
}

const autoHelpPlaybookService = new AutoHelpPlaybookService();
export default autoHelpPlaybookService;
export { AutoHelpPlaybookService };
