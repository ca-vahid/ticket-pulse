import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Ban, CheckCircle2, Clock, XCircle,
  Loader2, Check, X, MessageCircleQuestion, Inbox, ExternalLink, RotateCcw, ClipboardList, Tags, ArrowUpRight, Forward,
  Search, Download, SlidersHorizontal, CalendarDays, UserRound, ChevronDown, ChevronUp,
} from 'lucide-react';
import { AmountChip, TierChip } from '../components/tickets/ApprovalHandoff';
import ApprovalComposer from '../components/tickets/ApprovalComposer';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import ApprovalCategoriesPanel from '../components/settings/ApprovalCategoriesPanel';
import FancySelect from '../components/common/FancySelect';
import { ticketsAPI } from '../services/api';
import { useSSE } from '../hooks/useSSE';
import { useRequesterPhoto } from '../hooks/useRequesterPhoto';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { applyWidth, useLayoutWidth } from '../contexts/LayoutContext';
import { useWorkspaceRole } from '../components/nav/navDestinations';
import { BrandArt, PersonAvatar, formatDayTime, timeAgo } from '../components/tickets/ticketUi';

/**
 * Approvals (QA 09-16 #4 redesign): an illustrated inbox that matches the
 * rest of the app — status art per row, people with photos, and for
 * reviewers a real filter bar (text, status, category, approver, requester,
 * dates, sort) with CSV export over the filtered set.
 */
