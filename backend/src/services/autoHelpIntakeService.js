/**
 * Auto-help intake (integration W1 + W5, plans/AUTO_HELP_INTEGRATION_PLAN.md
 * designs A, C and G).
 *
 * ONE trigger point: `ticket.intake_settled`, emitted after the assignment
 * pipeline saved category, priority, noise and its decision (the run record is
 * updated first), or when a person / the API / a workflow set the category
 * while no pipeline run was open (source 'manual'). The after-hours
 * priority-only run settles PROVISIONALLY at night; the business-hours run
 * settles FINALLY in the morning.
 *
 * Every settle becomes a durable row in auto_help_jobs (dedupe per settle:
 * provisional / final / manual:<stamp>), claimed with a conditional update so
 * two containers never run the same job, retried with backoff (1, 5, 15 min;
 * 4 attempts), never run once older than 6 h, and drained by this module's
 * OWN tick (every JOB_TICK_MS, its own running guard - audit S1: the park
 * sweep never waits on a model call) plus an immediate kick. Two jobs for one
 * ticket never run at once (per-ticket advisory lock on the claim - audit
 * S2). A catch-up sweep re-queues settles the queue lost: a pipeline run that
 * finished in the last 6 h with no job and no Auto-help decision after it
 * (only runs created since Auto-help was switched on, paged), and a
 * provisional night draft whose morning settle never arrived within business
 * hours + 2 h. Finished rows are deleted after 14 days (bounded batches).
 *
 * Handling a settle (handleSettle):
 *   verdict skips   noise decision · not actionable · never-noise veto held →
 *                   a skip row (these can clear: never "already ran")
 *   first answer    no real run yet → runForTicket (approve → staged; shadow →
 *                   recorded), the settle facts kept on the run
 *   provisional     after something already ran → nothing (no second night run)
 *   final / manual  same category, same verdict → keep the draft
 *                   recategorized, or the verdict became noise / not
 *                   actionable / an approval:
 *                     staged, not sent → WITHDRAWN (proposal dismissed, run
 *                       outcome 'withdrawn' + why), then a re-run on the new
 *                       category (only for a category change): once for the
 *                       morning settle, and again for each manual
 *                       recategorization — at most 3 real runs per ticket
 *                     already SENT → an internal note for the assignee
 *                       ("Auto-help answered as X; the full run chose Y")
 *
 * The runner never sends; this module never sends either — it dismisses a
 * proposal nobody sent and writes internal notes through ticketService.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import autoHelpPlaybookService from './autoHelpPlaybookService.js';
import autoHelpRunner, { settleFacts } from './autoHelpRunner.js';
import { stateOfRun } from './autoHelpContextService.js';
import { PRE_SEND_OUTCOMES } from './autoHelpOutcomes.js';
import { releaseReplyOwner, REPLY_OWNERS } from './autoHelpReplyOwner.js';
import ticketActivityRepository from './ticketActivityRepository.js';
import { withTicketSettleLock } from './autoHelpLocks.js';

export const JOB_TRIGGER = 'intake_settled';
export const JOB_MAX_AGE_MS = 6 * 3600e3;
export const JOB_MAX_ATTEMPTS = 4;
export const JOB_BACKOFF_MS = Object.freeze([60e3, 5 * 60e3, 15 * 60e3]);
/** A 'running' job older than this died with its container (a run takes ≤ 45 s + staging). */
export const JOB_RUNNING_STALE_MS = 15 * 60e3;
export const CATCH_UP_WINDOW_MS = 6 * 3600e3;
/** Queued overnight / over a weekend: the business-hours run may be created days before it finishes. */
export const CATCH_UP_CREATED_LOOKBACK_MS = 96 * 3600e3;
export const CATCH_UP_BATCH = 100;
/** Pages per workspace per catch-up pass (bounded: 10 x 100 pipeline runs). */
export const CATCH_UP_MAX_PAGES = 10;
export const DRAIN_BATCH = 10;
/** The Auto-help queue's own cadence (audit S1: never inside the park sweep). */
export const JOB_TICK_MS = 45e3;
/** Catch-up every 7th tick (~5 min); cleanup every 80th (~1 h). */
export const CATCH_UP_EVERY_TICKS = 7;
export const CLEANUP_EVERY_TICKS = 80;
/** Finished / failed / expired jobs are kept this long (dedupe + catch-up need >= 96 h). */
export const JOB_RETENTION_MS = 14 * 86400e3;
export const CLEANUP_BATCH = 500;
/** A provisional draft whose final settle is missing this long into business hours is re-settled. */
export const MISSED_SETTLE_GRACE_BUSINESS_MINUTES = 120;
export const MISSED_SETTLE_BATCH = 50;
/** The after-hours priority-only run: its settle is provisional. */
export const PROVISIONAL_TRIGGER = 'priority_assessment_after_hours';
/** Activity row a manual settle leaves behind (the catch-up sweep's record of it). */
export const MANUAL_SETTLE_MARKER = 'auto_help_manual_settle';
export const MANUAL_ENQUEUE_RETRY_MS = Object.freeze([250, 1000]);
/** Real Auto-help runs per ticket, all settles together (first + morning re-run + manual re-runs). */
export const MAX_RUNS_PER_TICKET = 3;
/** Pipeline triggers that re-assess an open ticket — never an intake settle. */
export const NON_INTAKE_TRIGGERS = Object.freeze(['priority_assessment_only', 'priority_changed']);
/**
 * Runs the catch-up never re-queues: the re-assessments above, plus a noise
 * rule's dismissal - syncService records it as a run but it is not an intake
 * settle (the ticket is closed as noise), so re-queueing it only logged a
 * warning per rule close (ws1 shadow trial, 27 Sep 2026).
 */
