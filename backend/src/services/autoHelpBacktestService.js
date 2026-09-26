/**
 * Backtest a playbook (Auto-help P1, plans/AUTO_HELP_P1_PLAN.md §5 "Evidence
 * before trust").
 *
 * Runs a playbook in SHADOW on the last N (default 20, max 50) RESOLVED
 * tickets it would have picked up, so a new playbook reaches 30 reviewed
 * drafts in an afternoon instead of a month. Each run is an ordinary
 * autoHelpRunner run with trigger 'backtest' — a probe trigger: always shadow
 * (the runner only stages on 'categorized'), skip reasons such as "resolved"
 * or "an agent already replied" become warnings, and nothing is written to
 * the ticket. The run's detail shows the draft next to what the team actually
 * replied (R6), ready for review in Activity.
 *
 * Flow: candidates() picks the tickets, estimate() prices them (average cost
 * of this workspace's recent runs, else the Auto-help model's list price on a
 * typical run), start() queues them — concurrency 2 — and status() reports
 * progress. Tickets already backtested with this playbook are skipped. A
 * monthly cost cap reached mid-way stops the batch. results() reads the runs
 * back from the database.
 *
 * One backtest per workspace ACROSS containers and restarts: the job is a
 * lease in app_settings (`auto_help_backtest:<ws>`, JSON with the progress).
 * start() claims it with one INSERT … ON CONFLICT DO UPDATE … WHERE the
 * current job is not running or its heartbeat is older than STALE_MS, so two
 * containers cannot both win. The driver heartbeats (writes progress) after
 * every ticket and every HEARTBEAT_MS; cancel from any container sets a flag
 * the next heartbeat reads. A container that dies leaves a stale lease: after
 * STALE_MS status() reports it 'interrupted' and a new start() may take over
 * (the tickets already run are skipped, so nothing runs twice).
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ConflictError, ValidationError } from '../utils/errors.js';
import autoHelpRunner from './autoHelpRunner.js';
import autoHelpPlaybookService, { explainMatch } from './autoHelpPlaybookService.js';
import providerModelResolver from './aiProviders/providerModelResolver.js';
import { costUsdFor } from './tokenUsageService.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

export const BACKTEST_TRIGGER = 'backtest';
export const DEFAULT_N = 20;
export const MAX_N = 50;
export const CONCURRENCY = 2;
const CANDIDATE_SCAN = 400;
const HISTORY_RUNS = 200;
/** A typical run when there is no cost history: ~3 model turns + the answerability check. */
export const TYPICAL_RUN_TOKENS = Object.freeze({ inputTokens: 12000, outputTokens: 1200 });
const JOB_KEEP_MS = 24 * 3600e3;
/** A running job whose heartbeat is older than this is treated as dead. */
export const STALE_MS = 3 * 60 * 1000;
export const HEARTBEAT_MS = 30 * 1000;
export const LEASE_PREFIX = 'auto_help_backtest';
const leaseKey = (ws) => `${LEASE_PREFIX}:${Number(ws)}`;

/**
 * The shared lock + progress, in app_settings (raw SQL so the claim is one
 * atomic statement). Every method degrades: a failure to read reports no job,
 * a failed claim refuses to start.
 */
export class PgBacktestJobStore {
  constructor(db = null) {
    this.db = db;
  }

  get prisma() {
    return this.db || prisma;
  }

  /** True when this process now owns the workspace's backtest. */
  async claim(ws, job, staleMs = STALE_MS) {
    const rows = await this.prisma.$queryRaw`
      INSERT INTO app_settings (key, value, description, updated_at)
      VALUES (${leaseKey(ws)}, ${JSON.stringify(job)}, 'Auto-help backtest: lock + progress', now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      WHERE (app_settings.value::jsonb ->> 'status') IS DISTINCT FROM 'running'
         OR app_settings.updated_at < now() - make_interval(secs => ${Math.round(staleMs / 1000)}::double precision)
      RETURNING key`;
    return Array.isArray(rows) && rows.length === 1;
  }

