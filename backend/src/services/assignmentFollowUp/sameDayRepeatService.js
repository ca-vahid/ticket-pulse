import prisma from '../prisma.js';
import settingsRepository from '../settingsRepository.js';
import logger from '../../utils/logger.js';
import { getLocalDateBounds, getTodayRange } from '../../utils/timezone.js';
import { onShiftAt } from '../assignmentLevelMatch/rules.js';
import {
  MODES, OUTCOMES, applyPatch, mergeNote, normalizeSettings, priorityId, raisedPriority, routingSentence, sameProblem,
  ticketRef, toStored,
} from './rules.js';

/**
 * Same requester, same problem, same day — the part that reads (QA 11-23
 * items 4 and 5). Rules in rules.js.
 *
 * - findSameDayRelatedOpenTicket(ticket): the requester's open ticket from
 *   earlier the same local day about the same problem, or null.
 * - evaluate(): run by the pipeline on every run with a recommendation. When a
 *   related ticket exists the AI's priority goes up one level (Live for
 *   everyone, no switch) and the run records `recommendation.repeatReport`.
 * - route(): follow-up routing, `followup_routing_ws<N>` = off | shadow | live
 *   (off by default). Records `recommendation.followUpRouting`; Live gives the
 *   ticket to the related ticket's owner on an automatic assignment.
 *
 * Nothing here may fail an assignment: every public method catches and
 * answers "leave it as it was".
 */

export const settingsKey = (workspaceId) => `followup_routing_ws${Number(workspaceId)}`;
export const PRIORITY_SOURCE = 'repeat_report';
export const AFTER_HOURS_SENTENCE = 'Kept at High: after hours, a repeat report doesn\'t page on-call.';
const SETTINGS_CACHE_MS = 15 * 1000;
const NOT_AWAY = ['WFH', 'IGNORED'];
const NOTE_ACTOR = Object.freeze({ name: 'Ticket Pulse', email: null, role: 'automation' });
const MATCH_STRENGTH = { subcategory: 4, category: 3, subject: 2, text: 1 };

const positive = (n) => Number.isInteger(n) && n > 0;
const toId = (v) => { const n = Number(v); return positive(n) ? n : null; };
const soft = (fn, fallback = null) => Promise.resolve().then(fn).catch(() => fallback);

class SameDayRepeatService {
  constructor() {
    this._settingsCache = new Map();
  }

  async getSettings(workspaceId, { fresh = false } = {}) {
    const ws = Number(workspaceId);
    const cached = this._settingsCache.get(ws);
    if (!fresh && cached && Date.now() - cached.at < SETTINGS_CACHE_MS) return cached.value;
    let failed = false;
    const raw = await Promise.resolve().then(() => settingsRepository.get(settingsKey(ws))).catch(() => { failed = true; return null; });
    if (failed) return { ...normalizeSettings(null), mode: 'off', unreadable: true };
    const value = normalizeSettings(raw);
    this._settingsCache.set(ws, { at: Date.now(), value });
    return value;
  }

  async saveSettings(workspaceId, patch = {}, { by = null, now = new Date() } = {}) {
    const ws = Number(workspaceId);
    const current = await this.getSettings(ws, { fresh: true });
    const { next, changes, errors } = applyPatch(current, patch, { by, now });
    if (errors.length) return { settings: current, changes: [], errors };
    if (changes.length) {
      await settingsRepository.set(settingsKey(ws), JSON.stringify(toStored(next)));
      logger.info('Follow-up routing settings saved', { workspaceId: ws, by, changes });
    }
    this._settingsCache.delete(ws);
    return { settings: await this.getSettings(ws, { fresh: true }), changes, errors: [] };
  }