export const CATCH_UP_EXCLUDED_TRIGGERS = Object.freeze([...NON_INTAKE_TRIGGERS, 'noise_rule']);
const REAL_RUN_EXCLUDED = ['skipped', 'no_match'];
const NOTE_ACTOR = Object.freeze({ name: 'Ticket Pulse (Auto-help)', email: null, role: 'automation' });

function safeJson(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function withHistory(detail, step, extra = {}, at = new Date()) {
  const d = detail && typeof detail === 'object' && !Array.isArray(detail) ? { ...detail } : {};
  const history = Array.isArray(d.history) ? d.history.slice(-40) : [];
  history.push({ at: at.toISOString(), step, ...extra });
  return { ...d, history };
}

/** provisional | final | manual */
export function settleKind(extra = {}) {
  if (extra?.provisional === true) return 'provisional';
  if (extra?.source === 'manual') return 'manual';
  return 'final';
}

export function dedupeKeyFor(ticketId, extra = {}) {
  const kind = settleKind(extra);
  if (kind === 'manual') return `settle:${Number(ticketId)}:manual:${String(extra.stamp || Date.now()).slice(0, 80)}`;
  return `settle:${Number(ticketId)}:${kind}`;
}

/** The verdict half of a settle that means "do not answer" (all can clear later). */
export function verdictSkipCode(extra = {}) {
  if (extra?.noiseVeto === true) return 'noise_veto';
  if (extra?.decision === 'noise_dismissed') return 'noise_decision';
  if (extra?.nonActionable === true) return 'not_actionable';
  return null;
}

export function backoffMs(attempts) {
  return JOB_BACKOFF_MS[Math.min(Math.max(Number(attempts) || 1, 1), JOB_BACKOFF_MS.length) - 1];
}

class AutoHelpIntakeService {
  constructor() {
    this._draining = false;
    this._ticking = false;
    this._timer = null;
    this._pass = 0;
    this.autoDrain = process.env.AUTO_HELP_JOB_AUTODRAIN !== 'false';
  }

  // ---------- own tick (audit S1) ----------

  /**
   * The queue's own interval. It used to ride the 60 s park sweep, whose
   * running guard then waited on up to 10 model runs (45 s each, two at a
   * time) and held park wakes and due-soon notices in every workspace.
   */
  start() {
    if (this._timer || process.env.AUTO_HELP_JOB_SWEEP_ENABLED === 'false') return;
    this._timer = setInterval(() => { this.tick().catch((err) => logger.warn(`Auto-help job tick failed: ${err.message}`)); }, JOB_TICK_MS);
    this._timer.unref?.();
    logger.info(`Auto-help job queue started (every ${JOB_TICK_MS / 1000}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** One tick: catch-up (every 7th), cleanup (every 80th), then drain. Never overlaps itself. */
  async tick({ now = new Date() } = {}) {
    if (this._ticking) return { skipped: true };
    this._ticking = true;
    const out = {};
    try {
      this._pass += 1;
      if (this._pass % CATCH_UP_EVERY_TICKS === 1) {
        const caught = await this.catchUp({ now }).catch((err) => { logger.warn(`Auto-help catch-up failed: ${err.message}`); return null; });
        if (caught?.requeued) out.requeued = caught.requeued;
        const missed = await this.missedFinalSettles({ now }).catch((err) => { logger.warn(`Auto-help missed-settle sweep failed: ${err.message}`); return null; });
        if (missed?.requeued) out.missedSettles = missed.requeued;
      }
      if (this._pass % CLEANUP_EVERY_TICKS === 1) {
        const removed = await this.cleanup({ now }).catch((err) => { logger.warn(`Auto-help job cleanup failed: ${err.message}`); return 0; });
        if (removed) out.removed = removed;
      }
      const drained = await this.drain({ now });
      if (drained?.ran || drained?.failed || drained?.expired || drained?.busy) out.jobs = drained;
      return out;
    } finally {
      this._ticking = false;
    }
  }

  /** Delete finished / failed / expired jobs older than JOB_RETENTION_MS, one bounded batch. */
  async cleanup({ now = new Date(), limit = CLEANUP_BATCH } = {}) {
    const cutoff = new Date(now.getTime() - JOB_RETENTION_MS);
    const done = ['done', 'failed', 'expired'];
    const rows = await Promise.resolve()
      .then(() => prisma.autoHelpJob.findMany({
        where: { status: { in: done }, finishedAt: { lt: cutoff } },
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true },
      }))
      .catch(() => []);
    const ids = (rows || []).map((r) => r.id);
    if (!ids.length) return 0;
    const res = await Promise.resolve()
      .then(() => prisma.autoHelpJob.deleteMany({ where: { id: { in: ids }, status: { in: done } } }))
      .catch((err) => { logger.warn(`Auto-help job cleanup delete failed: ${err.message}`); return { count: 0 }; });
    return res?.count || 0;
  }

  // ---------- enqueue ----------

  /**
   * ticket.intake_settled → a durable job (only when the workspace switch is
   * on — most workspaces are off and would only add rows). Never throws.
   */
  async onIntakeSettled(ticketId, workspaceId, extra = {}) {
    const id = Number(ticketId);
    const ws = Number(workspaceId);
    if (!id || !ws) return { skipped: 'bad_ticket' };
    const settings = await Promise.resolve().then(() => autoHelpPlaybookService.getSettings(ws)).catch(() => null);
    if (!settings?.enabled) return { skipped: 'workspace_disabled' };
    const job = await this.enqueue({ workspaceId: ws, ticketId: id, extra });
    if (job?.id && this.autoDrain) this.kick();
    return job;
  }

  /**
   * A person / the API / a workflow set the category with no pipeline run
   * open (ticketService._emitManualIntakeSettled). Made durable in the same
   * code path: a marker row on the ticket's activity (what the catch-up sweep
   * reads if the job never lands), then the job insert, retried. Never throws.
   */
  async onManualSettle(ticketId, workspaceId, extra = {}, { retryDelaysMs = MANUAL_ENQUEUE_RETRY_MS } = {}) {
    const id = Number(ticketId);
    const ws = Number(workspaceId);
    if (!id || !ws) return { skipped: 'bad_ticket' };
    const settings = await Promise.resolve().then(() => autoHelpPlaybookService.getSettings(ws)).catch(() => null);
    if (!settings?.enabled) return { skipped: 'workspace_disabled' };
    const payload = { ...extra, source: 'manual', provisional: false };
    await Promise.resolve().then(() => ticketActivityRepository.create({
      ticketId: id,
      activityType: MANUAL_SETTLE_MARKER,
      performedBy: extra.actorName || 'Ticket Pulse',
      performedAt: new Date(),
      details: safeJson({
        workspaceId: ws, stamp: payload.stamp || null, categoryId: payload.categoryId ?? null, subcategoryId: payload.subcategoryId ?? null,
        by: payload.by || null, note: 'The category was set by hand; Auto-help will look at the ticket again',
      }),
    })).catch((err) => logger.warn(`Auto-help: manual settle marker for ticket ${id} not written (${err.message})`));
    let job = null;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      job = await this.enqueue({ workspaceId: ws, ticketId: id, extra: payload });
      if (job?.id || job?.duplicate) break;
      if (attempt < retryDelaysMs.length) await new Promise((r) => { const t = setTimeout(r, retryDelaysMs[attempt]); t.unref?.(); });
    }
    if (job?.id && this.autoDrain) this.kick();
    return job;
  }

  async enqueue({ workspaceId, ticketId, extra = {}, runAfter = new Date() }) {
    const dedupeKey = dedupeKeyFor(ticketId, extra);
    try {
      const row = await prisma.autoHelpJob.create({
        data: {
          workspaceId: Number(workspaceId),
          ticketId: Number(ticketId),
          trigger: JOB_TRIGGER,
          dedupeKey,
          payload: safeJson(extra),
          status: 'pending',
          attempts: 0,
          runAfter,
        },
      });
      return row;
    } catch (err) {
      if (err?.code === 'P2002') return { duplicate: true, dedupeKey };
      logger.warn(`Auto-help: settle job for ticket ${ticketId} not queued (${err.message}) — the catch-up sweep will retry`);
      return { error: err.message, dedupeKey };
    }
  }

  kick() {
    if (this._draining) { this._rekick = true; return; }
    const t = setTimeout(() => { this.drain().catch((err) => logger.warn(`Auto-help job drain failed: ${err.message}`)); }, 0);
    t.unref?.();
  }

  // ---------- the queue ----------

  /** One pass: expire, recover dead claims, claim and run due jobs. Never overlaps itself in one process. */
  async drain({ now = new Date(), limit = DRAIN_BATCH } = {}) {
    if (this._draining) return { skipped: true };
    this._draining = true;
    const out = { ran: 0, expired: 0, recovered: 0, failed: 0, busy: 0 };
    try {
      out.expired = await this.expireOld(now);
      out.recovered = await this.recoverStuck(now);
      const due = await Promise.resolve()
        .then(() => prisma.autoHelpJob.findMany({
          where: { status: 'pending', runAfter: { lte: now }, createdAt: { gte: new Date(now.getTime() - JOB_MAX_AGE_MS) } },
          orderBy: { runAfter: 'asc' },
          take: limit,
        }))
        .catch((err) => { logger.warn(`Auto-help job scan failed: ${err.message}`); return []; });
      // Two at a time (a run can take up to 45 s): a morning drain burst
      // still moves, and one slow ticket never holds the rest.
      const list = [...(due || [])];
      const worker = async () => {
        while (list.length) {
          const job = list.shift();
          const claimed = await this.claim(job, now);
          if (!claimed) continue;
          if (claimed.busy) { out.busy += 1; continue; }
          const res = await this.process(claimed, now);
          if (res.status === 'done') out.ran += 1;
          else out.failed += 1;
        }
      };
      await Promise.all([worker(), worker()]);
      return out;
    } finally {
      this._draining = false;
      if (this._rekick) {
        this._rekick = false;
        if (this.autoDrain) this.kick();
      }
    }
  }

  /**
   * Conditional claim: only one worker moves a pending job to running - and
   * (audit S2) never while another job for the SAME ticket is running (in
   * this or another container). The check and the claim happen under the
   * ticket's settle lock, so two claims for one ticket serialize; a refused
   * job stays pending for the next tick. Returns the claimed row, null, or
   * { busy } when another job for the ticket holds it.
   */
  async claim(job, now = new Date()) {
    const staleCutoff = new Date(now.getTime() - JOB_RUNNING_STALE_MS);
    const res = await Promise.resolve()
      .then(() => withTicketSettleLock(job.ticketId, async (tx) => {
        const busy = await tx.autoHelpJob.findFirst({
          where: { ticketId: Number(job.ticketId), status: 'running', id: { not: job.id }, claimedAt: { gte: staleCutoff } },
          select: { id: true },
        });
        if (busy) return { count: 0, busyWith: busy.id };
        return tx.autoHelpJob.updateMany({
          where: { id: job.id, status: 'pending', runAfter: { lte: now } },
          data: { status: 'running', claimedAt: now, attempts: { increment: 1 } },
        });
      }))
      .catch(() => ({ count: 0 }));
    if (res?.busyWith) return { busy: true, busyWith: res.busyWith };
    if (!res?.count) return null;
    return Promise.resolve().then(() => prisma.autoHelpJob.findFirst({ where: { id: job.id } })).catch(() => null)
      .then((row) => row || { ...job, status: 'running', claimedAt: now, attempts: (job.attempts || 0) + 1 });
  }

  async process(job, now = new Date()) {
    try {
      const result = await this.handleSettle(job);
      await Promise.resolve().then(() => prisma.autoHelpJob.updateMany({
        where: { id: job.id, status: 'running' },
        data: { status: 'done', finishedAt: new Date(), result: safeJson(result), lastError: null },
      })).catch((err) => logger.warn(`Auto-help job ${job.id} finished but not marked done: ${err.message}`));
      return { status: 'done', result };
    } catch (err) {
      const attempts = Number(job.attempts) || 1;
      const final = attempts >= JOB_MAX_ATTEMPTS;
      await Promise.resolve().then(() => prisma.autoHelpJob.updateMany({
        where: { id: job.id, status: 'running' },
        data: final
          ? { status: 'failed', finishedAt: new Date(), lastError: String(err.message).slice(0, 1000) }
          : { status: 'pending', runAfter: new Date(new Date(now).getTime() + backoffMs(attempts)), claimedAt: null, lastError: String(err.message).slice(0, 1000) },
      })).catch(() => {});
      logger.warn(`Auto-help job ${job.id} (ticket ${job.ticketId}) failed (attempt ${attempts}): ${err.message}${final ? ' — giving up' : ''}`);
      return { status: final ? 'failed' : 'retry', error: err.message };
    }
  }

  /** Age cap: a settle older than 6 h is stale news — recorded, never run. */
  async expireOld(now = new Date()) {
    const res = await Promise.resolve()
      .then(() => prisma.autoHelpJob.updateMany({
        where: { status: 'pending', createdAt: { lt: new Date(now.getTime() - JOB_MAX_AGE_MS) } },
        data: { status: 'expired', finishedAt: now, lastError: 'Older than 6 hours — not run' },
      }))
      .catch(() => ({ count: 0 }));
    return res?.count || 0;
  }

  /** A claim whose container died: back to pending (or failed after the last attempt). */
  async recoverStuck(now = new Date()) {
    const cutoff = new Date(now.getTime() - JOB_RUNNING_STALE_MS);
    const [back, dead] = await Promise.all([
      Promise.resolve().then(() => prisma.autoHelpJob.updateMany({
        where: { status: 'running', claimedAt: { lt: cutoff }, attempts: { lt: JOB_MAX_ATTEMPTS } },
        data: { status: 'pending', claimedAt: null, runAfter: now, lastError: 'Claim went stale (container restart?) — retried' },
      })).catch(() => ({ count: 0 })),
      Promise.resolve().then(() => prisma.autoHelpJob.updateMany({
        where: { status: 'running', claimedAt: { lt: cutoff }, attempts: { gte: JOB_MAX_ATTEMPTS } },
        data: { status: 'failed', finishedAt: now, lastError: 'Claim went stale on the last attempt' },
      })).catch(() => ({ count: 0 })),
    ]);
    return (back?.count || 0) + (dead?.count || 0);
  }

  /** Workspaces with Auto-help on, each with the moment it was switched on (enabled_at; updated_at for older rows). */
  async _enabledWorkspaces() {
    const rows = await Promise.resolve()
      .then(() => prisma.autoHelpSettings.findMany({ where: { enabled: true }, select: { workspaceId: true, enabledAt: true, updatedAt: true } }))
      .catch(() => []);
    return (rows || []).filter((r) => r.workspaceId).map((r) => ({ workspaceId: r.workspaceId, since: r.enabledAt || r.updatedAt || null }));
  }

  /** The earliest moment a catch-up in this workspace may look at: never before Auto-help was switched on. */
  static sinceFor(ws, now, lookbackMs) {
    const floor = now.getTime() - lookbackMs;
    const on = ws?.since ? new Date(ws.since).getTime() : NaN;
    return new Date(Number.isFinite(on) ? Math.max(floor, on) : floor);
  }

  /**
   * Catch-up (W5): intake settles of the last 6 h that never became a job and
   * got no Auto-help decision (a restart between the pipeline's run update and
   * the job insert, a DB blip). Only workspaces with Auto-help on, only
   * pipeline runs created since it was switched on (audit nice-to-have 2),
   * paged by id (never just the newest 100 of a morning burst), bounded at
   * CATCH_UP_MAX_PAGES pages per workspace.
   */
  async catchUp({ now = new Date() } = {}) {
    const out = { checked: 0, requeued: 0 };
    const workspaces = await this._enabledWorkspaces();
    if (!workspaces.length) return out;
    for (const ws of workspaces) {
      const since = AutoHelpIntakeService.sinceFor(ws, now, CATCH_UP_CREATED_LOOKBACK_MS);
      let cursor = 0;
      for (let page = 0; page < CATCH_UP_MAX_PAGES; page += 1) {
        const runs = await Promise.resolve()
          .then(() => prisma.assignmentPipelineRun.findMany({
            where: {
              workspaceId: ws.workspaceId,
              id: { gt: cursor },
              status: 'completed',
              decision: { not: null },
              triggerSource: { notIn: [...CATCH_UP_EXCLUDED_TRIGGERS] },
              createdAt: { gte: since },
              updatedAt: { gte: new Date(now.getTime() - CATCH_UP_WINDOW_MS) },
            },
            orderBy: { id: 'asc' },
            take: CATCH_UP_BATCH,
            select: { id: true, ticketId: true, workspaceId: true, triggerSource: true, decision: true, nonActionable: true, errorMessage: true, updatedAt: true },
          }))
          .catch((err) => { logger.warn(`Auto-help catch-up scan failed: ${err.message}`); return []; });
        for (const run of runs || []) {
          out.checked += 1;
          if (await this._requeueFromPipelineRun(run)) out.requeued += 1;
        }
        if (!runs?.length || runs.length < CATCH_UP_BATCH) break;
        cursor = runs[runs.length - 1].id;
      }
    }

    // Manual settles (a person / API / workflow set the category): marker
    // rows of the last 6 h whose job never landed. ticket_activities is
    // indexed on activity_type and performed_at. Paged by id.
    const byWs = new Map(workspaces.map((w) => [Number(w.workspaceId), w]));
    const floor = new Date(now.getTime() - CATCH_UP_WINDOW_MS);
    let cursor = 0;
    for (let page = 0; page < CATCH_UP_MAX_PAGES; page += 1) {
      const markers = await Promise.resolve()
        .then(() => prisma.ticketActivity.findMany({
          where: { activityType: MANUAL_SETTLE_MARKER, performedAt: { gte: floor }, id: { gt: cursor } },
          orderBy: { id: 'asc' },
          take: CATCH_UP_BATCH,
          select: { id: true, ticketId: true, details: true, performedAt: true },
        }))
        .catch((err) => { logger.warn(`Auto-help catch-up (manual) scan failed: ${err.message}`); return []; });
      for (const m of markers || []) {
        const d = m.details && typeof m.details === 'object' ? m.details : {};
        const ws = byWs.get(Number(d.workspaceId));
        if (!ws || !d.stamp) continue;
        if (m.performedAt && new Date(m.performedAt) < AutoHelpIntakeService.sinceFor(ws, now, CATCH_UP_WINDOW_MS)) continue;
        out.checked += 1;
        const extra = {
          source: 'manual', provisional: false, stamp: d.stamp, categoryId: d.categoryId ?? null, subcategoryId: d.subcategoryId ?? null,
          by: d.by || null, recovered: true,
        };
        const key = dedupeKeyFor(m.ticketId, extra);
        const job = await Promise.resolve().then(() => prisma.autoHelpJob.findFirst({ where: { dedupeKey: key }, select: { id: true } })).catch(() => ({ id: 'unknown' }));
        if (job) continue;
        const res = await this.enqueue({ workspaceId: ws.workspaceId, ticketId: m.ticketId, extra });
        if (res?.id) {
          out.requeued += 1;
          logger.warn(`Auto-help catch-up: re-queued the manual settle of ticket ${m.ticketId} (${d.stamp})`);
        }
      }
      if (!markers?.length || markers.length < CATCH_UP_BATCH) break;
      cursor = markers[markers.length - 1].id;
    }
    return out;
  }

  /** The settle a completed pipeline run stands for, as a job payload. */
  static settleFromPipelineRun(run, overrides = {}) {
    const provisional = run.triggerSource === PROVISIONAL_TRIGGER;
    return {
      provisional,
      source: 'pipeline',
      decision: run.decision,
      nonActionable: run.nonActionable === true,
      noiseVeto: run.decision === 'pending_review' && String(run.errorMessage || '').startsWith('Noise veto:'),
      afterHours: provisional,
      pipelineRunId: run.id,
      recovered: true,
      ...overrides,
    };
  }

  /** Re-queue one pipeline run's settle unless a job or an Auto-help decision exists. Returns true when queued. */
  async _requeueFromPipelineRun(run) {
    const extra = AutoHelpIntakeService.settleFromPipelineRun(run);
    const key = dedupeKeyFor(run.ticketId, extra);
    const job = await Promise.resolve().then(() => prisma.autoHelpJob.findFirst({ where: { dedupeKey: key }, select: { id: true } })).catch(() => ({ id: 'unknown' }));
    if (job) return false;
    const decided = await Promise.resolve()
      .then(() => prisma.autoHelpRun.findFirst({
        where: { ticketId: run.ticketId, trigger: 'categorized', createdAt: { gte: new Date(new Date(run.updatedAt).getTime() - 2 * 60e3) } },
        select: { id: true },
      }))
      .catch(() => ({ id: 'unknown' }));
    if (decided) return false;
    const ticket = await Promise.resolve()
      .then(() => prisma.ticket.findFirst({ where: { id: run.ticketId }, select: { internalCategoryId: true, internalSubcategoryId: true } }))
      .catch(() => null);
    const res = await this.enqueue({
      workspaceId: run.workspaceId,
      ticketId: run.ticketId,
      extra: { ...extra, categoryId: ticket?.internalCategoryId ?? null, subcategoryId: ticket?.internalSubcategoryId ?? null },
    });
    if (res?.id) {
      logger.warn(`Auto-help catch-up: re-queued the ${extra.provisional ? 'provisional' : 'final'} settle of ticket ${run.ticketId} (pipeline run ${run.id})`);
      return true;
    }
    return false;
  }

  /**
   * A missed morning settle (audit nice-to-have 4): a draft staged on the
   * provisional (night) settle whose final settle never arrived within
   * business hours + 2 h. When a full (non-provisional) pipeline run finished
   * after the draft, its settle is queued as the final one (the normal
   * keep / withdraw / re-run rules then apply). No full run yet → nothing:
   * the draft keeps waiting for an agent, which is the safe side.
   */
  async missedFinalSettles({ now = new Date() } = {}) {
    const out = { checked: 0, requeued: 0 };
    const workspaces = await this._enabledWorkspaces();
    if (!workspaces.length) return out;
    const { default: businessCalendarService } = await import('./businessCalendarService.js');
    for (const ws of workspaces) {
      const since = AutoHelpIntakeService.sinceFor(ws, now, CATCH_UP_CREATED_LOOKBACK_MS);
      const staged = await Promise.resolve()
        .then(() => prisma.autoHelpRun.findMany({
          where: { workspaceId: ws.workspaceId, trigger: 'categorized', status: 'staged', outcome: null, decision: null, createdAt: { gte: since } },
          orderBy: { id: 'asc' },
          take: MISSED_SETTLE_BATCH,
          select: { id: true, ticketId: true, workspaceId: true, createdAt: true, outcomeDetail: true },
        }))
        .catch((err) => { logger.warn(`Auto-help missed-settle scan failed: ${err.message}`); return []; });
      if (!staged?.length) continue;
      const calendar = await Promise.resolve().then(() => businessCalendarService.loadCalendar(ws.workspaceId)).catch(() => null);
      for (const run of staged) {
        if (run.outcomeDetail?.settle?.provisional !== true) continue;
        out.checked += 1;
        const finalKey = dedupeKeyFor(run.ticketId, { provisional: false, source: 'pipeline' });
        const job = await Promise.resolve().then(() => prisma.autoHelpJob.findFirst({ where: { dedupeKey: finalKey }, select: { id: true } })).catch(() => ({ id: 'unknown' }));
        if (job) continue;
        const deadline = await Promise.resolve()
          .then(() => businessCalendarService.addBusinessMinutes(run.createdAt, MISSED_SETTLE_GRACE_BUSINESS_MINUTES, { workspaceId: ws.workspaceId, calendar }))
          .catch(() => new Date(new Date(run.createdAt).getTime() + 24 * 3600e3));
        if (now < new Date(deadline)) continue;
        const full = await Promise.resolve()
          .then(() => prisma.assignmentPipelineRun.findFirst({
            where: {
              ticketId: run.ticketId,
              status: 'completed',
              decision: { not: null },
              triggerSource: { notIn: [...NON_INTAKE_TRIGGERS, PROVISIONAL_TRIGGER] },
              updatedAt: { gte: new Date(run.createdAt) },
            },
            orderBy: { updatedAt: 'desc' },
            select: { id: true, ticketId: true, workspaceId: true, triggerSource: true, decision: true, nonActionable: true, errorMessage: true, updatedAt: true },
          }))
          .catch(() => null);
        if (!full) continue;
        const ticket = await Promise.resolve()
          .then(() => prisma.ticket.findFirst({ where: { id: run.ticketId }, select: { internalCategoryId: true, internalSubcategoryId: true } }))
          .catch(() => null);
        const extra = AutoHelpIntakeService.settleFromPipelineRun(full, {
          missedSettle: true, categoryId: ticket?.internalCategoryId ?? null, subcategoryId: ticket?.internalSubcategoryId ?? null,
        });
        const res = await this.enqueue({ workspaceId: ws.workspaceId, ticketId: run.ticketId, extra });
        if (res?.id) {
          out.requeued += 1;
          logger.warn(`Auto-help: the morning settle of ticket ${run.ticketId} never arrived — queued it from pipeline run ${full.id} (draft run ${run.id})`);
        }
      }
    }
    return out;
  }

  // ---------- one settle ----------

  async _latestRealRun(ticketId) {
    return Promise.resolve()
      .then(() => prisma.autoHelpRun.findFirst({
        where: { ticketId: Number(ticketId), trigger: 'categorized', status: { notIn: REAL_RUN_EXCLUDED } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }))
      .catch(() => null);
  }

  async _ticket(ticketId, workspaceId) {
    return Promise.resolve()
      .then(() => prisma.ticket.findFirst({
        where: { id: Number(ticketId), workspaceId: Number(workspaceId) },
        select: {
          id: true, workspaceId: true, requesterId: true, subject: true, fsApprovalStatus: true,
          internalCategoryId: true, internalSubcategoryId: true,
        },
      }))
      .catch(() => null);
  }

  async _approvalInProgress(ticket) {
    if (ticket?.fsApprovalStatus === 0) return true;
    const n = await Promise.resolve()
      .then(() => prisma.ticketApproval.count({ where: { ticketId: ticket.id, status: { in: ['pending', 'info_requested'] } } }))
      .catch(() => 0);
    return Number(n) > 0;
  }

  async _categoryLabel(workspaceId, categoryId, subcategoryId) {
    const ids = [categoryId, subcategoryId].filter((x) => x !== null && x !== undefined);
    if (!ids.length) return 'no category';
    const rows = await Promise.resolve()
      .then(() => prisma.competencyCategory.findMany({ where: { workspaceId: Number(workspaceId), id: { in: ids } }, select: { id: true, name: true } }))
      .catch(() => []);
    const byId = new Map((rows || []).map((r) => [r.id, r.name]));
    return ids.map((id) => byId.get(id) || `#${id}`).join(' › ');
  }

  async _activity(ticketId, activityType, details) {
    await Promise.resolve()
      .then(() => ticketActivityRepository.create({
        ticketId: Number(ticketId), activityType, performedBy: NOTE_ACTOR.name, performedAt: new Date(), details: safeJson(details),
      }))
      .catch((err) => logger.warn(`Auto-help activity ${activityType} not written for ticket ${ticketId}: ${err.message}`));
  }

  async _appendHistory(run, step, extra = {}) {
    const fresh = await Promise.resolve().then(() => prisma.autoHelpRun.findFirst({ where: { id: run.id } })).catch(() => null);
    await Promise.resolve().then(() => prisma.autoHelpRun.update({
      where: { id: run.id },
      data: { outcomeDetail: safeJson(withHistory(fresh?.outcomeDetail ?? run.outcomeDetail, step, extra)) },
    })).catch((err) => logger.warn(`Auto-help history ${step} not recorded on run ${run.id}: ${err.message}`));
  }

  /**
   * Withdraw a staged answer nobody sent. Only a proposal still 'proposed' is
   * taken back — an agent mid-send (or done) wins. Returns true when withdrawn.
   */
  async withdraw(run, { why, fromCategoryId = null, toCategoryId = null, decision = null } = {}) {
    if (run.proposedReplyId) {
      const res = await Promise.resolve()
        .then(() => prisma.ticketProposedReply.updateMany({
          where: { id: run.proposedReplyId, status: 'proposed' },
          data: { status: 'dismissed', decidedBy: 'auto_help_withdrawn', decidedAt: new Date() },
        }))
        .catch(() => ({ count: 0 }));
      if (!res?.count) return false;
    }
    const fresh = await Promise.resolve().then(() => prisma.autoHelpRun.findFirst({ where: { id: run.id } })).catch(() => null);
    const base = fresh?.outcomeDetail ?? run.outcomeDetail;
    const withdrawn = { why, fromCategoryId, toCategoryId, decision, at: new Date().toISOString() };
    const res = await Promise.resolve().then(() => prisma.autoHelpRun.updateMany({
      where: { id: run.id, outcome: null, decision: null },
      data: {
        outcome: PRE_SEND_OUTCOMES.WITHDRAWN,
        outcomeAt: new Date(),
        outcomeDetail: safeJson({ ...withHistory(base, PRE_SEND_OUTCOMES.WITHDRAWN, { why }), withdrawn }),
      },
    })).catch(() => ({ count: 0 }));
    await releaseReplyOwner(run.ticketId, REPLY_OWNERS.AUTO_HELP, `run:${run.id}`);
    await this._activity(run.ticketId, 'auto_help_withdrawn', {
      runId: run.id, why, note: `Auto-help withdrew its suggestion: ${why}`,
    });
    import('../routes/sse.routes.js')
      .then(({ sseManager }) => sseManager.broadcast('ticket-change', { action: 'proposed_reply', proposalAction: 'withdrawn', workspaceId: run.workspaceId, ticketId: run.ticketId }, run.workspaceId))
      .catch(() => {});
    return (res?.count || 0) > 0 || Boolean(run.proposedReplyId);
  }

  /** An answer already went out on the provisional category: tell the assignee. */
  async _noteCategoryChangedAfterSend(run, ticket, priorSettle) {
    const history = Array.isArray(run.outcomeDetail?.history) ? run.outcomeDetail.history : [];
    if (history.some((h) => h.step === 'settle_note')) return false;
    const [was, now] = await Promise.all([
      this._categoryLabel(ticket.workspaceId, priorSettle.categoryId, priorSettle.subcategoryId),
      this._categoryLabel(ticket.workspaceId, ticket.internalCategoryId, ticket.internalSubcategoryId),
    ]);
    const text = `Auto-help answered this as ${was}; the full intake run chose ${now}. Check that the answer the requester got still fits.`;
    try {
      const { default: ticketService } = await import('./ticketService.js');
      await ticketService.addPrivateNote(ticket.id, ticket.workspaceId, { bodyText: text }, NOTE_ACTOR, [], { systemNote: true });
    } catch (err) {
      logger.warn(`Auto-help: settle note on ticket ${ticket.id} not written (${err.message})`);
      await this._activity(ticket.id, 'auto_help_settle_changed', { runId: run.id, note: text });
    }
    await this._appendHistory(run, 'settle_note', { was, now });
    return true;
  }

  /**
   * Decide what one settle means for Auto-help (see the header). Returns a
   * small result for the job row. Throws only for errors worth a retry.
   */
  async handleSettle(job) {
    const extra = job.payload && typeof job.payload === 'object' ? job.payload : {};
    const ticketId = Number(job.ticketId);
    const workspaceId = Number(job.workspaceId);
    const settings = await autoHelpPlaybookService.getSettings(workspaceId);
    if (!settings?.enabled) return { result: 'workspace_disabled' };
    const ticket = await this._ticket(ticketId, workspaceId);
    if (!ticket) return { result: 'ticket_missing' };
    const provisional = extra.provisional === true;
    const settle = {
      provisional,
      source: extra.source || 'pipeline',
      categoryId: ticket.internalCategoryId ?? extra.categoryId ?? null,
      subcategoryId: ticket.internalSubcategoryId ?? extra.subcategoryId ?? null,
      decision: extra.decision || null,
      jobId: job.id ?? null,
    };
    const verdict = verdictSkipCode(extra);
    const prior = await this._latestRealRun(ticketId);

    if (!prior) {
      if (verdict) {
        const row = await autoHelpRunner._recordSkip(
          { id: ticketId, workspaceId, requesterId: ticket.requesterId ?? null, internalCategoryId: ticket.internalCategoryId, internalSubcategoryId: ticket.internalSubcategoryId },
          { status: 'skipped', code: verdict, reasons: [autoHelpRunnerSkipLabel(verdict)], trigger: 'categorized', started: Date.now(), settle },
        );
        return { result: 'skipped', code: verdict, runId: row?.id ?? null, provisional };
      }
      const view = await autoHelpRunner.runForTicket(ticketId, { trigger: 'categorized', workspaceId, settle });
      return summarize(view, { provisional, first: true });
    }

    // Something already ran on this ticket.
    if (provisional) return { result: 'already_ran', runId: prior.id, provisional };
    const priorSettle = prior.outcomeDetail?.settle || null;
    const categoryChanged = Boolean(priorSettle)
      && ((priorSettle.categoryId ?? null) !== (ticket.internalCategoryId ?? null)
        || (priorSettle.subcategoryId ?? null) !== (ticket.internalSubcategoryId ?? null));
    const approval = await this._approvalInProgress(ticket);
    const turned = verdict || (approval ? 'approval_in_progress' : null);
    const state = stateOfRun(prior);

    if (!categoryChanged && !turned) {
      await this._appendHistory(prior, 'settle_confirmed', { source: settle.source, jobId: job.id ?? null });
      return { result: 'kept', runId: prior.id, state };
    }

    if (state === 'sent') {
      if (categoryChanged) {
        const noted = await this._noteCategoryChangedAfterSend(prior, ticket, priorSettle);
        return { result: 'sent_noted', runId: prior.id, noted };
      }
      return { result: 'sent_unchanged', runId: prior.id, turned };
    }

    const why = turned
      ? `the full intake run judged it ${turned === 'noise_decision' ? 'noise' : turned === 'not_actionable' ? 'not actionable' : turned === 'noise_veto' ? 'a never-noise hold for a person' : 'an approval'}`
      : settle.source === 'manual' ? 'the category was changed by hand' : 'the full intake run chose a different category';
    // A run still drafting would stage on the old category after we decided:
    // look again shortly (the job retries with backoff).
    if (state === 'pending') throw new Error(`Auto-help run ${prior.id} is still running — settle retried shortly`);
    let withdrawn = false;
    if (state === 'staged') {
      withdrawn = await this.withdraw(prior, {
        why, fromCategoryId: priorSettle?.categoryId ?? null, toCategoryId: ticket.internalCategoryId ?? null, decision: settle.decision,
      });
      if (!withdrawn) return { result: 'agent_acting', runId: prior.id };
    } else if (['drafted', 'not_answerable', 'failed'].includes(state)) {
      await this._appendHistory(prior, 'superseded_by_settle', { why });
    } else if (!(state === 'withdrawn' && settle.source === 'manual')) {
      // dismissed / superseded: a person already decided; withdrawn by the
      // morning run: nothing new unless a person recategorizes (below).
      return { result: 'nothing_to_do', runId: prior.id, state };
    }

    // A re-run only for a new category (a noise / not actionable / approval
    // verdict means no answer at all). The morning settle happens once per
    // ticket, so it re-runs at most once; a person / API recategorizing re-runs
    // too (Vahid, 26 Sep 2026) — capped at MAX_RUNS_PER_TICKET real runs.
    if (turned || !categoryChanged) return { result: withdrawn ? 'withdrawn' : 'superseded', runId: prior.id, rerun: false, why };
    const realRuns = await Promise.resolve()
      .then(() => prisma.autoHelpRun.count({ where: { ticketId, trigger: 'categorized', status: { notIn: REAL_RUN_EXCLUDED } } }))
      .catch(() => MAX_RUNS_PER_TICKET);
    if (Number(realRuns) >= MAX_RUNS_PER_TICKET) return { result: withdrawn ? 'withdrawn' : 'superseded', runId: prior.id, rerun: false, reason: 'run_cap' };
    const view = await autoHelpRunner.runForTicket(ticketId, {
      trigger: 'categorized', workspaceId, settle: { ...settle, rerunOf: prior.id }, allowRerun: true,
    });
    return { ...summarize(view, { provisional: false, first: false }), withdrawnRunId: withdrawn ? prior.id : null, rerunOf: prior.id };
  }
}

function autoHelpRunnerSkipLabel(code) {
  return {
    noise_decision: 'The AI judged this ticket to be noise',
    not_actionable: 'The AI judged this ticket not actionable',
    noise_veto: 'A never-noise rule is holding this ticket for a person',
  }[code] || code;
}

function summarize(view, { provisional, first }) {
  if (!view) return { result: 'no_result', provisional };
  if (view.skipped) return { result: 'skipped', code: view.gateDecision || null, runId: view.runId ?? null, provisional, first };
  return { result: 'ran', runId: view.id ?? null, status: view.status || null, gateDecision: view.gateDecision || null, provisional, first };
}

export { settleFacts };
const autoHelpIntakeService = new AutoHelpIntakeService();
export default autoHelpIntakeService;
export { AutoHelpIntakeService };