const STATUS_META = {
  pending: { label: 'Pending', art: 'approval-waiting', cls: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30', dot: 'bg-amber-500' },
  info_requested: { label: 'Needs info', art: 'approval-question', cls: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200 border-violet-200 dark:border-violet-500/30', dot: 'bg-violet-500' },
  approved: { label: 'Approved', art: 'approval-stamp', cls: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-200 dark:border-emerald-500/30', dot: 'bg-emerald-500' },
  rejected: { label: 'Not approved', art: 'approval-rejected', cls: 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200 border-red-200 dark:border-red-500/30', dot: 'bg-red-500' },
  cancelled: { label: 'Cancelled', art: null, cls: 'bg-muted text-muted-foreground border-border', dot: 'bg-muted-foreground/50' },
  escalated: { label: 'Escalated', art: 'approval-escalate', cls: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-200 dark:border-amber-500/30', dot: 'bg-amber-500' },
  forwarded: { label: 'Forwarded', art: 'approval-forward', cls: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border-blue-200 dark:border-blue-500/30', dot: 'bg-blue-500' },
};
// Status as a glyph and coloured words — no pills, no stamp clip-art (Vahid, 18 Sep 2026).
const STATUS_ICON = {
  pending: { Icon: Clock, text: 'text-amber-700 dark:text-amber-300', soft: 'bg-amber-50 dark:bg-amber-500/15' },
  info_requested: { Icon: MessageCircleQuestion, text: 'text-violet-700 dark:text-violet-300', soft: 'bg-violet-50 dark:bg-violet-500/15' },
  approved: { Icon: CheckCircle2, text: 'text-emerald-700 dark:text-emerald-300', soft: 'bg-emerald-50 dark:bg-emerald-500/15' },
  rejected: { Icon: XCircle, text: 'text-red-700 dark:text-red-300', soft: 'bg-red-50 dark:bg-red-500/15' },
  cancelled: { Icon: Ban, text: 'text-muted-foreground', soft: 'bg-muted' },
  escalated: { Icon: ArrowUpRight, text: 'text-amber-700 dark:text-amber-300', soft: 'bg-amber-50 dark:bg-amber-500/15' },
  forwarded: { Icon: Forward, text: 'text-blue-700 dark:text-blue-300', soft: 'bg-blue-50 dark:bg-blue-500/15' },
};
function StatusGlyph({ status, size = 'h-10 w-10', icon = 'h-5 w-5' }) {
  // The layered-glass set (Vahid's pick, 18 Sep 2026), kept small. Statuses without
  // artwork (cancelled) fall back to a quiet glyph in a soft circle.
  const art = STATUS_META[status]?.art;
  if (art) return <BrandArt name={art} className={`${size} flex-shrink-0`} />;
  const m = STATUS_ICON[status] || STATUS_ICON.cancelled;
  return <span className={`inline-flex ${size} flex-shrink-0 items-center justify-center rounded-full ${m.soft}`} aria-hidden="true"><m.Icon className={`${icon} ${m.text}`} /></span>;
}

/** One person in the row's side column: small label over avatar + name. Never a bare address. */
function SidePerson({ label, name, email }) {
  const photo = useRequesterPhoto(email);
  const shown = name || (email ? String(email).split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—');
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <PersonAvatar name={shown} photoUrl={photo} size="h-8 w-8" textSize="text-[10px]" />
      <div className="min-w-0">
        <p className="text-[11px] leading-4 text-muted-foreground/75">{label}</p>
        <p className="truncate text-sm font-medium leading-5 text-foreground" title={email || undefined}>{shown}</p>
      </div>
    </div>
  );
}

const STAT_TILES = [
  { key: 'pending', label: 'Pending', color: 'text-amber-600 dark:text-amber-300', art: 'approval-waiting' },
  { key: 'info_requested', label: 'Needs info', color: 'text-violet-600 dark:text-violet-300', art: 'approval-question' },
  { key: 'approved', label: 'Approved', color: 'text-emerald-600 dark:text-emerald-300', art: 'approval-stamp' },
  { key: 'rejected', label: 'Not approved', color: 'text-red-600 dark:text-red-300', art: 'approval-rejected' },
  { key: 'cancelled', label: 'Cancelled', color: 'text-muted-foreground', art: null },
];
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'status', label: 'By status' },
];
const EMPTY_FILTERS = { q: '', status: '', categoryId: '', approver: '', requestedBy: '', from: '', to: '', sort: 'newest' };

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function ApprovalsInbox() {
  const location = useLocation();
  // Return address so /tickets/:id's Back control comes back to this inbox.
  const backState = { from: `${location.pathname}${location.search}` };
  const { currentWorkspace, isWorkspaceSelected } = useWorkspace();
  const { width: layoutWidth } = useLayoutWidth();
  const wsRole = useWorkspaceRole();
  const canReview = wsRole === 'admin' || wsRole === 'reviewer';
  // mine | all | categories. `categories` (v3.7.02, QA 08-24 #3) is the
  // reviewer's home for approval-category management now that Settings is
  // admin-only — same <ApprovalCategoriesPanel/> the admin sees in Settings.
  // Deep-linkable via ?tab= (the Settings → Approval Categories cross-link).
  const requestedTab = new URLSearchParams(location.search).get('tab');
  const [view, setView] = useState(['mine', 'all', 'categories'].includes(requestedTab) ? requestedTab : 'mine');
  const [pending, setPending] = useState([]);
  const [needsInfo, setNeedsInfo] = useState([]);
  const [overview, setOverview] = useState(null); // { stats, items }
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  // Filter changes refetch SILENTLY (a spinner replacing the filter bar while
  // you type lost focus and flashed) — a small inline indicator instead.
  const [refreshing, setRefreshing] = useState(false);
  const firstLoadDone = useRef(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  // Approvals v3: which row has the composer open; people load lazily for the forward picker.
  const [openId, setOpenId] = useState(null);
  const [people, setPeople] = useState(null);

  useEffect(() => { const t = setTimeout(() => setDebouncedQ(filters.q.trim()), 300); return () => clearTimeout(t); }, [filters.q]);

  const loadMeta = useCallback(async () => {
    if (meta) return meta;
    try {
      const res = await ticketsAPI.meta();
      const m = res?.data || res || null;
      setMeta(m);
      return m;
    } catch { return null; }
  }, [meta]);

  const openComposer = async (a) => {
    setOpenId(a.id);
    if (people === null) {
      const m = await loadMeta();
      const map = new Map();
      for (const t of [...(m?.technicians || []), ...(m?.members || [])]) {
        if (!t?.email) continue;
        const key = String(t.email).toLowerCase();
        if (!map.has(key)) map.set(key, { name: t.name || t.email, email: key, photoUrl: t.photoUrl || null, role: t.role || null });
      }
      setPeople([...map.values()].sort((x, y) => x.name.localeCompare(y.name)));
    }
  };

  const overviewParams = useMemo(() => {
    const p = {};
    if (filters.status) p.status = filters.status;
    if (filters.categoryId) p.categoryId = filters.categoryId;
    if (debouncedQ) p.q = debouncedQ;
    if (filters.approver.trim()) p.approver = filters.approver.trim();
    if (filters.requestedBy.trim()) p.requestedBy = filters.requestedBy.trim();
    if (filters.from) p.from = filters.from;
    if (filters.to) p.to = filters.to;
    if (filters.sort && filters.sort !== 'newest') p.sort = filters.sort;
    return p;
  }, [filters.status, filters.categoryId, debouncedQ, filters.approver, filters.requestedBy, filters.from, filters.to, filters.sort]);
  const activeFilterCount = Object.keys(overviewParams).filter((k) => k !== 'sort').length;

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    try {
      const tasks = [ticketsAPI.approvalInbox(), ticketsAPI.approvalsNeedingMyInfo()];
      if (canReview) tasks.push(ticketsAPI.approvalsOverview(overviewParams));
      const [inbox, mine, ov] = await Promise.all(tasks);
      setPending(inbox || []);
      setNeedsInfo(mine || []);
      if (canReview) setOverview(ov || null);
      setError(null);
      firstLoadDone.current = true;
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to load approvals');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [canReview, overviewParams]);

  useEffect(() => { if (isWorkspaceSelected) load({ silent: firstLoadDone.current }); }, [load, isWorkspaceSelected, currentWorkspace?.id]);
  useEffect(() => { if (canReview && view === 'all') loadMeta(); }, [canReview, view, loadMeta]);

  const onTicketChange = useCallback((data) => { if (data?.action === 'approval') load({ silent: true }); }, [load]);
  // reconnectKey: deterministic stream re-key on workspace switch (realtime
  // plan Phase 1) — the context-subscribed id, not a render-time module read.
  useSSE({ onTicketChange, enabled: Boolean(isWorkspaceSelected), reconnectKey: currentWorkspace?.id });

  const act = async (fn, id) => {
    setBusyId(id); setError(null);
    try { await fn(); await load({ silent: true }); }
    catch (err) { setError(err.response?.data?.message || err.message); }
    finally { setBusyId(null); }
  };

  const resubmit = (a) => act(() => ticketsAPI.resubmitApproval(a.ticketId, a.id), a.id);
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const toggleExpanded = (id) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const exportCsv = () => {
    const rows = overview?.items || [];
    const header = ['Status', 'Category', 'Ticket', 'Subject', 'Approver', 'Approver e-mail', 'Requested by', 'Amount', 'Tier', 'Requested at', 'Decided at', 'Decision note', 'Condition'];
    const lines = [header.join(',')].concat(rows.map((a) => [
      STATUS_META[a.status]?.label || a.status, a.categoryName, a.displayRef, a.subject, a.approverName, a.approverEmail, a.requestedBy,
      a.amountLabel || '', a.tierName, a.createdAt ? new Date(a.createdAt).toISOString() : '', a.decidedAt ? new Date(a.decidedAt).toISOString() : '',
      a.decisionNote, a.conditionNote,
    ].map(csvEscape).join(',')));
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `approvals-${currentWorkspace?.name || 'workspace'}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const categoryOptions = useMemo(() => [
    { value: '', label: 'All categories' },
    ...((meta?.approvalCategories || []).map((c) => ({ value: c.id, label: c.name }))),
  ], [meta]);

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[58px]">
      <AppHeader activePage="approvals" />
      <main className={applyWidth('max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-24 lg:pb-6 animate-fadeIn', layoutWidth)}>
        {/* Hero */}
        <div className="tp-card tp-ticket-header relative mb-5 flex items-center gap-4 rounded-2xl p-4 sm:p-5">
          <span className="inline-flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-blue-50 shadow-subtle ring-1 ring-blue-100 dark:bg-blue-500/15 dark:ring-blue-500/20">
            <BrandArt name="approval-inbox" className="h-10 w-10" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-foreground">Approvals</h1>
            <p className="text-sm text-muted-foreground">Requests awaiting your decision, and your requests that need more info. A Ticket Pulse feature — not synced to FreshService.</p>
          </div>
          {canReview && overview?.stats && (
            <div className="ml-auto hidden items-center gap-3 sm:flex">
              {[['pending', 'waiting'], ['info_requested', 'need info']].map(([k, word]) => (
                <span key={k} className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/80 px-2.5 py-1 text-xs font-semibold text-foreground/85">
                  <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATUS_META[k].dot}`} />
                  {overview.stats[k] ?? 0} {word}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Reviewer/admin tab toggle: my inbox vs. everything in the workspace */}
        {canReview && (
          <div role="tablist" className="flex items-end gap-1 border-b border-border mb-4">
            {[
              { k: 'mine', label: 'For you', Icon: Inbox },
              { k: 'all', label: 'All approvals', Icon: ClipboardList },
              { k: 'categories', label: 'Categories', Icon: Tags },
            ].map(({ k, label, Icon }) => (
              <button
                key={k}
                role="tab"
                aria-selected={view === k}
                onClick={() => setView(k)}
                className={`tp-focus-ring relative -mb-px inline-flex items-center gap-1.5 px-4 py-2.5 rounded-t-lg border text-sm font-semibold transition-colors ${
                  view === k ? 'bg-card text-emerald-700 dark:text-emerald-200 border-border border-b-card' : 'bg-muted/50 text-muted-foreground border-transparent hover:bg-muted hover:text-foreground/85'
                }`}
              >
                {view === k && <span className="absolute inset-x-0 top-0 h-0.5 rounded-t bg-emerald-600" aria-hidden="true" />}
                <Icon className="w-4 h-4" aria-hidden="true" /> {label}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg text-sm text-red-700 dark:text-red-200">
            <X className="w-4 h-4 mt-0.5 shrink-0" /><span>{error}</span>
          </div>
        )}

        {view === 'categories' && canReview ? (
          <section aria-label="Approval categories" className="tp-card rounded-xl p-5">
            <ApprovalCategoriesPanel />
          </section>
        ) : loading ? (
          <div className="flex items-center justify-center py-24 text-muted-foreground/75"><Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" /></div>
        ) : view === 'all' && canReview ? (
          <div className="space-y-4" data-testid="approvals-all">
            {/* Stats = one-click status filters */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
              {STAT_TILES.map(({ key, label, color }) => {
                const active = filters.status === key;
                return (
                  <button
                    key={key}
                    onClick={() => setFilter({ status: active ? '' : key })}
                    aria-pressed={active}
                    className={`tp-card group rounded-xl p-3 text-left transition-all ${active ? 'ring-2 ring-emerald-400 shadow-soft' : 'hover:border-input hover:shadow-subtle'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className={`text-2xl font-bold tabular-nums ${color}`}>{overview?.stats?.[key] ?? 0}</div>
                        <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
                      </div>
                      <StatusGlyph status={key} size="h-9 w-9" icon="h-[18px] w-[18px]" />
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Filter bar */}
            <div className="tp-card rounded-xl p-3" data-testid="approvals-filters">
              <div className="flex flex-wrap items-center gap-2">
                <label className="relative min-w-[240px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
                  <input
                    type="text"
                    value={filters.q}
                    onChange={(e) => setFilter({ q: e.target.value })}
                    placeholder="Search subject, note, TP-1234 or #242054…"
                    aria-label="Search approvals"
                    className="tp-focus-ring h-9 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-sm placeholder:text-muted-foreground/75"
                  />
                </label>
                <div className="w-52">
                  <FancySelect value={filters.categoryId} onChange={(v) => setFilter({ categoryId: v })} options={categoryOptions} aria-label="Approval category" />
                </div>
                <div className="w-40">
                  <FancySelect value={filters.sort} onChange={(v) => setFilter({ sort: v })} options={SORT_OPTIONS} aria-label="Sort approvals" />
                </div>
                <button
                  type="button"
                  onClick={() => setShowFilters((v) => !v)}
                  aria-expanded={showFilters}
                  className={`tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${showFilters || activeFilterCount > 1 ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" /> More filters
                  {activeFilterCount > 0 && <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white">{activeFilterCount}</span>}
                </button>
                {refreshing && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" aria-label="Updating" />}
                <button
                  type="button"
                  onClick={exportCsv}
                  disabled={!(overview?.items?.length)}
                  title="Download the rows below as CSV"
                  className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-muted-foreground hover:border-blue-300 hover:text-blue-700 disabled:opacity-50 dark:hover:border-blue-500/40 dark:hover:text-blue-200"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" /> Export CSV
                </button>
              </div>
              {showFilters && (
                <div className="mt-3 grid grid-cols-1 gap-2 border-t border-border/60 pt-3 sm:grid-cols-2 lg:grid-cols-4 animate-popIn">
                  <div className="text-xs font-medium text-muted-foreground">
                    <label htmlFor="ap-f-approver" className="mb-1 inline-flex items-center gap-1"><UserRound className="h-3.5 w-3.5" aria-hidden="true" /> Approver</label>
                    <input id="ap-f-approver" type="text" value={filters.approver} onChange={(e) => setFilter({ approver: e.target.value })} placeholder="Name or e-mail" className="tp-focus-ring h-9 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground/75" />
                  </div>
                  <div className="text-xs font-medium text-muted-foreground">
                    <label htmlFor="ap-f-requested-by" className="mb-1 inline-flex items-center gap-1"><UserRound className="h-3.5 w-3.5" aria-hidden="true" /> Requested by</label>
                    <input id="ap-f-requested-by" type="text" value={filters.requestedBy} onChange={(e) => setFilter({ requestedBy: e.target.value })} placeholder="E-mail" className="tp-focus-ring h-9 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground/75" />
                  </div>
                  <div className="text-xs font-medium text-muted-foreground">
                    <label htmlFor="ap-f-from" className="mb-1 inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" /> Requested from</label>
                    <input id="ap-f-from" type="date" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} className="tp-focus-ring h-9 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground" />
                  </div>
                  <div className="text-xs font-medium text-muted-foreground">
                    <label htmlFor="ap-f-to" className="mb-1 inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" /> Requested to</label>
                    <input id="ap-f-to" type="date" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} className="tp-focus-ring h-9 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground" />
                  </div>
                </div>
              )}
              {activeFilterCount > 0 && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{overview?.items?.length ?? 0} approval{(overview?.items?.length ?? 0) === 1 ? '' : 's'} match</span>
                  <button onClick={() => setFilters(EMPTY_FILTERS)} className="tp-focus-ring inline-flex items-center gap-1 rounded text-blue-700 hover:underline dark:text-blue-200">
                    <X className="w-3 h-3" aria-hidden="true" /> Clear filters
                  </button>
                </div>
              )}
            </div>

            {/* All approvals list / history */}
            {(overview?.items?.length || 0) === 0 ? (
              <div className="tp-card rounded-xl p-10 text-center">
                <BrandArt name="approval-inbox" className="mx-auto mb-3 h-12 w-12 opacity-80" />
                <p className="text-sm font-medium text-foreground/85">No approvals{filters.status ? ` with status “${STATUS_META[filters.status]?.label}”` : ''}{activeFilterCount ? ' match these filters' : ' yet'}.</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {overview.items.map((a) => {
                  const meta_ = STATUS_META[a.status] || {};
                  const isOpen = expanded.has(a.id);
                  const note = a.decisionNote || a.conditionNote || a.requestNote || '';
                  return (
                    <li key={a.id} className="tp-card group/row rounded-xl px-5 py-4 transition-shadow hover:shadow-subtle" data-testid="approval-row">
                      <div className="flex flex-col gap-4 md:flex-row md:items-stretch md:gap-6">
                        {/* Left: what was asked, and what happened to it */}
                        <div className="flex min-w-0 flex-1 items-start gap-3.5">
                          <StatusGlyph status={a.status} />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[13px]">
                              <span className={`font-semibold ${(STATUS_ICON[a.status] || STATUS_ICON.cancelled).text}`}>{meta_.label || a.status}</span>
                              {a.categoryName && <><span className="text-muted-foreground/40" aria-hidden="true">·</span><span className="text-muted-foreground">{a.categoryName}</span></>}
                              <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                              <Link to={`/tickets/${a.ticketId}?tab=approvals`} state={backState} className="tp-focus-ring rounded font-mono text-xs font-semibold text-blue-700 dark:text-blue-200 hover:underline inline-flex items-center gap-1">{a.displayRef} <ExternalLink className="w-3 h-3" aria-hidden="true" /></Link>
                            </div>
                            <p className="mt-1 text-[15px] font-semibold leading-snug text-foreground">{a.subject || '(no subject)'}</p>
                            {note && (
                              <div className="mt-2">
                                <p className={`text-sm leading-relaxed text-muted-foreground ${isOpen ? '' : 'line-clamp-2'}`}>“{note}”</p>
                                {note.length > 140 && (
                                  <button onClick={() => toggleExpanded(a.id)} className="tp-focus-ring mt-1 inline-flex items-center gap-0.5 rounded text-xs font-medium text-blue-700 hover:underline dark:text-blue-200">
                                    {isOpen ? <><ChevronUp className="h-3 w-3" aria-hidden="true" /> Less</> : <><ChevronDown className="h-3 w-3" aria-hidden="true" /> More</>}
                                  </button>
                                )}
                              </div>
                            )}
                            <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground/75">
                              <span title={new Date(a.decidedAt || a.createdAt).toLocaleString()}>{formatDayTime(a.decidedAt || a.createdAt)} · {timeAgo(a.decidedAt || a.createdAt)}</span>
                              <AmountChip amount={a.amount} currency={a.amountCurrency} />
                              {a.tierCount > 1 && <TierChip tier={a.tier} tierName={a.tierName} tierCount={a.tierCount} />}
                            </p>
                          </div>
                        </div>
                        {/* Right: the people — who it is for, who decides, who asked */}
                        <div className="grid flex-shrink-0 grid-cols-1 gap-3 border-t border-border/70 pt-3 sm:grid-cols-3 md:w-60 md:grid-cols-1 md:border-l md:border-t-0 md:pl-6 md:pt-0">
                          {(a.requesterName || a.requesterEmail) && <SidePerson label="Requested for" name={a.requesterName} email={a.requesterEmail} />}
                          <SidePerson label="Approver" name={a.approverName} email={a.approverEmail} />
                          <SidePerson label="Requested by" name={a.requestedByName} email={a.requestedBy} />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Pending for me */}
            <section>
              <h2 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-2">Pending for you ({pending.length})</h2>
              {pending.length === 0 ? (
                <div className="tp-card rounded-xl p-8 text-center text-sm text-muted-foreground/75">
                  <BrandArt name="approval-stamp" className="mx-auto mb-2 h-10 w-10 opacity-80" /> Nothing awaiting your decision. 🎉
                </div>
              ) : (
                <ul className="space-y-2">
                  {pending.map((a) => (
                    <li key={a.id} className="tp-card rounded-xl p-4">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 hidden h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-amber-50 ring-1 ring-amber-100 dark:bg-amber-500/15 dark:ring-amber-500/20 sm:inline-flex">
                          <BrandArt name="approval-waiting" className="h-7 w-7" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-2 flex-wrap">
                            {a.categoryName && <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border border-blue-100 dark:border-blue-500/20">{a.categoryName}</span>}
                            <Link to={`/tickets/${a.ticketId}?tab=approvals`} state={backState} className="tp-focus-ring rounded font-mono text-xs font-bold text-blue-700 dark:text-blue-200 hover:underline inline-flex items-center gap-1">
                              {a.displayRef} <ExternalLink className="w-3 h-3" aria-hidden="true" />
                            </Link>
                            <span className="text-sm text-foreground font-medium truncate max-w-full">{a.subject || '(no subject)'}</span>
                            <span className="ml-auto text-[11px] text-muted-foreground/75 whitespace-nowrap">{formatDayTime(a.createdAt)} · {timeAgo(a.createdAt)}</span>
                          </div>
                          <p className="text-xs text-muted-foreground/75 mt-1 flex flex-wrap items-center gap-1.5">
                            <span>Requested by {a.requestedByName || a.requestedBy}{a.requesterName ? ` · for ${a.requesterName}` : ''}</span>
                            <AmountChip amount={a.amount} currency={a.amountCurrency} />
                            <TierChip tier={a.tier} tierName={a.tierName} tierCount={a.tierCount} />
                            {a.isFinal && <span className="rounded border border-border bg-muted/70 px-1 py-px text-[10px] font-semibold text-muted-foreground">final approver</span>}
                          </p>
                          {a.requestNote && <p className="text-xs text-muted-foreground mt-1">“{a.requestNote}”</p>}

                          {openId === a.id ? (
                            <div className="mt-2.5">
                              <ApprovalComposer
                                compact
                                showShortcuts={false}
                                minHeight={180}
                                approval={{ ...a, ticketRef: a.displayRef, nextTier: a.nextTierName ? { name: a.nextTierName, approverNames: [] } : null, amountLabel: null }}
                                participants={null}
                                selfEmail={a.approverEmail}
                                forwardCandidates={(people || []).filter((p) => p.email !== String(a.approverEmail || '').toLowerCase() && p.email !== String(a.requestedBy || '').toLowerCase())}
                                onDecide={(decision, note, noteHtml, extra) => act(() => ticketsAPI.decideApproval(a.ticketId, a.id, decision, note, { noteHtml, ...extra }), a.id)}
                                onAsk={(payload) => act(() => ticketsAPI.askApproval(a.ticketId, a.id, payload), a.id)}
                                onHandoff={({ mode, note, toEmail }) => act(async () => {
                                  if (mode === 'forward') await ticketsAPI.forwardApproval(a.ticketId, a.id, { toEmail, note });
                                  else await ticketsAPI.escalateApproval(a.ticketId, a.id, { note });
                                }, a.id)}
                                disabled={busyId === a.id}
                                footer={<>Decisions ask you to confirm first · <button type="button" onClick={() => setOpenId(null)} className="tp-focus-ring rounded font-medium text-muted-foreground underline hover:text-foreground">close</button></>}
                              />
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                              <button onClick={() => openComposer(a)} disabled={busyId === a.id} className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                                {busyId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Decide
                              </button>
                              <button onClick={() => openComposer(a)} disabled={busyId === a.id} className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-card text-violet-700 dark:text-violet-200 border border-violet-200 dark:border-violet-500/30 hover:bg-violet-50 dark:hover:bg-violet-500/15 disabled:opacity-50">
                                <MessageCircleQuestion className="w-3 h-3" /> Ask a question
                              </button>
                              {a.canEscalate && (
                                <button onClick={() => openComposer(a)} disabled={busyId === a.id} title={`Escalate to ${a.nextTierName || 'the next tier'}`} className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-card text-amber-700 dark:text-amber-200 border border-amber-200 dark:border-amber-500/30 hover:bg-amber-50 dark:hover:bg-amber-500/15 disabled:opacity-50">
                                  <ArrowUpRight className="w-3 h-3" /> Escalate
                                </button>
                              )}
                              <button onClick={() => openComposer(a)} disabled={busyId === a.id} title="Forward to anyone in the workspace as the final approver" className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-card text-muted-foreground border border-border hover:bg-muted disabled:opacity-50">
                                <Forward className="w-3 h-3" /> Forward
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Needs my info */}
            {needsInfo.length > 0 && (
              <section>
                <h2 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-2">Needs your info ({needsInfo.length})</h2>
                <ul className="space-y-2">
                  {needsInfo.map((a) => (
                    <li key={a.id} className="tp-card rounded-xl p-4 border-l-2 border-l-violet-300 dark:border-l-violet-500/40">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 hidden h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-violet-50 ring-1 ring-violet-100 dark:bg-violet-500/15 dark:ring-violet-500/20 sm:inline-flex">
                          <BrandArt name="approval-question" className="h-7 w-7" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-2 flex-wrap">
                            {a.categoryName && <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200 border border-blue-100 dark:border-blue-500/20">{a.categoryName}</span>}
                            <Link to={`/tickets/${a.ticketId}?tab=approvals`} state={backState} className="tp-focus-ring rounded font-mono text-xs font-bold text-blue-700 dark:text-blue-200 hover:underline inline-flex items-center gap-1">
                              {a.displayRef} <ExternalLink className="w-3 h-3" aria-hidden="true" />
                            </Link>
                            <span className="text-sm text-foreground font-medium truncate max-w-full">{a.subject || '(no subject)'}</span>
                            <span className="ml-auto text-[11px] text-muted-foreground/75 whitespace-nowrap">{formatDayTime(a.createdAt)} · {timeAgo(a.createdAt)}</span>
                          </div>
                          {a.decisionNote && <p className="text-xs text-violet-600 dark:text-violet-300 mt-1.5">{a.approverEmail} asks: “{a.decisionNote}”</p>}
                          <div className="flex items-center gap-1.5 mt-2.5">
                            <button onClick={() => resubmit(a)} disabled={busyId === a.id} className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
                              {busyId === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Resubmit for approval
                            </button>
                            <Link to={`/tickets/${a.ticketId}?tab=conversation`} state={backState} className="tp-focus-ring px-2 py-1 text-[11px] font-medium rounded-lg text-muted-foreground hover:bg-muted">Add info on ticket →</Link>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </main>
      <MobileTabBar />
    </div>
  );
}
