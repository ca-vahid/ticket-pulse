import prisma from '../prisma.js';
import settingsRepository from '../settingsRepository.js';
import logger from '../../utils/logger.js';
import { resolveRequesterTimezone } from './requesterTimezone.js';
import {
  MODES, OUTCOMES, applyPatch, decide, normalizeSettings, sentenceFor, toStored,
} from './rules.js';

/**
 * Time-zone fit — the part that reads (QA 11-17 item 1). Rules in rules.js,
 * the requester's zone in requesterTimezone.js.
 *
 * - Settings live in app_settings under `assignment_timezone_fit_ws<id>`:
 *   mode off | shadow | live. Every workspace starts off.
 * - Shadow records who the rule would have put first on the run
 *   (`recommendation.timezoneFit`, plus a `timezone_fit` step when the person
 *   would change) and changes nothing. Live gives the ticket to that person
 *   on an automatic assignment.
 * - The people come from Level match's loader (same never-pick facts).
 *
 * Nothing here may fail an assignment: every public method catches and
 * answers "leave it as it was".
 */

export const settingsKey = (workspaceId) => `assignment_timezone_fit_ws${Number(workspaceId)}`;
const SANDBOX_WORKSPACES = [6, 7, 8, 9];
const SETTINGS_CACHE_MS = 15 * 1000;

const positive = (n) => Number.isInteger(n) && n > 0;
const toId = (v) => { const n = Number(v); return positive(n) ? n : null; };

class TimezoneFitService {
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
      logger.info('Time-zone fit settings saved', { workspaceId: ws, by, changes });
    }
    this._settingsCache.delete(ws);
    return { settings: await this.getSettings(ws, { fresh: true }), changes, errors: [] };
  }

  /** The requester's zone for this ticket, or null. */
  async loadRequester(ticketId) {
    const id = toId(ticketId);
    if (!id) return null;
    const row = await Promise.resolve()
      .then(() => prisma.ticket.findUnique({
        where: { id },
        select: {
          requester: {
            select: { entraCity: true, entraState: true, entraCountry: true, entraOfficeLocation: true, timeZone: true },
          },
        },
      }))
      .catch(() => null);
    return resolveRequesterTimezone(row?.requester || null);
  }

  /** The AI's list with skills, presence and time zones (Level match's loader). */
  async loadCandidates(args) {
    const { default: levelMatchService } = await import('../assignmentLevelMatch/levelMatchService.js');
    return levelMatchService.loadCandidates(args);
  }

  /**
   * The pipeline hook. Records on every run where it applies; moves the
   * ticket only in Live, on an automatic assignment, when nothing earlier
   * (urgent, escalation, share, level match) chose the person.
   * @returns {null | { techId, moved, applied, record, step, sentence }}
   */
  async guard({
    workspaceId, ticketId, runId = null, techId, decision, recommendation, siteBound = false,
    locked = false, dryRun = false, now = new Date(),
  } = {}) {
    try {
      const ws = Number(workspaceId);
      const pickId = toId(techId);
      if (!pickId || SANDBOX_WORKSPACES.includes(ws)) return null;
      if (!['auto_assigned', 'pending_review'].includes(decision)) return null;
      const settings = await this.getSettings(ws);
      if (!MODES.includes(settings.mode) || settings.mode === 'off') return null;

      const requester = await this.loadRequester(ticketId);
      const needsPeople = Boolean(requester?.timezone) && requester.confidence !== 'low' && !siteBound;
      const candidates = needsPeople ? await this.loadCandidates({ workspaceId: ws, ticketId, recommendation, now }) : [];
      const result = decide({
        requester, siteBound, requiredLevel: recommendation?.requiredLevel || null, aiPickId: pickId, candidates, now,
      });
      const live = settings.mode === 'live' && !dryRun;
      const wouldMove = result.outcome === OUTCOMES.MOVED;
      const applied = live && !locked && decision === 'auto_assigned' && wouldMove;
      const sentence = sentenceFor(result, { applied });
      // Live but not applied: say why, so the run never reads as Shadow.
      let notAppliedReason = null;
      if (live && wouldMove && !applied) {
        notAppliedReason = locked ? 'an earlier rule chose the person' : 'the run waits for a person to decide';
      }

      const record = {
        mode: live ? 'live' : 'shadow',
        outcome: result.outcome,
        applied,
        notAppliedReason,
        locked: Boolean(locked),
        requester: result.requester || (requester ? { timezone: requester.timezone, source: requester.source, confidence: requester.confidence } : null),
        from: result.from,
        to: wouldMove ? { techId: result.techId, techName: result.techName } : null,
        considered: result.considered,
        sentence,
        at: now.toISOString(),
      };
      const step = wouldMove ? {
        stepName: 'timezone_fit',
        status: 'completed',
        durationMs: 0,
        output: { kind: 'timezone_fit', ...record },
      } : null;
      if (wouldMove) {
        logger.info(`Time-zone fit ${applied ? 'moved' : 'would move'} ticket ${ticketId}`, {
          workspaceId: ws, runId, from: result.from.techId, to: result.techId, mode: record.mode,
        });
      }
      return {
        techId: applied ? result.techId : pickId,
        moved: applied,
        applied,
        record,
        step,
        sentence: applied ? sentence : null,
      };
    } catch (err) {
      logger.warn('Time-zone fit failed - assignment unchanged', { workspaceId, ticketId, runId, error: err.message });
      return null;
    }
  }

  /** The mode and what the rule did lately, for the switch beside Level match. */
  async results(workspaceId, { days = 14 } = {}) {
    const ws = Number(workspaceId);
    const settings = await this.getSettings(ws, { fresh: true });
    const span = Math.min(Math.max(Number(days) || 14, 1), 60);
    const since = new Date(Date.now() - span * 86400000);
    const rows = await Promise.resolve().then(() => prisma.$queryRaw`
      select r.id::int run_id, r.ticket_id::int ticket_id, r.created_at, r.recommendation->'timezoneFit' timezone_fit,
        t.subject, t.native_number::int native_number, t.freshservice_ticket_id::text fs_id, t.origin
      from assignment_pipeline_runs r join tickets t on t.id = r.ticket_id
      where r.workspace_id = ${ws} and r.created_at > ${since} and r.recommendation ? 'timezoneFit'
      order by r.created_at desc limit 400`).catch(() => []);
    const runs = rows.map((r) => ({
      runId: r.run_id,
      ticketId: r.ticket_id,
      ref: r.origin === 'ticketpulse' && r.native_number ? `TP-${r.native_number}` : r.fs_id ? `#${r.fs_id}` : `#${r.ticket_id}`,
      subject: r.subject,
      at: r.created_at,
      ...(r.timezone_fit || {}),
    }));
    const moved = runs.filter((r) => r.outcome === OUTCOMES.MOVED);
    return {
      settings,
      days: span,
      // moved = every would-move (Shadow days included); applied = the ones Live actually made.
      tally: { total: runs.length, moved: moved.length, applied: moved.filter((r) => r.applied === true).length },
      recentMoves: moved.slice(0, 10).map((r) => ({
        runId: r.runId, ticketId: r.ticketId, ref: r.ref, subject: r.subject, at: r.at,
        mode: r.mode === 'live' ? 'live' : 'shadow', applied: r.applied === true, notAppliedReason: r.notAppliedReason || null, sentence: r.sentence || null,
      })),
    };
  }

  /** For tests. */
  _reset() { this._settingsCache.clear(); }
}

export default new TimezoneFitService();
