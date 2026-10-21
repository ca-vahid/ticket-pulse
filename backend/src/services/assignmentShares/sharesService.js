import { Prisma } from '@prisma/client';
import prisma from '../prisma.js';
import settingsRepository from '../settingsRepository.js';
import logger from '../../utils/logger.js';
import { ticketDisplayRef } from '../../utils/ticketOrigin.js';
import {
  applyPatch, buildLedger, categoryMatches, decide, normalizeSettings, periodOf, previewSequence,
  promoteSuggestion, recordFor, summarizeReport, toStored, validateDraft, onLeaveAt, workingAt,
} from './rules.js';

/**
 * Ticket shares — the part that reads and remembers (QA 10-16 item 4, proof
 * of concept). The rules themselves are in rules.js (pure).
 *
 * - Settings live in app_settings under `assignment_shares_ws<id>` (no table).
 * - Counts are read live from `tickets` on every decision: created this
 *   period, in the chosen categories, held by someone on the list, not noise,
 *   not deleted, not a duplicate or merged away. No credits table: a person's
 *   "earned" share is worked out again from those tickets and the leave rows.
 *   What that loses: shares and the list are the CURRENT ones for the whole
 *   period, so someone added (or given more) mid-period earns as if they had
 *   been there from its start and catches up a little.
 * - Live picks still waiting for a reviewer (suggest-only) count as held by
 *   the person picked for 24 hours, plus decisions made in this process a
 *   moment ago (the ledger) — so five tickets at once do not all go to one
 *   person. The check-then-remember step runs one at a time per workspace.
 * - Off everywhere by default. Shadow records "would have" on the run and
 *   changes nothing.
 *
 * Nothing here may ever fail an assignment: every public method catches and
 * answers "leave it as it was".
 */

export const settingsKey = (workspaceId) => `assignment_shares_ws${Number(workspaceId)}`;

/** Integration sandboxes: never. */
const SANDBOX_WORKSPACES = [6, 7, 8, 9];
const SETTINGS_CACHE_MS = 15 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LEDGER_KEEP_MS = 30 * MINUTE_MS;
const RESERVE_MS = DAY_MS;
const LOCK_TIMEOUT_MS = 15 * 1000;
const COUNT_ROWS = 5000;
const REPORT_ROWS = 4000;
const EVENT_ROWS = 25;

const soft = (fn, fallback = null) => Promise.resolve().then(fn).catch((err) => {
  logger.debug?.(`Ticket shares read degraded: ${err.message}`);
  return fallback;
});
const positive = (n) => Number.isInteger(n) && n > 0;

class AssignmentSharesService {
  constructor() {
    this._settingsCache = new Map();
    this._ledger = new Map();
    this._locks = new Map();
  }

  /** For tests. */
  _reset() {
    this._settingsCache.clear();
    this._ledger.clear();
    this._locks.clear();
  }

  // ---- settings ------------------------------------------------------------

  async getSettings(workspaceId, { fresh = false } = {}) {
    const ws = Number(workspaceId);
    const cached = this._settingsCache.get(ws);
    if (!fresh && cached && Date.now() - cached.at < SETTINGS_CACHE_MS) return cached.value;
    let failed = false;
    const raw = await Promise.resolve().then(() => settingsRepository.get(settingsKey(ws))).catch((err) => {
      failed = true;
      logger.debug?.(`Ticket shares settings unreadable: ${err.message}`);
      return null;
    });
    // A read that FAILS is "off for this decision": never act on settings we could not read.
    if (failed) return { ...normalizeSettings(null), unreadable: true };
    const value = normalizeSettings(raw);
    this._settingsCache.set(ws, { at: Date.now(), value });
    return value;
  }

