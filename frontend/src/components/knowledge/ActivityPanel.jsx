import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ListChecks, Search, SlidersHorizontal, X } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { formatDayTime, timeAgo } from '../tickets/ticketUi';
import { EmptyState, Loading } from './knowledgeUi';
import { isNotThisPlaybook } from './knowledgeFormat';
import PlaybookMetrics from './PlaybookMetrics';
import { BAND_LABELS } from './answeringFormat';
import { OUTCOMES, RANGE_OPTIONS, RunResult, VERDICT_WORD, rowReason, stayQuietOf } from './runParts';
import RunPage from './RunPage';
import { pageWords, rememberList } from './activityList';

/**
 * Knowledge → Activity. Two views:
 *   Runs (default)  one line of outcome counts that doubles as the result
 *                   filter, a filter row, then the runs a page at a time.
 *                   A run opens on its own page (RunPage), like a ticket.
 *   By playbook     one compact row per playbook (PlaybookMetrics).
 * Every filter and the page live in the URL, so Back from a run, F5 and a
 * shared link land on the same list (12 Oct 2026).
 *
 * One bar, not four rows (13 Oct 2026): the view switch (Answers, By
 * playbook, the two waiting lists) belongs to the page (Knowledge.jsx); this
 * panel puts the search and ONE "Filters" button at the right end of that
 * same row (toolsNode), and the filters in use read as words on the counts
 * line, each with its own remove.
 */

const PAGE_SIZES = [25, 50, 100].map((n) => ({ value: String(n), label: `${n} a page` }));
const BAND_OPTIONS = [
  { value: '', label: 'Any sureness' },
  { value: 'high', label: BAND_LABELS.high },
  { value: 'medium', label: BAND_LABELS.medium },
  { value: 'low', label: BAND_LABELS.low },
];
const REVIEW_OPTIONS = [
  { value: '', label: 'Judged or not' },
  { value: 'needs', label: 'To review' },
  { value: 'done', label: 'Reviewed' },
];
const TRIGGER_OPTIONS = [
  { value: '', label: 'Live and tests' },
  { value: 'live', label: 'Live tickets only' },
  { value: 'test', label: 'Tests only' },
];
const BAND_TONE = {
  high: 'bg-emerald-500',
  medium: 'bg-amber-500',
  low: 'bg-muted-foreground/50',
};

/** How sure, as a dot and a word (never a pill). */
function Band({ band }) {
  if (!band) return <span className="text-xs text-muted-foreground/60">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-foreground/85">
      <span className={`h-1.5 w-1.5 rounded-full ${BAND_TONE[band] || BAND_TONE.low}`} aria-hidden="true" />
      {BAND_LABELS[band] || band}
    </span>
  );
}

/** The outcome line: every result with its count; a click filters the list. */
function OutcomeLine({ counts, total, value, onChange }) {
  const shown = OUTCOMES.filter((o) => (counts?.[o.value] || 0) > 0 || o.value === value);
  const item = (key, label, n, active) => (
    <button
      key={key}
      type="button"
      onClick={() => onChange(active && key ? '' : key)}
      aria-pressed={active}
      className={`tp-focus-ring inline-flex items-baseline gap-1.5 rounded-md px-2 py-1 text-sm transition-colors ${
        active ? 'bg-primary/10 font-semibold text-primary' : 'text-foreground/85 hover:bg-muted'
      }`}
    >
      <span className="tabular-nums">{n}</span>{' '}
      <span className={active ? '' : 'text-muted-foreground'}>{label}</span>
    </button>
  );
  return (
    <nav aria-label="Filter by result" className="flex flex-wrap items-center gap-x-1 gap-y-1" data-testid="outcome-line">
      {item('', 'All runs', total, value === '')}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      {shown.map((o) => item(o.value, o.label, counts?.[o.value] || 0, value === o.value))}
    </nav>
  );
}

