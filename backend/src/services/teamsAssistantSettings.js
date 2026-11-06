/**
 * Teams assistant settings, the per-person switch, the monthly cap and the
 * audit log reads (plans/TEAMS_BOT_COMMANDS_PLAN.md; product decisions 5 Nov 2026).
 *
 *  - Per workspace (Settings -> Teams): mode off | shadow | pilot | on, the
 *    pilot people, the monthly AI cap (USD 25 by default, adjustable) and the
 *    "sensitive" switch (ticket subjects never go to the model there).
 *    No row = the defaults: every workspace Off, IT (workspace 1) in Shadow.
 *  - Per person (Mail & alerts -> Teams): "Ask Ticket Pulse in Teams
 *    (advanced)", on by default. Off = the bot behaves exactly as before.
 *  - The cap: this month's teams_assistant spend in ai_provider_attempts.
 *    At the cap the AI stops (keyword cards only) and the super admins get
 *    one e-mail per workspace per month, through the same transactional
 *    mail path as the sync-health alert.
 *
 * Every read degrades: a missing table (migration not applied yet) reads as
 * the defaults, a missing person row as "on", unreadable spend as "capped".
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';

export const ASSISTANT_OPERATION = 'teams_assistant';
export const ASSISTANT_MODES = Object.freeze(['off', 'shadow', 'pilot', 'on']);
export const DEFAULT_MONTHLY_CAP_USD = 25;
export const MAX_MONTHLY_CAP_USD = 1000;
export const RETENTION_DAYS = 180;
export const MAX_PILOT_PEOPLE = 50;
const CACHE_MS = 60_000;
const PERSON_CACHE_MS = 30_000;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const lc = (s) => String(s || '').trim().toLowerCase();

/** IT is workspace 1 (AGENTS.md); it starts in Shadow, everything else Off. */
export function defaultModeFor(workspaceId) {
  return Number(workspaceId) === 1 ? 'shadow' : 'off';
}

export function defaultSettings(workspaceId) {
  return { workspaceId: Number(workspaceId), mode: defaultModeFor(workspaceId), pilotEmails: [], monthlyCapUsd: DEFAULT_MONTHLY_CAP_USD, sensitive: false, capAlertedMonth: null, isDefault: true };
}

