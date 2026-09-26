import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowUpRight, ChevronRight, History } from 'lucide-react';
import { knowledgeGrowthAPI } from '../../services/api';
import { ConfirmDialog, Confidence, RunStatus, SectionTitle, inputClass } from './knowledgeUi';
import {
  BACKTEST_DEFAULT_N, BACKTEST_MAX_N, estimateLine, money,
} from './knowledgeGrowthFormat';

/**
 * "Backtest this playbook" (Auto-help P1, plans/AUTO_HELP_P1_PLAN.md §5):
 * runs the SAVED playbook in shadow on the last N resolved tickets it would
 * have picked up (default 20, max 50), after showing the estimated cost and
 * an in-app confirm. Runs land in Activity tagged Backtest, each next to what
 * the team actually replied, ready for review. Nothing is sent and the
 * tickets are not touched. One backtest per workspace at a time; progress
 * polls every 2 s while it runs.
 */
const DEFAULT_N = BACKTEST_DEFAULT_N;
const MAX_N = BACKTEST_MAX_N;
const POLL_MS = 2000;

function ProgressLine({ job }) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div className="space-y-1.5" role="status" aria-live="polite" data-testid="backtest-progress">
      <div className="flex items-center gap-2 text-xs text-foreground/85">
        {job.status === 'running' && <Activity className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />}
        <span className="tabular-nums">
          {job.status === 'running' ? `${job.done} of ${job.total} done` : `${job.status === 'done' ? 'Finished' : job.status === 'cancelled' ? 'Stopped by you' : job.status === 'interrupted' ? 'Interrupted' : 'Stopped'}: ${job.done} of ${job.total}`}
          {' · '}{job.counts?.drafted || 0} drafted · {job.counts?.not_answerable || 0} not answerable{job.counts?.failed ? ` · ${job.counts.failed} failed` : ''}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      {job.error && <p className="text-xs text-amber-700 dark:text-amber-300">{job.error}</p>}
    </div>
  );
}

