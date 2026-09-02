import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Coins, Database, RefreshCw, Sparkles, Zap } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { aiUsageAPI, ticketsAPI } from '../../services/api';
import { useChartColors } from '../../utils/highchartsTheme';
import { formatDayTime } from '../tickets/ticketUi';

const fmtInt = (n) => Number(n || 0).toLocaleString();
const fmtTok = (n) => {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
};
const fmtCad = (n) => `$${Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

function StatCard({ icon: Icon, label, value, sub, tone = 'blue' }) {
  const tones = {
    blue: 'bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300',
    emerald: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    violet: 'bg-violet-50 dark:bg-violet-500/15 text-violet-600 dark:text-violet-300',
    amber: 'bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-300',
  };
  return (
    <div className="tp-card rounded-xl p-4 flex items-start gap-3">
      <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${tones[tone]}`}>
        <Icon className="w-4.5 h-4.5 w-[18px] h-[18px]" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">{label}</p>
        <p className="text-xl font-bold text-foreground tabular-nums">{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground/75">{sub}</p>}
      </div>
    </div>
  );
}

function BreakdownTable({ title, rows, keyField, labelField }) {
  if (!rows?.length) return null;
  const totalCost = rows.reduce((s, r) => s + r.costCad, 0);
  return (
    <div className="tp-card rounded-xl p-4">
      <h3 className="text-sm font-bold text-foreground mb-2">{title}</h3>
      <div className="overflow-x-auto settings-scrollbar">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground/75 border-b border-border/60">
              <th className="text-left py-1.5 pr-3 font-semibold">{labelField}</th>
              <th className="text-right py-1.5 px-3 font-semibold">Calls</th>
              <th className="text-right py-1.5 px-3 font-semibold">Input</th>
              <th className="text-right py-1.5 px-3 font-semibold">Output</th>
              <th className="text-right py-1.5 px-3 font-semibold" title="Tokens written to the prompt cache (billed at 1.25x input)">Cache write</th>
              <th className="text-right py-1.5 px-3 font-semibold" title="Tokens served from the prompt cache (billed at ~10% of input)">Cache read</th>
              <th className="text-right py-1.5 pl-3 font-semibold">Cost (CAD)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r[keyField]} className="border-b border-border/60 last:border-0">
                <td className="py-1.5 pr-3 font-medium text-foreground/85 truncate max-w-[220px]" title={String(r[keyField])}>
                  {r.workspaceName || r[keyField]}
                </td>
                <td className="py-1.5 px-3 text-right tabular-nums text-muted-foreground">{fmtInt(r.calls)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-muted-foreground">{fmtTok(r.inputTokens)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-muted-foreground">{fmtTok(r.outputTokens)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-muted-foreground">{fmtTok(r.cacheWriteTokens)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-emerald-600 dark:text-emerald-300">{fmtTok(r.cacheReadTokens)}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums font-semibold text-foreground">{fmtCad(r.costCad)}</td>
              </tr>
            ))}
            <tr className="border-t border-border">
              <td className="py-1.5 pr-3 text-[11px] font-bold uppercase tracking-wide text-muted-foreground/75">Total</td>
              <td colSpan={5} />
              <td className="py-1.5 pl-3 text-right tabular-nums font-bold text-foreground">{fmtCad(totalCost)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

const MATCH_CHIP = {
  matched: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/30',
  ambiguous: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30',
  none: 'bg-muted text-muted-foreground border-border',
};
const MATCH_LABEL = { matched: 'matched', ambiguous: 'ambiguous', none: 'none' };

function MatchChip({ match }) {
  const status = match && typeof match === 'object' && MATCH_LABEL[match.status] ? match.status : 'none';
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${MATCH_CHIP[status]}`}>
      {MATCH_LABEL[status]}
    </span>
  );
}

/** The ticket a run ended up on, however the backend chose to attach it. */
const linkedTicketOf = (run) => {
  const r = run?.resolved || {};
  const id = run?.ticketId ?? r.ticketId ?? r.ticket?.id ?? run?.ticket?.id ?? null;
  const ref = run?.displayRef ?? r.displayRef ?? r.ticket?.displayRef ?? run?.ticket?.displayRef ?? (id != null ? `TP-${id}` : null);
  return id != null ? { id, ref } : null;
};

/**
 * Autofill runs (v2): the workspace's last 50 paste-to-ticket reads — who
 * ran them, what subject the model proposed, whether the requester /
 * assignee resolved, the token cost, and the ticket they became. Additive to
 * the cost report above; the current workspace only (the runs endpoint is
 * workspace-scoped).
 */
export function AutofillRunsTable() {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    ticketsAPI.workspaceIntakeRuns(50)
      .then((res) => { if (alive) setRuns(Array.isArray(res?.data) ? res.data : []); })
      .catch((err) => {
        if (!alive) return;
        // 404 = backend not deployed yet / feature off — stay quiet.
        if (err?.response?.status === 404) { setRuns([]); return; }
        setError(err?.response?.data?.message || err?.message || 'Could not load Autofill runs');
        setRuns([]);
      });
    return () => { alive = false; };
  }, []);

  if (runs === null && !error) return null;

  return (
    <div className="tp-card rounded-xl p-4" data-testid="autofill-runs">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-indigo-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">Autofill runs</h3>
        <span className="text-[11px] text-muted-foreground/75">last {Math.min(50, runs?.length || 0)} in this workspace · what each paste proposed and where it landed</span>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-300">{error}</p>}
      {!error && runs.length === 0 && <p className="text-xs text-muted-foreground/75">No Autofill runs yet — they appear here once an agent drafts a ticket from a paste.</p>}
      {!error && runs.length > 0 && (
        <div className="overflow-x-auto settings-scrollbar">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground/75 border-b border-border/60">
                <th scope="col" className="text-left py-1.5 pr-3 font-semibold whitespace-nowrap">When</th>
                <th scope="col" className="text-left py-1.5 px-3 font-semibold">Who</th>
                <th scope="col" className="text-left py-1.5 px-3 font-semibold">Subject proposed</th>
                <th scope="col" className="text-left py-1.5 px-3 font-semibold">Requester</th>
                <th scope="col" className="text-left py-1.5 px-3 font-semibold">Assignee</th>
                <th scope="col" className="text-right py-1.5 px-3 font-semibold whitespace-nowrap" title="Input / output tokens">Tokens</th>
                <th scope="col" className="text-left py-1.5 pl-3 font-semibold">Ticket</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const result = run.result && typeof run.result === 'object' ? run.result : {};
                const ticket = linkedTicketOf(run);
                return (
                  <tr key={run.id} className="border-b border-border/60 last:border-0 align-top" data-testid="autofill-run-row">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground tabular-nums">
                      {formatDayTime(run.createdAt)}
                      <span className="block text-[10px] text-muted-foreground/75">#{run.id}{run.model ? ` · ${run.model}` : ''}</span>
                    </td>
                    <td className="py-1.5 px-3 text-foreground/85 whitespace-nowrap">{run.actorName || '—'}</td>
                    <td className="py-1.5 px-3 text-foreground max-w-[320px]">
                      <span className="line-clamp-2 break-words">{result.subject || <span className="italic text-muted-foreground/75">—</span>}</span>
                    </td>
                    <td className="py-1.5 px-3"><MatchChip match={result.requesterMatch} /></td>
                    <td className="py-1.5 px-3"><MatchChip match={result.assigneeMatch} /></td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-muted-foreground whitespace-nowrap">{fmtTok(run.inputTokens)} / {fmtTok(run.outputTokens)}</td>
                    <td className="py-1.5 pl-3 whitespace-nowrap">
                      {ticket
                        ? <Link to={`/tickets/${ticket.id}`} className="tp-focus-ring rounded font-semibold text-blue-600 dark:text-blue-300 hover:underline">{ticket.ref}</Link>
                        : <span className="text-muted-foreground/75">not created</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * AI token usage & estimated cost — super admins only (the nav item is
 * minRole 'global'). Always spans all workspaces; the workspace filter
 * narrows focus without changing visibility.
 */
export default function AiUsagePanel() {
  // Dark mode (DM8): token-resolved chart colours as state so the recharts
  // chart re-renders with the right palette on theme change.
  const chartColors = useChartColors();
  const [days, setDays] = useState(30);
  const [workspaceId, setWorkspaceId] = useState('');
  const [report, setReport] = useState(null);
  const [allWorkspaces, setAllWorkspaces] = useState([]); // stable list for the filter
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rateDraft, setRateDraft] = useState('');
  const [savingRate, setSavingRate] = useState(false);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await aiUsageAPI.report({ days, ...(workspaceId ? { workspaceId } : {}) });
      setReport(data);
      setRateDraft(String(data.usdCadRate));
      if (!workspaceId) setAllWorkspaces(data.byWorkspace.map((w) => ({ id: w.workspaceId, name: w.workspaceName })));
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not load usage');
    } finally {
      setLoading(false);
    }
  }, [days, workspaceId]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const saveRate = async () => {
    setSavingRate(true);
    try {
      await aiUsageAPI.setUsdCadRate(Number(rateDraft));
      await fetchReport();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save rate');
    } finally {
      setSavingRate(false);
    }
  };

  // Cache savings: what the cache-read tokens WOULD have cost at full input
  // price minus what they actually cost (~10%). Approximated with the
  // blended Sonnet rate — good enough for the headline.
  const cacheSavingsCad = useMemo(() => {
    if (!report) return 0;
    const saved = (report.overall.cacheReadTokens * (3 - 0.30)) / 1_000_000;
    return saved * report.usdCadRate;
  }, [report]);

  const chartData = useMemo(() => (report?.byDay || []).map((d) => ({
    day: d.day.slice(5),
    costCad: Number(d.costCad.toFixed(2)),
    tokens: Math.round((d.inputTokens + d.cacheWriteTokens + d.cacheReadTokens + d.outputTokens) / 1000),
  })), [report]);

  if (loading && !report) {
    return <div className="flex items-center justify-center py-16"><Activity className="w-6 h-6 animate-spin text-blue-600 dark:text-blue-300" aria-label="Loading usage" /></div>;
  }

  return (
    <div className="space-y-4 animate-fadeIn">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h2 className="text-lg font-bold text-foreground">AI Usage &amp; Cost</h2>
          <p className="text-xs text-muted-foreground">Every AI call across all workspaces. Costs are estimates from list prices.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            className="tp-focus-ring rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm text-foreground/85"
            aria-label="Workspace filter"
          >
            <option value="">All workspaces</option>
            {allWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <div className="flex rounded-lg border border-input bg-card p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setDays(r.days)}
                className={`tp-focus-ring rounded-md px-2.5 py-1 text-xs font-semibold ${days === r.days ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:bg-muted/50'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button onClick={fetchReport} className="tp-focus-ring p-1.5 rounded-lg border border-input bg-card text-muted-foreground hover:text-blue-700 dark:hover:text-blue-200" aria-label="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg px-3 py-2">{error}</p>}

      {report && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={Coins} label={`Est. cost (${days}d)`} value={fmtCad(report.overall.costCad)} sub={`US$${report.overall.costUsd.toFixed(2)} · rate ${report.usdCadRate}`} tone="blue" />
            <StatCard icon={Database} label="Tokens in / out" value={`${fmtTok(report.overall.inputTokens + report.overall.cacheWriteTokens + report.overall.cacheReadTokens)} / ${fmtTok(report.overall.outputTokens)}`} sub={`${fmtInt(report.overall.calls)} calls`} tone="violet" />
            <StatCard icon={Zap} label="Served from cache" value={fmtTok(report.overall.cacheReadTokens)} sub={report.overall.cacheReadTokens ? `≈ ${fmtCad(cacheSavingsCad)} saved` : 'caching starts with the next deploy'} tone="emerald" />
            <StatCard icon={Activity} label="Daily average" value={fmtCad(report.overall.costCad / report.windowDays)} sub={`over ${report.windowDays} days`} tone="amber" />
          </div>

          <div className="tp-card rounded-xl p-4">
            <h3 className="text-sm font-bold text-foreground mb-2">Daily cost (CAD) &amp; tokens</h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={chartColors.grid} vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: chartColors.axis }} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="cost" tick={{ fontSize: 10, fill: chartColors.axis }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}`} />
                  <YAxis yAxisId="tok" orientation="right" tick={{ fontSize: 10, fill: chartColors.series.violet }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}K`} />
                  <Tooltip formatter={(value, name) => (name === 'Cost (CAD)' ? fmtCad(value) : `${fmtInt(value)}K tokens`)} contentStyle={{ fontSize: 12, borderRadius: 8, backgroundColor: chartColors.tooltipBg, border: `1px solid ${chartColors.tooltipBorder}`, color: chartColors.text }} labelStyle={{ fontSize: 12, color: chartColors.text }} itemStyle={{ color: chartColors.text }} />
                  <Bar yAxisId="cost" dataKey="costCad" name="Cost (CAD)" fill={chartColors.series.blueDeep} radius={[3, 3, 0, 0]} maxBarSize={26} />
                  <Line yAxisId="tok" dataKey="tokens" name="Tokens (K)" stroke={chartColors.series.violet} strokeWidth={1.5} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <BreakdownTable title="By workspace" rows={report.byWorkspace} keyField="workspaceId" labelField="Workspace" />
            <BreakdownTable title="By operation" rows={report.byOperation} keyField="operation" labelField="Operation" />
          </div>
          <BreakdownTable title="By model" rows={report.byModel} keyField="model" labelField="Model" />
          <AutofillRunsTable />

          <div className="tp-card rounded-xl p-4 flex flex-wrap items-center gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-foreground">USD → CAD rate</h3>
              <p className="text-[11px] text-muted-foreground/75">Used for all CAD figures on this page. Model list prices (USD per million tokens) are shown in each table&rsquo;s hover titles.</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <input
                type="number"
                step="0.01"
                min="0.5"
                max="3"
                value={rateDraft}
                onChange={(e) => setRateDraft(e.target.value)}
                className="tp-focus-ring w-24 rounded-lg border border-input px-2.5 py-1.5 text-sm text-right tabular-nums"
                aria-label="USD to CAD rate"
              />
              <button
                onClick={saveRate}
                disabled={savingRate || !rateDraft || Number(rateDraft) === report.usdCadRate}
                className="tp-focus-ring rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
              >
                {savingRate ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