  async _timezone(workspaceId) {
    const row = await soft(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { defaultTimezone: true } }));
    return row?.defaultTimezone || 'America/Vancouver';
  }

  /** availabilityService.isBusinessHours — the check after-hours escalation uses. Unknown → false. */
  async _isBusinessHours(workspaceId, now = new Date()) {
    try {
      const { default: availabilityService } = await import('../availabilityService.js');
      const check = await availabilityService.isBusinessHours(now, await this._timezone(workspaceId), Number(workspaceId));
      return check?.isBusinessHours === true;
    } catch {
      return false;
    }
  }

  async _openStatuses(workspaceId) {
    try {
      const { openWorkloadStatuses } = await import('../assignmentTools.js');
      const list = await openWorkloadStatuses(workspaceId);
      if (Array.isArray(list) && list.length) return list;
    } catch { /* fall through */ }
    return ['Open', 'Pending', 'open', 'pending', '2', '3'];
  }

  /**
   * The requester's open ticket from earlier the same local (Pacific) day
   * about the same problem as `ticket`, or null.
   * @param {object} ticket  { id, workspaceId, requesterId, createdAt, subject, internalCategoryId, internalSubcategoryId }
   *   — anything missing is read from the database (category from the ticket row).
   * @returns {Promise<null | { ticketId, ref, subject, createdAt, status, matchedOn, similarity, owner: {techId, techName}|null }>}
   */
  async findSameDayRelatedOpenTicket(ticket, { now = new Date() } = {}) {
    try {
      const ticketId = toId(ticket?.id);
      if (!ticketId) return null;
      let t = ticket;
      if (!toId(t.requesterId) || !toId(t.workspaceId) || !t.createdAt) {
        const row = await soft(() => prisma.ticket.findUnique({
          where: { id: ticketId },
          select: {
            id: true, workspaceId: true, requesterId: true, createdAt: true, subject: true, internalCategoryId: true, internalSubcategoryId: true,
          },
        }));
        if (!row) return null;
        t = { ...row, ...Object.fromEntries(Object.entries(ticket).filter(([, v]) => v !== undefined && v !== null)) };
      }
      const ws = toId(t.workspaceId);
      const requesterId = toId(t.requesterId);
      if (!ws || !requesterId) return null;
      const createdAt = t.createdAt ? new Date(t.createdAt) : now;
      const timezone = await this._timezone(ws);
      const { start } = getTodayRange(timezone, createdAt);
      const openStatuses = await this._openStatuses(ws);

      const rows = await soft(() => prisma.ticket.findMany({
        where: {
          workspaceId: ws,
          requesterId,
          id: { not: ticketId },
          // Earlier the same day only: the first report never "follows up" the second.
          createdAt: { gte: start, lt: createdAt },
          status: { in: openStatuses },
          isNoise: false,
        },
        select: {
          id: true, subject: true, createdAt: true, status: true, origin: true, nativeNumber: true, freshserviceTicketId: true,
          internalCategoryId: true, internalSubcategoryId: true, assignedTechId: true,
          assignedTech: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }), []);
      if (!Array.isArray(rows) || !rows.length) return null;

      const textSimilarity = await this._textSimilarity(ticketId, rows.map((r) => r.id));
      let best = null;
      for (const r of rows) {
        const match = sameProblem(t, r, { textSimilarity: textSimilarity.get(r.id) });
        if (!match) continue;
        // Strongest match first; between equals, the most recent (rows are newest first).
        if (!best || MATCH_STRENGTH[match.matchedOn] > MATCH_STRENGTH[best.match.matchedOn]) best = { row: r, match };
      }
      if (!best) return null;
      const { row, match } = best;
      return {
        ticketId: row.id,
        ref: ticketRef(row),
        subject: row.subject || null,
        createdAt: row.createdAt,
        status: row.status,
        matchedOn: match.matchedOn,
        similarity: match.similarity ?? null,
        owner: toId(row.assignedTechId) ? { techId: row.assignedTechId, techName: row.assignedTech?.name || null } : null,
      };
    } catch (err) {
      logger.warn('Same-day related ticket lookup failed', { ticketId: ticket?.id, error: err.message });
      return null;
    }
  }

  /** Embedding cosine against each candidate, when both are already embedded. Never embeds; never throws. */
  async _textSimilarity(ticketId, candidateIds) {
    const out = new Map();
    try {
      const rows = await prisma.ticketEmbedding.findMany({
        where: { ticketId: { in: [ticketId, ...candidateIds] } },
        select: { ticketId: true, embedding: true },
      });
      const own = rows.find((r) => r.ticketId === ticketId)?.embedding;
      if (!Array.isArray(own) || !own.length) return out;
      const { cosineSimilarity } = await import('../ticketEmbeddingService.js');
      for (const r of rows) {
        if (r.ticketId !== ticketId && Array.isArray(r.embedding)) out.set(r.ticketId, cosineSimilarity(own, r.embedding));
      }
    } catch { /* no embeddings: subject and category decide */ }
    return out;
  }

  /**
   * The pipeline hook, before any assignment rule. Finds the related ticket
   * and raises the AI's priority one level (mutates `recommendation`:
   * assessedPriority, assessedPriorityId, priorityRationale, repeatReport).
   * @returns {Promise<null | { related, bump: {from, to}|null, record, origin }>}
   */
  async evaluate({
    workspaceId, ticketId, runId = null, recommendation, priorityAssessmentEnabled = true, now = new Date(),
  } = {}) {
    try {
      if (!recommendation || typeof recommendation !== 'object') return null;
      const id = toId(ticketId);
      if (!id) return null;
      const row = await soft(() => prisma.ticket.findUnique({
        where: { id },
        select: {
          id: true, workspaceId: true, requesterId: true, createdAt: true, subject: true, triageMode: true, origin: true,
          internalCategoryId: true, internalSubcategoryId: true,
        },
      }));
      if (!row || !toId(row.requesterId)) return null;
      const { triageMode, origin, ...ticket } = row;
      // The AI's category for this run wins over what the ticket had before it.
      const related = await this.findSameDayRelatedOpenTicket({
        ...ticket,
        workspaceId: ticket.workspaceId || workspaceId,
        internalCategoryId: toId(recommendation.internalCategoryId) || ticket.internalCategoryId || null,
        internalSubcategoryId: toId(recommendation.internalSubcategoryId) || ticket.internalSubcategoryId || null,
      }, { now });
      if (!related) return null;

      const aiPriority = String(recommendation.assessedPriority || '').trim() || null;
      const to = raisedPriority(aiPriority);
      const from = to ? (['Low', 'Medium', 'High', 'Urgent'].find((p) => p.toLowerCase() === aiPriority.toLowerCase()) || aiPriority) : null;
      let notRaisedReason = null;
      if (!priorityAssessmentEnabled) notRaisedReason = 'priority_assessment_off';
      else if (triageMode === 'trusted') notRaisedReason = 'trusted_intake';
      else if (!to) notRaisedReason = 'no_ai_priority';
      else if (to === from) notRaisedReason = 'already_urgent';
      // Outside business hours (the calendar after-hours escalation uses) a
      // repeat never lifts a ticket to Urgent, so it never pages on-call; the
      // requester can still raise it from their status link (coordinator,
      // 23 Nov). An unreadable calendar counts as after hours.
      else if (to === 'Urgent' && !(await this._isBusinessHours(workspaceId, now))) notRaisedReason = 'after_hours';
      const raised = !notRaisedReason;
      if (raised) {
        recommendation.assessedPriority = to;
        recommendation.assessedPriorityId = priorityId(to);
        const why = `Raised from ${from} to ${to}: the same requester reported the same problem earlier today (${related.ref}).`;
        recommendation.priorityRationale = [String(recommendation.priorityRationale || '').trim(), why].filter(Boolean).join(' ').slice(0, 4000);
      }
      const record = {
        relatedTicketId: related.ticketId,
        relatedRef: related.ref,
        relatedSubject: related.subject,
        relatedCreatedAt: related.createdAt ? new Date(related.createdAt).toISOString() : null,
        matchedOn: related.matchedOn,
        similarity: related.similarity,
        owner: related.owner,
        aiPriority: from || aiPriority,
        raisedTo: raised ? to : null,
        raised,
        notRaisedReason,
        sentence: raised ? `Raised to ${to}: same problem reported again today (${related.ref}).`
          : notRaisedReason === 'after_hours' ? AFTER_HOURS_SENTENCE : null,
        at: now.toISOString(),
      };
      recommendation.repeatReport = record;
      logger.info(`Same-day repeat for ticket ${id}: ${related.ref}${raised ? `, priority ${from} → ${to}` : ''}`, {
        workspaceId, runId, relatedTicketId: related.ticketId, matchedOn: related.matchedOn, notRaisedReason,
      });
      return { related, bump: raised ? { from, to } : null, record, origin: origin || null };
    } catch (err) {
      logger.warn('Same-day repeat check failed - nothing changed', { workspaceId, ticketId, runId, error: err.message });
      return null;
    }
  }

  /**
   * The history row for the raise, through the shared priority audit helper
   * (B1's `recordPriorityChange`). Written once per ticket and level: a re-run
   * that raises to the same level again writes nothing. Never throws.
   */
  async recordPriorityBump({ ticketId, workspaceId, runId = null, bump, related, now = new Date() } = {}) {
    try {
      const id = toId(ticketId);
      if (!id || !bump?.to || !bump?.from) return false;
      const earlier = await soft(() => prisma.ticketActivity.findMany({
        where: { ticketId: id, activityType: 'priority_changed' },
        select: { details: true },
        orderBy: { performedAt: 'desc' },
        take: 30,
      }), []);
      if ((earlier || []).some((r) => r?.details?.source === PRIORITY_SOURCE && r?.details?.to === bump.to)) return false;
      const note = `Same problem reported again today (${related?.ref || 'an earlier ticket'})`;
      await this._recordPriorityChange({
        ticketId: id,
        from: bump.from,
        to: bump.to,
        source: PRIORITY_SOURCE,
        actorKind: 'system',
        actorName: NOTE_ACTOR.name,
        actorEmail: null,
        via: { kind: 'assignment_pipeline', runId },
        note,
        at: now,
        details: { workspaceId: Number(workspaceId) || null, runId, relatedTicketId: related?.ticketId || null, relatedRef: related?.ref || null },
      });
      return true;
    } catch (err) {
      logger.warn('Repeat-report priority history not written', { ticketId, runId, error: err.message });
      return false;
    }
  }

  /** The shared priority audit helper (services/priorityHistoryService.js); the contract row if it cannot load. */
  async _recordPriorityChange(args) {
    let helper = null;
    try {
      const mod = await import('../priorityHistoryService.js');
      helper = typeof mod.recordPriorityChange === 'function' ? mod.recordPriorityChange : null;
    } catch { helper = null; }
    if (helper) return helper(args);
    return prisma.ticketActivity.create({
      data: {
        ticketId: args.ticketId,
        activityType: 'priority_changed',
        performedBy: args.actorName,
        performedAt: args.at,
        details: {
          ...(args.details || {}),
          from: args.from, to: args.to, source: args.source, actorKind: args.actorKind, actorName: args.actorName,
          actorEmail: args.actorEmail, via: args.via, note: args.note,
        },
      },
    });
  }

  /** Can `techId` take this ticket right now? { ok, reason } */
  async _ownerAvailable({ workspaceId, ticketId, techId, ticketOrigin = null, now = new Date() }) {
    const ws = Number(workspaceId);
    const [tech, leaves, rejected, timezone] = await Promise.all([
      soft(() => prisma.technician.findFirst({
        where: { id: techId, workspaceId: ws },
        select: { id: true, name: true, isActive: true, timezone: true, workStartTime: true, workEndTime: true, freshserviceId: true },
      })),
      (async () => {
        const tz = await this._timezone(ws);
        const { start, end } = getLocalDateBounds(tz, now);
        return soft(() => prisma.technicianLeave.findMany({
          where: { workspaceId: ws, technicianId: techId, leaveDate: { gte: start, lte: end }, status: 'APPROVED' },
          select: { category: true },
        }), []);
      })(),
      toId(ticketId)
        ? soft(() => prisma.ticketAssignmentEpisode.findFirst({ where: { ticketId: toId(ticketId), technicianId: techId, endMethod: 'rejected' }, select: { id: true } }))
        : null,
      this._timezone(ws),
    ]);
    if (!tech || tech.isActive === false) return { ok: false, reason: 'no longer active' };
    // A local (app-only) person can never hold a FreshService-born ticket.
    if (ticketOrigin && ticketOrigin !== 'ticketpulse' && !tech.freshserviceId) return { ok: false, reason: 'cannot hold FreshService tickets' };
    if (rejected) return { ok: false, reason: 'handed this ticket back' };
    if ((leaves || []).some((l) => !NOT_AWAY.includes(l.category))) return { ok: false, reason: 'away today' };
    try {
      const { default: away } = await import('../assigneeAwayService.js');
      if (await away.forTechnician(ws, techId, { now })) return { ok: false, reason: 'away' };
    } catch { /* away lookup is a refinement */ }
    if (!onShiftAt(tech, now, timezone)) return { ok: false, reason: 'not at work now' };
    return { ok: true, reason: null };
  }

  /**
   * Follow-up routing, after the urgent and share rules and before Level match.
   * @returns {Promise<null | { techId, applied, record, step, sentence }>}
   */
  async route({
    workspaceId, ticketId, runId = null, decision, related, pickId, pickName = null, locked = false, dryRun = false,
    ticketOrigin = null, now = new Date(),
  } = {}) {
    try {
      if (!related?.ticketId) return null;
      if (!['auto_assigned', 'pending_review'].includes(decision)) return null;
      const settings = await this.getSettings(workspaceId);
      if (!MODES.includes(settings.mode) || settings.mode === 'off') return null;
      const live = settings.mode === 'live' && !dryRun;
      const pick = toId(pickId);
      const owner = related.owner;
      let outcome;
      let unavailableReason = null;
      if (!owner?.techId) outcome = OUTCOMES.NO_OWNER;
      else if (owner.techId === pick) outcome = OUTCOMES.ALREADY_THERE;
      else {
        const check = await this._ownerAvailable({ workspaceId, ticketId, techId: owner.techId, ticketOrigin, now });
        if (!check.ok) { outcome = OUTCOMES.OWNER_UNAVAILABLE; unavailableReason = check.reason; } else outcome = OUTCOMES.WOULD_ROUTE;
      }
      const canMove = outcome === OUTCOMES.WOULD_ROUTE;
      const applied = canMove && live && !locked && decision === 'auto_assigned';
      if (applied) outcome = OUTCOMES.ROUTED;
      const notAppliedReason = canMove && !applied
        ? (settings.mode !== 'live' ? 'shadow' : dryRun ? 'dry_run' : locked ? 'locked' : 'suggest_only')
        : null;
      const sentence = routingSentence({ outcome, ownerName: owner?.techName, ref: related.ref, reason: unavailableReason });
      const record = {
        mode: live ? 'live' : 'shadow',
        outcome,
        applied,
        locked: Boolean(locked),
        notAppliedReason,
        unavailableReason,
        relatedTicketId: related.ticketId,
        relatedRef: related.ref,
        matchedOn: related.matchedOn,
        similarity: related.similarity ?? null,
        from: { techId: pick, techName: pickName },
        to: owner?.techId ? { techId: owner.techId, techName: owner.techName || null } : null,
        sentence,
        at: now.toISOString(),
      };
      const step = canMove ? {
        stepName: 'followup_routing', status: 'completed', durationMs: 0, output: { kind: 'followup_routing', ...record },
      } : null;
      if (canMove) {
        logger.info(`Follow-up routing ${applied ? 'sent' : 'would send'} ticket ${ticketId} to the owner of ${related.ref}`, {
          workspaceId, runId, from: pick, to: owner.techId, mode: record.mode,
        });
      }
      return { techId: applied ? owner.techId : pick, applied, record, step, sentence: applied ? sentence : null };
    } catch (err) {
      logger.warn('Follow-up routing failed - assignment unchanged', { workspaceId, ticketId, runId, error: err.message });
      return null;
    }
  }

  /** The private note suggesting a merge (Live routing only). Never throws. */
  async addMergeNote({ ticketId, workspaceId, related }) {
    try {
      if (!related?.ref) return false;
      const { default: ticketService } = await import('../ticketService.js');
      const text = mergeNote({ ref: related.ref, subject: related.subject, ownerName: related.owner?.techName });
      await ticketService.addPrivateNote(Number(ticketId), Number(workspaceId), { bodyText: text }, NOTE_ACTOR, [], { systemNote: true });
      return true;
    } catch (err) {
      logger.warn(`Follow-up routing: merge note on ticket ${ticketId} not written (${err.message})`);
      return false;
    }
  }

  /** Recent runs with a same-day repeat, for the Assignment Review tab. */
  async results(workspaceId, { days = 14 } = {}) {
    const ws = Number(workspaceId);
    const settings = await this.getSettings(ws, { fresh: true });
    const span = Math.min(Math.max(Number(days) || 14, 1), 60);
    const since = new Date(Date.now() - span * 86400000);
    const rows = await Promise.resolve().then(() => prisma.$queryRaw`
      select r.id::int run_id, r.ticket_id::int ticket_id, r.created_at, r.decision,
        r.recommendation->'followUpRouting' follow_up, r.recommendation->'repeatReport' repeat_report,
        t.subject, t.native_number::int native_number, t.freshservice_ticket_id::text fs_id, t.origin
      from assignment_pipeline_runs r join tickets t on t.id = r.ticket_id
      where r.workspace_id = ${ws} and r.created_at > ${since}
        and (r.recommendation ? 'followUpRouting' or r.recommendation ? 'repeatReport')
      order by r.created_at desc limit 400`).catch(() => []);
    const runs = rows.map((r) => ({
      runId: r.run_id,
      ticketId: r.ticket_id,
      ref: r.origin === 'ticketpulse' && r.native_number ? `TP-${r.native_number}` : r.fs_id ? `#${r.fs_id}` : `#${r.ticket_id}`,
      subject: r.subject,
      at: r.created_at,
      decision: r.decision,
      followUpRouting: r.follow_up || null,
      repeatReport: r.repeat_report || null,
    }));
    const tally = {
      total: runs.length,
      raised: runs.filter((r) => r.repeatReport?.raised === true).length,
      wouldRoute: runs.filter((r) => r.followUpRouting?.outcome === OUTCOMES.WOULD_ROUTE).length,
      routed: runs.filter((r) => r.followUpRouting?.outcome === OUTCOMES.ROUTED).length,
    };
    return { settings, days: span, tally, runs };
  }

  /** For tests. */
  _reset() { this._settingsCache.clear(); }
}

export default new SameDayRepeatService();