/** "1–50 of 425", previous / next and the page size. */
function Pager({ offset, size, shown, total, onPage, onSize }) {
  const page = Math.floor(offset / size) + 1;
  const pages = Math.max(1, Math.ceil(total / size));
  const btn = 'tp-focus-ring inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-40 disabled:hover:bg-card';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1" data-testid="runs-pager">
      <p className="text-xs text-muted-foreground" role="status">{pageWords({ offset, shown, total })}</p>
      <div className="ml-auto flex items-center gap-2">
        <div className="w-32"><FancySelect value={String(size)} onChange={(v) => onSize(Number(v))} options={PAGE_SIZES} aria-label="Runs a page" className="h-8" /></div>
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
        </button>
        <span className="text-xs tabular-nums text-muted-foreground">Page {page} of {pages}</span>
        <button type="button" className={btn} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function RunsView({ filters, set, canReview, inUse = null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const { status, playbookId, range, q, categoryId, band, review, trigger, page, size } = filters;
  const offset = (page - 1) * size;

  useEffect(() => {
    let cancelled = false;
    const from = range ? new Date(Date.now() - Number(range) * 86400e3).toISOString() : undefined;
    knowledgeAPI.listRuns({
      status: status || undefined, playbookId: playbookId || undefined, from,
      q: q || undefined, categoryId: categoryId || undefined, band: band || undefined,
      review: review || undefined, trigger: trigger || undefined, limit: size, offset,
    })
      .then((res) => { if (!cancelled) { setData(res?.data || { items: [], total: 0 }); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load activity'); });
    return () => { cancelled = true; };
  }, [status, playbookId, range, q, categoryId, band, review, trigger, size, offset]);

  const counts = data?.statusCounts || null;
  const allTotal = counts ? Object.values(counts).reduce((s, n) => s + n, 0) : (data?.total || 0);
  const needs = Number(data?.needsReview) || 0;
  const open = (id) => {
    // The run page reads this for "Back", Previous and Next.
    rememberList({ ids: (data?.items || []).map((r) => r.id), search: location.search, offset, total: data?.total || 0 });
    navigate(`/knowledge/activity/${id}`);
  };
  const filtered = Boolean(status || q || categoryId || band || review || trigger);

  return (
    <div className="space-y-3" data-testid="runs-view">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {counts && <OutcomeLine counts={counts} total={allTotal} value={status} onChange={(v) => set({ status: v })} />}
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {inUse}
          {canReview && needs > 0 && review !== 'needs' && (
            <button
              type="button"
              onClick={() => set({ review: 'needs', status: '' })}
              className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-foreground hover:bg-muted"
              data-testid="to-review"
            >
              <span className="tabular-nums text-primary">{needs}</span> to review
            </button>
          )}
        </div>
      </div>
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {!data && !error ? <Loading label="Loading activity…" /> : data && data.items.length === 0 ? (
        <div className="tp-card">
          <EmptyState icon={ListChecks} title={filtered ? 'No runs match these filters' : 'No runs yet'}>
            {filtered
              ? 'Clear a filter above to see more.'
              : 'Runs appear here when a new ticket comes in, or when someone tests a rule on a ticket.'}
          </EmptyState>
        </div>
      ) : data && (
        <div className="tp-card overflow-hidden">
          <table className="w-full text-left text-sm" data-testid="runs-table">
            <thead className="hidden border-b border-border/70 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:table-header-group">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">When</th>
                <th scope="col" className="px-2 py-2 font-medium">Ticket</th>
                <th scope="col" className="px-2 py-2 font-medium">Result</th>
                <th scope="col" className="px-2 py-2 font-medium">How sure</th>
                <th scope="col" className="px-2 py-2 font-medium">Why</th>
                <th scope="col" className="px-4 py-2 font-medium">Review</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {data.items.map((r) => {
                const where = [r.requesterName, r.subcategoryName || r.categoryName, r.playbookName || (r.playbookId ? `Removed playbook #${r.playbookId}` : null)].filter(Boolean);
                const reviewable = ['drafted', 'staged', 'sent'].includes(r.status) && r.trigger !== 'test' && r.trigger !== 'backtest';
                return (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    onClick={() => open(r.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(r.id); } }}
                    className="tp-focus-ring cursor-pointer align-top transition-colors hover:bg-muted/40 max-sm:flex max-sm:flex-wrap max-sm:gap-x-3 max-sm:gap-y-1 max-sm:px-4 max-sm:py-3"
                    aria-label={`Run on ${r.ticketRef}`}
                  >
                    <td className="whitespace-nowrap text-xs text-muted-foreground sm:px-4 sm:py-3" title={formatDayTime(r.createdAt)}>
                      {timeAgo(r.createdAt)}{r.trigger === 'test' ? ' · test' : r.trigger === 'backtest' ? ' · backtest' : ''}
                    </td>
                    <td className="min-w-0 max-w-[22rem] max-sm:w-full sm:px-2 sm:py-3">
                      <p className="truncate text-foreground"><span className="text-muted-foreground">{r.ticketRef}</span> {r.ticketSubject}</p>
                      {where.length > 0 && <p className="mt-0.5 truncate text-xs text-muted-foreground">{where.join(' · ')}</p>}
                    </td>
                    <td className="sm:px-2 sm:py-3"><RunResult run={r} /></td>
                    <td className="sm:px-2 sm:py-3"><Band band={r.confidenceBand} /></td>
                    <td className="max-w-[26rem] text-xs text-muted-foreground max-sm:w-full sm:px-2 sm:py-3">
                      <span className="line-clamp-2" data-testid={stayQuietOf(r) ? 'row-stayed-quiet' : isNotThisPlaybook(r) ? 'row-not-this-playbook' : undefined}>
                        {rowReason(r)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-xs sm:px-4 sm:py-3">
                      {r.reviewVerdict
                        ? <span className="text-foreground/85">reviewed: {VERDICT_WORD[r.reviewVerdict] || r.reviewVerdict}</span>
                        : reviewable ? <span className="text-primary">To review</span> : <span className="text-muted-foreground/60">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 && (
        <Pager
          offset={offset}
          size={size}
          shown={data.items.length}
          total={data.total}
          onPage={(p) => set({ page: p > 1 ? p : '' }, { keepPage: true })}
          onSize={(n) => set({ size: n === 50 ? '' : n })}
        />
      )}
      {canReview && needs > 0 && (
        <p className="px-1 text-xs text-muted-foreground">Open a drafted run to review it. Reviews are what let a category move above Draft only.</p>
      )}
    </div>
  );
}

function PlaybooksView({ playbookId, range }) {
  const [summary, setSummary] = useState(null);
  const [autoModeAllowed, setAutoModeAllowed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const from = range ? new Date(Date.now() - Number(range) * 86400e3).toISOString() : undefined;
    Promise.resolve()
      .then(() => knowledgeAPI.runsSummary({ from }))
      .then((res) => { if (!cancelled) setSummary(res?.data || []); })
      .catch(() => { if (!cancelled) setSummary([]); });
    return () => { cancelled = true; };
  }, [range]);
  useEffect(() => {
    Promise.resolve()
      .then(() => knowledgeAPI.getSettings())
      .then((res) => setAutoModeAllowed(res?.data?.autoModeAllowed === true))
      .catch(() => {});
  }, []);
  if (summary === null) return <Loading label="Loading playbooks…" />;
  const items = playbookId ? summary.filter((p) => String(p.playbookId) === String(playbookId)) : summary;
  if (!items.length) {
    return (
      <div className="tp-card">
        <EmptyState icon={ListChecks} title="No playbook has run yet">Numbers appear once a playbook has drafted or declined at least one ticket.</EmptyState>
      </div>
    );
  }
  return <PlaybookMetrics items={items} autoModeAllowed={autoModeAllowed} />;
}

/** The search box: typed text reaches the URL after a short pause. */
function SearchBox({ value, onChange }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  useEffect(() => {
    if (text === value) return undefined;
    const t = setTimeout(() => onChange(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text, value, onChange]);
  return (
    <div className="relative w-full sm:w-60">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ticket number or subject"
        aria-label="Search runs by ticket number or subject"
        className="tp-focus-ring h-9 w-full rounded-lg border border-input bg-card pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground/75"
      />
    </div>
  );
}

/** One "Filters" button; the selects open under it and close on Escape or a click outside. */
function FiltersButton({ count, children }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      // A select's own list may render outside this box: keep the panel open for it.
      if (box.current?.contains(e.target) || e.target.closest?.('[role="listbox"],[role="option"]')) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="kh-activity-filters"
        onClick={() => setOpen((v) => !v)}
        className={`tp-focus-ring inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-sm font-medium transition-colors ${
          count ? 'border-primary/40 bg-primary/10 text-primary' : 'border-input bg-card text-foreground/85 hover:bg-muted'
        }`}
        data-testid="filters-button"
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
        Filters{count ? <span className="tabular-nums">{count}</span> : null}
      </button>
      {open && (
        <div
          id="kh-activity-filters"
          role="group"
          aria-label="Filters"
          className="absolute right-0 top-full z-30 mt-2 grid w-[min(34rem,calc(100vw-2rem))] grid-cols-1 gap-2 rounded-xl border border-border bg-card p-3 shadow-soft animate-fadeIn sm:grid-cols-2"
          data-testid="filters-panel"
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Knowledge → Activity: the runs or the per-playbook view; a run id opens the run page. */
export default function ActivityPanel({ runId = null, canReview = false, categories = [], toolsNode = null }) {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'playbooks' ? 'playbooks' : 'runs';
  const [playbooks, setPlaybooks] = useState([]);

  useEffect(() => {
    Promise.resolve().then(() => knowledgeAPI.listPlaybooks()).then((res) => setPlaybooks(res?.data || [])).catch(() => {});
  }, []);

  const filters = useMemo(() => ({
    status: params.get('result') || '',
    // ?playbook=<id> (the builder's "Runs in Activity") pre-filters the list.
    playbookId: params.get('playbook') || '',
    range: params.get('range') || '',
    q: params.get('q') || '',
    categoryId: params.get('category') || '',
    band: params.get('sure') || '',
    review: params.get('review') || '',
    trigger: params.get('from') || '',
    page: Math.max(1, Number(params.get('page')) || 1),
    size: [25, 50, 100].includes(Number(params.get('size'))) ? Number(params.get('size')) : 50,
  }), [params]);

  // One writer for the URL: any filter change goes back to page 1.
  const KEY = { status: 'result', playbookId: 'playbook', range: 'range', q: 'q', categoryId: 'category', band: 'sure', review: 'review', trigger: 'from', page: 'page', size: 'size', view: 'view' };
  const set = (patch, { keepPage = false } = {}) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      const key = KEY[k] || k;
      if (v === '' || v === null || v === undefined) next.delete(key); else next.set(key, String(v));
    }
    if (!keepPage) next.delete('page');
    setParams(next, { replace: true });
  };

  const playbookOptions = useMemo(() => [
    { value: '', label: 'Every rule' },
    ...playbooks.map((p) => ({ value: String(p.id), label: p.name })),
  ], [playbooks]);
  const categoryOptions = useMemo(() => [
    { value: '', label: 'Every category' },
    ...(categories || []).map((c) => ({ value: String(c.id), label: c.name })),
  ], [categories]);

  if (runId) return <RunPage runId={runId} canReview={canReview} />;

  const runs = view === 'runs';
  // The selects behind "Filters", and each one in use as words with its own remove.
  const FIELDS = [
    runs && categoryOptions.length > 1 ? { key: 'categoryId', label: 'Category', options: categoryOptions } : null,
    runs ? { key: 'band', label: 'How sure', options: BAND_OPTIONS } : null,
    runs ? { key: 'review', label: 'Review', options: REVIEW_OPTIONS } : null,
    runs ? { key: 'trigger', label: 'Live or test', options: TRIGGER_OPTIONS } : null,
    { key: 'playbookId', label: 'Playbook', options: playbookOptions },
    { key: 'range', label: 'When', options: RANGE_OPTIONS },
  ].filter(Boolean);
  const used = FIELDS
    .filter((f) => filters[f.key])
    .map((f) => ({ ...f, word: f.options.find((o) => String(o.value) === String(filters[f.key]))?.label || filters[f.key] }));
  const clear = () => setParams(runs ? {} : { view: 'playbooks' }, { replace: true });
  const anyFilter = used.length > 0 || Boolean(filters.q || filters.status);

  const tools = (
    <div className="flex w-full items-center gap-2 sm:w-auto" data-testid="activity-filters">
      {runs && <SearchBox value={filters.q} onChange={(v) => set({ q: v })} />}
      <FiltersButton count={used.length}>
        {FIELDS.map((f) => (
          <label key={f.key} className="block min-w-0">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{f.label}</span>
            <FancySelect value={filters[f.key]} onChange={(v) => set({ [f.key]: v })} options={f.options} aria-label={f.label} className="h-9" />
          </label>
        ))}
      </FiltersButton>
    </div>
  );
  const inUse = anyFilter ? (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="filters-in-use">
      {used.map((f) => (
        <button key={f.key} type="button" onClick={() => set({ [f.key]: '' })} className="tp-focus-ring inline-flex items-center gap-1 rounded text-foreground/85 hover:text-foreground" aria-label={`Remove the filter: ${f.word}`}>
          {f.word} <X className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        </button>
      ))}
      <button type="button" onClick={clear} className="tp-focus-ring rounded font-medium text-primary hover:underline" data-testid="clear-filters">Clear all</button>
    </p>
  ) : null;

  return (
    <div className="space-y-3">
      {toolsNode ? createPortal(tools, toolsNode) : <div className="flex justify-end">{tools}</div>}
      {runs
        ? <RunsView filters={filters} set={set} canReview={canReview} inUse={inUse} />
        : (
          <>
            {inUse && <div className="flex justify-end">{inUse}</div>}
            <PlaybooksView playbookId={filters.playbookId} range={filters.range} />
          </>
        )}
    </div>
  );
}
