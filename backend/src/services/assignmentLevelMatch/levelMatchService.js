import prisma from '../prisma.js';
import settingsRepository from '../settingsRepository.js';
import logger from '../../utils/logger.js';
import { getTodayRange, getLocalDateBounds } from '../../utils/timezone.js';
import {
  MODES, OUTCOMES, applyPatch, decide, normalizeLevel, normalizeSettings, onShiftAt, skillFor, toStored,
} from './rules.js';

/**
 * Level match — the part that reads (Vahid, 26 Oct 2026). Rules in rules.js.
 *
 * - Settings live in app_settings under `assignment_level_match_ws<id>`:
 *   mode off | shadow | live. IT starts in Shadow; everything else off.
 * - Shadow records who the rule would have picked on the run
 *   (`recommendation.levelMatch`) and changes nothing. Live gives the ticket
 *   to that person on an automatic assignment.
 * - "Today" = assignment episodes started since local midnight (picked by
 *   hand or given by automation — both are load), this ticket excluded.
 *
 * Nothing here may fail an assignment: every public method catches and
 * answers "leave it as it was".
 */

export const settingsKey = (workspaceId) => `assignment_level_match_ws${Number(workspaceId)}`;
const SANDBOX_WORKSPACES = [6, 7, 8, 9];
const SETTINGS_CACHE_MS = 15 * 1000;
const NOT_AWAY = ['WFH', 'IGNORED'];

const positive = (n) => Number.isInteger(n) && n > 0;
const toId = (v) => { const n = Number(v); return positive(n) ? n : null; };

class LevelMatchService {
  constructor() {
    this._settingsCache = new Map();
  }

