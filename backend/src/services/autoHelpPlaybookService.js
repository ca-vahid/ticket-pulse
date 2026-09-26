/**
 * Auto-help playbooks + per-workspace settings (Auto-help P0,
 * plans/AUTO_HELP_PLAN.md).
 *
 * A playbook is "how we answer this kind of request": the category (and
 * optionally subcategories) it covers, keyword include/exclude rules, the
 * instructions the model follows, which read-only tools it may call, which
 * knowledge it may quote, and the follow-up rhythm used once sending exists.
 *
 * Modes (P1, plans/AUTO_HELP_P1_PLAN.md):
 *   shadow   drafted and recorded, never sent (the default)
 *   approve  staged on the ticket for an agent to send — needs the
 *            workspace's approve switch (settings.approveModeEnabled)
 *   auto     sent without a person — refused unless auto sending is allowed
 *            in this build (AUTO_MODE_BUILD_ENABLED, false) AND the playbook
 *            meets the readiness gate AND it is not sensitive.
 * Sensitive playbooks (password / MFA / access / security) are approve-only.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { AUTO_HELP_TOOL_NAMES } from './autoHelpTools.js';
import { containsWordForm as containsWord } from '../utils/wordMatch.js';
import { READINESS, evaluateReadiness, readinessEvidence, SENT_DECISIONS } from './autoHelpOutcomes.js';

export const AUTO_HELP_MODES = Object.freeze(['shadow', 'approve', 'auto']);
export const DEFAULT_MODE = 'shadow';
/** @deprecated P0 name for DEFAULT_MODE. */
export const P0_MODE = DEFAULT_MODE;
/**
 * Nothing sends on its own until Vahid switches this on in code (P1 review,
 * 26 Sep 2026). The readiness gate is enforced on top of it.
 */
export const AUTO_MODE_BUILD_ENABLED = false;
export const AUTO_MODE_LOCKED_MESSAGE = 'Auto sending is switched off in this build';
export const APPROVE_OFF_MESSAGE = 'Switch approve mode on for this workspace first (the Auto-help switches at the top of Knowledge)';
export const SENSITIVE_AUTO_MESSAGE = 'A sensitive playbook (password, MFA, access, security) is approve-only — it never sends on its own';
export const AUTO_NOT_READY_MESSAGE = 'This playbook has not met the readiness bar for auto mode yet';
/** @deprecated kept for older callers; the P1 locks carry their own messages. */
export const MODE_LOCKED_MESSAGE = AUTO_MODE_LOCKED_MESSAGE;
export const MAX_MONTHLY_COST_CAP_USD = 100000;
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
/**
 * "Always stay quiet when" (26 Sep 2026): the workspace's hard stops, given to
 * the model before every playbook's own list. Same three lines as the SQL
 * column default (migration 20260926020000) and the Prisma @default.
 */
export const DEFAULT_ALWAYS_STAY_QUIET = Object.freeze([
  'Any sign of a security incident or a possibly compromised account (phishing, suspicious sign-ins, hacked, breach)',
  'The requester is complaining about IT or is frustrated with a previous answer',
  'HR, legal, or personal matters',
]);
export const MAX_STAY_QUIET = 20;
/** How long enabledState() trusts its per-workspace read. */
export const ENABLED_CACHE_MS = 60e3;
export const MAX_STAY_QUIET_CHARS = 300;

const MAX_KEYWORDS = 30;
const MAX_INSTRUCTIONS = 8000;
// Fields whose change makes a different playbook (runs record the version).
const VERSIONED_FIELDS = ['name', 'categoryId', 'subcategoryIds', 'match', 'instructions', 'instructionsAreSource', 'stayQuietWhen', 'allowedTools', 'kbScope', 'minConfidence', 'followUp', 'onHelp'];