  /**
   * Write progress (only while this job still owns the lease) and read back
   * a cancel request made from any container. { owned, cancelRequested }.
   */
  async heartbeat(ws, job) {
    const rows = await this.prisma.$queryRaw`
      UPDATE app_settings
         SET value = (${JSON.stringify(job)}::jsonb
                     || jsonb_build_object('cancelRequested', COALESCE((value::jsonb ->> 'cancelRequested')::boolean, false)))::text,
             updated_at = now()
       WHERE key = ${leaseKey(ws)} AND (value::jsonb ->> 'id') = ${String(job.id)}
      RETURNING (value::jsonb ->> 'cancelRequested') AS cancel`;
    if (!Array.isArray(rows) || !rows.length) return { owned: false, cancelRequested: false };
    return { owned: true, cancelRequested: rows[0].cancel === 'true' };
  }

  /** The workspace's job (running or last finished) with its heartbeat age, or null. */
  async read(ws) {
    const row = await this.prisma.appSettings.findUnique({ where: { key: leaseKey(ws) } });
    if (!row?.value) return null;
    try {
      return { ...JSON.parse(row.value), heartbeatAt: row.updatedAt || null };
    } catch {
      return null;
    }
  }

  async requestCancel(ws) {
    const rows = await this.prisma.$queryRaw`
      UPDATE app_settings SET value = jsonb_set(value::jsonb, '{cancelRequested}', 'true'::jsonb)::text
       WHERE key = ${leaseKey(ws)} AND (value::jsonb ->> 'status') = 'running'
      RETURNING value`;
    return Array.isArray(rows) && rows.length ? JSON.parse(rows[0].value) : null;
  }

  /** Give the lease back without a job (a start that found nothing to run). */
  async release(ws, jobId) {
    await this.prisma.$executeRaw`
      DELETE FROM app_settings WHERE key = ${leaseKey(ws)} AND (value::jsonb ->> 'id') = ${String(jobId)}`;
  }
}