  /** The workspace's people (active or assignable) and categories (active), for the editor and the checks. */
  async options(workspaceId) {
    const ws = Number(workspaceId);
    const people = await soft(() => prisma.technician.findMany({
      where: { workspaceId: ws, OR: [{ isActive: true }, { assignableOnly: true }] },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 300,
    }), []);
    const cats = await soft(() => prisma.competencyCategory.findMany({
      where: { workspaceId: ws, isActive: true },
      select: { id: true, name: true, parentId: true },
      orderBy: { name: 'asc' },
      take: 500,
    }), []);
    const tops = (cats || []).filter((c) => !c.parentId);
    const categories = tops.map((t) => ({
      id: t.id,
      name: t.name,
      subcategories: (cats || []).filter((c) => c.parentId === t.id).map((c) => ({ id: c.id, name: c.name })),
    }));
    return { people: (people || []).map((p) => ({ id: p.id, name: p.name })), categories };
  }

  /** @returns {{ settings, changes, errors }} — errors non-empty = nothing was saved. */
  async saveSettings(workspaceId, patch = {}, { by = null, now = new Date() } = {}) {
    const ws = Number(workspaceId);
    if (SANDBOX_WORKSPACES.includes(ws)) return { settings: await this.getSettings(ws, { fresh: true }), changes: [], errors: ['Ticket shares are not available in an integration sandbox'] };
    const current = await this.getSettings(ws, { fresh: true });
    if (current.unreadable) return { settings: current, changes: [], errors: ['The current settings could not be read; nothing was saved'] };
    const { people, categories } = await this.options(ws);
    const validTechIds = new Set(people.map((p) => p.id));
    const validCategoryIds = new Set(categories.flatMap((c) => [c.id, ...c.subcategories.map((s) => s.id)]));
    const { next, changes, errors } = applyPatch(current, patch, { by, now, validTechIds, validCategoryIds });
    if (errors.length) return { settings: current, changes: [], errors };
    await settingsRepository.set(settingsKey(ws), JSON.stringify(toStored(next)));
    this._settingsCache.delete(ws);
    logger.info('Ticket shares settings saved', { workspaceId: ws, by, mode: next.mode, changes: changes.map((c) => c.field) });
    return { settings: await this.getSettings(ws, { fresh: true }), changes, errors: [] };
  }

  // ---- the lock and the in-process ledger -----------------------------------

  _note(workspaceId, entry) {
    const ws = Number(workspaceId);
    const cutoff = Date.now() - LEDGER_KEEP_MS;
    const list = (this._ledger.get(ws) || []).filter((e) => e.noted >= cutoff && e.ticketId !== entry.ticketId);
    list.push({ ...entry, noted: Date.now() });
    this._ledger.set(ws, list);
  }

