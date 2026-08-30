import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, FileText, Loader2, Pencil, Plus, Printer, Sparkles, Trash2, TrendingDown, TrendingUp, X,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { analyticsAPI, ticketsAPI } from '../../services/api';
import { useChartColors } from '../../utils/highchartsTheme';
import MetricHint from './MetricHint';

/**
 * Analytics → Reports (feedback 07-14): saved report snapshots for weekly
 * meetings. Every number shown comes from the deterministic dataset; the AI
 * narrative is a clearly-banner-labeled brief written FROM that dataset
 * (summary, subject clusters, discussion points). Deliberately a separate
 * surface from the six deterministic tabs.
 */
export default function AnalyticsReports({ initialReportId = null, onReportSelected = null }) {
  const [reports, setReports] = useState(null);
  const [selected, setSelected] = useState(null); // full report row
  const [loadingReport, setLoadingReport] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null); // { categoryTree, tags }

  const load = useCallback(async () => {
    try {
      const res = await analyticsAPI.listReports();
      const rows = res?.data || [];
      setReports(rows);
      if (rows.length && !selected) {
        const wanted = initialReportId && rows.some((r) => String(r.id) === String(initialReportId))
          ? Number(initialReportId)
          : rows[0].id;
        openReport(wanted);
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setReports([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    ticketsAPI.meta()
      .then((res) => setMeta({ categoryTree: res.data?.categoryTree || [], tags: res.data?.tags || [] }))
      .catch(() => setMeta({ categoryTree: [], tags: [] }));
  }, []);

  const openReport = async (id, { silent = false } = {}) => {
    if (!silent) setLoadingReport(true);
    try {
      const res = await analyticsAPI.getReport(id);
      setSelected(res?.data || null);
      onReportSelected?.(res?.data?.id ?? null);
      setError(null);
    } catch (err) {
      if (!silent) setError(err.response?.data?.message || err.message);
    }
    if (!silent) setLoadingReport(false);
  };

  // The narrative is written in the background after generation — poll the
  // open report until it lands (or gives up), so the brief appears in place.
  useEffect(() => {
    if (selected?.dataset?.narrativeStatus !== 'pending') return undefined;
    // A report stuck 'pending' long past generation means the background
    // writer died (e.g. a deploy restart) — don't poll a corpse.
    const ageMs = Date.now() - new Date(selected.createdAt).getTime();
    if (ageMs > 3 * 60 * 1000) return undefined;
    const timer = setInterval(() => {
      if (document.hidden) return; // don't poll a backgrounded tab
      openReport(selected.id, { silent: true });
    }, 3000);
    const giveUp = setTimeout(() => clearInterval(timer), 150000);
    return () => { clearInterval(timer); clearTimeout(giveUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.dataset?.narrativeStatus]);

  const generate = async (payload) => {
    setGenerating(true); setError(null);
    try {
      const res = await analyticsAPI.generateReport(payload);
      setBuilderOpen(false);
      await load();
      if (res?.data?.id) openReport(res.data.id);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
    setGenerating(false);
  };

  const remove = async (id) => {
    try {
      await analyticsAPI.deleteReport(id);
      if (selected?.id === id) { setSelected(null); onReportSelected?.(null); }
      load();
    } catch (err) { setError(err.response?.data?.message || err.message); }
  };

  // Template shortcuts — the phishing one resolves its subcategory by name so
  // it keeps working if ids ever change.
  const phishingNode = useMemo(() => {
    const subs = (meta?.categoryTree || []).flatMap((c) => c.subcategories || []);
    // Exact home first; otherwise any phishing/spam subcategory that is NOT
    // the awareness-training one (the old /phishing/i match grabbed
    // "Simulated Phishing / Training" and produced a useless report).
    return subs.find((sub) => /phishing\s*\/\s*spam/i.test(sub.name || ''))
      || subs.find((sub) => /phish|spam/i.test(sub.name || '') && !/simulat|training/i.test(sub.name || ''))
      || null;
  }, [meta]);

  const TEMPLATES = [
    phishingNode && {
      label: 'Phishing & spam — weekly',
      hint: 'Everything filed under Phishing / Spam Reports in the last 7 days, clustered by what the attempts were.',
      payload: { scope: { kind: 'subcategory', id: phishingNode.id }, rangeDays: 7 },
    },
    {
      label: 'Noise & spam overview — weekly',
      hint: 'All noise-flagged tickets: volume trend, sources, categories.',
      payload: { scope: { kind: 'noise' }, rangeDays: 7 },
    },
    {
      label: 'Workspace summary — weekly',
      hint: 'The whole workspace: demand trend, category mix, hotspots.',
      payload: { scope: { kind: 'all' }, rangeDays: 7 },
    },
  ].filter(Boolean);

  return (
    <div className="grid gap-4 lg:grid-cols-[280px,1fr]">
      {/* ---- left: saved reports + new ---- */}
      <div className="space-y-3 print:hidden">
        <button
          onClick={() => setBuilderOpen(true)}
          className="tp-focus-ring flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> New report
        </button>
        <div className="rounded-lg border border-border bg-card">
          <p className="border-b border-border/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">Saved reports</p>
          {reports === null ? (
            <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground/75"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          ) : reports.length === 0 ? (
            <p className="px-3 py-4 text-sm italic text-muted-foreground/75">No reports yet — generate your first for this week’s meeting.</p>
          ) : (
            <ul className="max-h-[26rem] divide-y divide-border/60 overflow-y-auto settings-scrollbar">
              {reports.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => openReport(r.id)}
                    className={`tp-focus-ring block w-full px-3 py-2 text-left hover:bg-muted/50 ${selected?.id === r.id ? 'bg-blue-50 dark:bg-blue-500/15' : ''}`}
                  >
                    <span className="block truncate text-sm font-medium text-foreground/85">{r.title}</span>
                    <span className="block text-xs text-muted-foreground/75">
                      {new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      {(r.createdByName || r.createdBy) ? ` · ${r.createdByName || r.createdBy.split('@')[0]}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-3 py-2" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-300" aria-hidden="true" />
            <span className="text-xs text-red-700 dark:text-red-200">{error}</span>
          </div>
        )}
      </div>

      {/* ---- right: report view ---- */}
      <div className="min-w-0">
        {loadingReport ? (
          <div className="flex min-h-[24rem] items-center justify-center rounded-lg border border-border bg-card">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600 dark:text-blue-300" />
          </div>
        ) : selected ? (
          <ReportView
            report={selected}
            onDelete={() => remove(selected.id)}
            onRename={async (title) => {
              const res = await analyticsAPI.renameReport(selected.id, title);
              setSelected((prev) => (prev ? { ...prev, title: res?.data?.title ?? title } : prev));
              load();
            }}
          />
        ) : (
          <div className="flex min-h-[24rem] flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card text-muted-foreground/75">
            <FileText className="h-8 w-8" aria-hidden="true" />
            <p className="text-sm">Pick a saved report or generate a new one.</p>
          </div>
        )}
      </div>

      {builderOpen && (
        <ReportBuilder
          meta={meta}
          templates={TEMPLATES}
          generating={generating}
          onGenerate={generate}
          onClose={() => setBuilderOpen(false)}
        />
      )}
    </div>
  );
}

function Delta({ pct }) {
  if (pct === null || pct === undefined) return <span className="text-xs text-muted-foreground/75">no prior period</span>;
  const up = pct > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${up ? 'text-red-600 dark:text-red-300' : 'text-emerald-600 dark:text-emerald-300'}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />{up ? '+' : ''}{pct}% vs prior period
    </span>
  );
}

function BreakdownList({ title, rows }) {
  if (!rows?.length) return null;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">{title}</p>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center gap-2 text-xs">
            <span className="w-44 truncate text-muted-foreground" title={r.name}>{r.name}</span>
            <span className="h-2 rounded-full bg-blue-200 dark:bg-blue-500/30" style={{ width: `${Math.max(4, Math.round((r.count / max) * 100))}%` }} aria-hidden="true" />
            <span className="tabular-nums font-semibold text-foreground/85">{r.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SAMPLES_PER_PAGE = 15;

function ReportView({ report, onDelete, onRename = null }) {
  // Dark mode (DM8): token-resolved chart colours as React state — recharts
  // takes plain colour strings, so re-reading on theme change re-renders it.
  const chartColors = useChartColors();
  const d = report.dataset || {};
  const n = report.narrative;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(report.title);
  const [savingName, setSavingName] = useState(false);
  useEffect(() => { setRenaming(false); setNameDraft(report.title); }, [report.id, report.title]);
  const saveName = async () => {
    const next = nameDraft.trim();
    if (!next || next === report.title) { setRenaming(false); setNameDraft(report.title); return; }
    setSavingName(true);
    try { await onRename?.(next); setRenaming(false); } catch { /* error shows via list reload */ }
    setSavingName(false);
  };
  const [samplePage, setSamplePage] = useState(1);
  useEffect(() => { setSamplePage(1); }, [report.id]);
  const samples = d.samples || [];
  const pageCount = Math.max(1, Math.ceil(samples.length / SAMPLES_PER_PAGE));
  const pageRows = samples.slice((samplePage - 1) * SAMPLES_PER_PAGE, samplePage * SAMPLES_PER_PAGE);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2 print:hidden">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex items-center gap-1.5">
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setRenaming(false); setNameDraft(report.title); } }}
                autoFocus
                maxLength={200}
                aria-label="Report name"
                className="tp-focus-ring w-full max-w-md rounded-lg border border-blue-300 dark:border-blue-500/40 px-2 py-1 text-lg font-bold text-foreground"
              />
              <button onClick={saveName} disabled={savingName} className="tp-focus-ring rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : 'Save'}
              </button>
            </div>
          ) : (
            <h2 className="group flex items-center gap-1.5 text-lg font-bold text-foreground">
              <span className="truncate">{report.title}</span>
              {onRename && (
                <button
                  onClick={() => setRenaming(true)}
                  aria-label="Rename report"
                  title="Rename"
                  className="tp-focus-ring rounded p-1 text-muted-foreground/50 hover:text-blue-600 dark:hover:text-blue-300 group-hover:text-muted-foreground/75"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </h2>
          )}
          <p className="text-xs text-muted-foreground/75">
            {report.scope?.workspaceName && (
              <span className="mr-1.5 inline-flex items-center rounded-full border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700 dark:text-blue-200">
                {report.scope.workspaceName}
              </span>
            )}
            {d.window?.completeDays ? (
              <>
                {new Date(report.rangeStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                {' – '}
                {new Date(new Date(report.rangeEnd).getTime() - 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                {` · ${d.rangeDays} complete day${d.rangeDays === 1 ? '' : 's'} (${d.window.timezone})`}
              </>
            ) : (
              <>
                {new Date(report.rangeStart).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {' → '}
                {new Date(report.rangeEnd).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {' · rolling window'}
              </>
            )}
            {' · '}generated {new Date(report.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {(report.createdByName || report.createdBy) ? ` by ${report.createdByName || report.createdBy}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => window.print()} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-blue-300 dark:hover:border-blue-500/40">
            <Printer className="h-3.5 w-3.5" aria-hidden="true" /> Print / PDF
          </button>
          <button
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
            className={`tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${confirmDelete ? 'border-red-600 bg-red-600 text-white' : 'border-border bg-card text-muted-foreground hover:border-red-300 dark:hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-300'}`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {confirmDelete ? 'Confirm delete' : 'Delete'}
          </button>
        </div>
      </div>

      {/* KPI row — each tile carries a glossary hint (QA 08-17 #5); the ⓘ is
          print-hidden so exported PDFs stay clean. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">
            Created <MetricHint metric="reportCreated" />
          </p>
          <p className="text-2xl font-bold tabular-nums text-foreground">{d.totals?.created ?? '—'}</p>
          <Delta pct={d.totals?.deltaPct} />
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">
            Prior period <MetricHint metric="reportPriorPeriod" />
          </p>
          <p className="text-2xl font-bold tabular-nums text-foreground">{d.totals?.previousPeriod ?? '—'}</p>
          <span className="text-xs text-muted-foreground/75">same length, immediately before</span>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">
            Resolved in window <MetricHint metric="reportResolvedInWindow" />
          </p>
          <p className="text-2xl font-bold tabular-nums text-foreground">{d.totals?.resolvedInWindow ?? '—'}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">
            Avg resolution <MetricHint metric="reportAvgResolution" />
          </p>
          <p className="text-2xl font-bold tabular-nums text-foreground">{d.totals?.avgResolutionHours != null ? `${d.totals.avgResolutionHours}h` : '—'}</p>
          <span className="text-xs text-muted-foreground/75">of tickets created + resolved in window</span>
        </div>
      </div>

      {/* trend */}
      {d.byDay?.length > 1 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">Daily volume</p>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.byDay} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: chartColors.axis }} tickFormatter={(v) => v.slice(5)} />
                <YAxis tick={{ fontSize: 10, fill: chartColors.axis }} allowDecimals={false} />
                <Tooltip cursor={{ fill: chartColors.cursor }} contentStyle={{ fontSize: 12, borderRadius: 8, backgroundColor: chartColors.tooltipBg, border: `1px solid ${chartColors.tooltipBorder}`, color: chartColors.text }} labelStyle={{ color: chartColors.text }} itemStyle={{ color: chartColors.text }} />
                <Bar dataKey="count" fill={chartColors.series.blueDeep} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* AI narrative — explicitly labeled; written in the background */}
      {!n && d.narrativeStatus === 'pending' && (Date.now() - new Date(report.createdAt).getTime() < 3 * 60 * 1000) && (
        <div className="flex items-center gap-2.5 rounded-lg border border-violet-200 dark:border-violet-500/30 bg-violet-50/50 dark:bg-violet-500/10 p-4 text-sm text-violet-700 dark:text-violet-200">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          The AI narrative is being written from the dataset — it will appear here in a few seconds.
        </div>
      )}
      {!n && (d.narrativeStatus === 'failed' || (d.narrativeStatus === 'pending' && Date.now() - new Date(report.createdAt).getTime() >= 3 * 60 * 1000)) && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 p-3 text-xs text-amber-800 dark:text-amber-200">
          The AI narrative couldn&apos;t be generated for this snapshot — the numbers above are complete; regenerate the report to retry the brief.
        </div>
      )}
      {n && (
        <div className="rounded-lg border border-violet-200 dark:border-violet-500/30 bg-violet-50/50 dark:bg-violet-500/10 p-4">
          <p className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-violet-100 dark:bg-violet-500/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-violet-700 dark:text-violet-200">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> AI narrative — written from the dataset above
          </p>
          <p className="text-sm leading-relaxed text-foreground/85">{n.executiveSummary}</p>
          {n.keyFindings?.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-violet-500">Key findings</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-foreground/85">{n.keyFindings.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </>
          )}
          {n.clusters?.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-violet-500">What these were (clusters from subjects)</p>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                {n.clusters.map((c, i) => (
                  <div key={i} className="rounded-lg border border-violet-100 dark:border-violet-500/20 bg-card p-2.5">
                    <p className="text-sm font-semibold text-foreground">{c.label}{c.approxShare ? <span className="ml-1 text-xs font-medium text-violet-500">{c.approxShare}</span> : null}</p>
                    <p className="text-xs text-muted-foreground">{c.description}</p>
                  </div>
                ))}
              </div>
            </>
          )}
          {n.trendCommentary && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-violet-500">Trend</p>
              <p className="text-sm text-foreground/85">{n.trendCommentary}</p>
            </>
          )}
          {n.discussionPoints?.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-violet-500">For the meeting</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-foreground/85">{n.discussionPoints.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </>
          )}
          {n.recommendations?.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-violet-500">Recommendations</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-foreground/85">{n.recommendations.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </>
          )}
        </div>
      )}

      {/* breakdowns */}
      <div className="grid gap-3 sm:grid-cols-2">
        <BreakdownList title="By category" rows={d.byCategory} />
        <BreakdownList title="By subcategory" rows={(d.bySubcategory || []).length === 1 && d.bySubcategory[0].name === '(no subcategory)' ? null : d.bySubcategory} />
        <BreakdownList title="By requester domain" rows={d.byRequesterDomain} />
        <BreakdownList title="Top requesters" rows={d.topRequesters} />
        <BreakdownList title="By status" rows={d.byStatus} />
        <BreakdownList title="By priority" rows={d.byPriority} />
      </div>

      {/* samples — full in-scope list, paginated; refs open the ticket page */}
      {samples.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <p className="border-b border-border/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">
            Tickets in scope ({samples.length})
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-border/60">
                {pageRows.map((s) => (
                  <tr key={s.id || s.ref} className="hover:bg-muted/50">
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono">
                      {s.id ? (
                        <a href={`/tickets/${s.id}`} target="_blank" rel="noopener noreferrer" className="tp-focus-ring rounded text-blue-600 dark:text-blue-300 hover:underline">{s.ref}</a>
                      ) : (
                        <span className="text-muted-foreground/75">{s.ref}</span>
                      )}
                    </td>
                    <td className="max-w-[26rem] truncate px-3 py-1.5">
                      {s.id ? (
                        <a href={`/tickets/${s.id}`} target="_blank" rel="noopener noreferrer" className="tp-focus-ring rounded text-foreground/85 hover:text-blue-700 dark:hover:text-blue-200 hover:underline">{s.subject}</a>
                      ) : (
                        <span className="text-foreground/85">{s.subject}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground/75">{s.status}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground/75">{new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 text-xs text-muted-foreground print:hidden">
              <span>{(samplePage - 1) * SAMPLES_PER_PAGE + 1}–{Math.min(samplePage * SAMPLES_PER_PAGE, samples.length)} of {samples.length}</span>
              <div className="flex gap-1.5">
                <button
                  onClick={() => setSamplePage((p) => Math.max(1, p - 1))}
                  disabled={samplePage <= 1}
                  className="tp-focus-ring rounded-lg border border-border px-2.5 py-1 font-medium hover:border-blue-300 dark:hover:border-blue-500/40 disabled:opacity-40"
                >
                  Prev
                </button>
                <span className="px-1 py-1 tabular-nums">page {samplePage} / {pageCount}</span>
                <button
                  onClick={() => setSamplePage((p) => Math.min(pageCount, p + 1))}
                  disabled={samplePage >= pageCount}
                  className="tp-focus-ring rounded-lg border border-border px-2.5 py-1 font-medium hover:border-blue-300 dark:hover:border-blue-500/40 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {d.truncated && <p className="text-xs italic text-muted-foreground/75">{d.truncated}</p>}
    </div>
  );
}

function ReportBuilder({ meta, templates, generating, onGenerate, onClose }) {
  const [customTitle, setCustomTitle] = useState('');
  const [kind, setKind] = useState('all');
  const [taxPick, setTaxPick] = useState(''); // 'category:ID' | 'subcategory:ID'
  const [tagId, setTagId] = useState('');
  const [rangeDays, setRangeDays] = useState(7);

  const cats = meta?.categoryTree || [];
  // One hierarchical picker serves both taxonomy styles: IT picks a whole
  // category or drills to a subcategory; Accounting's flat tree just lists
  // its top-level categories.
  const hasSubs = cats.some((c) => (c.subcategories || []).length > 0);

  const customPayload = () => {
    if (kind === 'taxonomy') {
      if (!taxPick) return null;
      const [k, id] = taxPick.split(':');
      return { scope: { kind: k, id: Number(id) }, rangeDays: Number(rangeDays) };
    }
    if (kind === 'tag') {
      if (!tagId) return null;
      return { scope: { kind: 'tag', id: Number(tagId) }, rangeDays: Number(rangeDays) };
    }
    return { scope: { kind }, rangeDays: Number(rangeDays) };
  };
  const withTitle = (payload) => (customTitle.trim() ? { ...payload, title: customTitle.trim() } : payload);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] print:hidden" role="dialog" aria-modal="true" aria-label="New report" onClick={generating ? undefined : onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-foreground">New report</h3>
          <button onClick={onClose} disabled={generating} aria-label="Close" className="tp-focus-ring rounded p-1 text-muted-foreground/75 hover:text-muted-foreground"><X className="h-4 w-4" /></button>
        </div>

        <input
          value={customTitle}
          onChange={(e) => setCustomTitle(e.target.value)}
          maxLength={200}
          placeholder="Report name (optional — e.g. “Phishing wave review, Jul 14 meeting”)"
          aria-label="Report name"
          className="tp-focus-ring mb-3 w-full rounded-lg border border-border px-3 py-2 text-sm"
        />
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">Templates</p>
        <div className="space-y-1.5">
          {templates.map((t) => (
            <button
              key={t.label}
              onClick={() => onGenerate(withTitle(t.payload))}
              disabled={generating}
              className="tp-focus-ring block w-full rounded-lg border border-border px-3 py-2 text-left hover:border-blue-300 dark:hover:border-blue-500/40 hover:bg-blue-50/40 dark:hover:bg-blue-500/10 disabled:opacity-50"
            >
              <span className="block text-sm font-semibold text-foreground/85">{t.label}</span>
              <span className="block text-xs text-muted-foreground/75">{t.hint}</span>
            </button>
          ))}
        </div>

        <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">Custom</p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Report scope" className="tp-focus-ring rounded-lg border border-border px-2 py-1.5">
            <option value="all">All tickets</option>
            <option value="noise">Noise & spam</option>
            <option value="taxonomy">{hasSubs ? 'A category / subcategory' : 'A category'}</option>
            <option value="tag">A tag</option>
          </select>
          {kind === 'taxonomy' && (
            <select value={taxPick} onChange={(e) => setTaxPick(e.target.value)} aria-label="Category or subcategory" className="tp-focus-ring max-w-[17rem] rounded-lg border border-border px-2 py-1.5">
              <option value="">Pick…</option>
              {cats.map((c) => (
                (c.subcategories || []).length > 0 ? (
                  <optgroup key={c.id} label={c.name}>
                    <option value={`category:${c.id}`}>{c.name} — whole category</option>
                    {c.subcategories.map((sub) => (
                      <option key={sub.id} value={`subcategory:${sub.id}`}>&nbsp;&nbsp;{sub.name}</option>
                    ))}
                  </optgroup>
                ) : (
                  <option key={c.id} value={`category:${c.id}`}>{c.name}</option>
                )
              ))}
            </select>
          )}
          {kind === 'tag' && (
            <select value={tagId} onChange={(e) => setTagId(e.target.value)} aria-label="Tag" className="tp-focus-ring max-w-[15rem] rounded-lg border border-border px-2 py-1.5">
              <option value="">Pick…</option>
              {(meta?.tags || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <select value={rangeDays} onChange={(e) => setRangeDays(e.target.value)} aria-label="Range" className="tp-focus-ring rounded-lg border border-border px-2 py-1.5">
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
          </select>
          <button
            onClick={() => { const p = customPayload(); if (p) onGenerate(withTitle(p)); }}
            disabled={generating || !customPayload()}
            className="tp-focus-ring ml-auto inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {generating && <p className="mt-3 text-xs text-muted-foreground/75">Crunching the numbers and writing the brief — usually 10–20 seconds…</p>}
      </div>
    </div>
  );
}
