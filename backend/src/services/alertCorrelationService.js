/**
 * Alert correlation (20 Sep 2026) — pair rules + storm grouping for machine
 * alerts, so "server down" / "server up" never reach a person or the AI.
 *
 * Runs at three moments, all through `evaluateTicket`:
 *   - at arrival, from assignmentPipelineService.runPipeline (before the
 *     duplicate-burst guard and before any AI run is queued) — at any hour;
 *   - every 5 minutes (`sweep`) over recent non-terminal tickets from matching
 *     senders — catches out-of-order arrival, restarts and the backlog;
 *   - on demand from Settings: `preview` (dry run over history) and
 *     `applyOpen` (the open backlog now).
 *
 * A rule = sender regex (required: a person forwarding an alert never
 * matches) + fired regex + optional cleared regex + optional follow-up regex.
 * The instance key is the `(?<key>…)` group (else the subject minus the
 * matched prefix); the storm family is `(?<family>…)` (else the rule).
 *
 * Airtight, in this order: never_noise / trusted-intake veto wins; a fired
 * ticket a person touched (agent message, human assignment or status change)
 * is linked and noted but never resolved; a fired ticket already closed by a
 * person keeps that status; a cleared with no open fired is an orphan (resolved
 * or left alone, per rule); a fired with no cleared inside the window is a
 * real incident and is never resolved on its own. Deleted/Spam are untouched.
 * Correlated tickets are Resolved with the rule's resolution reason — never
 * marked noise, they are real alerts that cleared.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import statusService from './statusService.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { isResolutionReason } from './resolutionReasonService.js';

export const ACTOR = { email: 'alerts@ticketpulse.internal', name: 'Ticket Pulse alert correlation', role: 'system', technicianId: null };
export const LINK_KIND_CLEARED_BY = 'cleared_by';
export const ACTIVITY_TYPE = 'alert_correlated';
const SWEEP_INTERVAL_MS = Number(process.env.ALERT_CORRELATION_INTERVAL_MS) || 5 * 60 * 1000;
const MAX_WINDOW_MINUTES = 7 * 24 * 60;
const TERMINAL_HARD = ['Deleted', 'Spam'];
const SYSTEM_ACTOR_NAMES = ['System', 'FreshService', 'Ticket Pulse', 'Ticket Pulse Bot', 'Ticket Pulse Mail', ACTOR.name, 'Ticket Pulse duplicate guard'];
// fs_write_back rows are a person's own edits on an FS-born ticket (assignee,
// status ...) — the engine's own write-backs carry ACTOR.name and are excluded.
const HUMAN_ACTIVITY_TYPES = ['assigned', 'reassigned', 'picked', 'self_picked', 'coordinator_assigned', 'status_changed', 'resolved', 'closed', 'fs_write_back'];

const PAIR_ACTIONS = ['resolve', 'link_only'];
// A clear notice with no alert to match is left alone for this long before it
// counts as an orphan: its alert may simply be a minute behind in the sync.
const ORPHAN_GRACE_MINUTES = 10;
// Sync ordering skew tolerated when looking the "wrong way" in time.
const ORDER_SKEW_MINUTES = 2;
const ORPHAN_ACTIONS = ['resolve', 'leave'];

/** The starter set, derived from six months of production mail (plans/ALERT_CORRELATION_PLAN.md). */
export const STARTER_RULES = [
  {
    name: 'Azure Monitor alerts (Fired / Resolved)',
    description: 'Azure Monitor sends a "Fired:" ticket when a VM or resource alert trips and a "Resolved:" ticket when it clears — in production every pair has cleared 15–20 minutes later. Pairs on the alert + resource, groups a burst across resources into one incident.',
    senderPattern: '^azure-noreply@microsoft\\.com$',
    firedPattern: '^Fired:Sev\\d+ Azure Monitor Alert (?<key>.+?) \\(',
    clearedPattern: '^Resolved:Sev\\d+ Azure Monitor Alert (?<key>.+?) \\(',
    followupPattern: null,
    pairWindowMinutes: 360, stormEnabled: true, stormWindowMinutes: 60, stormMinCount: 3,
  },
  {
    name: 'Site24x7 monitors (Down / Trouble → Up, RCA reports)',
    description: 'A host "is Down" or "is in Trouble", later "is Up"; the Root Cause Analysis report for the same host is attached to the outage and resolved.',
    senderPattern: '^noreply@site24x7\\.com$',
    firedPattern: '^(?<key>[\\w.-]+) is (Down|in Trouble)\\b',
    clearedPattern: '^(?<key>[\\w.-]+) is Up\\b',
    followupPattern: '^Root Cause Analysis Report - (?<key>[\\w.-]+)',
    pairWindowMinutes: 720, stormEnabled: true, stormWindowMinutes: 60, stormMinCount: 3,
  },
  {
    name: 'Cambio Earth data feed (ON / OFF)',
    description: '"ON - <site> - Data Feed Outage" starts an outage, "OFF - …" ends it.',
    senderPattern: '^notifications@cambioearth\\.com$',
    firedPattern: '^ON - (?<key>.+?) - Data Feed Outage',
    clearedPattern: '^OFF - (?<key>.+?) - Data Feed Outage',
    followupPattern: null,
    pairWindowMinutes: 1440, stormEnabled: true, stormWindowMinutes: 60, stormMinCount: 3,
  },
  {
    name: 'Rapid Recovery replication errors (storms)',
    description: 'Transfer / replication failures repeat every few minutes while a job is stuck (49 tickets on 6 Jul). No "cleared" mail exists, so this rule only folds a burst into one parent ticket; the parent stays open for a person.',
    senderPattern: '^rapidrecovery@bgcengineering\\.ca$',
    firedPattern: '^(?<key>[\\w-]+ - Error: .+? for [\\w-]+)',
    clearedPattern: null,
    followupPattern: null,
    pairWindowMinutes: 360, stormEnabled: true, stormWindowMinutes: 120, stormMinCount: 3,
  },
];

/** Fire/clear prefixes the suggestion scan knows about. */
const PREFIX_PAIRS = [
  ['^Fired:', '^Resolved:'],
  ['\\bis (Down|in Trouble)\\b', '\\bis Up\\b'],
  ['^ON - ', '^OFF - '],
  ['^(PROBLEM|Problem):', '^(RECOVERY|Recovery):'],
  ['\\b(DOWN|Down)\\b', '\\b(UP|Up)\\b'],
  ['\\b(CRITICAL|Critical)\\b', '\\b(OK|Ok)\\b'],
  ['\\b(Alert|ALERT)\\b', '\\b(Cleared|CLEARED|cleared)\\b'],
  ['\\bError\\b', '\\b(Recovered|recovered|Success|succeeded)\\b'],
];
const MACHINE_SENDER = /(noreply|no-reply|no_reply|donotreply|do-not-reply|alert|monitor|notification|daemon|mailer|rapidrecovery|backup|veeam|synology)/i;

const normalizeKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function compile(pattern) {
  if (!pattern) return null;
  try { return new RegExp(pattern, 'i'); } catch { return null; }
}

export function compileRule(rule) {
  const sender = compile(rule.senderPattern);
  const fired = compile(rule.firedPattern);
  if (!sender || !fired) return null;
  return {
    rule,
    sender,
    fired,
    cleared: compile(rule.clearedPattern),
    followup: compile(rule.followupPattern),
  };
}

/** `{ key, family, prefix }` when `re` matches the subject, else null. */
export function matchKey(re, subject) {
  if (!re) return null;
  const m = re.exec(String(subject || ''));
  if (!m) return null;
  const rawKey = m.groups?.key !== undefined ? m.groups.key : String(subject || '').replace(m[0], '');
  return {
    key: normalizeKey(rawKey),
    family: m.groups?.family !== undefined ? normalizeKey(m.groups.family) : null,
    prefix: m[0],
  };
}

export function validateRuleInput(input = {}) {
  const out = {};
  const name = String(input.name || '').trim();
  if (!name || name.length > 160) throw new Error('Name is required (max 160 characters)');
  out.name = name;
  out.description = input.description === undefined ? undefined : (String(input.description || '').slice(0, 2000) || null);
  for (const [field, required] of [['senderPattern', true], ['firedPattern', true], ['clearedPattern', false], ['followupPattern', false]]) {
    const v = input[field] === undefined || input[field] === null ? '' : String(input[field]).trim();
    if (!v) {
      if (required) throw new Error(`${field} is required`);
      if (input[field] !== undefined) out[field] = null;
      continue;
    }
    if (v.length > 1000) throw new Error(`${field} is too long`);
    if (!compile(v)) throw new Error(`${field} is not a valid regular expression`);
    out[field] = v;
  }
  const num = (field, def, min, max) => {
    if (input[field] === undefined) return;
    const n = Number(input[field]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${field} must be between ${min} and ${max}`);
    out[field] = Math.round(n);
  };
  num('pairWindowMinutes', 360, 1, MAX_WINDOW_MINUTES);
  num('stormWindowMinutes', 60, 1, MAX_WINDOW_MINUTES);
  num('stormMinCount', 3, 2, 500);
  if (input.pairAction !== undefined) {
    if (!PAIR_ACTIONS.includes(input.pairAction)) throw new Error(`pairAction must be one of ${PAIR_ACTIONS.join(', ')}`);
    out.pairAction = input.pairAction;
  }
  if (input.orphanClearedAction !== undefined) {
    if (!ORPHAN_ACTIONS.includes(input.orphanClearedAction)) throw new Error(`orphanClearedAction must be one of ${ORPHAN_ACTIONS.join(', ')}`);
    out.orphanClearedAction = input.orphanClearedAction;
  }
  if (input.resolutionReason !== undefined) {
    if (!isResolutionReason(input.resolutionReason)) throw new Error('resolutionReason is not a known reason');
    out.resolutionReason = input.resolutionReason;
  }
  for (const b of ['isEnabled', 'stormEnabled', 'skipAi']) {
    if (input[b] !== undefined) out[b] = input[b] === true;
  }
  return out;
}

class AlertCorrelationService {
  constructor() {
    this._timer = null;
    this._sweeping = false;
    this._ruleCache = new Map(); // workspaceId -> { at, rules }
    this._inFlight = new Set(); // "ws:ticket" keys being evaluated right now
  }

  // ---------------------------------------------------------------- rules
  async listRules(workspaceId) {
    return prisma.alertCorrelationRule.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } });
  }

  async createRule(workspaceId, input, actor = null) {
    const data = validateRuleInput(input);
    const rule = await prisma.alertCorrelationRule.create({ data: { ...data, workspaceId, createdBy: actor?.email || null } });
    this._ruleCache.delete(workspaceId);
    return rule;
  }

  async updateRule(workspaceId, id, input) {
    const existing = await prisma.alertCorrelationRule.findFirst({ where: { id: Number(id), workspaceId } });
    if (!existing) throw new Error('Rule not found');
    const data = validateRuleInput({ ...existing, ...input });
    const rule = await prisma.alertCorrelationRule.update({ where: { id: existing.id }, data });
    this._ruleCache.delete(workspaceId);
    return rule;
  }

  async deleteRule(workspaceId, id) {
    const existing = await prisma.alertCorrelationRule.findFirst({ where: { id: Number(id), workspaceId } });
    if (!existing) throw new Error('Rule not found');
    await prisma.alertCorrelationRule.delete({ where: { id: existing.id } });
    this._ruleCache.delete(workspaceId);
    return { deleted: true };
  }

  /** Install the starter rules whose sender has written to this workspace in the last 180 days. */
  async installStarterRules(workspaceId, actor = null) {
    const since = new Date(Date.now() - 180 * 86400 * 1000);
    const senders = await prisma.$queryRaw`
      SELECT DISTINCT lower(req.email) AS email
      FROM tickets t JOIN requesters req ON req.id = t.requester_id
      WHERE t.workspace_id = ${Number(workspaceId)} AND t.created_at >= ${since} AND req.email IS NOT NULL`
      .then((rows) => rows.map((r) => String(r.email))).catch(() => []);
    const existing = await this.listRules(workspaceId);
    const installed = [];
    const skipped = [];
    for (const starter of STARTER_RULES) {
      if (existing.some((r) => r.name === starter.name)) { skipped.push({ name: starter.name, reason: 'already installed' }); continue; }
      const re = compile(starter.senderPattern);
      if (!senders.some((e) => re.test(e))) { skipped.push({ name: starter.name, reason: 'no tickets from this sender in 180 days' }); continue; }
      installed.push(await this.createRule(workspaceId, starter, actor));
    }
    return { installed, skipped };
  }

  async _compiledRules(workspaceId) {
    const hit = this._ruleCache.get(workspaceId);
    if (hit && Date.now() - hit.at < 30 * 1000) return hit.rules;
    const rows = await Promise.resolve().then(() => prisma.alertCorrelationRule.findMany({ where: { workspaceId, isEnabled: true }, orderBy: { id: 'asc' } })).catch(() => []);
    const rules = rows.map(compileRule).filter(Boolean);
    this._ruleCache.set(workspaceId, { at: Date.now(), rules });
    return rules;
  }

  // ------------------------------------------------------------ evaluation
  /**
   * Evaluate one ticket against the workspace's rules.
   * @returns {{ handled: boolean, kind?: 'pair'|'orphan'|'storm'|'followup'|'fired', skipAi?: boolean, actions: object[] }}
   */
  async evaluateTicket(ticketId, workspaceId, opts = {}) {
    // Two triggers can reach the same ticket in the same second (a fast-sync
    // tick and the sweep both saw an orphan clear come of age — 21 Sep 2026:
    // #243405 got two notes, two FS write-backs and two run records). The
    // second caller is told to defer; the first one's work stands.
    const dryRun = Boolean(opts.dryRun);
    const key = `${workspaceId}:${ticketId}`;
    if (!dryRun && this._inFlight.has(key)) {
      return { handled: false, kind: 'in_flight', skipAi: false, defer: true, actions: [{ type: 'deferred', ticketId, reason: 'another evaluation of this ticket is already running' }] };
    }
    if (!dryRun) this._inFlight.add(key);
    try {
      return await this._evaluate(ticketId, workspaceId, opts);
    } finally {
      if (!dryRun) this._inFlight.delete(key);
    }
  }

  async _evaluate(ticketId, workspaceId, { dryRun = false, triggerSource = null, session = null, now = new Date() } = {}) {
    const result = { handled: false, kind: null, skipAi: false, actions: [] };
    const rules = await this._compiledRules(workspaceId);
    if (rules.length === 0) return result;
    const ticket = await this._loadTicket(ticketId, workspaceId);
    if (!ticket || TERMINAL_HARD.includes(ticket.status)) return result;
    const email = String(ticket.requester?.email || '').toLowerCase();
    if (!email) return result;
    const matching = rules.filter((r) => r.sender.test(email));
    if (matching.length === 0) return result;

    // Trusted intake (a credential that already investigated the ticket) vetoes
    // everything. A never_noise RULE only vetoes the judgment calls — resolving
    // an orphan clear notice — never a pair: when the platform that raised the
    // alert says it cleared, that evidence outranks a subject regex.
    const trusted = ticket.triageMode === 'trusted';
    if (trusted) { result.actions.push({ type: 'vetoed', reason: 'Trusted intake (credential)' }); return result; }
    const ctx = { dryRun, session, now, result, triggerSource };
    for (const compiled of matching) {
      const cleared = matchKey(compiled.cleared, ticket.subject);
      if (cleared) return this._handleCleared(compiled, ticket, cleared, ctx);
      const followup = matchKey(compiled.followup, ticket.subject);
      if (followup) return this._handleFollowup(compiled, ticket, followup, ctx);
      const fired = matchKey(compiled.fired, ticket.subject);
      if (fired) return this._handleFired(compiled, ticket, fired, ctx);
    }
    return result;
  }

  async _handleCleared(compiled, ticket, cleared, ctx) {
    const { rule } = compiled;
    const { result, dryRun } = ctx;
    const firedTicket = await this._findCounterpart(compiled, ticket, cleared.key, 'fired', ctx);
    if (!firedTicket) {
      if (rule.orphanClearedAction !== 'resolve') {
        result.kind = 'orphan';
        result.actions.push({ type: 'left_open', ticketId: ticket.id, ref: ticketDisplayRef(ticket), reason: 'orphan cleared, rule says leave' });
        return result; // not handled: ordinary flow continues
      }
      // Its alert may be a minute behind in the sync: wait for the sweep
      // before calling it an orphan. Live runs only — history is history.
      const ageMinutes = (new Date(ctx.now || Date.now()) - new Date(ticket.createdAt)) / 60000;
      if (!dryRun && ageMinutes < ORPHAN_GRACE_MINUTES) {
        result.kind = 'orphan_pending';
        result.defer = true;
        result.actions.push({ type: 'deferred', ticketId: ticket.id, ref: ticketDisplayRef(ticket), reason: `no alert yet; re-checked by the sweep after ${ORPHAN_GRACE_MINUTES} min` });
        return result;
      }
      const veto = await this._neverNoiseVeto(ticket);
      if (veto.vetoed) { result.actions.push({ type: 'vetoed', ruleId: rule.id, reason: veto.ruleName }); return result; }
      result.kind = 'orphan';
      result.handled = true;
      result.skipAi = rule.skipAi;
      const note = `Alert correlation (${rule.name}): this is a clear notice with no open alert to match in the last ${humanMinutes(rule.pairWindowMinutes)}. Resolved automatically.`;
      await this._resolve(ticket, rule, note, { dryRun, result, kind: 'orphan', other: null, session: ctx.session });
      await this._recordActivity(ticket, rule, 'orphan', null, { dryRun, resolved: true });
      if (!dryRun && rule.skipAi) await this._supersedeQueuedRuns(ticket.id, `Clear notice with no alert to match (${rule.name})`);
      return this._bump(rule, dryRun, result);
    }
    return this._pair(compiled, firedTicket, ticket, ctx);
  }

  async _handleFollowup(compiled, ticket, followup, ctx) {
    const { rule } = compiled;
    const { result, dryRun } = ctx;
    const firedTicket = await this._findCounterpart(compiled, ticket, followup.key, 'fired', { ...ctx, anyStatus: true });
    result.kind = 'followup';
    result.handled = true;
    result.skipAi = rule.skipAi;
    if (firedTicket) {
      await this._link(firedTicket, ticket, 'related_to', { dryRun, result, session: ctx.session });
      const note = `Alert correlation (${rule.name}): follow-up report for ${ticketDisplayRef(firedTicket)}; attached there and resolved.`;
      await this._resolve(ticket, rule, note, { dryRun, result, kind: 'followup', other: firedTicket, session: ctx.session });
      await this._recordActivity(ticket, rule, 'followup', firedTicket, { dryRun, resolved: true });
    } else if (rule.orphanClearedAction === 'resolve' && !(await this._neverNoiseVeto(ticket)).vetoed) {
      const note = `Alert correlation (${rule.name}): follow-up report with no matching alert in the last ${humanMinutes(rule.pairWindowMinutes)}; resolved.`;
      await this._resolve(ticket, rule, note, { dryRun, result, kind: 'followup', other: null, session: ctx.session });
      await this._recordActivity(ticket, rule, 'followup', null, { dryRun, resolved: true });
    } else {
      result.handled = false;
      result.skipAi = false;
    }
    return this._bump(rule, dryRun, result);
  }

  async _handleFired(compiled, ticket, fired, ctx) {
    const { rule } = compiled;
    const { result } = ctx;
    // Out-of-order arrival: its clear notice is already here.
    if (compiled.cleared) {
      const clearedTicket = await this._findCounterpart(compiled, ticket, fired.key, 'cleared', ctx);
      if (clearedTicket) return this._pair(compiled, ticket, clearedTicket, ctx);
    }
    if (rule.stormEnabled) {
      const grouped = await this._storm(compiled, ticket, fired, ctx);
      if (grouped) return result;
    }
    result.kind = 'fired';
    result.handled = false; // a real alert with no clear yet — people (and the AI) see it
    return result;
  }

  /**
   * Pair a fired ticket with its cleared ticket. Airtight ordering: the human
   * always wins on the fired side (touched or already terminal → link + note
   * only); the cleared side is resolved unless the rule says link only.
   */
  async _pair(compiled, firedTicket, clearedTicket, ctx) {
    const { rule } = compiled;
    const { result, dryRun, session } = ctx;
    result.kind = 'pair';
    result.handled = true;
    result.skipAi = rule.skipAi;
    const gapMinutes = Math.max(0, Math.round((new Date(clearedTicket.createdAt) - new Date(firedTicket.createdAt)) / 60000));
    const firedRef = ticketDisplayRef(firedTicket);
    const clearedRef = ticketDisplayRef(clearedTicket);

    const alreadyLinked = await this._linkExists(firedTicket.id, clearedTicket.id, LINK_KIND_CLEARED_BY, session);
    if (!alreadyLinked) await this._link(firedTicket, clearedTicket, LINK_KIND_CLEARED_BY, { dryRun, result, session });

    const firedTerminal = await this._isTerminal(firedTicket, session);
    const touched = firedTerminal ? false : await this._humanTouched(firedTicket);
    const noteFired = touched
      ? `Alert correlation (${rule.name}): cleared by ${clearedRef} ${humanMinutes(gapMinutes)} after it fired. A person is on this ticket, so its status was left alone.`
      : `Alert correlation (${rule.name}): cleared by ${clearedRef} ${humanMinutes(gapMinutes)} after it fired. Resolved automatically.`;
    const noteCleared = firedTerminal
      ? `Alert correlation (${rule.name}): clears ${firedRef}, which was already ${firedTicket.status.toLowerCase()}. Resolved automatically.`
      : `Alert correlation (${rule.name}): clears ${firedRef} (${humanMinutes(gapMinutes)} after it fired). Resolved automatically.`;

    if (rule.pairAction === 'resolve') {
      if (!firedTerminal && !touched) {
        await this._resolve(firedTicket, rule, noteFired, { dryRun, result, kind: 'pair', other: clearedTicket, session });
      } else {
        await this._note(firedTicket, touched ? noteFired : `Alert correlation (${rule.name}): cleared by ${clearedRef}.`, { dryRun, result });
        result.actions.push({ type: firedTerminal ? 'kept_status' : 'left_to_person', ticketId: firedTicket.id, ref: firedRef, status: firedTicket.status });
      }
      await this._resolve(clearedTicket, rule, noteCleared, { dryRun, result, kind: 'pair', other: firedTicket, session });
    } else {
      await this._note(firedTicket, `Alert correlation (${rule.name}): cleared by ${clearedRef}.`, { dryRun, result });
      await this._note(clearedTicket, `Alert correlation (${rule.name}): clears ${firedRef}.`, { dryRun, result });
    }
    await this._recordActivity(firedTicket, rule, 'pair', clearedTicket, { dryRun, resolved: rule.pairAction === 'resolve' && !firedTerminal && !touched, gapMinutes, touched, firedTerminal });
    await this._recordActivity(clearedTicket, rule, 'pair', firedTicket, { dryRun, resolved: rule.pairAction === 'resolve', gapMinutes });
    if (!dryRun && rule.skipAi) {
      await this._supersedeQueuedRuns(firedTicket.id, `Alert cleared by ${clearedRef} (${rule.name})`);
      await this._supersedeQueuedRuns(clearedTicket.id, `Clear notice for ${firedRef} (${rule.name})`);
    }
    result.pair = { firedId: firedTicket.id, firedRef, clearedId: clearedTicket.id, clearedRef, gapMinutes, touched, firedTerminal };
    return this._bump(rule, dryRun, result);
  }

  /** Storm: enough earlier fired tickets of the same family → this one becomes a child of the root. */
  async _storm(compiled, ticket, fired, ctx) {
    const { rule } = compiled;
    const { result, dryRun, session } = ctx;
    const family = fired.family || `rule:${rule.id}`;
    const windowStart = new Date(new Date(ticket.createdAt).getTime() - rule.stormWindowMinutes * 60000);
    // A storm is about arrival volume, so siblings count whatever their status;
    // the root prefers an open one so children hang under a live incident.
    const earlier = await this._candidates(compiled, ticket, windowStart, new Date(ticket.createdAt), { anyStatus: true });
    const siblings = earlier
      .filter((t) => t.id !== ticket.id)
      .map((t) => ({ t, m: matchKey(compiled.fired, t.subject) }))
      .filter(({ m }) => m && (m.family || `rule:${rule.id}`) === family)
      .map(({ t }) => t)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (siblings.length + 1 < rule.stormMinCount) return false;
    const terminal = session?.asIfOpen ? new Set() : await this._terminalNames(ticket.workspaceId);
    // Children hang under a LIVE incident. With every earlier sibling already
    // closed there is nothing open to hang under: this ticket stays a plain
    // fired alert (and is the open root for the next one). Never file a new
    // alert under a closed ticket (21 Sep 2026: four test alerts ended up
    // under one the noise verdict had already closed, out of everyone's sight).
    const openSiblings = siblings.filter((t) => !terminal.has(t.status));
    if (openSiblings.length === 0) return false;
    let root = openSiblings[0];
    const parentId = await this._parentOf(root.id, session);
    if (parentId) {
      const parent = await this._loadTicket(parentId, ticket.workspaceId);
      if (parent && !TERMINAL_HARD.includes(parent.status) && !terminal.has(parent.status)) root = parent;
    }
    if (root.id === ticket.id) return false;
    const existingParent = await this._parentOf(ticket.id, session);
    if (existingParent) { result.kind = 'storm'; result.handled = true; result.skipAi = rule.skipAi; return true; }
    result.kind = 'storm';
    result.handled = true;
    result.skipAi = rule.skipAi;
    const rootRef = ticketDisplayRef(root);
    if (!dryRun) {
      try {
        const { default: ticketLinkService } = await import('./ticketLinkService.js');
        await ticketLinkService.setParent(ticket.id, ticket.workspaceId, { parentTicketId: root.id }, ACTOR);
      } catch (err) {
        logger.warn(`Alert storm: parent link failed for ${ticket.id} → ${root.id}: ${err.message}`);
        result.actions.push({ type: 'error', step: 'storm_link', ticketId: ticket.id, message: err.message });
        return false;
      }
      await this._supersedeQueuedRuns(ticket.id, `Part of an alert storm under ${rootRef} (${rule.name})`);
    } else {
      session?.children?.add(ticket.id);
      session?.parents?.set(ticket.id, root.id);
    }
    result.actions.push({ type: 'storm_child', ticketId: ticket.id, ref: ticketDisplayRef(ticket), rootId: root.id, rootRef, siblings: siblings.length + 1 });
    await this._recordActivity(ticket, rule, 'storm', root, { dryRun, resolved: false, siblings: siblings.length + 1 });
    result.storm = { rootId: root.id, rootRef, childId: ticket.id, count: siblings.length + 1 };
    await this._bump(rule, dryRun, result);
    return true;
  }

  // ------------------------------------------------------------- lookups
  async _loadTicket(ticketId, workspaceId) {
    return prisma.ticket.findFirst({
      where: { id: Number(ticketId), workspaceId: Number(workspaceId) },
      select: {
        id: true, workspaceId: true, subject: true, status: true, origin: true, createdAt: true, assignedTechId: true,
        freshserviceTicketId: true, nativeNumber: true, triageMode: true, category: true, descriptionText: true, description: true,
        requester: { select: { email: true } }, internalCategory: { select: { name: true } },
      },
    });
  }

  /** Tickets from the same sender in [from, to], any status but Deleted/Spam (or non-terminal only). */
  async _candidates(compiled, ticket, from, to, { anyStatus = false } = {}) {
    const rows = await prisma.ticket.findMany({
      where: {
        workspaceId: ticket.workspaceId,
        createdAt: { gte: from, lte: to },
        status: { notIn: TERMINAL_HARD },
      },
      select: {
        id: true, workspaceId: true, subject: true, status: true, origin: true, createdAt: true, assignedTechId: true,
        freshserviceTicketId: true, nativeNumber: true, requester: { select: { email: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const terminal = anyStatus ? new Set() : await this._terminalNames(ticket.workspaceId);
    return rows.filter((t) => compiled.sender.test(String(t.requester?.email || '').toLowerCase()) && (anyStatus || !terminal.has(t.status)));
  }

  /**
   * The other half of a pair. For a cleared ticket: the newest fired ticket
   * with the same key inside the window before it (open preferred; a closed
   * one still counts so the clear can be filed against it). For a fired
   * ticket: a cleared with the same key that arrived after it.
   */
  async _findCounterpart(compiled, ticket, key, want, ctx) {
    const { rule } = compiled;
    const windowMs = rule.pairWindowMinutes * 60000;
    const created = new Date(ticket.createdAt);
    const skewMs = ORDER_SKEW_MINUTES * 60000;
    // A clear notice can only be "already here" if it arrived by now — in a
    // dry run over history `now` is the ticket's own arrival, so the report
    // shows what would have happened at the time, not with hindsight.
    const nowMs = new Date(ctx.now || Date.now()).getTime();
    const [from, to] = want === 'fired'
      ? [new Date(created.getTime() - windowMs), new Date(created.getTime() + skewMs)]
      : [new Date(created.getTime() - skewMs), new Date(Math.min(created.getTime() + windowMs, nowMs))];
    const re = want === 'fired' ? compiled.fired : compiled.cleared;
    if (!re) return null;
    const all = await this._candidates(compiled, ticket, from, to, { anyStatus: true });
    const matches = all.filter((t) => t.id !== ticket.id && matchKey(re, t.subject)?.key === key);
    if (matches.length === 0) return null;
    const terminal = await this._terminalNames(ticket.workspaceId);
    const isPaired = async (t) => (want === 'fired'
      ? this._hasLinkOfKind(t.id, LINK_KIND_CLEARED_BY, 'out', ctx.session)
      : this._hasLinkOfKind(t.id, LINK_KIND_CLEARED_BY, 'in', ctx.session));
    const unpaired = [];
    for (const t of matches) if (!(await isPaired(t))) unpaired.push(t);
    if (unpaired.length === 0) return null;
    if (ctx.anyStatus) return unpaired[unpaired.length - 1];
    if (ctx.session?.asIfOpen) return want === 'fired' ? unpaired[unpaired.length - 1] : unpaired[0];
    const open = unpaired.filter((t) => !terminal.has(t.status));
    const pool = open.length ? open : unpaired;
    // Newest before a cleared; oldest after a fired.
    return want === 'fired' ? pool[pool.length - 1] : pool[0];
  }

  async _terminalNames(workspaceId) {
    try {
      const names = await statusService.statusNamesForBase(workspaceId, ['Resolved', 'Closed']);
      return new Set([...names, ...TERMINAL_HARD]);
    } catch {
      return new Set(['Resolved', 'Closed', ...TERMINAL_HARD]);
    }
  }

  async _isTerminal(ticket, session = null) {
    if (session?.asIfOpen) return false;
    const names = await this._terminalNames(ticket.workspaceId);
    return names.has(ticket.status);
  }

  /** An agent wrote on it, or a person assigned / re-statused it. */
  async _humanTouched(ticket) {
    const entry = await Promise.resolve().then(() => prisma.ticketThreadEntry.findFirst({
      where: {
        ticketId: ticket.id,
        OR: [
          { authorType: 'agent' },
          { source: 'freshservice_conversation', incoming: false },
        ],
      },
      select: { id: true },
    })).catch(() => null);
    if (entry) return true;
    const activity = await Promise.resolve().then(() => prisma.ticketActivity.findFirst({
      where: {
        ticketId: ticket.id,
        activityType: { in: HUMAN_ACTIVITY_TYPES },
        NOT: [
          { performedBy: { in: SYSTEM_ACTOR_NAMES } },
          { performedBy: { contains: 'ticketpulse.internal' } },
          { performedBy: { startsWith: 'Ticket Pulse' } },
        ],
      },
      select: { id: true },
    })).catch(() => null);
    return Boolean(activity);
  }

  async _neverNoiseVeto(ticket) {
    try {
      const { default: noiseRuleService } = await import('./noiseRuleService.js');
      const v = await noiseRuleService.evaluateNeverNoise(ticket.workspaceId, {
        subject: ticket.subject,
        description: ticket.descriptionText || ticket.description,
        category: ticket.internalCategory?.name || ticket.category,
        requesterEmail: ticket.requester?.email || null,
      });
      return v || { vetoed: false };
    } catch (err) {
      logger.warn(`Alert correlation veto check failed (treating as vetoed): ${err.message}`);
      return { vetoed: true, ruleName: 'veto check unavailable' };
    }
  }

  async _linkExists(fromId, toId, kind, session) {
    if (session?.links?.has(`${fromId}:${toId}:${kind}`)) return true;
    const row = await prisma.ticketLink.findFirst({ where: { ticketId: fromId, relatedTicketId: toId, kind }, select: { id: true } }).catch(() => null);
    return Boolean(row);
  }

  async _hasLinkOfKind(ticketId, kind, direction, session) {
    if (session?.linkedIds?.has(`${ticketId}:${kind}:${direction}`)) return true;
    const where = direction === 'out' ? { ticketId, kind } : { relatedTicketId: ticketId, kind };
    const row = await prisma.ticketLink.findFirst({ where, select: { id: true } }).catch(() => null);
    return Boolean(row);
  }

  async _parentOf(ticketId, session) {
    if (session?.parents?.has(ticketId)) return session.parents.get(ticketId);
    const row = await prisma.ticketLink.findFirst({ where: { relatedTicketId: ticketId, kind: 'parent_of' }, select: { ticketId: true } }).catch(() => null);
    return row ? row.ticketId : null;
  }

  // ------------------------------------------------------------- writes
  async _link(from, to, kind, { dryRun, result, session }) {
    result.actions.push({ type: 'link', kind, fromId: from.id, fromRef: ticketDisplayRef(from), toId: to.id, toRef: ticketDisplayRef(to) });
    if (dryRun) {
      session?.links?.add(`${from.id}:${to.id}:${kind}`);
      session?.linkedIds?.add(`${from.id}:${kind}:out`);
      session?.linkedIds?.add(`${to.id}:${kind}:in`);
      return;
    }
    try {
      await prisma.ticketLink.upsert({
        where: { ticketId_relatedTicketId_kind: { ticketId: from.id, relatedTicketId: to.id, kind } },
        update: {},
        create: { workspaceId: from.workspaceId, ticketId: from.id, relatedTicketId: to.id, kind, createdBy: ACTOR.email },
      });
    } catch (err) {
      logger.warn(`Alert correlation link ${kind} ${from.id}→${to.id} failed: ${err.message}`);
      result.actions.push({ type: 'error', step: 'link', message: err.message });
    }
  }

  async _note(ticket, text, { dryRun, result }) {
    result.actions.push({ type: 'note', ticketId: ticket.id, ref: ticketDisplayRef(ticket), text });
    if (dryRun) return;
    try {
      const { default: ticketService } = await import('./ticketService.js');
      await ticketService.addPrivateNote(ticket.id, ticket.workspaceId, { bodyText: text }, ACTOR);
    } catch (err) {
      logger.warn(`Alert correlation note on ${ticket.id} failed (non-fatal): ${err.message}`);
      result.actions.push({ type: 'error', step: 'note', ticketId: ticket.id, message: err.message });
    }
  }

  /** Resolve with the rule's reason; TP-born through the audited path, FS-born through the FreshService write-back. */
  async _resolve(ticket, rule, note, { dryRun, result, kind, other, session = null }) {
    if (await this._isTerminal(ticket, session)) {
      result.actions.push({ type: 'already_terminal', ticketId: ticket.id, ref: ticketDisplayRef(ticket), status: ticket.status });
      return;
    }
    if (!dryRun) {
      const fresh = await this._loadTicket(ticket.id, ticket.workspaceId).catch(() => null);
      if (fresh && await this._isTerminal(fresh, session)) {
        result.actions.push({ type: 'already_terminal', ticketId: ticket.id, ref: ticketDisplayRef(ticket), status: fresh.status });
        return;
      }
    }
    result.actions.push({ type: 'resolve', ticketId: ticket.id, ref: ticketDisplayRef(ticket), kind, otherId: other?.id || null, reason: rule.resolutionReason });
    if (dryRun) return;
    try {
      const { default: ticketService } = await import('./ticketService.js');
      await ticketService.addPrivateNote(ticket.id, ticket.workspaceId, { bodyText: note }, ACTOR);
      if (ticket.origin === 'ticketpulse') {
        await ticketService.changeStatus(ticket.id, ticket.workspaceId, 'Resolved', ACTOR, { resolutionReason: rule.resolutionReason, resolutionNote: note.slice(0, 500) });
      } else {
        await ticketService.updateFsTicket(ticket.id, ticket.workspaceId, { status: 'Resolved' }, ACTOR);
      }
    } catch (err) {
      logger.warn(`Alert correlation resolve of ${ticket.id} failed (non-fatal): ${err.message}`);
      result.actions.push({ type: 'error', step: 'resolve', ticketId: ticket.id, message: err.message });
    }
  }

  async _recordActivity(ticket, rule, kind, other, { dryRun, ...details }) {
    if (dryRun) return;
    await Promise.resolve().then(() => ticketActivityRepository.create({
      ticketId: ticket.id,
      activityType: ACTIVITY_TYPE,
      performedBy: ACTOR.name,
      performedAt: new Date(),
      details: { kind, ruleId: rule.id, ruleName: rule.name, otherTicketId: other?.id || null, otherRef: other ? ticketDisplayRef(other) : null, ...details },
    })).catch((err) => logger.warn(`Alert correlation activity write failed (non-fatal): ${err.message}`));
  }

  async _supersedeQueuedRuns(ticketId, reason) {
    await Promise.resolve().then(() => prisma.assignmentPipelineRun.updateMany({
      where: { ticketId, status: 'queued' },
      data: { status: 'superseded', errorMessage: reason },
    })).catch((err) => logger.warn(`Alert correlation: could not supersede queued runs for ${ticketId}: ${err.message}`));
  }

  async _bump(rule, dryRun, result) {
    if (!dryRun) {
      await Promise.resolve().then(() => prisma.alertCorrelationRule.update({ where: { id: rule.id }, data: { matchCount: { increment: 1 }, lastMatchedAt: new Date() } })).catch(() => {});
    }
    return result;
  }

  /** The pipeline's record of a skipped run — mirrors the duplicate guard's shape. */
  async recordRun(ticketId, workspaceId, triggerSource, correlation) {
    const summary = correlation.kind === 'pair'
      ? `Alert correlation: ${correlation.pair?.firedRef || 'the alert'} was cleared by ${correlation.pair?.clearedRef || 'its clear notice'} ${humanMinutes(correlation.pair?.gapMinutes || 0)} after it fired. Both were resolved automatically; no AI run.`
      : correlation.kind === 'storm'
        ? `Alert correlation: part of an alert storm (${correlation.storm?.count || 0} alerts in the window) grouped under ${correlation.storm?.rootRef || 'the first alert'}. Triage continues on the parent; no AI run.`
        : correlation.kind === 'orphan'
          ? 'Alert correlation: a clear notice with no open alert to match; resolved automatically, no AI run.'
          : 'Alert correlation: follow-up report attached to its alert and resolved; no AI run.';
    return prisma.assignmentPipelineRun.create({
      data: {
        ticketId, workspaceId, status: 'completed', triggerSource, llmModel: 'alert-correlation',
        totalDurationMs: 0, totalTokensUsed: 0, decision: 'alert_correlated', decidedAt: new Date(),
        nonActionable: true, nonActionableReason: `alert_${correlation.kind}`,
        recommendation: { recommendations: [], overallReasoning: summary, source: 'alert_correlation', correlation: { kind: correlation.kind, pair: correlation.pair || null, storm: correlation.storm || null } },
        errorMessage: summary.slice(0, 200),
      },
      select: { id: true },
    });
  }

  // ----------------------------------------------------------- sweeps
  async sweep(workspaceId = null) {
    const wsIds = workspaceId
      ? [Number(workspaceId)]
      : (await Promise.resolve().then(() => prisma.alertCorrelationRule.findMany({ where: { isEnabled: true }, select: { workspaceId: true }, distinct: ['workspaceId'] })).catch(() => [])).map((r) => r.workspaceId);
    let evaluated = 0; let handled = 0;
    for (const ws of wsIds) {
      const rules = await this._compiledRules(ws);
      if (rules.length === 0) continue;
      const lookback = Math.max(...rules.map((r) => Math.max(r.rule.pairWindowMinutes, r.rule.stormWindowMinutes))) + 120;
      const terminal = await this._terminalNames(ws);
      const rows = await prisma.ticket.findMany({
        where: { workspaceId: ws, createdAt: { gte: new Date(Date.now() - lookback * 60000) }, status: { notIn: [...terminal] } },
        select: { id: true, subject: true, requester: { select: { email: true } } },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }).catch(() => []);
      for (const t of rows) {
        const email = String(t.requester?.email || '').toLowerCase();
        if (!rules.some((r) => r.sender.test(email))) continue;
        evaluated += 1;
        const res = await this.evaluateTicket(t.id, ws, { triggerSource: 'alert_sweep' }).catch((err) => { logger.warn(`Alert sweep: ticket ${t.id} failed: ${err.message}`); return null; });
        if (res?.handled) handled += 1;
      }
    }
    return { workspaces: wsIds.length, evaluated, handled };
  }

  /** Dry run over the last N days (all statuses but Deleted/Spam), in arrival order. */
  async preview(workspaceId, { days = 30 } = {}) {
    const rules = await this._compiledRules(workspaceId);
    const since = new Date(Date.now() - Math.min(365, Math.max(1, Number(days) || 30)) * 86400 * 1000);
    const rows = await prisma.ticket.findMany({
      where: { workspaceId, createdAt: { gte: since }, status: { notIn: TERMINAL_HARD } },
      select: { id: true, subject: true, status: true, createdAt: true, freshserviceTicketId: true, nativeNumber: true, origin: true, requester: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });
    // History is evaluated as if every ticket were still open, so the report
    // shows what the rules WOULD do, not what a person already did.
    const session = { links: new Set(), linkedIds: new Set(), children: new Set(), parents: new Map(), asIfOpen: true };
    const out = { days, candidates: 0, pairs: [], storms: [], orphans: [], followups: [], unmatchedFired: [], vetoed: [] };
    for (const t of rows) {
      const email = String(t.requester?.email || '').toLowerCase();
      if (!rules.some((r) => r.sender.test(email))) continue;
      out.candidates += 1;
      const res = await this.evaluateTicket(t.id, workspaceId, { dryRun: true, session, now: new Date(new Date(t.createdAt).getTime() + 1000) }).catch(() => null);
      if (!res) continue;
      const ref = ticketDisplayRef(t);
      if (res.actions.some((a) => a.type === 'vetoed')) out.vetoed.push({ id: t.id, ref, subject: t.subject });
      else if (res.kind === 'pair' && res.pair && res.pair.clearedId === t.id) out.pairs.push({ ...res.pair, firedSubject: null, clearedSubject: t.subject, status: t.status });
      else if (res.kind === 'pair' && res.pair && res.pair.firedId === t.id) out.pairs.push({ ...res.pair, firedSubject: t.subject, status: t.status });
      else if (res.kind === 'storm' && res.storm) out.storms.push({ ...res.storm, subject: t.subject });
      else if (res.kind === 'orphan') out.orphans.push({ id: t.id, ref, subject: t.subject, status: t.status });
      else if (res.kind === 'followup') out.followups.push({ id: t.id, ref, subject: t.subject, status: t.status });
      else if (res.kind === 'fired') out.unmatchedFired.push({ id: t.id, ref, subject: t.subject, status: t.status, createdAt: t.createdAt });
    }
    // An alert is only "never cleared" if nothing paired with it later in the run.
    const pairedFired = new Set(out.pairs.map((p) => p.firedId));
    out.unmatchedFired = out.unmatchedFired.filter((u) => !pairedFired.has(u.id));
    out.summary = { pairs: out.pairs.length, storms: out.storms.length, orphans: out.orphans.length, followups: out.followups.length, unmatchedFired: out.unmatchedFired.length, vetoed: out.vetoed.length };
    return out;
  }

  /** Real run over the open backlog (last 30 days), oldest first. */
  async applyOpen(workspaceId, { days = 30 } = {}) {
    const rules = await this._compiledRules(workspaceId);
    const terminal = await this._terminalNames(workspaceId);
    const since = new Date(Date.now() - Math.min(365, Math.max(1, Number(days) || 30)) * 86400 * 1000);
    const rows = await prisma.ticket.findMany({
      where: { workspaceId, createdAt: { gte: since }, status: { notIn: [...terminal] } },
      select: { id: true, subject: true, freshserviceTicketId: true, nativeNumber: true, origin: true, requester: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
      take: 2000,
    });
    const out = { evaluated: 0, handled: [], untouched: [] };
    for (const t of rows) {
      const email = String(t.requester?.email || '').toLowerCase();
      if (!rules.some((r) => r.sender.test(email))) continue;
      out.evaluated += 1;
      const res = await this.evaluateTicket(t.id, workspaceId, { triggerSource: 'alert_apply' }).catch((err) => ({ handled: false, error: err.message, actions: [] }));
      const ref = ticketDisplayRef(t);
      if (res.handled) out.handled.push({ id: t.id, ref, subject: t.subject, kind: res.kind, actions: res.actions });
      else out.untouched.push({ id: t.id, ref, subject: t.subject, kind: res.kind || null, error: res.error || null });
    }
    return out;
  }

  /** Senders with fire/clear-shaped subjects and no rule yet. */
  async suggestions(workspaceId, { days = 180 } = {}) {
    const rules = await this._compiledRules(workspaceId);
    const since = new Date(Date.now() - Math.min(365, Math.max(7, Number(days) || 180)) * 86400 * 1000);
    const rows = await prisma.$queryRaw`
      SELECT lower(req.email) AS email, t.subject, t.created_at
      FROM tickets t JOIN requesters req ON req.id = t.requester_id
      WHERE t.workspace_id = ${Number(workspaceId)} AND t.created_at >= ${since} AND t.status <> 'Deleted'
        AND req.email IS NOT NULL
      ORDER BY t.created_at ASC
      LIMIT 20000`.catch(() => []);
    const bySender = new Map();
    for (const r of rows) {
      if (!MACHINE_SENDER.test(r.email)) continue;
      if (rules.some((c) => c.sender.test(r.email))) continue;
      if (!bySender.has(r.email)) bySender.set(r.email, []);
      bySender.get(r.email).push(String(r.subject || ''));
    }
    const out = [];
    for (const [email, subjects] of bySender) {
      if (subjects.length < 3) continue;
      let best = null;
      for (const [firedP, clearedP] of PREFIX_PAIRS) {
        const fRe = new RegExp(firedP); const cRe = new RegExp(clearedP);
        const fired = subjects.filter((s) => fRe.test(s));
        const cleared = subjects.filter((s) => cRe.test(s) && !fRe.test(s));
        if (fired.length >= 2 && cleared.length >= 1 && (!best || fired.length + cleared.length > best.fired + best.cleared)) {
          best = { fired: fired.length, cleared: cleared.length, sampleFired: fired[fired.length - 1], sampleCleared: cleared[cleared.length - 1], firedPattern: `${firedP}(?<key>.+)$`, clearedPattern: `${clearedP}(?<key>.+)$` };
        }
      }
      const templates = new Map();
      for (const s of subjects) { const k = s.replace(/\d+/g, 'N').toLowerCase(); templates.set(k, (templates.get(k) || 0) + 1); }
      const busiest = [...templates.entries()].sort((a, b) => b[1] - a[1])[0];
      const stormy = busiest && busiest[1] >= 5;
      if (!best && !stormy) continue;
      out.push({
        sender: email,
        tickets: subjects.length,
        kind: best ? 'pair' : 'storm',
        pairsSeen: best ? Math.min(best.fired, best.cleared) : 0,
        sampleFired: best ? best.sampleFired : subjects[subjects.length - 1],
        sampleCleared: best ? best.sampleCleared : null,
        busiestTemplate: busiest ? { template: busiest[0], count: busiest[1] } : null,
        proposal: {
          name: `${email} alerts`,
          senderPattern: `^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          firedPattern: best ? best.firedPattern : '^(?<key>.+)$',
          clearedPattern: best ? best.clearedPattern : null,
          stormEnabled: true,
        },
      });
    }
    return out.sort((a, b) => b.tickets - a.tickets).slice(0, 20);
  }

  async activity(workspaceId, { days = 30 } = {}) {
    const since = new Date(Date.now() - Math.min(365, Math.max(1, Number(days) || 30)) * 86400 * 1000);
    // TicketActivity has no Prisma relation to Ticket (3.9.61 hotfix: the
    // relation filter threw and the catch hid it, so the list was always
    // empty). Read the activities first, then the tickets of this workspace.
    const rows = await prisma.ticketActivity.findMany({
      where: { activityType: ACTIVITY_TYPE, performedAt: { gte: since } },
      orderBy: { performedAt: 'desc' },
      take: 600,
      select: { id: true, ticketId: true, performedAt: true, details: true },
    }).catch(() => []);
    if (!rows.length) return [];
    const tickets = await prisma.ticket.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.ticketId))] }, workspaceId },
      select: { id: true, subject: true, status: true, freshserviceTicketId: true, nativeNumber: true, origin: true },
    }).catch(() => []);
    const byId = new Map(tickets.map((t) => [t.id, t]));
    return rows
      .filter((r) => byId.has(r.ticketId))
      .slice(0, 200)
      .map((r) => { const t = byId.get(r.ticketId); return { id: r.id, ticketId: r.ticketId, ref: ticketDisplayRef(t), subject: t.subject, status: t.status, at: r.performedAt, ...(r.details || {}) }; });
  }

  // ------------------------------------------------------------- worker
  start() {
    if (this._timer) return;
    if (process.env.ALERT_CORRELATION_ENABLED === 'false') { logger.info('Alert correlation sweep disabled by env'); return; }
    this._timer = setInterval(() => {
      if (this._sweeping) return;
      this._sweeping = true;
      this.sweep().then((r) => { if (r.handled) logger.info('Alert correlation sweep', r); })
        .catch((err) => logger.warn(`Alert correlation sweep failed: ${err.message}`))
        .finally(() => { this._sweeping = false; });
    }, SWEEP_INTERVAL_MS);
    this._timer.unref?.();
    logger.info(`Alert correlation sweep started (every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

export function humanMinutes(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) { const h = Math.round(m / 6) / 10; return `${h} h`; }
  return `${Math.round(m / 1440)} d`;
}

const alertCorrelationService = new AlertCorrelationService();
export default alertCorrelationService;
