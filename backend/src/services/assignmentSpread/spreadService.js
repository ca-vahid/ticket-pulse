import { Prisma } from '@prisma/client';
import prisma from '../prisma.js';
import settingsRepository from '../settingsRepository.js';
import logger from '../../utils/logger.js';
import { ticketDisplayRef } from '../../utils/ticketOrigin.js';
import {
  MINUTE_MS, NEW_HIRE_SET_KEYS, RULES,
  applyPatch, decide, normalizeSettings, orderForRelease, recentByTech, recordFor, releaseAllowance, summarize, toStored, unitKeyFor,
} from './rules.js';

/**
 * Assignment spread — the part that reads and remembers (QA 10-13 item 17).
 * The rules themselves are in rules.js (pure).
 *
 * - Settings live in app_settings under `assignment_spread_ws<id>` (no table).
 * - "What was just assigned" = the automatic assignments of the last minutes
 *   read from assignment_pipeline_runs, plus the decisions made in this
 *   process that are not saved yet (the ledger). The database read makes it
 *   hold across restarts; the ledger closes the gap of a decision that is
 *   still being written.
 * - The check-then-remember step runs one at a time per workspace (a promise
 *   chain, milliseconds long), so two runs finishing together cannot both see
 *   "2 so far" and both keep the same person.
 * - What a rule changed is kept on the run itself: `recommendation.spread`
 *   and a `assignment_spread` step. The results page reads those.
 *
 * Nothing here may ever fail an assignment: every public method catches and
 * answers "leave it as it was".
 */

export const settingsKey = (workspaceId) => `assignment_spread_ws${Number(workspaceId)}`;

/** Integration sandboxes: never guarded. */
const SANDBOX_WORKSPACES = [6, 7, 8, 9];
const SETTINGS_CACHE_MS = 15 * 1000;
const LEDGER_KEEP_MS = 130 * MINUTE_MS;
const LOCK_TIMEOUT_MS = 15 * 1000;
const RELEASE_FETCH = 50;
const RELEASE_MAX_ROUNDS = 8;
const RESULT_ROWS = 6000;
const EVENT_ROWS = 60;
/** A decision whose write-back did not put the ticket with the person does not count. */
const NOT_ASSIGNED_SYNC = ['dry_run', 'skipped', 'failed'];

const soft = (fn, fallback = null) => Promise.resolve().then(fn).catch((err) => {
  logger.debug?.(`Assignment spread read degraded: ${err.message}`);
  return fallback;
});
const positive = (n) => Number.isInteger(n) && n > 0;

class AssignmentSpreadService {
  constructor() {
    this._settingsCache = new Map();
    this._ledger = new Map();
    this._locks = new Map();
    this._releasing = new Set();
    this._releasedAt = new Map();
  }

  // ---- settings ------------------------------------------------------------

  async getSettings(workspaceId, { fresh = false } = {}) {
    const ws = Number(workspaceId);
    const cached = this._settingsCache.get(ws);
    if (!fresh && cached && Date.now() - cached.at < SETTINGS_CACHE_MS) return cached.value;
    // A read that FAILS is "off for this decision" (never the IT default-on):
    // the rules must not act on settings they could not read.
    let failed = false;
    const raw = await Promise.resolve().then(() => settingsRepository.get(settingsKey(ws))).catch((err) => {
      failed = true;
      logger.debug?.(`Assignment spread settings unreadable: ${err.message}`);
      return null;
    });
    if (failed) return { ...normalizeSettings(null, ws), enabled: false, unreadable: true };
    const value = normalizeSettings(raw, ws);
    this._settingsCache.set(ws, { at: Date.now(), value });
    return value;
  }

  /** @returns {{ settings, changes, errors }} — errors non-empty = nothing was saved. */
  async saveSettings(workspaceId, patch = {}, { by = null, now = new Date() } = {}) {
    const ws = Number(workspaceId);
    const current = await this.getSettings(ws, { fresh: true });
    const { next, changes, errors } = applyPatch(current, patch, { by, now });
    if (errors.length) return { settings: current, changes: [], errors };
    await settingsRepository.set(settingsKey(ws), JSON.stringify(toStored(next)));
    this._settingsCache.delete(ws);
    logger.info('Assignment spread settings saved', { workspaceId: ws, by, changes });
    return { settings: await this.getSettings(ws, { fresh: true }), changes, errors: [] };
  }

