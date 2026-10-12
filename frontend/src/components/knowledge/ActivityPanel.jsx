import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ListChecks, Search, X } from 'lucide-react';
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

function RunsView({ filters, set, canReview }) {
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
        {canReview && needs > 0 && review !== 'needs' && (
          <button
            type="button"
            onClick={() => set({ review: 'needs', status: '' })}
            className="tp-focus-ring ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
            data-testid="to-review"
          >
            <span className="tabular-nums text-primary">{needs}</span> to review
          </button>
        )}
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

const VIEWS = [
  { value: 'runs', label: 'Runs' },
  { value: 'playbooks', label: 'By playbook' },
];

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
    <div className="relative sm:w-64">
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

/** Knowledge → Activity: Runs / By playbook with shared filters; a run id opens the run page. */
export default function ActivityPanel({ runId = null, canReview = false, categories = [] }) {
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

  const anyFilter = Boolean(filters.q || filters.categoryId || filters.band || filters.review || filters.trigger || filters.playbookId || filters.range || filters.status);
  const clear = () => setParams(view === 'playbooks' ? { view: 'playbooks' } : {}, { replace: true });

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center" data-testid="activity-filters">
        <div role="tablist" aria-label="Activity view" className="inline-flex self-start rounded-lg border border-border bg-card p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="tab"
              aria-selected={view === v.value}
              onClick={() => set({ view: v.value === 'runs' ? '' : v.value })}
              className={`tp-focus-ring h-8 rounded-md px-3.5 text-sm font-medium transition-colors ${
                view === v.value ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view === 'runs' && <SearchBox value={filters.q} onChange={(v) => set({ q: v })} />}
        <div className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex sm:flex-wrap">
          {view === 'runs' && categoryOptions.length > 1 && (
            <div className="sm:w-48"><FancySelect value={filters.categoryId} onChange={(v) => set({ categoryId: v })} options={categoryOptions} aria-label="Category" className="h-9" /></div>
          )}
          {view === 'runs' && (
            <>
              <div className="sm:w-40"><FancySelect value={filters.band} onChange={(v) => set({ band: v })} options={BAND_OPTIONS} aria-label="How sure" className="h-9" /></div>
              <div className="sm:w-40"><FancySelect value={filters.review} onChange={(v) => set({ review: v })} options={REVIEW_OPTIONS} aria-label="Review" className="h-9" /></div>
              <div className="sm:w-44"><FancySelect value={filters.trigger} onChange={(v) => set({ trigger: v })} options={TRIGGER_OPTIONS} aria-label="Live or test" className="h-9" /></div>
            </>
          )}
          <div className="sm:w-48"><FancySelect value={filters.playbookId} onChange={(v) => set({ playbookId: v })} options={playbookOptions} aria-label="Playbook" className="h-9" /></div>
          <div className="sm:w-40"><FancySelect value={filters.range} onChange={(v) => set({ range: v })} options={RANGE_OPTIONS} aria-label="When" className="h-9" /></div>
          {anyFilter && (
            <button type="button" onClick={clear} className="tp-focus-ring inline-flex h-9 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" data-testid="clear-filters">
              <X className="h-3.5 w-3.5" aria-hidden="true" /> Clear
            </button>
          )}
        </div>
      </div>

      {view === 'runs'
        ? <RunsView filters={filters} set={set} canReview={canReview} />
        : <PlaybooksView playbookId={filters.playbookId} range={filters.range} />}
    </div>
  );
}
