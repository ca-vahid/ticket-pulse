import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Coins, Database, RefreshCw, Zap } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { aiUsageAPI } from '../../services/api';

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
    blue: 'bg-blue-50 text-blue-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    violet: 'bg-violet-50 text-violet-600',
    amber: 'bg-amber-50 text-amber-600',
  };
  return (
    <div className="tp-card rounded-xl p-4 flex items-start gap-3">
      <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${tones[tone]}`}>
        <Icon className="w-4.5 h-4.5 w-[18px] h-[18px]" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
        <p className="text-xl font-bold text-slate-800 tabular-nums">{value}</p>
        {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
      </div>
    </div>
  );
}

function BreakdownTable({ title, rows, keyField, labelField }) {
  if (!rows?.length) return null;
  const totalCost = rows.reduce((s, r) => s + r.costCad, 0);
  return (
    <div className="tp-card rounded-xl p-4">
      <h3 className="text-sm font-bold text-slate-800 mb-2">{title}</h3>
      <div className="overflow-x-auto settings-scrollbar">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
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
              <tr key={r[keyField]} className="border-b border-slate-50 last:border-0">
                <td className="py-1.5 pr-3 font-medium text-slate-700 truncate max-w-[220px]" title={String(r[keyField])}>
                  {r.workspaceName || r[keyField]}
                </td>
                <td className="py-1.5 px-3 text-right tabular-nums text-slate-600">{fmtInt(r.calls)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-slate-600">{fmtTok(r.inputTokens)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-slate-600">{fmtTok(r.outputTokens)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-slate-500">{fmtTok(r.cacheWriteTokens)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-emerald-600">{fmtTok(r.cacheReadTokens)}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums font-semibold text-slate-800">{fmtCad(r.costCad)}</td>
              </tr>
            ))}
            <tr className="border-t border-slate-200">
              <td className="py-1.5 pr-3 text-[11px] font-bold uppercase tracking-wide text-slate-400">Total</td>
              <td colSpan={5} />
              <td className="py-1.5 pl-3 text-right tabular-nums font-bold text-slate-900">{fmtCad(totalCost)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * AI token usage & estimated cost — super admins only (the nav item is
 * minRole 'global'). Always spans all workspaces; the workspace filter
 * narrows focus without changing visibility.
 */
export default function AiUsagePanel() {
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
    return <div className="flex items-center justify-center py-16"><Activity className="w-6 h-6 animate-spin text-blue-600" aria-label="Loading usage" /></div>;
  }

  return (
    <div className="space-y-4 animate-fadeIn">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h2 className="text-lg font-bold text-slate-800">AI Usage &amp; Cost</h2>
          <p className="text-xs text-slate-500">Every AI call across all workspaces. Costs are estimates from list prices.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            className="tp-focus-ring rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700"
            aria-label="Workspace filter"
          >
            <option value="">All workspaces</option>
            {allWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setDays(r.days)}
                className={`tp-focus-ring rounded-md px-2.5 py-1 text-xs font-semibold ${days === r.days ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button onClick={fetchReport} className="tp-focus-ring p-1.5 rounded-lg border border-slate-300 bg-white text-slate-500 hover:text-blue-700" aria-label="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      {report && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={Coins} label={`Est. cost (${days}d)`} value={fmtCad(report.overall.costCad)} sub={`US$${report.overall.costUsd.toFixed(2)} · rate ${report.usdCadRate}`} tone="blue" />
            <StatCard icon={Database} label="Tokens in / out" value={`${fmtTok(report.overall.inputTokens + report.overall.cacheWriteTokens + report.overall.cacheReadTokens)} / ${fmtTok(report.overall.outputTokens)}`} sub={`${fmtInt(report.overall.calls)} calls`} tone="violet" />
            <StatCard icon={Zap} label="Served from cache" value={fmtTok(report.overall.cacheReadTokens)} sub={report.overall.cacheReadTokens ? `≈ ${fmtCad(cacheSavingsCad)} saved` : 'caching starts with the next deploy'} tone="emerald" />
            <StatCard icon={Activity} label="Daily average" value={fmtCad(report.overall.costCad / report.windowDays)} sub={`over ${report.windowDays} days`} tone="amber" />
          </div>

          <div className="tp-card rounded-xl p-4">
            <h3 className="text-sm font-bold text-slate-800 mb-2">Daily cost (CAD) &amp; tokens</h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="cost" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `$${v}`} />
                  <YAxis yAxisId="tok" orientation="right" tick={{ fontSize: 10, fill: '#c4b5fd' }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}K`} />
                  <Tooltip formatter={(value, name) => (name === 'Cost (CAD)' ? fmtCad(value) : `${fmtInt(value)}K tokens`)} labelStyle={{ fontSize: 12 }} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Bar yAxisId="cost" dataKey="costCad" name="Cost (CAD)" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={26} />
                  <Line yAxisId="tok" dataKey="tokens" name="Tokens (K)" stroke="#8b5cf6" strokeWidth={1.5} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <BreakdownTable title="By workspace" rows={report.byWorkspace} keyField="workspaceId" labelField="Workspace" />
            <BreakdownTable title="By operation" rows={report.byOperation} keyField="operation" labelField="Operation" />
          </div>
          <BreakdownTable title="By model" rows={report.byModel} keyField="model" labelField="Model" />

          <div className="tp-card rounded-xl p-4 flex flex-wrap items-center gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-slate-800">USD → CAD rate</h3>
              <p className="text-[11px] text-slate-400">Used for all CAD figures on this page. Model list prices (USD per million tokens) are shown in each table&rsquo;s hover titles.</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <input
                type="number"
                step="0.01"
                min="0.5"
                max="3"
                value={rateDraft}
                onChange={(e) => setRateDraft(e.target.value)}
                className="tp-focus-ring w-24 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-right tabular-nums"
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