  // ---- the ledger: decided here, perhaps not saved yet -------------------------

  _note(workspaceId, entry) {
    const ws = Number(workspaceId);
    const cutoff = Date.now() - LEDGER_KEEP_MS;
    const list = (this._ledger.get(ws) || []).filter((e) => e.at >= cutoff && e.ticketId !== entry.ticketId);
    list.push(entry);
    this._ledger.set(ws, list);
  }

  /** For tests. */
  _reset() {
    this._settingsCache.clear();
    this._ledger.clear();
    this._locks.clear();
    this._releasing.clear();
    this._releasedAt.clear();
  }

  async _withLock(workspaceId, fn) {
    const ws = Number(workspaceId);
    const previous = this._locks.get(ws) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    this._locks.set(ws, previous.then(() => mine));
    // A stuck holder must never stop assignments: wait for it, but not for ever.
    let timer = null;
    await Promise.race([previous, new Promise((resolve) => { timer = setTimeout(resolve, LOCK_TIMEOUT_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ---- A. what was just assigned ---------------------------------------------

  /** ticketId → family id, for tickets that are one half of a new hire's Workstation + Laptop/Desktop set. */
  async _setFamilies(ticketIds) {
    const ids = [...new Set((ticketIds || []).map(Number).filter(positive))];
    const out = new Map();
    if (!ids.length) return out;
    const members = await soft(() => prisma.hrLifecycleFamilyMember.findMany({
      where: { ticketId: { in: ids }, templateKey: { in: [...NEW_HIRE_SET_KEYS] }, family: { kind: 'onboarding' } },
      select: { ticketId: true, familyId: true },
      take: 1000,
    }), []);
    for (const m of members || []) out.set(Number(m.ticketId), Number(m.familyId));
    return out;
  }

  /**
   * Every automatic assignment since `since`, as events for rules.recentByTech():
   * the pipeline's own (saved or still being saved) and a new hire's set given
   * by the onboarding engine. Never one a person made by hand, never a ticket
   * that has since left the person (handed back or moved).
   */
  async recentEvents(workspaceId, { since, settings = null } = {}) {
    const ws = Number(workspaceId);
    const s = settings || await this.getSettings(ws);
    const rows = await soft(() => prisma.assignmentPipelineRun.findMany({
      where: { workspaceId: ws, decision: 'auto_assigned', assignedTechId: { not: null }, decidedAt: { gte: since } },
      select: { id: true, ticketId: true, assignedTechId: true, decidedAt: true, syncStatus: true, ticket: { select: { assignedTechId: true } } },
      orderBy: { decidedAt: 'desc' },
      take: 500,
    }), []);
    const events = [];
    const knownRuns = new Set();
    const seenTickets = new Set();
    for (const run of rows || []) {
      knownRuns.add(run.id);
      if (NOT_ASSIGNED_SYNC.includes(run.syncStatus)) continue;
      const holder = run.ticket?.assignedTechId ?? null;
      // Applied and no longer with this person: handed back or moved on. Not load.
      if (holder && holder !== run.assignedTechId) continue;
      if (!holder && run.syncStatus === 'synced') continue;
      if (seenTickets.has(run.ticketId)) continue;
      seenTickets.add(run.ticketId);
      events.push({ techId: run.assignedTechId, at: run.decidedAt, ticketId: run.ticketId, saved: holder === run.assignedTechId, source: 'run' });
    }
    // Decided in this process and not in the table yet.
    for (const entry of this._ledger.get(ws) || []) {
      if (entry.at < new Date(since).getTime()) continue;
      if ((entry.runId && knownRuns.has(entry.runId)) || seenTickets.has(entry.ticketId)) continue;
      seenTickets.add(entry.ticketId);
      events.push({ techId: entry.techId, at: entry.at, ticketId: entry.ticketId, unitKey: entry.unitKey, saved: false, source: 'ledger' });
    }

    if (s.keepNewHireSet) {
      // A new hire's set handed out by the onboarding engine counts too (once per new hire).
      const engineGiven = await soft(() => prisma.ticket.findMany({
        where: { workspaceId: ws, assignedTechId: { not: null }, assignedAt: { gte: since }, assignedBy: { startsWith: 'Ticket Pulse' } },
        select: { id: true, assignedTechId: true, assignedAt: true },
        orderBy: { assignedAt: 'desc' },
        take: 300,
      }), []);
      const families = await this._setFamilies([...events.map((e) => e.ticketId), ...(engineGiven || []).map((t) => t.id)]);
      for (const event of events) {
        if (!event.unitKey) event.unitKey = unitKeyFor(event.ticketId, { familyId: families.get(Number(event.ticketId)) || null, keepNewHireSet: true });
      }
      for (const t of engineGiven || []) {
        if (seenTickets.has(t.id) || !families.has(t.id)) continue;
        seenTickets.add(t.id);
        events.push({ techId: t.assignedTechId, at: t.assignedAt, ticketId: t.id, unitKey: unitKeyFor(t.id, { familyId: families.get(t.id), keepNewHireSet: true }), saved: true, source: 'onboarding' });
      }
    }
    for (const event of events) if (!event.unitKey) event.unitKey = unitKeyFor(event.ticketId, { keepNewHireSet: false });
    return events;
  }

  /**
   * For the AI's candidate lists (find_matching_agents, get_workload_stats):
   * adds to every row what automation just gave that person, a load figure
   * the score uses, and whether they are at the cap. Mutates `rows`; returns a
   * one-line note for the model, or null when the rules are off. Never throws.
   */
  async annotateCandidates(workspaceId, rows, { now = new Date(), ticketId = null } = {}) {
    try {
      const ws = Number(workspaceId);
      if (!Array.isArray(rows) || !rows.length || SANDBOX_WORKSPACES.includes(ws)) return null;
      const settings = await this.getSettings(ws);
      if (!settings.enabled || (!settings.countRecent && !settings.capEnabled)) return null;
      const longest = Math.max(settings.countRecent ? settings.recentWindowMinutes : 0, settings.capEnabled ? settings.capWindowMinutes : 0);
      const events = await this.recentEvents(ws, { since: new Date(new Date(now).getTime() - longest * MINUTE_MS), settings });
      const recent = recentByTech(events, { now, windowMinutes: settings.recentWindowMinutes, excludeTicketId: ticketId });
      const capped = recentByTech(events, { now, windowMinutes: settings.capWindowMinutes, excludeTicketId: ticketId });
      for (const row of rows) {
        const id = Number(row.techId);
        const mine = recent.get(id) || { count: 0, notSaved: 0 };
        if (settings.countRecent) {
          row.assignedByAutomationRecently = { count: mine.count, minutes: settings.recentWindowMinutes, notYetInOpenTickets: mine.notSaved };
          // Saved ones are already inside openTickets; while they are fresh they
          // weigh twice, and the ones still being saved are added so the count is true.
          row.loadForScore = (Number(row.openTickets) || 0) + mine.count + mine.notSaved;
        }
        if (settings.capEnabled && (capped.get(id)?.count || 0) >= settings.capCount) {
          row.atAssignmentCap = true;
        }
      }
      const parts = [];
      if (settings.countRecent) parts.push(`assignedByAutomationRecently = tickets automation gave this person in the last ${settings.recentWindowMinutes} min (some are not in openTickets yet); treat them as load`);
      if (settings.capEnabled) parts.push(`atAssignmentCap = already got ${settings.capCount} in ${settings.capWindowMinutes} min: automation will pass this ticket to your next-ranked candidate, so rank a real second choice`);
      return parts.join('. ') || null;
    } catch (err) {
      logger.warn('Assignment spread: could not add recent assignments to the candidate list', { workspaceId, error: err.message });
      return null;
    }
  }

  // ---- B + D. the guard on one automatic assignment ------------------------------

  /** Who may take this ticket instead: the run's own ranked list first, then anybody else at work with the skill. */
  async _candidates({ ws, ticket, pickId, ranked, exclude, now }) {
    const { default: urgent } = await import('../urgentResponse/urgentResponseService.js');
    const ctx = await urgent._context(ws, now, { mode: 'observe' });
    const fsBorn = ticket.origin !== 'ticketpulse';
    const out = [];
    for (const rec of ranked || []) {
      const id = Number(rec?.techId);
      if (!positive(id) || id === pickId || out.some((c) => c.techId === id)) continue;
      const tech = await urgent._person(ctx, id);
      let whyNot = null;
      if (!tech || !tech.isActive) whyNot = 'not active';
      else if (exclude.has(id)) whyNot = 'handed this ticket back';
      else if (fsBorn && !(tech.freshserviceId && tech.origin !== 'local')) whyNot = 'no FreshService seat';
      else if (!urgent._state(ctx, tech, now, 0).atWork) whyNot = 'not at work';
      out.push({ techId: id, name: tech?.name || rec.techName || null, eligible: !whyNot, whyNot, source: 'run' });
    }
    // The run named nobody else who can take it: anybody at work with the skill.
    if (!out.some((c) => c.eligible)) {
      const pick = await soft(() => urgent.pickResponder(ws, ticket, { exclude: [pickId, ...exclude], now, ctx }), null);
      for (const person of pick?.ranked || []) {
        if (person.skill === 'none' || out.some((c) => c.techId === person.id)) continue;
        out.push({ techId: person.id, name: person.name, eligible: true, whyNot: null, source: 'skill' });
      }
    }
    return out;
  }

  /** Who already holds the other half of this new hire's set (saved, or decided a moment ago). */
  async _setOwner({ ws, ticketId, familyId, unitKey }) {
    if (!familyId) return null;
    const members = await soft(() => prisma.hrLifecycleFamilyMember.findMany({
      where: { familyId, templateKey: { in: [...NEW_HIRE_SET_KEYS] }, ticketId: { not: ticketId } },
      select: { ticketId: true },
      take: 10,
    }), []);
    const ids = (members || []).map((m) => m.ticketId);
    let ownerId = null;
    if (ids.length) {
      const siblings = await soft(() => prisma.ticket.findMany({
        where: { id: { in: ids }, workspaceId: ws, assignedTechId: { not: null } },
        select: { assignedTechId: true, assignedAt: true },
        orderBy: { assignedAt: 'desc' },
        take: 10,
      }), []);
      ownerId = siblings?.[0]?.assignedTechId || null;
    }
    if (!ownerId) {
      const pending = (this._ledger.get(ws) || []).filter((e) => e.unitKey === unitKey && e.ticketId !== ticketId).pop();
      ownerId = pending?.techId || null;
    }
    if (!ownerId) return null;
    const tech = await soft(() => prisma.technician.findFirst({ where: { id: ownerId, workspaceId: ws }, select: { id: true, name: true, isActive: true } }), null);
    return tech?.isActive ? { techId: tech.id, name: tech.name } : null;
  }

  /**
   * Called by the pipeline when a run is about to auto-assign.
   *
   * @returns {{ techId:number|null, techName:string|null, changed:boolean, rule:string, sentence:string|null, record:object|null, step:object|null }}
   *   `techId` is who gets the ticket. `record` goes on the run (`recommendation.spread`);
   *   `step` (when a rule did something) is a pipeline step to save. Any error → unchanged.
   */
  async guardAutoAssignment({
    workspaceId, ticketId, runId = null, techId, techName = null, recommendation = null, reboundFrom = null, locked = false, dryRun = false, now = new Date(),
  } = {}) {
    const unchanged = { techId: techId ?? null, techName, changed: false, rule: RULES.NONE, sentence: null, record: null, step: null };
    try {
      const ws = Number(workspaceId);
      const pickId = Number(techId);
      if (!positive(pickId) || !positive(Number(ticketId)) || dryRun || SANDBOX_WORKSPACES.includes(ws)) return unchanged;
      const settings = await this.getSettings(ws);
      if (!settings.enabled) return unchanged;

      return await this._withLock(ws, async () => {
        const saved = await soft(() => prisma.ticket.findUnique({
          where: { id: Number(ticketId) },
          select: { id: true, workspaceId: true, origin: true, internalCategoryId: true, internalSubcategoryId: true },
        }), null);
        const ticket = { origin: 'freshservice', ...(saved || {}), id: Number(ticketId), workspaceId: ws };
        const guarded = {
          ...ticket,
          internalCategoryId: Number(recommendation?.internalCategoryId) || ticket.internalCategoryId || null,
          internalSubcategoryId: Number(recommendation?.internalSubcategoryId) || ticket.internalSubcategoryId || null,
        };

        const familyId = settings.keepNewHireSet ? (await this._setFamilies([ticket.id])).get(ticket.id) || null : null;
        const unitKey = unitKeyFor(ticket.id, { familyId, keepNewHireSet: settings.keepNewHireSet });
        const setOwner = familyId ? await this._setOwner({ ws, ticketId: ticket.id, familyId, unitKey }) : null;

        const events = await this.recentEvents(ws, { since: new Date(new Date(now).getTime() - settings.capWindowMinutes * MINUTE_MS), settings });
        const recent = recentByTech(events, { now, windowMinutes: settings.capWindowMinutes, excludeTicketId: ticket.id });

        const ranked = Array.isArray(recommendation?.recommendations)
          ? [...recommendation.recommendations].sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99))
          : [];
        const pickName = techName || ranked.find((r) => Number(r.techId) === pickId)?.techName || null;
        const overCap = settings.capEnabled && !locked && !setOwner
          && (recent.get(pickId)?.count || 0) >= settings.capCount && !recent.get(pickId)?.units?.has(unitKey);
        let candidates = [];
        if (overCap) {
          // People who handed this very ticket back are never the "next best".
          const rejected = await soft(() => prisma.ticketAssignmentEpisode.findMany({
            where: { ticketId: ticket.id, endMethod: 'rejected' }, select: { technicianId: true }, take: 50,
          }), []);
          const exclude = new Set((rejected || []).map((r) => Number(r.technicianId)));
          if (positive(Number(reboundFrom?.previousTechId))) exclude.add(Number(reboundFrom.previousTechId));
          candidates = await this._candidates({ ws, ticket: guarded, pickId, ranked, exclude, now });
        }

        const result = decide({ settings, pick: { techId: pickId, name: pickName }, unitKey, recent, candidates, setOwner, locked });
        const finalId = result.techId || pickId;
        this._note(ws, { techId: finalId, at: new Date(now).getTime(), ticketId: ticket.id, unitKey, runId });
        const record = recordFor(result, { unitKey, settings, now });
        const changed = result.rule !== RULES.NONE;
        if (changed) {
          logger.info('Assignment spread changed an automatic assignment', {
            workspaceId: ws, ticketId: ticket.id, runId, rule: result.rule, fromTechId: pickId, toTechId: finalId, recent: result.recentCount,
          });
        }
        return {
          techId: finalId,
          techName: result.moved ? (result.to?.name || null) : pickName,
          changed,
          moved: result.moved === true,
          rule: result.rule,
          sentence: result.sentence,
          record,
          step: changed ? {
            stepName: 'assignment_spread',
            status: 'completed',
            durationMs: 0,
            output: {
              kind: 'assignment_spread',
              rule: result.rule,
              fromTechId: pickId,
              fromTechName: pickName,
              toTechId: result.moved ? finalId : null,
              toTechName: result.moved ? (result.to?.name || null) : null,
              recentCount: result.recentCount,
              considered: record.considered,
              message: result.sentence,
            },
          } : null,
        };
      });
    } catch (err) {
      logger.warn('Assignment spread: the guard failed, the assignment goes ahead as it was', { workspaceId, ticketId, runId, error: err.message });
      return unchanged;
    }
  }

  // ---- F. the release of the queue ---------------------------------------------

  /**
   * Called at the top of every queue drain. With the stagger off (or on any
   * error) the drain runs exactly as before. With it on: one release at a time
   * per workspace, `staggerCount` every `staggerMinutes`, most urgent and
   * oldest first, one decision after another.
   *
   * @returns {{ staggered:boolean, wait:boolean, allowance:number, fetchLimit:number, order:Function|null, started:Function, done:Function }}
   */
  async beginRelease(workspaceId, { now = new Date() } = {}) {
    const ws = Number(workspaceId);
    const pass = { staggered: false, wait: false, allowance: 0, fetchLimit: 0, order: null, started: () => {}, done: () => {} };
    try {
      if (SANDBOX_WORKSPACES.includes(ws)) return pass;
      const settings = await this.getSettings(ws);
      if (!settings.enabled || !settings.staggerEnabled) return pass;
      if (this._releasing.has(ws)) return { ...pass, staggered: true, wait: true };
      const allowance = releaseAllowance(settings, this._releasedAt.get(ws) || [], now);
      if (allowance <= 0) return { ...pass, staggered: true, wait: true };
      this._releasing.add(ws);
      return {
        staggered: true,
        wait: false,
        allowance,
        fetchLimit: RELEASE_FETCH,
        maxRounds: RELEASE_MAX_ROUNDS,
        order: orderForRelease,
        // One mark per run that really started (a stale run that was only swept away is free).
        started: (count = 1) => {
          const cutoff = Date.now() - 2 * 60 * MINUTE_MS;
          const list = (this._releasedAt.get(ws) || []).filter((t) => t >= cutoff);
          for (let i = 0; i < count; i += 1) list.push(Date.now());
          this._releasedAt.set(ws, list);
        },
        done: () => { this._releasing.delete(ws); },
      };
    } catch (err) {
      logger.warn('Assignment spread: the staggered release could not start, draining as before', { workspaceId: ws, error: err.message });
      this._releasing.delete(ws);
      return pass;
    }
  }

  // ---- "how have they worked" ----------------------------------------------------

  async results(workspaceId, { days = 30, now = new Date() } = {}) {
    const ws = Number(workspaceId);
    const period = [7, 14, 30].includes(Number(days)) ? Number(days) : 30;
    const settings = await this.getSettings(ws, { fresh: true });
    const workspace = await soft(() => prisma.workspace.findUnique({ where: { id: ws }, select: { defaultTimezone: true } }), null);
    const timeZone = workspace?.defaultTimezone || 'America/Los_Angeles';
    const since = new Date(new Date(now).getTime() - period * 24 * 60 * MINUTE_MS);

    // Only the small `spread` object leaves the database, never the whole recommendation.
    const runs = await soft(() => prisma.$queryRaw(Prisma.sql`
      SELECT r.id, r.ticket_id AS "ticketId", r.assigned_tech_id AS "techId", r.decided_at AS "at",
             r.recommendation -> 'spread' AS spread
      FROM assignment_pipeline_runs r
      WHERE r.workspace_id = ${ws} AND r.decision = 'auto_assigned' AND r.assigned_tech_id IS NOT NULL
        AND r.decided_at >= ${since}
        AND (r.sync_status IS NULL OR r.sync_status NOT IN ('dry_run', 'skipped', 'failed'))
      ORDER BY r.decided_at ASC
      LIMIT ${RESULT_ROWS}`), []);
    const queued = await soft(() => prisma.$queryRaw(Prisma.sql`
      SELECT r.queued_at AS "queuedAt", r.claimed_at AS "claimedAt"
      FROM assignment_pipeline_runs r
      WHERE r.workspace_id = ${ws} AND r.queued_at IS NOT NULL AND r.claimed_at >= ${since} AND r.status = 'completed'
      ORDER BY r.claimed_at ASC
      LIMIT ${RESULT_ROWS}`), []);

    const summary = summarize(runs || [], queued || [], { settings, timeZone, days: period, now });

    const changed = (runs || []).filter((r) => r.spread && r.spread.rule && r.spread.rule !== RULES.NONE).slice(-EVENT_ROWS).reverse();
    const ticketIds = [...new Set(changed.map((r) => Number(r.ticketId)))];
    const tickets = ticketIds.length ? await soft(() => prisma.ticket.findMany({
      where: { id: { in: ticketIds }, workspaceId: ws },
      select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true },
      take: ticketIds.length,
    }), []) : [];
    const ticketById = new Map((tickets || []).map((t) => [t.id, t]));
    const events = changed.map((r) => {
      const t = ticketById.get(Number(r.ticketId)) || null;
      return {
        runId: Number(r.id),
        at: r.at,
        rule: r.spread.rule,
        ticket: t ? { id: t.id, displayRef: ticketDisplayRef(t), subject: t.subject || null } : { id: Number(r.ticketId), displayRef: null, subject: null },
        wouldHaveGoneTo: r.spread.from?.name || null,
        wentTo: r.spread.to?.name || r.spread.from?.name || null,
        recent: r.spread.recent ?? null,
        why: r.spread.why || null,
      };
    });

    return { workspaceId: ws, timeZone, settings, ...summary, events };
  }
}

export default new AssignmentSpreadService();