  async getSettings(workspaceId, { fresh = false } = {}) {
    const ws = Number(workspaceId);
    const cached = this._settingsCache.get(ws);
    if (!fresh && cached && Date.now() - cached.at < SETTINGS_CACHE_MS) return cached.value;
    let failed = false;
    const raw = await Promise.resolve().then(() => settingsRepository.get(settingsKey(ws))).catch(() => { failed = true; return null; });
    // Settings that could not be read are "off" for this decision, never the IT default.
    if (failed) return { ...normalizeSettings(null, ws), mode: 'off', unreadable: true };
    const value = normalizeSettings(raw, ws);
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
      logger.info('Level match settings saved', { workspaceId: ws, by, changes });
    }
    this._settingsCache.delete(ws);
    return { settings: await this.getSettings(ws, { fresh: true }), changes, errors: [] };
  }

  /** Should the AI be asked for `requiredLevel` in this workspace? */
  async isActive(workspaceId) {
    if (SANDBOX_WORKSPACES.includes(Number(workspaceId))) return false;
    return (await this.getSettings(workspaceId).catch(() => ({ mode: 'off' }))).mode !== 'off';
  }

  /**
   * Everything the rule needs about the people the AI listed, as of `now`.
   * @returns {Promise<Array>} candidates in the AI's order (see rules.decide)
   */
  async loadCandidates({ workspaceId, ticketId, recommendation, now = new Date() }) {
    const ws = Number(workspaceId);
    const listed = (Array.isArray(recommendation?.recommendations) ? recommendation.recommendations : [])
      .map((r, i) => ({
        techId: toId(r?.techId), techName: r?.techName || null, rank: Number(r?.rank) || i + 1,
        score: Number.isFinite(Number(r?.score)) ? Number(r.score) : null,
      }))
      .filter((r) => r.techId);
    const seen = new Set();
    const unique = listed.filter((r) => (seen.has(r.techId) ? false : seen.add(r.techId)));
    if (!unique.length) return [];
    const ids = unique.map((r) => r.techId);

    const subcategoryId = toId(recommendation?.internalSubcategoryId);
    let categoryId = toId(recommendation?.internalCategoryId);
    if (subcategoryId && !categoryId) {
      const sub = await prisma.competencyCategory.findUnique({ where: { id: subcategoryId }, select: { parentId: true } }).catch(() => null);
      categoryId = toId(sub?.parentId);
    }
    const workspace = await prisma.workspace.findUnique({ where: { id: ws }, select: { defaultTimezone: true } }).catch(() => null);
    const timezone = workspace?.defaultTimezone || 'America/Vancouver';
    const { start: todayStart } = getTodayRange(timezone, now);
    const { start: dayStart, end: dayEnd } = getLocalDateBounds(timezone, now);
    const { openWorkloadStatuses } = await import('../assignmentTools.js');
    const openStatuses = await openWorkloadStatuses(ws);
    const thisTicket = toId(ticketId);

    const [techs, skills, todayRows, openRows, leaves, rejections] = await Promise.all([
      prisma.technician.findMany({
        where: { id: { in: ids }, workspaceId: ws },
        select: { id: true, name: true, isActive: true, timezone: true, workStartTime: true, workEndTime: true, routingGuidance: true, assignableOnly: true },
      }),
      categoryId || subcategoryId
        ? prisma.technicianCompetency.findMany({
          where: { workspaceId: ws, technicianId: { in: ids }, competencyCategoryId: { in: [categoryId, subcategoryId].filter(Boolean) } },
          select: { technicianId: true, competencyCategoryId: true, proficiencyLevel: true },
        })
        : [],
      prisma.ticketAssignmentEpisode.groupBy({
        by: ['technicianId'],
        where: { workspaceId: ws, technicianId: { in: ids }, startedAt: { gte: todayStart, lte: now }, ...(thisTicket ? { NOT: { ticketId: thisTicket } } : {}) },
        _count: { _all: true },
      }),
      prisma.ticket.groupBy({
        by: ['assignedTechId'],
        where: { workspaceId: ws, assignedTechId: { in: ids }, status: { in: openStatuses }, ...(thisTicket ? { NOT: { id: thisTicket } } : {}) },
        _count: { _all: true },
      }),
      prisma.technicianLeave.findMany({
        where: { workspaceId: ws, technicianId: { in: ids }, leaveDate: { gte: dayStart, lte: dayEnd }, status: 'APPROVED' },
        select: { technicianId: true, category: true },
      }),
      thisTicket
        ? prisma.ticketAssignmentEpisode.findMany({ where: { ticketId: thisTicket, endMethod: 'rejected' }, select: { technicianId: true } })
        : [],
    ]);

    const byId = new Map(techs.map((t) => [t.id, t]));
    const skillsBy = new Map();
    for (const s of skills) {
      if (!skillsBy.has(s.technicianId)) skillsBy.set(s.technicianId, []);
      skillsBy.get(s.technicianId).push({ categoryId: s.competencyCategoryId, level: s.proficiencyLevel });
    }
    const count = (rows, key) => new Map(rows.map((r) => [r[key], r._count?._all ?? 0]));
    const today = count(todayRows, 'technicianId');
    const open = count(openRows, 'assignedTechId');
    const away = new Set(leaves.filter((l) => !NOT_AWAY.includes(l.category)).map((l) => l.technicianId));
    const rejected = new Set(rejections.map((r) => r.technicianId));

    return unique
      .filter((r) => byId.get(r.techId)?.isActive !== false && byId.has(r.techId))
      .map((r) => {
        const t = byId.get(r.techId);
        return {
          techId: r.techId,
          techName: t.name || r.techName,
          rank: r.rank,
          score: r.score,
          skill: skillFor(skillsBy.get(r.techId) || [], { categoryId, subcategoryId }),
          today: today.get(r.techId) || 0,
          open: open.get(r.techId) || 0,
          onLeave: away.has(r.techId),
          onShift: onShiftAt(t, now, timezone),
          rejectedThisTicket: rejected.has(r.techId),
          routingNote: t.routingGuidance || null,
          assignableOnly: t.assignableOnly === true,
        };
      });
  }

  /**
   * The pipeline hook. Records on every run where it applies; moves the
   * ticket only in Live, on an automatic assignment, when nothing earlier
   * (urgent, escalation) locked the pick.
   * @returns {null | { techId, moved, applied, record, step, sentence }}
   */
  async guard({
    workspaceId, ticketId, runId = null, techId, decision, recommendation, locked = false, dryRun = false, now = new Date(),
  } = {}) {
    try {
      const ws = Number(workspaceId);
      const pickId = toId(techId);
      if (!pickId || SANDBOX_WORKSPACES.includes(ws)) return null;
      if (!['auto_assigned', 'pending_review'].includes(decision)) return null;
      const settings = await this.getSettings(ws);
      if (!MODES.includes(settings.mode) || settings.mode === 'off') return null;

      const requiredLevel = normalizeLevel(recommendation?.requiredLevel);
      const candidates = requiredLevel ? await this.loadCandidates({ workspaceId: ws, ticketId, recommendation, now }) : [];
      const result = decide({ requiredLevel, aiPickId: pickId, candidates });
      const live = settings.mode === 'live' && !dryRun;
      const applied = live && !locked && decision === 'auto_assigned' && result.outcome === OUTCOMES.MOVED;

      const record = {
        mode: live ? 'live' : 'shadow',
        outcome: result.outcome,
        applied,
        locked: Boolean(locked),
        requiredLevel,
        requiredLevelReason: String(recommendation?.requiredLevelReason || '').slice(0, 400) || null,
        from: result.from,
        to: result.outcome === OUTCOMES.MOVED ? { techId: result.techId, techName: result.techName } : null,
        considered: result.considered,
        sentence: result.sentence,
        at: now.toISOString(),
      };
      const wouldMove = result.outcome === OUTCOMES.MOVED;
      const step = wouldMove ? {
        stepName: 'level_match',
        status: 'completed',
        durationMs: 0,
        output: { kind: 'level_match', ...record },
      } : null;
      if (wouldMove) {
        logger.info(`Level match ${applied ? 'moved' : 'would move'} ticket ${ticketId}`, {
          workspaceId: ws, runId, from: result.from.techId, to: result.techId, requiredLevel, mode: record.mode,
        });
      }
      return {
        techId: applied ? result.techId : pickId,
        moved: applied,
        applied,
        record,
        step,
        sentence: applied ? result.sentence : null,
      };
    } catch (err) {
      logger.warn('Level match failed - assignment unchanged', { workspaceId, ticketId, runId, error: err.message });
      return null;
    }
  }

  /** Recent runs the rule looked at, for the Assignment Review tab. */
  async results(workspaceId, { days = 14 } = {}) {
    const ws = Number(workspaceId);
    const settings = await this.getSettings(ws, { fresh: true });
    const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 14, 1), 60) * 86400000);
    const rows = await prisma.$queryRaw`
      select r.id::int run_id, r.ticket_id::int ticket_id, r.created_at, r.decision, r.assigned_tech_id::int assigned_tech_id,
        r.recommendation->'levelMatch' level_match, t.subject, t.native_number::int native_number,
        t.freshservice_ticket_id::text fs_id, t.origin
      from assignment_pipeline_runs r join tickets t on t.id = r.ticket_id
      where r.workspace_id = ${ws} and r.created_at > ${since} and r.recommendation ? 'levelMatch'
      order by r.created_at desc limit 400`.catch(() => []);
    const runs = rows.map((r) => ({
      runId: r.run_id,
      ticketId: r.ticket_id,
      ref: r.origin === 'ticketpulse' && r.native_number ? `TP-${r.native_number}` : r.fs_id ? `#${r.fs_id}` : `#${r.ticket_id}`,
      subject: r.subject,
      at: r.created_at,
      decision: r.decision,
      ...(r.level_match || {}),
    }));
    const tally = { total: runs.length, kept: 0, moved: 0, noLevel: 0, noSkill: 0, byLevel: {} };
    for (const r of runs) {
      if (r.outcome === OUTCOMES.KEPT) tally.kept += 1;
      else if (r.outcome === OUTCOMES.MOVED) tally.moved += 1;
      else if (r.outcome === OUTCOMES.NO_LEVEL) tally.noLevel += 1;
      else if (r.outcome === OUTCOMES.NO_SKILL) tally.noSkill += 1;
      if (r.requiredLevel) tally.byLevel[r.requiredLevel] = (tally.byLevel[r.requiredLevel] || 0) + 1;
    }
    return { settings, tally, runs };
  }

  /** For tests. */
  _reset() { this._settingsCache.clear(); }
}

export default new LevelMatchService();
