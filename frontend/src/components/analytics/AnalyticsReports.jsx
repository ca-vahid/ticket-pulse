import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, FileText, Loader2, Pencil, Plus, Printer, Sparkles, Trash2, TrendingDown, TrendingUp, X,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { analyticsAPI, ticketsAPI } from '../../services/api';

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

  const openReport = async (id) => {
    setLoadingReport(true);
    try {
      const res = await analyticsAPI.getReport(id);
      setSelected(res?.data || null);
      onReportSelected?.(res?.data?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    }
    setLoadingReport(false);
  };

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
    for (const cat of meta?.categoryTree || []) {
      for (const sub of cat.subcategories || cat.children || []) {
        if (/phishing/i.test(sub.name || '')) return sub;
      }
    }
    return null;
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
        <div className="rounded-lg border border-slate-200 bg-white">
          <p className="border-b border-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Saved reports</p>
          {reports === null ? (
            <p className="flex items-center gap-2 px-3 py-3 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          ) : reports.length === 0 ? (
            <p className="px-3 py-4 text-sm italic text-slate-400">No reports yet — generate your first for this week’s meeting.</p>
          ) : (
            <ul className="max-h-[26rem] divide-y divide-slate-100 overflow-y-auto settings-scrollbar">
              {reports.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => openReport(r.id)}
                    className={`tp-focus-ring block w-full px-3 py-2 text-left hover:bg-slate-50 ${selected?.id === r.id ? 'bg-blue-50' : ''}`}
                  >
                    <span className="block truncate text-sm font-medium text-slate-700">{r.title}</span>
                    <span className="block text-xs text-slate-400">
                      {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      {r.createdBy ? ` · ${r.createdBy.split('@')[0]}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" aria-hidden="true" />
            <span className="text-xs text-red-700">{error}</span>
          </div>
        )}
      </div>

      {/* ---- right: report view ---- */}
      <div className="min-w-0">
        {loadingReport ? (
          <div className="flex min-h-[24rem] items-center justify-center rounded-lg border border-slate-200 bg-white">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
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
          <div className="flex min-h-[24rem] flex-col items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white text-slate-400">
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
  if (pct === null || pct === undefined) return <span className="text-xs text-slate-400">no prior period</span>;
  const up = pct > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${up ? 'text-red-600' : 'text-emerald-600'}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />{up ? '+' : ''}{pct}% vs prior period
    </span>
  );
}

function BreakdownList({ title, rows }) {
  if (!rows?.length) return null;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center gap-2 text-xs">
            <span className="w-44 truncate text-slate-600" title={r.name}>{r.name}</span>
            <span className="h-2 rounded-full bg-blue-200" style={{ width: `${Math.max(4, Math.round((r.count / max) * 100))}%` }} aria-hidden="true" />
            <span className="tabular-nums font-semibold text-slate-700">{r.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SAMPLES_PER_PAGE = 15;

function ReportView({ report, onDelete, onRename = null }) {
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
                className="tp-focus-ring w-full max-w-md rounded-lg border border-blue-300 px-2 py-1 text-lg font-bold text-slate-900"
              />
              <button onClick={saveName} disabled={savingName} className="tp-focus-ring rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : 'Save'}
              </button>
            </div>
          ) : (
            <h2 className="group flex items-center gap-1.5 text-lg font-bold text-slate-900">
              <span className="truncate">{report.title}</span>
              {onRename && (
                <button
                  onClick={() => setRenaming(true)}
                  aria-label="Rename report"
                  title="Rename"
                  className="tp-focus-ring rounded p-1 text-slate-300 hover:text-blue-600 group-hover:text-slate-400"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </h2>
          )}
          <p className="text-xs text-slate-400">
            {new Date(report.rangeStart).toLocaleDateString()} → {new Date(report.rangeEnd).toLocaleDateString()}
            {' · '}generated {new Date(report.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {report.createdBy ? ` by ${report.createdBy}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => window.print()} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-blue-300">
            <Printer className="h-3.5 w-3.5" aria-hidden="true" /> Print / PDF
          </button>
          <button
            onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
            className={`tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${confirmDelete ? 'border-red-600 bg-red-600 text-white' : 'border-slate-200 bg-white text-slate-500 hover:border-red-300 hover:text-red-600'}`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {confirmDelete ? 'Confirm delete' : 'Delete'}
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Created</p>
          <p className="text-2xl font-bold tabular-nums text-slate-900">{d.totals?.created ?? '—'}</p>
          <Delta pct={d.totals?.deltaPct} />
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Prior period</p>
          <p className="text-2xl font-bold tabular-nums text-slate-900">{d.totals?.previousPeriod ?? '—'}</p>
          <span className="text-xs text-slate-400">same length, immediately before</span>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Resolved in window</p>
          <p className="text-2xl font-bold tabular-nums text-slate-900">{d.totals?.resolvedInWindow ?? '—'}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Avg resolution</p>
          <p className="text-2xl font-bold tabular-nums text-slate-900">{d.totals?.avgResolutionHours != null ? `${d.totals.avgResolutionHours}h` : '—'}</p>
          <span className="text-xs text-slate-400">of tickets created + resolved in window</span>
        </div>
      </div>

      {/* trend */}
      {d.byDay?.length > 1 && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Daily volume</p>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.byDay} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={(v) => v.slice(5)} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} allowDecimals={false} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} />
                <Bar dataKey="count" fill="#3b82f6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* AI narrative — explicitly labeled */}
      {n && (
        <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-4">
          <p className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-violet-700">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> AI narrative — written from the dataset above
          </p>
          <p className="text-sm leading-relaxed text-slate-700">{n.executiveSummary}</p>
          {n.keyFindings?.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-violet-500">Key findings</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">{n.keyFindings.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </>
          )}
          {n.clusters?.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-violet-500">What these were (clusters from subjects)</p>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                {n.clusters.map((c, i) => (
                  <div key={i} className="rounded-lg border border-violet-100 bg-white p-2.5">
                    <p className="text-sm font-semibold text-slate-800">{c.label}{c.approxShare ? <span className="ml-1 text-xs font-medium text-violet-500">{c.approxShare}</span> : null}</p>
                    <p className="text-xs text-slate-500">{c.description}</p>
                  </div>
                ))}
              </div>
            </>
          )}
          {n.trendCommentary && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-violet-500">Trend</p>
              <p className="text-sm text-slate-700">{n.trendCommentary}</p>
            </>
          )}
          {n.discussionPoints?.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-violet-500">For the meeting</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">{n.discussionPoints.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </>
          )}
          {n.recommendations?.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-violet-500">Recommendations</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">{n.recommendations.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </>
          )}
        </div>
      )}

      {/* breakdowns */}
      <div className="grid gap-3 sm:grid-cols-2">
        <BreakdownList title="By category" rows={d.byCategory} />
        <BreakdownList title="By subcategory" rows={d.bySubcategory} />
        <BreakdownList title="By requester domain" rows={d.byRequesterDomain} />
        <BreakdownList title="Top requesters" rows={d.topRequesters} />
        <BreakdownList title="By status" rows={d.byStatus} />
        <BreakdownList title="By priority" rows={d.byPriority} />
      </div>

      {/* samples — full in-scope list, paginated; refs open the ticket page */}
      {samples.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <p className="border-b border-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Tickets in scope ({samples.length})
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-slate-100">
                {pageRows.map((s) => (
                  <tr key={s.id || s.ref} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono">
                      {s.id ? (
                        <a href={`/tickets/${s.id}`} target="_blank" rel="noopener noreferrer" className="tp-focus-ring rounded text-blue-600 hover:underline">{s.ref}</a>
                      ) : (
                        <span className="text-slate-400">{s.ref}</span>
                      )}
                    </td>
                    <td className="max-w-[26rem] truncate px-3 py-1.5">
                      {s.id ? (
                        <a href={`/tickets/${s.id}`} target="_blank" rel="noopener noreferrer" className="tp-focus-ring rounded text-slate-700 hover:text-blue-700 hover:underline">{s.subject}</a>
                      ) : (
                        <span className="text-slate-700">{s.subject}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-400">{s.status}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-400">{new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-500 print:hidden">
              <span>{(samplePage - 1) * SAMPLES_PER_PAGE + 1}–{Math.min(samplePage * SAMPLES_PER_PAGE, samples.length)} of {samples.length}</span>
              <div className="flex gap-1.5">
                <button
                  onClick={() => setSamplePage((p) => Math.max(1, p - 1))}
                  disabled={samplePage <= 1}
                  className="tp-focus-ring rounded-lg border border-slate-200 px-2.5 py-1 font-medium hover:border-blue-300 disabled:opacity-40"
                >
                  Prev
                </button>
                <span className="px-1 py-1 tabular-nums">page {samplePage} / {pageCount}</span>
                <button
                  onClick={() => setSamplePage((p) => Math.min(pageCount, p + 1))}
                  disabled={samplePage >= pageCount}
                  className="tp-focus-ring rounded-lg border border-slate-200 px-2.5 py-1 font-medium hover:border-blue-300 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {d.truncated && <p className="text-xs italic text-slate-400">{d.truncated}</p>}
    </div>
  );
}

function ReportBuilder({ meta, templates, generating, onGenerate, onClose }) {
  const [customTitle, setCustomTitle] = useState('');
  const [kind, setKind] = useState('all');
  const [catId, setCatId] = useState('');
  const [tagId, setTagId] = useState('');
  const [rangeDays, setRangeDays] = useState(7);

  const cats = meta?.categoryTree || [];
  const subs = cats.flatMap((c) => (c.subcategories || c.children || []).map((s) => ({ ...s, parentName: c.name })));

  const customPayload = () => {
    if (kind === 'category' || kind === 'subcategory') {
      if (!catId) return null;
      return { scope: { kind, id: Number(catId) }, rangeDays: Number(rangeDays) };
    }
    if (kind === 'tag') {
      if (!tagId) return null;
      return { scope: { kind, id: Number(tagId) }, rangeDays: Number(rangeDays) };
    }
    return { scope: { kind }, rangeDays: Number(rangeDays) };
  };
  const withTitle = (payload) => (customTitle.trim() ? { ...payload, title: customTitle.trim() } : payload);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px] print:hidden" role="dialog" aria-modal="true" aria-label="New report" onClick={generating ? undefined : onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">New report</h3>
          <button onClick={onClose} disabled={generating} aria-label="Close" className="tp-focus-ring rounded p-1 text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>

        <input
          value={customTitle}
          onChange={(e) => setCustomTitle(e.target.value)}
          maxLength={200}
          placeholder="Report name (optional — e.g. “Phishing wave review, Jul 14 meeting”)"
          aria-label="Report name"
          className="tp-focus-ring mb-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Templates</p>
        <div className="space-y-1.5">
          {templates.map((t) => (
            <button
              key={t.label}
              onClick={() => onGenerate(withTitle(t.payload))}
              disabled={generating}
              className="tp-focus-ring block w-full rounded-lg border border-slate-200 px-3 py-2 text-left hover:border-blue-300 hover:bg-blue-50/40 disabled:opacity-50"
            >
              <span className="block text-sm font-semibold text-slate-700">{t.label}</span>
              <span className="block text-xs text-slate-400">{t.hint}</span>
            </button>
          ))}
        </div>

        <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Custom</p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Report scope" className="tp-focus-ring rounded-lg border border-slate-200 px-2 py-1.5">
            <option value="all">All tickets</option>
            <option value="noise">Noise & spam</option>
            <option value="category">A category</option>
            <option value="subcategory">A subcategory</option>
            <option value="tag">A tag</option>
          </select>
          {kind === 'category' && (
            <select value={catId} onChange={(e) => setCatId(e.target.value)} aria-label="Category" className="tp-focus-ring max-w-[15rem] rounded-lg border border-slate-200 px-2 py-1.5">
              <option value="">Pick…</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {kind === 'subcategory' && (
            <select value={catId} onChange={(e) => setCatId(e.target.value)} aria-label="Subcategory" className="tp-focus-ring max-w-[15rem] rounded-lg border border-slate-200 px-2 py-1.5">
              <option value="">Pick…</option>
              {subs.map((s) => <option key={s.id} value={s.id}>{s.parentName} › {s.name}</option>)}
            </select>
          )}
          {kind === 'tag' && (
            <select value={tagId} onChange={(e) => setTagId(e.target.value)} aria-label="Tag" className="tp-focus-ring max-w-[15rem] rounded-lg border border-slate-200 px-2 py-1.5">
              <option value="">Pick…</option>
              {(meta?.tags || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <select value={rangeDays} onChange={(e) => setRangeDays(e.target.value)} aria-label="Range" className="tp-focus-ring rounded-lg border border-slate-200 px-2 py-1.5">
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
        {generating && <p className="mt-3 text-xs text-slate-400">Crunching the numbers and writing the brief — usually 10–20 seconds…</p>}
      </div>
    </div>
  );
}