  async _withLock(workspaceId, fn) {
    const ws = Number(workspaceId);
    const previous = this._locks.get(ws) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    this._locks.set(ws, previous.then(() => mine));
    let timer = null;
    await Promise.race([previous, new Promise((resolve) => { timer = setTimeout(resolve, LOCK_TIMEOUT_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ---- the state the rule needs ----------------------------------------------

  async _timeZone(ws) {
    const workspace = await soft(() => prisma.workspace.findUnique({ where: { id: ws }, select: { defaultTimezone: true } }), null);
    return workspace?.defaultTimezone || 'America/Vancouver';
  }

  /**
   * Everything one decision (or the preview) needs, read once.
   * @param {object} p
   * @param {object} p.settings      normalised settings (or a draft for the preview)
   * @param {boolean} p.reserve      count Live picks still waiting for a reviewer + this process's ledger
   * @param {number|null} p.excludeTicketId  the ticket being decided
   * @param {number[]} p.handedBack  people who handed this ticket back: out for it
   */
  async _state(ws, { settings, now = new Date(), reserve = false, excludeTicketId = null, handedBack = [] } = {}) {
    const timeZone = await this._timeZone(ws);
    const period = periodOf(now, settings.period, timeZone);
    const members = settings.members || [];
    const memberIds = members.map((m) => m.techId);
    const cats = settings.categoryIds || [];

    const techs = memberIds.length ? await soft(() => prisma.technician.findMany({
      where: { id: { in: memberIds }, workspaceId: ws },
      select: { id: true, name: true, isActive: true, assignableOnly: true, timezone: true, workStartTime: true, workEndTime: true },
      take: 100,
    }), []) : [];
    const names = new Map((techs || []).map((t) => [t.id, t.name]));
    const active = new Set((techs || []).filter((t) => t.isActive || t.assignableOnly).map((t) => t.id));

    const rows = memberIds.length && cats.length ? await soft(() => prisma.ticket.findMany({
      where: {
        workspaceId: ws,
        createdAt: { gte: period.start, lte: now },
        assignedTechId: { in: memberIds },
        isNoise: false,
        status: { not: 'Deleted' },
        OR: [{ internalCategoryId: { in: cats } }, { internalSubcategoryId: { in: cats } }],
      },
      select: { id: true, assignedTechId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: COUNT_ROWS,
    }), []) : [];
    const ids = (rows || []).map((r) => r.id);
    const gone = ids.length ? await soft(() => prisma.ticketLink.findMany({
      where: { ticketId: { in: ids }, kind: { in: ['duplicate_of', 'merged_into'] } },
      select: { ticketId: true },
      take: COUNT_ROWS,
    }), []) : [];
    const goneIds = new Set((gone || []).map((g) => g.ticketId));
    const tickets = (rows || [])
      .filter((r) => !goneIds.has(r.id) && r.id !== Number(excludeTicketId))
      .map((r) => ({ ticketId: r.id, holderId: r.assignedTechId, at: r.createdAt }));

    if (reserve) {
      const counted = new Set(tickets.map((t) => t.ticketId));
      const since = new Date(new Date(now).getTime() - RESERVE_MS);
      const pending = await soft(() => prisma.$queryRaw(Prisma.sql`
        SELECT r.ticket_id AS "ticketId", t.created_at AS "createdAt", r.recommendation -> 'share' -> 'pick' ->> 'techId' AS "techId"
        FROM assignment_pipeline_runs r
        JOIN tickets t ON t.id = r.ticket_id
        WHERE r.workspace_id = ${ws} AND r.created_at >= ${since} AND r.decision = 'pending_review'
          AND t.assigned_tech_id IS NULL AND t.created_at >= ${period.start}
          AND r.recommendation -> 'share' ->> 'mode' = 'live'
          AND r.recommendation -> 'share' ->> 'applied' = 'true'
        ORDER BY r.created_at DESC
        LIMIT 200`), []);
      for (const p of pending || []) {
        const ticketId = Number(p.ticketId);
        const techId = Number(p.techId);
        if (counted.has(ticketId) || ticketId === Number(excludeTicketId) || !memberIds.includes(techId)) continue;
        counted.add(ticketId);
        tickets.push({ ticketId, holderId: techId, at: p.createdAt, reserved: true });
      }
      for (const entry of this._ledger.get(ws) || []) {
        if (counted.has(entry.ticketId) || entry.ticketId === Number(excludeTicketId) || !memberIds.includes(entry.techId)) continue;
        if (new Date(entry.createdAt).getTime() < period.start.getTime()) continue;
        counted.add(entry.ticketId);
        tickets.push({ ticketId: entry.ticketId, holderId: entry.techId, at: entry.createdAt, reserved: true });
      }
      tickets.sort((a, b) => new Date(a.at) - new Date(b.at));
    }

    const leaveRows = memberIds.length ? await soft(() => prisma.technicianLeave.findMany({
      where: {
        technicianId: { in: memberIds },
        status: 'APPROVED',
        leaveDate: { gte: new Date(period.start.getTime() - 2 * DAY_MS), lte: new Date(new Date(now).getTime() + 2 * DAY_MS) },
      },
      select: { technicianId: true, leaveDate: true, category: true, status: true, isFullDay: true, halfDayPart: true, startMinute: true, endMinute: true },
      take: 5000,
    }), []) : [];
    const leavesByTech = new Map(memberIds.map((id) => [id, []]));
    for (const l of leaveRows || []) leavesByTech.get(l.technicianId)?.push(l);

    const last = memberIds.length ? await soft(() => prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId: ws, assignedTechId: { in: memberIds }, assignedAt: { not: null } },
      _max: { assignedAt: true },
    }), []) : [];
    const lastAssignedAt = new Map();
    for (const row of last || []) {
      const at = row?._max?.assignedAt ? new Date(row._max.assignedAt).getTime() : null;
      if (at) lastAssignedAt.set(row.assignedTechId, at);
    }
    // Picks counted as held (reserved) are the most recent assignment of their person.
    for (const t of tickets) {
      if (!t.reserved) continue;
      const at = new Date(t.at).getTime();
      if (!lastAssignedAt.has(t.holderId) || lastAssignedAt.get(t.holderId) < at) lastAssignedAt.set(t.holderId, at);
    }

    const out = new Map();
    for (const m of members) {
      if (!active.has(m.techId)) out.set(m.techId, 'not active');
      else if (onLeaveAt(leavesByTech.get(m.techId), now, timeZone)) out.set(m.techId, 'on leave');
      else if (handedBack.includes(m.techId)) out.set(m.techId, 'handed this ticket back');
    }

    // QA 10-20 #4: outside their working hours now (their zone, their hours).
    const techById = new Map((techs || []).map((t) => [t.id, t]));
    const notWorking = new Map();
    for (const m of members) {
      if (out.has(m.techId)) continue;
      if (!workingAt(techById.get(m.techId), now, timeZone)) notWorking.set(m.techId, 'outside working hours');
    }

    const ledger = buildLedger({ members, tickets: tickets.map((t) => ({ holderId: t.holderId, at: t.at })), leavesByTech, timeZone });
    return { timeZone, period, names, out, notWorking, ledger, lastAssignedAt, counted: tickets.length };
  }

  // ---- the pipeline step -----------------------------------------------------

  /**
   * Called by the pipeline after the AI's verdict, for a run that will
   * auto-assign or wait for a reviewer.
   *
   * @returns {null | { mode, applied:boolean, techId, techName, sentence, record, recommendations?, step }}
   *   null = the rule does not cover this ticket (off, other category, sandbox, error).
   *   Shadow: only `record` (kept on the run). Live + applied: `techId` (auto-assign)
   *   or `recommendations` (suggest-only, the rule's pick first), and a `step`.
   */
  async applyToRun({
    workspaceId, ticketId, runId = null, decision, recommendation = null, aiPick = null, dryRun = false, now = new Date(),
  } = {}) {
    try {
      const ws = Number(workspaceId);
      if (!positive(Number(ticketId)) || SANDBOX_WORKSPACES.includes(ws)) return null;
      if (!['auto_assigned', 'pending_review'].includes(decision)) return null;
      const settings = await this.getSettings(ws);
      if (settings.mode === 'off' || !settings.members.length || !settings.categoryIds.length) return null;

      const saved = await soft(() => prisma.ticket.findUnique({
        where: { id: Number(ticketId) },
        select: { id: true, createdAt: true, internalCategoryId: true, internalSubcategoryId: true },
      }), null);
      const categoryId = Number(recommendation?.internalCategoryId) || saved?.internalCategoryId || null;
      const subcategoryId = Number(recommendation?.internalSubcategoryId) || saved?.internalSubcategoryId || null;
      if (!categoryMatches(settings.categoryIds, { categoryId, subcategoryId })) return null;

      // A pipeline in dry-run mode never acts: Live behaves as Shadow there.
      const live = settings.mode === 'live' && !dryRun;
      const mode = live ? 'live' : 'shadow';

      return await this._withLock(ws, async () => {
        const handed = await soft(() => prisma.ticketAssignmentEpisode.findMany({
          where: { ticketId: Number(ticketId), endMethod: 'rejected' }, select: { technicianId: true }, take: 50,
        }), []);
        const state = await this._state(ws, {
          settings, now, reserve: live, excludeTicketId: Number(ticketId), handedBack: (handed || []).map((h) => Number(h.technicianId)),
        });
        const result = decide({ settings, ledger: state.ledger, out: state.out, notWorking: state.notWorking, lastAssignedAt: state.lastAssignedAt, names: state.names, aiPick });
        const applied = live && Boolean(result.techId);
        const techName = result.techId ? state.names.get(result.techId) || null : null;
        const aiName = aiPick?.techName || null;

        const who = `${techName || `Technician ${result.techId}`}, ${result.reason}.`;
        let sentence;
        if (!result.techId) sentence = result.sentence;
        else if (!live) sentence = `Shadow: the share rule would have suggested ${who}${aiName ? ` The AI picked ${aiName}.` : ''}`;
        else if (decision === 'auto_assigned') sentence = `Assigned by the share rule to ${who}${aiName && !result.agreesWithAi ? ` The AI’s first choice was ${aiName}.` : ''}`;
        else sentence = `Suggested first by the share rule: ${who}${aiName && !result.agreesWithAi ? ` The AI’s own first choice, ${aiName}, is second.` : ''}`;

        const record = recordFor({ ...result, sentence }, { settings, mode, applied, period: state.period, aiPick, now });
        if (applied) {
          this._note(ws, { ticketId: Number(ticketId), techId: result.techId, createdAt: saved?.createdAt || now, runId });
          logger.info('Ticket shares picked the person', { workspaceId: ws, ticketId, runId, decision, techId: result.techId, aiTechId: aiPick?.techId || null });
        }
        const out = { mode, applied, techId: result.techId, techName, sentence, record, step: null };
        if (applied && decision === 'pending_review') {
          out.recommendations = promoteSuggestion(recommendation?.recommendations, { techId: result.techId, techName, reason: result.reason, aiPick });
        }
        if (live) {
          out.step = {
            stepName: 'share_rule',
            status: 'completed',
            durationMs: 0,
            output: {
              kind: 'share_rule',
              mode,
              applied,
              fromTechId: aiPick?.techId || null,
              fromTechName: aiName,
              toTechId: result.techId || null,
              toTechName: techName,
              message: sentence,
            },
          };
        }
        return out;
      });
    } catch (err) {
      logger.warn('Ticket shares: the rule failed, the AI’s pick stands', { workspaceId, ticketId, runId, error: err.message });
      return null;
    }
  }

  // ---- the preview -------------------------------------------------------------

  /**
   * "The next 10 tickets would go to …" for saved settings or a draft (period,
   * categories and people). Uses this period's real counts and today's leave.
   */
  async preview(workspaceId, draft = null, { now = new Date(), count = 10 } = {}) {
    const ws = Number(workspaceId);
    const saved = await this.getSettings(ws);
    const settings = draft ? { ...saved, ...draft } : saved;
    if (draft && validateDraft({ ...settings, mode: 'off' }).length) return { picks: [], out: [], counts: [], period: null, ready: false };
    if (!settings.members?.length || !settings.categoryIds?.length) return { picks: [], out: [], counts: [], period: null, ready: false };
    const state = await this._state(ws, { settings, now, reserve: settings.mode === 'live' });
    const picks = previewSequence({ members: settings.members, ledger: state.ledger, out: state.out, notWorking: state.notWorking, lastAssignedAt: state.lastAssignedAt, count, now });
    const name = (id) => state.names.get(id) || `Technician ${id}`;
    const result = decide({ settings, ledger: state.ledger, out: state.out, notWorking: state.notWorking, lastAssignedAt: state.lastAssignedAt, names: state.names });
    return {
      ready: true,
      period: { kind: settings.period, key: state.period.key, start: state.period.start.toISOString() },
      picks: picks.map((id) => ({ techId: id, name: name(id) })),
      out: [...state.out, ...state.notWorking].map(([techId, why]) => ({ techId, name: name(techId), why })),
      counts: result.people.map((p) => ({ techId: p.techId, name: p.name, pct: p.pct, count: p.count, target: p.target })),
      counted: state.counted,
    };
  }

  // ---- the Shadow report -------------------------------------------------------

  async results(workspaceId, { days = 14, now = new Date() } = {}) {
    const ws = Number(workspaceId);
    const period = [7, 14, 30].includes(Number(days)) ? Number(days) : 14;
    const settings = await this.getSettings(ws, { fresh: true });
    const timeZone = await this._timeZone(ws);
    const since = new Date(new Date(now).getTime() - period * DAY_MS);
    const members = settings.members || [];
    const cats = settings.categoryIds || [];
    const empty = { workspaceId: ws, timeZone, days: period, settings, rows: [], totals: null, events: [] };
    if (!members.length || !cats.length) return empty;

    const tickets = await soft(() => prisma.ticket.findMany({
      where: {
        workspaceId: ws,
        createdAt: { gte: since, lte: now },
        isNoise: false,
        status: { not: 'Deleted' },
        OR: [{ internalCategoryId: { in: cats } }, { internalSubcategoryId: { in: cats } }],
      },
      select: { id: true, assignedTechId: true, assignedBy: true, assignedTech: { select: { name: true } } },
      take: REPORT_ROWS,
    }), []);
    const ticketHolder = new Map((tickets || []).map((t) => [t.id, t.assignedTechId]));
    // QA 10-20 #4: how many the person took themselves (picked from the queue).
    // No rule and no AI decides those, so no formula can steer them.
    const selfPicked = (tickets || []).filter((t) => t.assignedTechId && t.assignedBy && t.assignedTech?.name && t.assignedBy === t.assignedTech.name).length;

    // Only the small `share` object leaves the database, never the whole recommendation.
    const runs = await soft(() => prisma.$queryRaw(Prisma.sql`
      SELECT DISTINCT ON (r.ticket_id) r.id, r.ticket_id AS "ticketId", r.created_at AS "at", r.recommendation -> 'share' AS share
      FROM assignment_pipeline_runs r
      WHERE r.workspace_id = ${ws} AND r.created_at >= ${since} AND r.recommendation -> 'share' IS NOT NULL
      ORDER BY r.ticket_id, r.created_at DESC
      LIMIT ${REPORT_ROWS}`), []);
    const inScope = (runs || []).filter((r) => r.share && ticketHolder.has(Number(r.ticketId)));
    const runRows = inScope.map((r) => ({ ticketId: Number(r.ticketId), share: r.share, holderId: ticketHolder.get(Number(r.ticketId)) ?? null }));

    const names = new Map();
    const techIds = new Set([...members.map((m) => m.techId), ...runRows.map((r) => Number(r.holderId)).filter(positive)]);
    const techs = await soft(() => prisma.technician.findMany({ where: { id: { in: [...techIds] } }, select: { id: true, name: true }, take: 300 }), []);
    for (const t of techs || []) names.set(t.id, t.name);

    const summary = summarizeReport({
      members,
      tickets: (tickets || []).map((t) => ({ id: t.id, holderId: t.assignedTechId })),
      runs: runRows,
      names,
    });

    const recent = [...inScope].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, EVENT_ROWS);
    const recentIds = recent.map((r) => Number(r.ticketId));
    const refs = recentIds.length ? await soft(() => prisma.ticket.findMany({
      where: { id: { in: recentIds }, workspaceId: ws },
      select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true },
      take: recentIds.length,
    }), []) : [];
    const refById = new Map((refs || []).map((t) => [t.id, t]));
    const events = recent.map((r) => {
      const t = refById.get(Number(r.ticketId)) || null;
      const holder = ticketHolder.get(Number(r.ticketId)) ?? null;
      return {
        runId: Number(r.id),
        at: r.at,
        mode: r.share.mode || null,
        ticket: t ? { id: t.id, displayRef: ticketDisplayRef(t), subject: t.subject || null } : { id: Number(r.ticketId), displayRef: null, subject: null },
        rulePick: r.share.pick?.name || null,
        aiPick: r.share.aiPick?.name || null,
        wentTo: holder ? (names.get(holder) || `Technician ${holder}`) : null,
        agreed: Boolean(holder && r.share.pick?.techId && Number(r.share.pick.techId) === Number(holder)),
      };
    });

    return { ...empty, ...summary, totals: summary.totals ? { ...summary.totals, selfPicked } : summary.totals, events };
  }
}

export default new AssignmentSharesService();