/** "YYYY-MM" of a moment in Pacific time (the cap and its e-mail are per Pacific month). */
export function pacificMonth(at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit' }).formatToParts(at);
    return `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
  } catch { return at.toISOString().slice(0, 7); }
}

/** 00:00 Pacific on the 1st of this month, as a Date. */
export function pacificMonthStart(at = new Date()) {
  const [y, m] = pacificMonth(at).split('-').map(Number);
  // Pacific is UTC-7 (PDT) or UTC-8 (PST): the candidate that reads 00:00 there.
  for (const offset of [7, 8]) {
    const d = new Date(Date.UTC(y, m - 1, 1, offset, 0, 0));
    try {
      const hh = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Vancouver', hour: '2-digit', hour12: false }).format(d);
      if (Number(hh) === 0) return d;
    } catch { break; }
  }
  return new Date(Date.UTC(y, m - 1, 1, 8, 0, 0));
}

function cleanEmails(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const v = lc(e);
    if (EMAIL_RE.test(v) && !out.includes(v)) out.push(v);
  }
  return out.slice(0, MAX_PILOT_PEOPLE);
}

function fromRow(row, workspaceId) {
  if (!row) return defaultSettings(workspaceId);
  const cap = Number(row.monthlyCapUsd);
  return {
    workspaceId: Number(workspaceId),
    mode: ASSISTANT_MODES.includes(row.mode) ? row.mode : defaultModeFor(workspaceId),
    pilotEmails: cleanEmails(row.pilotEmails),
    monthlyCapUsd: Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_MONTHLY_CAP_USD,
    sensitive: row.sensitive === true,
    capAlertedMonth: row.capAlertedMonth || null,
    updatedBy: row.updatedBy || null,
    updatedAt: row.updatedAt || null,
    isDefault: false,
  };
}

class TeamsAssistantSettings {
  constructor() {
    this.cache = new Map(); // workspaceId -> { at, value }
    this.people = new Map(); // email -> { at, enabled }
    this.spend = new Map(); // workspaceId -> { at, value }
    this.alerted = new Set(); // `${ws}|${month}` latched in this process
  }

  _table(name) {
    const t = prisma[name];
    return t && typeof t.findUnique === 'function' ? t : null;
  }

  async get(workspaceId) {
    const ws = Number(workspaceId);
    const hit = this.cache.get(ws);
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
    const table = this._table('teamsAssistantSetting');
    const row = table ? await Promise.resolve().then(() => table.findUnique({ where: { workspaceId: ws } })).catch(() => null) : null;
    const value = fromRow(row, ws);
    this.cache.set(ws, { at: Date.now(), value });
    return value;
  }

  async save(workspaceId, input = {}, actorEmail = null) {
    const ws = Number(workspaceId);
    const cur = await this.get(ws);
    const mode = input.mode === undefined ? cur.mode : String(input.mode);
    if (!ASSISTANT_MODES.includes(mode)) throw Object.assign(new Error('Pick Off, Shadow, Pilot or On'), { statusCode: 400 });
    let cap = input.monthlyCapUsd === undefined ? cur.monthlyCapUsd : Number(input.monthlyCapUsd);
    if (!Number.isFinite(cap) || cap < 1 || cap > MAX_MONTHLY_CAP_USD) throw Object.assign(new Error(`The monthly limit must be between $1 and $${MAX_MONTHLY_CAP_USD}`), { statusCode: 400 });
    cap = Math.round(cap * 100) / 100;
    const data = {
      mode,
      pilotEmails: input.pilotEmails === undefined ? cur.pilotEmails : cleanEmails(input.pilotEmails),
      monthlyCapUsd: cap,
      sensitive: input.sensitive === undefined ? cur.sensitive : input.sensitive === true,
      updatedBy: actorEmail ? lc(actorEmail) : null,
    };
    // A raised cap in a month that already hit it: the next hit e-mails again.
    if (cap > cur.monthlyCapUsd) data.capAlertedMonth = null;
    const table = this._table('teamsAssistantSetting');
    if (!table) throw Object.assign(new Error('The Teams assistant tables are not in the database yet (migration 20261105120000_teams_assistant)'), { statusCode: 503 });
    await table.upsert({ where: { workspaceId: ws }, update: data, create: { workspaceId: ws, ...data } });
    this.cache.delete(ws);
    this.spend.delete(ws);
    return this.get(ws);
  }

  // ------------------------------------------------------------ the per-person switch

  async personEnabled(email) {
    const key = lc(email);
    if (!key) return false;
    const hit = this.people.get(key);
    if (hit && hit.at > Date.now() - PERSON_CACHE_MS) return hit.enabled;
    const table = this._table('teamsAssistantPerson');
    const row = table ? await Promise.resolve().then(() => table.findUnique({ where: { email: key } })).catch(() => null) : null;
    const enabled = row?.enabled !== false;
    this.people.set(key, { at: Date.now(), enabled });
    if (this.people.size > 5000) this.people.clear();
    return enabled;
  }

  async setPersonEnabled(email, enabled) {
    const key = lc(email);
    if (!key) throw Object.assign(new Error('Sign in first'), { statusCode: 401 });
    const table = this._table('teamsAssistantPerson');
    if (!table) throw Object.assign(new Error('The Teams assistant tables are not in the database yet (migration 20261105120000_teams_assistant)'), { statusCode: 503 });
    await table.upsert({ where: { email: key }, update: { enabled: enabled === true }, create: { email: key, enabled: enabled === true } });
    this.people.delete(key);
    return this.personEnabled(key);
  }

  // ------------------------------------------------------------ the monthly cap

  /** This month's teams_assistant spend in a workspace. null = could not be read. */
  async monthSpendUsd(workspaceId, { fresh = false } = {}) {
    const ws = Number(workspaceId);
    const hit = this.spend.get(ws);
    if (!fresh && hit && hit.at > Date.now() - CACHE_MS) return hit.value;
    let value = null;
    try {
      const rows = await prisma.aiProviderAttempt.findMany({
        where: { workspaceId: ws, operation: ASSISTANT_OPERATION, startedAt: { gte: pacificMonthStart() } },
        select: { provider: true, model: true, inputTokens: true, outputTokens: true, cacheCreationInputTokens: true, cacheReadInputTokens: true },
        take: 100000,
      });
      const { costUsdFor } = await import('./tokenUsageService.js');
      const spent = (rows || []).reduce((sum, a) => sum + (Number(costUsdFor({
        provider: a.provider,
        model: a.model,
        inputTokens: Number(a.inputTokens) || 0,
        outputTokens: Number(a.outputTokens) || 0,
        cacheCreationInputTokens: Number(a.cacheCreationInputTokens) || 0,
        cacheReadInputTokens: Number(a.cacheReadInputTokens) || 0,
      })) || 0), 0);
      value = Math.round(spent * 1e4) / 1e4;
    } catch (err) {
      logger.warn(`Teams assistant: spend for workspace ${ws} unknown (${err.message}) — the AI stays off until it can be read`);
    }
    this.spend.set(ws, { at: Date.now(), value });
    return value;
  }

  /** { capUsd, spentUsd, exhausted, unknown } — unreadable spend counts as exhausted. */
  async capState(workspaceId, settings = null) {
    const s = settings || await this.get(workspaceId);
    const spentUsd = await this.monthSpendUsd(workspaceId);
    if (spentUsd === null) return { capUsd: s.monthlyCapUsd, spentUsd: null, exhausted: true, unknown: true };
    return { capUsd: s.monthlyCapUsd, spentUsd, exhausted: spentUsd >= s.monthlyCapUsd, unknown: false };
  }

  /** Count a turn's cost into the cached spend so the cap holds between reads. */
  addSpend(workspaceId, usd) {
    const hit = this.spend.get(Number(workspaceId));
    if (hit && hit.value !== null && Number.isFinite(Number(usd))) hit.value = Math.round((hit.value + Number(usd)) * 1e4) / 1e4;
  }

  /**
   * The cap was reached: e-mail the super admins once for this workspace and
   * month. Latched (row + process) BEFORE sending, so a broken mail path can
   * never turn into a storm. Never throws. Returns true when it sent.
   */
  async alertCapOnce(workspaceId, state, { workspaceName = null } = {}) {
    const ws = Number(workspaceId);
    const month = pacificMonth();
    const key = `${ws}|${month}`;
    if (this.alerted.has(key)) return false;
    this.alerted.add(key);
    try {
      const s = await this.get(ws);
      if (s.capAlertedMonth === month) return false;
      const table = this._table('teamsAssistantSetting');
      if (table) {
        await table.upsert({
          where: { workspaceId: ws },
          update: { capAlertedMonth: month },
          create: { workspaceId: ws, mode: s.mode, pilotEmails: s.pilotEmails, monthlyCapUsd: s.monthlyCapUsd, sensitive: s.sensitive, capAlertedMonth: month },
        });
        this.cache.delete(ws);
      }
      const { superAdminEmails } = await import('./reportRecipients.js');
      const to = await superAdminEmails();
      if (!to.length) { logger.warn(`Teams assistant: workspace ${ws} reached its monthly AI limit but no super admin e-mail is set`); return false; }
      const name = workspaceName || `workspace ${ws}`;
      const spent = state?.spentUsd === null || state?.spentUsd === undefined ? 'unknown' : `$${Number(state.spentUsd).toFixed(2)}`;
      const cap = `$${Number(state?.capUsd ?? s.monthlyCapUsd).toFixed(2)}`;
      const { resolvePublicBaseUrl } = await import('../utils/publicBaseUrl.js');
      const base = resolvePublicBaseUrl({ warn: () => {} });
      const html = `
        <p>The Teams assistant in <strong>${escapeHtml(name)}</strong> reached its monthly AI limit: ${spent} of ${cap} this month.</p>
        <p>Until the 1st, people who ask the bot a question get the keyword answers (the same lists, without AI). Nothing else changes.</p>
        <p>To raise the limit, open <a href="${base}/settings#teams">Settings → Teams → Ask Ticket Pulse in Teams</a>. You will not get this e-mail again for ${escapeHtml(name)} this month.</p>`;
      const { sendTransactionalEmail } = await import('./transactionalEmailService.js');
      const result = await sendTransactionalEmail({ workspaceId: ws, to, subject: `Ticket Pulse: the Teams assistant reached its monthly AI limit in ${name}`, html, label: 'teams-assistant-cap' });
      if (result?.sent) logger.warn(`Teams assistant: monthly AI limit reached in workspace ${ws}; ${to.length} super admin(s) e-mailed`);
      else logger.warn(`Teams assistant: monthly AI limit reached in workspace ${ws}; the e-mail did not go (${result?.reason || result?.error || 'unknown'})`);
      return result?.sent === true;
    } catch (err) {
      logger.warn(`Teams assistant: cap alert for workspace ${ws} failed (non-fatal): ${err.message}`);
      return false;
    }
  }

  // ------------------------------------------------------------ the audit log

  _turns() {
    const t = prisma.teamsAssistantTurn;
    return t && typeof t.findMany === 'function' ? t : null;
  }

  /** "My Teams questions": the person's own turns, last 180 days. Question, what they were shown, when. */
  async myTurns(email, { take = 50 } = {}) {
    const table = this._turns();
    if (!table || !lc(email)) return [];
    const rows = await Promise.resolve().then(() => table.findMany({
      where: { email: lc(email), createdAt: { gte: new Date(Date.now() - RETENTION_DAYS * 86400_000) } },
      orderBy: { id: 'desc' },
      take: Math.min(Math.max(Number(take) || 50, 1), 200),
      select: { id: true, question: true, replySummary: true, createdAt: true },
    })).catch(() => []);
    return (rows || []).map((r) => ({ id: r.id, question: r.question, answer: r.replySummary || null, at: r.createdAt }));
  }

  /** Super admins: the latest turns of a workspace (questions and outcomes, never results). */
  async recentTurns(workspaceId, { take = 50 } = {}) {
    const table = this._turns();
    if (!table) return [];
    const rows = await Promise.resolve().then(() => table.findMany({
      where: { workspaceId: Number(workspaceId) },
      orderBy: { id: 'desc' },
      take: Math.min(Math.max(Number(take) || 50, 1), 200),
      select: { id: true, email: true, mode: true, route: true, question: true, toolCalls: true, answerKind: true, lead: true, replySummary: true, delivered: true, model: true, latencyMs: true, costUsd: true, outcome: true, feedback: true, createdAt: true },
    })).catch(() => []);
    return (rows || []).map((r) => ({
      ...r,
      costUsd: r.costUsd === null || r.costUsd === undefined ? null : Number(r.costUsd),
      tools: Array.isArray(r.toolCalls) ? r.toolCalls.map((c) => c?.name).filter(Boolean) : [],
      toolCalls: undefined,
    }));
  }

  /** Daily prune (apiMaintenanceService): turns older than 180 days. */
  async prune(now = Date.now()) {
    const table = this._turns();
    if (!table || typeof table.deleteMany !== 'function') return 0;
    const res = await table.deleteMany({ where: { createdAt: { lt: new Date(now - RETENTION_DAYS * 86400_000) } } });
    return res?.count || 0;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const teamsAssistantSettings = new TeamsAssistantSettings();
export default teamsAssistantSettings;
export { TeamsAssistantSettings };