function lockError(message, code) {
  const err = new ValidationError(message);
  err.code = code;
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

/**
 * A "stay quiet when" list: one condition per entry (a string array, or text
 * with one per line), trimmed, whitespace collapsed, a leading "- " / "1." / "•"
 * dropped, case-insensitive duplicates removed, at most MAX_STAY_QUIET entries
 * of MAX_STAY_QUIET_CHARS each. Exported for tests.
 */
export function cleanStayQuiet(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(/\r?\n/);
  const out = [];
  for (const item of raw) {
    const line = String(item ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:[-*•]|\d{1,2}[.)])\s*/, '')
      .trim()
      .slice(0, MAX_STAY_QUIET_CHARS);
    if (line && !out.some((x) => x.toLowerCase() === line.toLowerCase())) out.push(line);
    if (out.length >= MAX_STAY_QUIET) break;
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

/**
 * Validated create/update data. The mode is only checked for shape here —
 * whether approve / auto are allowed depends on the workspace and the
 * playbook's record (AutoHelpPlaybookService._assertModeAllowed).
 */
export function normalizePlaybookInput(input = {}, { partial = false } = {}) {
  const data = {};
  if (input.mode !== undefined && input.mode !== null) {
    if (!AUTO_HELP_MODES.includes(input.mode)) throw new ValidationError(`mode must be one of: ${AUTO_HELP_MODES.join(', ')}`);
    data.mode = input.mode;
  } else if (!partial) {
    data.mode = DEFAULT_MODE;
  }
  if (!partial || input.sensitive !== undefined) data.sensitive = input.sensitive === true;
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
  if (!partial || input.stayQuietWhen !== undefined) data.stayQuietWhen = cleanStayQuiet(input.stayQuietWhen);
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
    mode: AUTO_HELP_MODES.includes(row.mode) ? row.mode : DEFAULT_MODE,
    sensitive: row.sensitive === true,
    instructionsAreSource: row.instructionsAreSource === true,
    stayQuietWhen: Array.isArray(row.stayQuietWhen) ? row.stayQuietWhen : [],
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
  _enabledCache = new Map();

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

  /**
   * Server-side mode rules (P1). approve needs the workspace switch; auto
   * needs the build switch, a non-sensitive playbook and the readiness gate.
   */
  async _assertModeAllowed(workspaceId, { mode, sensitive, playbookId = null }) {
    if (mode === 'approve' || mode === 'auto') {
      const settings = await this.getSettings(workspaceId);
      if (!settings.approveModeEnabled) throw lockError(APPROVE_OFF_MESSAGE, 'auto_help_approve_off');
    }
    if (mode !== 'auto') return;
    if (sensitive) throw lockError(SENSITIVE_AUTO_MESSAGE, 'auto_help_sensitive');
    if (!this.autoModeAllowed()) throw lockError(AUTO_MODE_LOCKED_MESSAGE, 'auto_help_auto_locked');
    const readiness = playbookId ? await this.readiness(workspaceId, playbookId, { sensitive }) : { met: false };
    if (!readiness.met) {
      const err = lockError(AUTO_NOT_READY_MESSAGE, 'auto_help_not_ready');
      err.details = { readiness };
      throw err;
    }
  }

  /** The build switch for auto sending (a method so tests can stub it). */
  autoModeAllowed() {
    return AUTO_MODE_BUILD_ENABLED === true;
  }

  /**
   * The auto-mode readiness gate for one playbook, from its recorded runs
   * (autoHelpOutcomes.evaluateReadiness). Never throws: a missing table reads
   * as "no evidence" (not met).
   */
  async readiness(workspaceId, playbookId, { sensitive = null } = {}) {
    const ws = Number(workspaceId);
    const pid = Number(playbookId);
    const [rows, pb] = await Promise.all([
      Promise.resolve().then(() => prisma.autoHelpRun.findMany({
        where: { workspaceId: ws, playbookId: pid, OR: [{ reviewVerdict: { not: null } }, { decision: { not: null } }] },
        select: { reviewVerdict: true, reviewedAt: true, decision: true, outcome: true, trigger: true, playbookVersion: true },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      })).catch(() => []),
      Promise.resolve().then(() => prisma.autoHelpPlaybook.findFirst({ where: { id: pid, workspaceId: ws }, select: { sensitive: true, version: true } })).catch(() => null),
    ]);
    // Only the current version's evidence, and never backtest / test runs
    // (autoHelpOutcomes.readinessEvidence). No playbook row = no evidence.
    const evidence = pb
      ? readinessEvidence(rows || [], { currentVersion: pb.version ?? 1 })
      : readinessEvidence([], {});
    return evaluateReadiness({
      ...evidence,
      sensitive: sensitive === null ? pb?.sensitive === true : sensitive === true,
    }, READINESS);
  }

  /**
   * What a playbook actually does right now: its saved mode, narrowed by the
   * workspace switches and the build / readiness / sensitive rules. Auto that
   * is not allowed falls back to approve (a person sends), never to silence.
   */
  async effectiveMode(workspaceId, playbook, settings = null) {
    const s = settings || await this.getSettings(workspaceId);
    const mode = playbookView(playbook).mode;
    if (mode === 'shadow' || !s.approveModeEnabled) return 'shadow';
    if (mode === 'approve') return 'approve';
    if (playbook.sensitive === true || !this.autoModeAllowed()) return 'approve';
    const readiness = await this.readiness(workspaceId, playbook.id, { sensitive: playbook.sensitive === true });
    return readiness.met ? 'auto' : 'approve';
  }

  async create(workspaceId, input, actor = null) {
    const data = normalizePlaybookInput(input);
    await this._assertModeAllowed(workspaceId, { mode: data.mode, sensitive: data.sensitive, playbookId: null });
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
    // Mode rules apply when the mode changes, or when a change makes the
    // current mode invalid (marking an auto playbook sensitive).
    if (data.mode !== undefined && data.mode !== existing.mode) {
      await this._assertModeAllowed(workspaceId, { mode: merged.mode, sensitive: merged.sensitive, playbookId: existing.id });
    } else if (merged.mode === 'auto' && merged.sensitive) {
      throw lockError(SENSITIVE_AUTO_MESSAGE, 'auto_help_sensitive');
    }
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

  /**
   * Delete a playbook — refused while answers it sent are still in their
   * follow-up loop (a deleted playbook must never leave a loop without its
   * rules; loops freeze their plan at send, and the sweep stops a loop whose
   * playbook is gone). Switch it off instead; delete once they finish.
   */
  async remove(workspaceId, id) {
    const existing = await this.get(workspaceId, id);
    const openLoops = await Promise.resolve()
      .then(() => prisma.autoHelpRun.count({
        where: { workspaceId: Number(workspaceId), playbookId: existing.id, decision: { in: SENT_DECISIONS }, outcome: null },
      }))
      .catch(() => null);
    if (openLoops === null) {
      throw lockError('Could not check this playbook for answers still waiting on requesters — try again, or switch it off instead', 'auto_help_playbook_in_use');
    }
    if (openLoops > 0) {
      throw lockError(
        `${openLoops} answer${openLoops === 1 ? ' from this playbook is' : 's from this playbook are'} still waiting on the requester. Switch the playbook off instead — it can be deleted once those finish.`,
        'auto_help_playbook_in_use',
      );
    }
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
    const cap = row?.monthlyCostCapUsd;
    return {
      workspaceId: Number(workspaceId),
      enabled: row?.enabled === true,
      enabledAt: row?.enabledAt || null,
      disclosureEnabled: row ? row.disclosureEnabled !== false : true,
      disclosureText: row?.disclosureText || DEFAULT_DISCLOSURE_TEXT,
      approveModeEnabled: row?.approveModeEnabled === true,
      monthlyCostCapUsd: cap !== null && cap !== undefined && Number.isFinite(Number(cap)) ? Number(cap) : null,
      thankOnConfirm: row?.thankOnConfirm === true,
      // W4: an auto-sent answer stops the first-response clock only when on (off).
      countsAsFirstResponse: row?.countsAsFirstResponse === true,
      // No row yet = the seeded defaults; a list someone emptied stays empty.
      alwaysStayQuietWhen: Array.isArray(row?.alwaysStayQuietWhen) ? row.alwaysStayQuietWhen : [...DEFAULT_ALWAYS_STAY_QUIET],
      // Not a setting anyone can flip: the build decides (AUTO_MODE_BUILD_ENABLED).
      autoModeAllowed: this.autoModeAllowed(),
      autoModeLockedMessage: this.autoModeAllowed() ? null : AUTO_MODE_LOCKED_MESSAGE,
      mode: DEFAULT_MODE,
      updatedBy: row?.updatedBy || null,
      updatedAt: row?.updatedAt || null,
    };
  }

  async updateSettings(workspaceId, input = {}, actor = null) {
    // Modes are per playbook; the build decides whether auto can exist at all.
    if (input.mode !== undefined && input.mode !== null && input.mode !== DEFAULT_MODE) {
      throw lockError('Modes are chosen per playbook', 'auto_help_mode_per_playbook');
    }
    if (input.autoModeAllowed === true && !this.autoModeAllowed()) throw lockError(AUTO_MODE_LOCKED_MESSAGE, 'auto_help_auto_locked');
    const data = {};
    if (input.enabled !== undefined) data.enabled = input.enabled === true;
    if (input.approveModeEnabled !== undefined) data.approveModeEnabled = input.approveModeEnabled === true;
    if (input.thankOnConfirm !== undefined) data.thankOnConfirm = input.thankOnConfirm === true;
    if (input.countsAsFirstResponse !== undefined) data.countsAsFirstResponse = input.countsAsFirstResponse === true;
    if (input.alwaysStayQuietWhen !== undefined) data.alwaysStayQuietWhen = cleanStayQuiet(input.alwaysStayQuietWhen);
    if (input.monthlyCostCapUsd !== undefined) {
      if (input.monthlyCostCapUsd === null || input.monthlyCostCapUsd === '') {
        data.monthlyCostCapUsd = null;
      } else {
        const n = Number(input.monthlyCostCapUsd);
        if (!Number.isFinite(n) || n < 0 || n > MAX_MONTHLY_COST_CAP_USD) {
          throw new ValidationError(`The monthly cost cap must be between 0 and ${MAX_MONTHLY_COST_CAP_USD} US dollars (empty = no cap)`);
        }
        data.monthlyCostCapUsd = Math.round(n * 100) / 100;
      }
    }
    if (input.disclosureEnabled !== undefined) data.disclosureEnabled = input.disclosureEnabled !== false;
    if (input.disclosureText !== undefined) {
      const text = String(input.disclosureText ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
      data.disclosureText = text || null;
    }
    data.updatedBy = actor?.email || actor?.name || null;
    const ws = Number(workspaceId);
    // Audit nice-to-have 2: when Auto-help was switched ON (off -> on only).
    // The catch-up sweep never re-queues a settle from before this moment.
    if (data.enabled === true) {
      const before = await Promise.resolve()
        .then(() => prisma.autoHelpSettings.findUnique({ where: { workspaceId: ws } }))
        .catch(() => null);
      if (before?.enabled !== true) data.enabledAt = new Date();
    }
    this._enabledCache.delete(ws);
    await prisma.autoHelpSettings.upsert({
      where: { workspaceId: ws },
      create: { workspaceId: ws, ...data },
      update: data,
    });
    this._enabledCache.delete(ws);
    return this.getSettings(ws);
  }

  /**
   * { enabled, enabledAt } for hot paths that only need the switch (the
   * pipeline's evidence block and intake settle, the catch-up sweep), cached
   * ENABLED_CACHE_MS per workspace so a workspace without Auto-help costs no
   * query per pipeline run. Fails soft to "off".
   */
  async enabledState(workspaceId, { now = Date.now() } = {}) {
    const ws = Number(workspaceId);
    const hit = this._enabledCache.get(ws);
    if (hit && now - hit.at < ENABLED_CACHE_MS) return hit.value;
    const row = await Promise.resolve()
      .then(() => prisma.autoHelpSettings.findUnique({ where: { workspaceId: ws } }))
      .catch(() => null);
    const value = { enabled: row?.enabled === true, enabledAt: row?.enabledAt || null };
    this._enabledCache.set(ws, { at: now, value });
    return value;
  }
}

const autoHelpPlaybookService = new AutoHelpPlaybookService();
export default autoHelpPlaybookService;
export { AutoHelpPlaybookService };