export default function PlaybookBacktestBox({ playbookId, dirty = false }) {
  const [n, setN] = useState(String(DEFAULT_N));
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [job, setJob] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [showTickets, setShowTickets] = useState(false);
  const timer = useRef(null);

  const loadResults = useCallback(async () => {
    if (!playbookId) return;
    try {
      const res = await knowledgeGrowthAPI.backtestResults(playbookId);
      setResults(res?.data || null);
    } catch { /* results are optional */ }
  }, [playbookId]);

  const poll = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const res = await knowledgeGrowthAPI.backtestStatus();
      const j = res?.data || null;
      setJob(j);
      if (j?.status === 'running') timer.current = setTimeout(poll, POLL_MS);
      else if (j && Number(j.playbookId) === Number(playbookId)) loadResults();
    } catch {
      timer.current = setTimeout(poll, POLL_MS * 3);
    }
  }, [playbookId, loadResults]);

  useEffect(() => {
    if (!playbookId) return undefined;
    poll();
    loadResults();
    return () => clearTimeout(timer.current);
  }, [playbookId, poll, loadResults]);

  const count = Math.min(MAX_N, Math.max(1, Math.round(Number(n) || DEFAULT_N)));
  const mine = job && Number(job.playbookId) === Number(playbookId);
  const otherRunning = job?.status === 'running' && !mine;

  const getEstimate = async (e) => {
    e?.preventDefault();
    setEstimating(true);
    setError(null);
    try {
      const res = await knowledgeGrowthAPI.backtestEstimate(playbookId, count);
      setEstimate(res?.data || null);
    } catch (err) {
      setError(err?.message || 'Could not estimate the backtest');
    } finally {
      setEstimating(false);
    }
  };

  const start = async () => {
    setConfirming(false);
    setError(null);
    try {
      const res = await knowledgeGrowthAPI.startBacktest(playbookId, count);
      setJob(res?.data || null);
      setEstimate(null);
      timer.current = setTimeout(poll, POLL_MS);
    } catch (err) {
      setError(err?.message || 'The backtest did not start');
    }
  };

  const cancel = async () => {
    try {
      const res = await knowledgeGrowthAPI.cancelBacktest();
      if (res?.data) setJob(res.data);
    } catch (err) {
      setError(err?.message || 'Could not stop it');
    }
  };

  const counts = results?.counts;
  return (
    <section aria-label="Backtest on resolved tickets" data-testid="playbook-backtest">
      <SectionTitle icon={History} hint="Runs this playbook on recent resolved tickets it matches and shows each draft next to what the team actually replied. Nothing is sent; the tickets are not touched.">
        Backtest on resolved tickets
      </SectionTitle>
      {!playbookId ? (
        <p className="text-xs text-muted-foreground">Save the playbook first, then backtest it here.</p>
      ) : (
        <div className="space-y-3">
          {mine && <ProgressLine job={job} />}
          {mine && job.status === 'running' && (
            <button type="button" onClick={cancel} disabled={job.cancelling} className="tp-focus-ring inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
              {job.cancelling ? 'Stopping after the current tickets…' : 'Stop'}
            </button>
          )}
          {otherRunning && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              A backtest of &ldquo;{job.playbookName}&rdquo; is running ({job.done} of {job.total}). One at a time per workspace.
            </p>
          )}

          {!(job?.status === 'running') && (
            <form onSubmit={getEstimate} className="flex items-end gap-2">
              <label className="w-24">
                <span className="mb-1 block text-xs font-medium text-foreground/85">Tickets</span>
                <input
                  type="number"
                  min="1"
                  max={MAX_N}
                  value={n}
                  onChange={(e) => { setN(e.target.value); setEstimate(null); }}
                  className={inputClass}
                  aria-describedby="backtest-n-hint"
                />
              </label>
              <button
                type="submit"
                disabled={estimating}
                className="tp-focus-ring inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50"
              >
                {estimating && <Activity className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {estimating ? 'Checking…' : 'Estimate'}
              </button>
            </form>
          )}
          {!(job?.status === 'running') && <p id="backtest-n-hint" className="text-[11px] text-muted-foreground/75">Up to {MAX_N}. Tickets already backtested with this playbook are skipped.</p>}
          {dirty && <p className="text-[11px] text-amber-700 dark:text-amber-300">Unsaved changes are not backtested — save first.</p>}

          {estimate && !(job?.status === 'running') && (
            <div className="space-y-2 animate-fadeIn" data-testid="backtest-estimate">
              {estimate.count ? (
                <>
                  <p className="text-sm text-foreground/85">
                    <span className="font-medium text-foreground">{estimate.count} resolved ticket{estimate.count === 1 ? '' : 's'}</span> ready · {estimateLine(estimate)}
                  </p>
                  {estimate.count < estimate.requested && (
                    <p className="text-[11px] text-muted-foreground/75">
                      {estimate.matching} resolved ticket{estimate.matching === 1 ? '' : 's'} match; {estimate.alreadyBacktested} already backtested.
                    </p>
                  )}
                  {estimate.budget?.mayStop && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Only {money(estimate.budget.remainingUsd)} of this month&rsquo;s Auto-help budget is left — the backtest stops if it reaches the cap.
                    </p>
                  )}
                  {/* Its own row: inline next to "Run backtest" the two overlapped (QA p1 evidence). */}
                  <div>
                    <button type="button" onClick={() => setShowTickets((v) => !v)} aria-expanded={showTickets} className="tp-focus-ring inline-flex items-center gap-1 rounded py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
                      <ChevronRight className={`h-3 w-3 transition-transform ${showTickets ? 'rotate-90' : ''}`} aria-hidden="true" /> Which tickets
                    </button>
                  </div>
                  {showTickets && (
                    <ul className="settings-scrollbar max-h-40 space-y-0.5 overflow-y-auto">
                      {estimate.tickets.map((t) => (
                        <li key={t.id} className="flex min-w-0 gap-2 text-xs">
                          <span className="w-16 flex-shrink-0 tabular-nums text-muted-foreground/75">{t.ref}</span>
                          <span className="min-w-0 truncate text-foreground/85">{t.subject}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setConfirming(true)}
                      disabled={otherRunning}
                      className="tp-focus-ring inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      data-testid="backtest-run"
                    >
                      Run backtest
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {estimate.matching ? 'Every recent resolved ticket this playbook matches has already been backtested.' : 'No resolved tickets match this playbook yet (category, subcategories and keywords).'}
                </p>
              )}
            </div>
          )}
          {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}

          {counts?.total > 0 && (
            <div className="space-y-2 border-t border-border/70 pt-3" data-testid="backtest-results">
              <p className="text-xs text-foreground/85">
                <span className="font-medium text-foreground">{counts.total} backtest run{counts.total === 1 ? '' : 's'}</span>
                {' · '}{counts.drafted} drafted · {counts.notAnswerable} not answerable{counts.failed ? ` · ${counts.failed} failed` : ''}
                {' · '}{counts.reviewed ? `${counts.reviewed} reviewed, ${counts.good} good` : 'none reviewed yet'}
              </p>
              <ul className="space-y-1">
                {results.runs.slice(0, 6).map((r) => (
                  <li key={r.id}>
                    <Link to={`/knowledge/activity/${r.id}`} className="tp-focus-ring flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50">
                      <RunStatus status={r.status} className="w-28 flex-shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-foreground/85">{r.ticketRef} · {r.ticketSubject}</span>
                      {r.status === 'drafted' && <Confidence value={r.confidence} />}
                    </Link>
                  </li>
                ))}
              </ul>
              <Link to="/knowledge/activity" className="tp-focus-ring inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline">
                Review them in Activity <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Backtest on ${estimate?.count || 0} resolved ticket${estimate?.count === 1 ? '' : 's'}?`}
        confirmLabel="Run backtest"
        onCancel={() => setConfirming(false)}
        onConfirm={start}
      >
        Estimated cost {estimate ? estimateLine(estimate) : ''}. Two run at a time; each lands in Activity tagged Backtest, next to what the team replied. Nothing is sent and the tickets are not changed.
      </ConfirmDialog>
    </section>
  );
}