export function clampN(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_N;
  return Math.min(MAX_N, Math.max(1, v));
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

class AutoHelpBacktestService {
  constructor() {
    this.jobs = new Map(); // this process's own jobs (the live copy it drives)
    this.runner = autoHelpRunner;
    this.concurrency = CONCURRENCY;
    this.store = new PgBacktestJobStore();
    this.heartbeatMs = HEARTBEAT_MS;
    this.staleMs = STALE_MS;
  }

  /** The most recent resolved tickets this playbook would pick up, not yet backtested with it. */
  async candidates(workspaceId, playbookId, { n = DEFAULT_N } = {}) {
    const ws = Number(workspaceId);
    const count = clampN(n);
    const playbook = await autoHelpPlaybookService.get(ws, playbookId);
    if (!playbook.categoryId) throw new ValidationError('Give the playbook a category first — the backtest picks resolved tickets from it');
    const subs = (playbook.subcategoryIds || []).map(Number).filter(Boolean);
    const rows = await Promise.resolve().then(() => prisma.ticket.findMany({
      where: {
        workspaceId: ws,
        internalCategoryId: Number(playbook.categoryId),
        ...(subs.length ? { internalSubcategoryId: { in: subs } } : {}),
        isNoise: false,
        resolvedAt: { not: null },
        status: { notIn: ['Deleted', 'Spam'] },
      },
      orderBy: { resolvedAt: 'desc' },
      take: CANDIDATE_SCAN,
      select: {
        id: true, subject: true, descriptionText: true, status: true, resolvedAt: true, internalCategoryId: true,
        internalSubcategoryId: true, origin: true, nativeNumber: true, freshserviceTicketId: true,
      },
    })).catch((err) => { logger.warn(`Backtest candidates failed (ws ${ws}): ${err.message}`); return []; });
    const matching = (rows || []).filter((t) => explainMatch(playbook, t, { ignoreEnabled: true }).matches);
    const done = matching.length ? await Promise.resolve().then(() => prisma.autoHelpRun.findMany({
      where: { workspaceId: ws, playbookId: playbook.id, trigger: BACKTEST_TRIGGER, ticketId: { in: matching.map((t) => t.id) } },
      select: { ticketId: true },
      take: CANDIDATE_SCAN,
    })).catch(() => []) : [];
    const already = new Set((done || []).map((r) => r.ticketId));
    const fresh = matching.filter((t) => !already.has(t.id));
    return {
      playbook: { id: playbook.id, name: playbook.name, version: playbook.version || 1 },
      tickets: fresh.slice(0, count).map((t) => ({
        id: t.id, ref: ticketDisplayRef(t), subject: t.subject || '(no subject)', resolvedAt: t.resolvedAt,
      })),
      matching: matching.length,
      alreadyBacktested: already.size,
      scanned: (rows || []).length,
    };
  }

  /** Price per run: this workspace's recent run costs, else the model's list price on a typical run. */
  async perRunCost(workspaceId) {
    const ws = Number(workspaceId);
    const recent = await Promise.resolve().then(() => prisma.autoHelpRun.findMany({
      where: { workspaceId: ws, costUsd: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_RUNS,
      select: { costUsd: true },
    })).catch(() => []);
    const costs = (recent || []).map((r) => Number(r.costUsd)).filter((x) => Number.isFinite(x) && x > 0);
    if (costs.length >= 3) {
      return { perRunUsd: round4(costs.reduce((a, b) => a + b, 0) / costs.length), basis: 'history', sampleRuns: costs.length, model: null };
    }
    let model = null;
    let provider = null;
    try {
      const res = await providerModelResolver.resolveAttempts({ workspaceId: ws, operation: 'auto_help' });
      model = res?.attempts?.[0]?.model || null;
      provider = res?.attempts?.[0]?.provider || null;
    } catch { /* default pricing */ }
    return { perRunUsd: round4(costUsdFor({ provider, model, ...TYPICAL_RUN_TOKENS })), basis: 'model_price', sampleRuns: 0, model };
  }

  async estimate(workspaceId, playbookId, { n = DEFAULT_N } = {}) {
    const ws = Number(workspaceId);
    const [cand, price, budget] = await Promise.all([
      this.candidates(ws, playbookId, { n }),
      this.perRunCost(ws),
      Promise.resolve().then(() => this.runner.budgetState?.(ws)).catch(() => null),
    ]);
    const count = cand.tickets.length;
    const totalUsd = round4(price.perRunUsd * count);
    const remaining = budget?.capUsd !== null && budget?.capUsd !== undefined ? round4(budget.capUsd - budget.spentUsd) : null;
    return {
      playbook: cand.playbook,
      requested: clampN(n),
      count,
      matching: cand.matching,
      alreadyBacktested: cand.alreadyBacktested,
      tickets: cand.tickets,
      perRunUsd: price.perRunUsd,
      totalUsd,
      basis: price.basis,
      sampleRuns: price.sampleRuns,
      model: price.model,
      budget: budget ? { capUsd: budget.capUsd ?? null, spentUsd: budget.spentUsd ?? 0, remainingUsd: remaining, mayStop: remaining !== null && totalUsd > remaining } : null,
      running: await this.status(ws),
    };
  }

  _prune() {
    const now = Date.now();
    for (const [ws, job] of this.jobs) {
      if (job.status !== 'running' && job.finishedAt && now - new Date(job.finishedAt).getTime() > JOB_KEEP_MS) this.jobs.delete(ws);
    }
  }

  _alreadyRunning(job) {
    const name = job?.playbookName && job.playbookName !== '…' ? `"${job.playbookName}"` : 'another playbook';
    const progress = job?.total ? ` (${job.done} of ${job.total} done)` : '';
    return new ConflictError(`A backtest of ${name} is already running in this workspace${progress}. Wait for it to finish.`);
  }

  /** The job as stored (without the live-only fields). */
  _snapshot(job) {
    const { cancelRequested, ...rest } = job;
    return { ...rest, cancelRequested: Boolean(cancelRequested) };
  }

  /**
   * Queue the backtest. One per workspace at a time, across containers (the
   * app_settings lease). Returns the job view immediately.
   */
  async start(workspaceId, playbookId, { n = DEFAULT_N, actor = null } = {}) {
    const ws = Number(workspaceId);
    this._prune();
    if (this.jobs.get(ws)?.status === 'running') throw this._alreadyRunning(this.jobs.get(ws));
    // Claim the lease BEFORE loading candidates, so a double click (or a
    // second container) cannot start two.
    const id = `bt-${ws}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const placeholder = { id, workspaceId: ws, status: 'running', playbookName: '…', done: 0, total: 0, startedAt: new Date() };
    let claimed = false;
    try {
      claimed = await this.store.claim(ws, placeholder, this.staleMs);
    } catch (err) {
      logger.warn(`Backtest lease unavailable (ws ${ws}): ${err.message}`);
      throw new ConflictError('The backtest could not be started right now (its lock is unavailable). Try again in a minute.');
    }
    if (!claimed) {
      const other = await this.store.read(ws).catch(() => null);
      throw this._alreadyRunning(other);
    }
    this.jobs.set(ws, placeholder);
    let cand;
    try {
      cand = await this.candidates(ws, playbookId, { n });
      if (!cand.tickets.length) {
        throw new ValidationError(cand.matching
          ? 'Every recent resolved ticket this playbook matches has already been backtested with it.'
          : 'No resolved tickets match this playbook yet (category, subcategories and keywords).');
      }
    } catch (err) {
      this.jobs.delete(ws);
      await this.store.release(ws, id).catch(() => {});
      throw err;
    }
    const job = {
      id,
      workspaceId: ws,
      playbookId: cand.playbook.id,
      playbookName: cand.playbook.name,
      playbookVersion: cand.playbook.version,
      total: cand.tickets.length,
      done: 0,
      counts: { drafted: 0, not_answerable: 0, failed: 0, other: 0 },
      items: cand.tickets.map((t) => ({ ticketId: t.id, ref: t.ref, subject: t.subject, state: 'queued', runId: null, status: null })),
      status: 'running',
      error: null,
      startedAt: new Date(),
      finishedAt: null,
      startedBy: actor?.email || actor?.name || null,
      cancelRequested: false,
    };
    this.jobs.set(ws, job);
    await this._beat(job);
    logger.info(`Auto-help backtest started: "${job.playbookName}" on ${job.total} resolved ticket(s) (ws ${ws})`);
    this._drive(job, actor).catch((err) => logger.warn(`Backtest driver failed (ws ${ws}): ${err.message}`));
    return this.view(job);
  }

  /** Persist progress; pick up a cancel from any container; stop when the lease was lost. */
  async _beat(job) {
    try {
      const res = await this.store.heartbeat(job.workspaceId, this._snapshot(job));
      if (!res.owned && job.status === 'running') {
        logger.warn(`Backtest ${job.id} lost its lease (ws ${job.workspaceId}) — stopping`);
        job.cancelRequested = true;
        job.leaseLost = true;
      } else if (res.cancelRequested) {
        job.cancelRequested = true;
      }
    } catch (err) {
      logger.warn(`Backtest heartbeat failed (ws ${job.workspaceId}): ${err.message}`);
    }
  }

  async _drive(job, actor) {
    let next = 0;
    const timer = setInterval(() => { this._beat(job).catch(() => {}); }, this.heartbeatMs);
    timer.unref?.();
    const worker = async () => {
      while (job.status === 'running' && !job.cancelRequested && next < job.items.length) {
        const item = job.items[next];
        next += 1;
        item.state = 'running';
        try {
          const run = await this.runner.runForTicket(item.ticketId, {
            trigger: BACKTEST_TRIGGER, playbookId: job.playbookId, actor, workspaceId: job.workspaceId,
          });
          item.runId = run?.id ?? run?.runId ?? null;
          item.status = run?.skipped ? 'skipped' : (run?.status || null);
          item.state = 'done';
          if (item.status === 'drafted') job.counts.drafted += 1;
          else if (item.status === 'not_answerable') job.counts.not_answerable += 1;
          else if (item.status === 'failed') job.counts.failed += 1;
          else job.counts.other += 1;
        } catch (err) {
          item.state = 'failed';
          item.status = 'failed';
          item.error = String(err.message || err).slice(0, 300);
          job.counts.failed += 1;
          // The monthly cap (or any "stop" the runner raises) ends the whole batch.
          if (err?.code === 'auto_help_budget_exhausted') {
            job.status = 'stopped';
            job.error = item.error;
          }
        } finally {
          job.done += 1;
          await this._beat(job);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.concurrency, job.items.length) }, worker));
    } finally {
      clearInterval(timer);
    }
    if (job.status === 'running') job.status = job.leaseLost ? 'interrupted' : (job.cancelRequested ? 'cancelled' : 'done');
    for (const item of job.items) if (item.state === 'queued') item.state = 'not_run';
    job.finishedAt = new Date();
    if (!job.leaseLost) await this._beat(job);
    logger.info(`Auto-help backtest ${job.status}: "${job.playbookName}" ${job.done}/${job.total} (ws ${job.workspaceId})`);
  }

  /** Stop scheduling more tickets. Works from any container (the flag is in the lease). */
  async cancel(workspaceId) {
    const ws = Number(workspaceId);
    const local = this.jobs.get(ws);
    if (local?.status === 'running' && local.items) local.cancelRequested = true;
    const stored = await this.store.requestCancel(ws).catch(() => null);
    if (local?.status === 'running' && local.items) return this.view(local);
    return stored?.items ? this.view({ ...stored, cancelRequested: true }) : null;
  }

  view(job) {
    if (!job || !job.items) return null;
    const rest = { ...job };
    delete rest.cancelRequested;
    delete rest.leaseLost;
    return { ...rest, cancelling: Boolean(job.cancelRequested) && job.status === 'running' };
  }

  /**
   * The workspace's backtest as any container sees it: this process's live
   * job when it is driving one, else the shared lease. A 'running' lease
   * whose heartbeat is older than STALE_MS is reported 'interrupted'.
   */
  async status(workspaceId) {
    const ws = Number(workspaceId);
    const local = this.jobs.get(ws);
    if (local?.status === 'running' && local.items) return this.view(local);
    const stored = await this.store.read(ws).catch(() => null);
    if (!stored) return local ? this.view(local) : null;
    if (local?.items && local.id === stored.id) return this.view(local);
    const age = stored.heartbeatAt ? Date.now() - new Date(stored.heartbeatAt).getTime() : Infinity;
    if (stored.status === 'running' && age > this.staleMs) {
      return this.view({ ...stored, status: 'interrupted', cancelRequested: false, error: stored.error || 'The server restarted while this backtest ran. The runs already made are in Activity; start it again to finish the rest.' });
    }
    return this.view(stored);
  }

  /** The playbook's backtest runs from the database (survives restarts), newest first, with counts. */
  async results(workspaceId, playbookId, { limit = 50 } = {}) {
    const ws = Number(workspaceId);
    const where = { workspaceId: ws, playbookId: Number(playbookId), trigger: BACKTEST_TRIGGER };
    const [rows, byStatus, byVerdict] = await Promise.all([
      Promise.resolve().then(() => prisma.autoHelpRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(Number(limit) || 50, 1), 100),
        select: {
          id: true, ticketId: true, status: true, gateDecision: true, confidence: true, reviewVerdict: true,
          createdAt: true, playbookVersion: true,
        },
      })).catch(() => []),
      Promise.resolve().then(() => prisma.autoHelpRun.groupBy({ by: ['status'], where, _count: { _all: true } })).catch(() => []),
      Promise.resolve().then(() => prisma.autoHelpRun.groupBy({ by: ['reviewVerdict'], where: { ...where, reviewVerdict: { not: null } }, _count: { _all: true } })).catch(() => []),
    ]);
    const ids = [...new Set((rows || []).map((r) => r.ticketId))];
    const tickets = ids.length ? await Promise.resolve().then(() => prisma.ticket.findMany({
      where: { workspaceId: ws, id: { in: ids } },
      select: { id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true },
      take: ids.length,
    })).catch(() => []) : [];
    const tById = new Map((tickets || []).map((t) => [t.id, t]));
    const counts = { total: 0, drafted: 0, notAnswerable: 0, failed: 0, reviewed: 0, good: 0 };
    for (const g of byStatus || []) {
      const c = g._count?._all || 0;
      counts.total += c;
      if (g.status === 'drafted') counts.drafted += c;
      else if (g.status === 'not_answerable') counts.notAnswerable += c;
      else if (g.status === 'failed') counts.failed += c;
    }
    for (const g of byVerdict || []) {
      const c = g._count?._all || 0;
      counts.reviewed += c;
      if (g.reviewVerdict === 'good') counts.good += c;
    }
    return {
      counts,
      runs: (rows || []).map((r) => {
        const t = tById.get(r.ticketId);
        return { ...r, ticketRef: t ? ticketDisplayRef(t) : `#${r.ticketId}`, ticketSubject: t?.subject || null };
      }),
    };
  }
}

const autoHelpBacktestService = new AutoHelpBacktestService();
export default autoHelpBacktestService;
export { AutoHelpBacktestService };
