import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity, AlertCircle, ArrowDownWideNarrow, ArrowUpNarrowWide, CalendarDays, Check,
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CornerUpRight, Download, Inbox,
  ListFilter, Loader2, MessageSquare, Plus, Rows2, Rows3, Rows4, Search, ShieldCheck, Sparkles, Ticket, UserRound, X,
} from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import TicketPreview from '../components/tickets/TicketPreview';
import ScheduledTicketsPanel from '../components/tickets/ScheduledTicketsPanel';
import TicketFilterRail, { ActiveFilterBar } from '../components/tickets/TicketFilterRail';
import AssigneePicker from '../components/tickets/AssigneePicker';
import StatusPicker from '../components/tickets/StatusPicker';
import MobileAssignSheet from '../components/tickets/MobileAssignSheet';
import AiAssignModal from '../components/tickets/AiAssignModal';
import FsSyncConfirm from '../components/tickets/FsSyncConfirm';
import {
  PersonAvatar, PriorityDot, SlaChip, StateChip, StatusPill, TagChip, TypePill, UnassignedBadge,
  PRIORITY_LABELS, PRIORITY_STRIP_COLORS, ticketCategoryLabels, timeAgo,
} from '../components/tickets/ticketUi';
import { assignmentAPI, ticketsAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useWorkspaceRole } from '../components/nav/navDestinations';
import { useSSE } from '../hooks/useSSE';
import ticketsHeroArt from '../assets/tickets-hero.png';

const STATUS_FILTERS = ['Open', 'Pending', 'Resolved', 'Closed'];
const DEFAULT_STATUSES = ['Open', 'Pending'];
const PAGE_SIZE = 25;

/**
 * "Handled in FreshService" marker: the assignment was made in FS, not by our
 * AI. Either the AI auto-assigned someone and a human reassigned it in FS
 * (kind='reassigned'), or the ticket was already taken in FS before the AI run
 * could act (kind='handled_in_fs'). The row shows the real current assignee;
 * this amber chip flags the FS handoff and links to the assignment-history
 * detail.
 */
function BypassBadge({ bypass }) {
  let title;
  if (bypass.kind === 'reassigned') {
    const bits = [];
    if (bypass.aiTechName) bits.push(`AI assigned ${bypass.aiTechName}`);
    if (bypass.byActorName) bits.push(`reassigned by ${bypass.byActorName}`);
    title = `Handled in FreshService — ${bits.join('; ') || 'reassigned in FreshService'}. Click for assignment history.`;
  } else {
    const who = bypass.byActorName
      ? (bypass.selfPicked ? `self-assigned by ${bypass.byActorName}` : `assigned by ${bypass.byActorName}`)
      : 'assigned in FreshService';
    const aiNote = bypass.aiTechName ? ` (AI would have picked ${bypass.aiTechName})` : '';
    title = `Handled in FreshService — ${who} before AI could act${aiNote}. Click for assignment history.`;
  }
  return (
    <Link
      to={`/assignments/history/${bypass.runId}`}
      onClick={(e) => e.stopPropagation()}
      title={title}
      aria-label={title}
      className="tp-focus-ring flex-shrink-0 inline-flex items-center h-5 w-5 rounded-md bg-amber-50 border border-amber-200 text-amber-600 hover:bg-amber-100 transition-colors"
    >
      <CornerUpRight className="w-3 h-3 m-auto" aria-hidden="true" />
    </Link>
  );
}

const SORT_OPTIONS = [
  { value: 'updatedAt', label: 'Last activity' },
  { value: 'createdAt', label: 'Created date' },
  { value: 'priority', label: 'Priority' },
  { value: 'subject', label: 'Subject' },
  { value: 'requester', label: 'Requester' },
];

// KPI stat cards (mockup: colored icon tile + large number + label). Clicking a
// card applies that segment. Unassigned lives in the sidebar Views, not here.
const SEGMENTS = [
  { key: 'all', label: 'All tickets', Icon: Ticket, tile: 'bg-blue-50 text-blue-600', num: 'text-blue-600' },
  { key: 'open', label: 'Open', Icon: Inbox, tile: 'bg-emerald-50 text-emerald-600', num: 'text-emerald-600' },
  { key: 'awaiting', label: 'Awaiting reply', Icon: MessageSquare, tile: 'bg-sky-50 text-sky-600', num: 'text-slate-800' },
  { key: 'due_today', label: 'Due today', Icon: CalendarDays, tile: 'bg-amber-50 text-amber-600', num: 'text-slate-800' },
  { key: 'overdue', label: 'Overdue', Icon: AlertCircle, tile: 'bg-red-50 text-red-600', num: 'text-red-600' },
  { key: 'resolved', label: 'Resolved', Icon: CheckCircle2, tile: 'bg-violet-50 text-violet-600', num: 'text-slate-800' },
];
const SEGMENT_COUNT_KEY = { all: 'all', open: 'open', unassigned: 'unassigned', awaiting: 'awaiting', due_today: 'dueToday', overdue: 'overdue', resolved: 'resolved' };

// Shared row-grid template: no REF column (nobody remembers the number — it
// lives small under the subject); Type is a tiny INC/REQ code so Category
// gets the width hierarchical names actually need.
// Subject AND category flex with viewport width (extra space goes to the two
// columns that hold long text); the rest stay fixed. Widening the page cap
// (below) plus these flexible tracks kills the truncation on wide screens.
// QA 07-06 #6: the type track was 58px — narrower than the pill + cell padding
// (icon 18 + gap 6 + "INC"/"REQ" ~28 + px-3×2 = ~80px), so the pill overflowed
// flush against the category text. 84px gives every column the same rhythm.
const ROW_GRID = 'grid grid-cols-[6px_minmax(0,1.6fr)_84px_minmax(160px,1fr)_214px_86px_84px_78px] items-center';
// No vertical grid lines (modern list feel) — horizontal row dividers only.
const CELL = 'px-3 self-stretch flex items-center min-w-0';

/** Inline priority dropdown for TP-born rows (FS-born rows stay read-only). */
function InlinePriorityPicker({ ticket, onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = async (p) => {
    setBusy(true);
    try {
      await ticketsAPI.update(ticket.id, { priority: p });
      onChanged?.();
    } catch { /* silent refresh shows the real state */ }
    setBusy(false);
    setOpen(false);
  };

  return (
    <span
      ref={rootRef}
      className="relative inline-flex"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        title="Change priority"
        aria-label={`Priority ${PRIORITY_LABELS[ticket.priority] || ticket.priority} — change`}
        className="tp-focus-ring rounded-md p-1 -m-1 hover:bg-blue-100/60"
      >
        {busy
          ? <Loader2 className="w-3 h-3 animate-spin text-slate-400" aria-hidden="true" />
          : <PriorityDot priority={ticket.priority} />}
      </button>
      {open && (
        <span className="absolute left-0 top-full mt-1 z-30 w-28 tp-card rounded-lg shadow-soft p-1 flex flex-col">
          {[1, 2, 3, 4].map((p) => (
            <button
              key={p}
              onClick={() => pick(p)}
              className={`tp-focus-ring px-2 py-1 text-xs rounded-md hover:bg-blue-50 text-left ${ticket.priority === p ? 'bg-blue-50' : ''}`}
            >
              <PriorityDot priority={p} withLabel />
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function pageWindow(current, total) {
  const pages = new Set([1, total]);
  for (let p = current - 2; p <= current + 2; p++) if (p >= 1 && p <= total) pages.add(p);
  const sorted = [...pages].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * Pagination built for thousands of tickets: labeled Prev/Next, first/last
 * jumps, a numbered window, and a type-a-page-number input. `compact` is the
 * top-of-list variant (no number row).
 */
function Pagination({ page, totalPages, total, pageSize, onPage, compact = false }) {
  const [jump, setJump] = useState('');
  const go = (p) => onPage(Math.min(totalPages, Math.max(1, p)));
  const commitJump = () => {
    const n = Number(jump);
    if (Number.isInteger(n) && n >= 1) go(n);
    setJump('');
  };
  const navBtn = 'tp-focus-ring inline-flex items-center gap-0.5 px-2 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700 disabled:opacity-35 disabled:hover:border-slate-200 disabled:hover:text-slate-600 transition-colors';
  const rangeText = total === 0
    ? '0 tickets'
    : `${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, total).toLocaleString()} of ${total.toLocaleString()}`;

  const jumpBox = (
    <span className="inline-flex items-center gap-1 text-xs text-slate-400">
      Page
      <input
        type="number"
        min={1}
        max={totalPages}
        value={jump}
        onChange={(e) => setJump(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commitJump(); }}
        onBlur={() => jump && commitJump()}
        placeholder={String(page)}
        aria-label="Jump to page"
        className="tp-focus-ring w-14 text-center text-xs bg-white border border-slate-200 rounded-lg px-1 py-1.5 text-slate-700 placeholder:text-slate-300 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      of {totalPages.toLocaleString()}
    </span>
  );

  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? '' : 'justify-between'}`}>
      <span className="text-xs text-slate-500 whitespace-nowrap">{rangeText}</span>
      <div className="flex items-center gap-1">
        <button onClick={() => go(1)} disabled={page <= 1} aria-label="First page" title="First page" className={navBtn}>
          <ChevronsLeft className="w-4 h-4" aria-hidden="true" />
        </button>
        <button onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page" className={`${navBtn} pl-1.5`}>
          <ChevronLeft className="w-4 h-4" aria-hidden="true" />
          Prev
        </button>
        {!compact && pageWindow(page, totalPages).map((p, i) => (typeof p === 'number' ? (
          <button
            key={p}
            onClick={() => go(p)}
            aria-current={p === page ? 'page' : undefined}
            className={`tp-focus-ring min-w-[34px] px-2 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
              p === page ? 'bg-blue-600 text-white border-blue-600 shadow-subtle' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-700'
            }`}
          >
            {p.toLocaleString()}
          </button>
        ) : (
          <span key={`gap-${i}`} className="px-0.5 text-xs text-slate-400" aria-hidden="true">…</span>
        )))}
        <button onClick={() => go(page + 1)} disabled={page >= totalPages} aria-label="Next page" className={`${navBtn} pr-1.5`}>
          Next
          <ChevronRight className="w-4 h-4" aria-hidden="true" />
        </button>
        <button onClick={() => go(totalPages)} disabled={page >= totalPages} aria-label="Last page" title="Last page" className={navBtn}>
          <ChevronsRight className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      {jumpBox}
    </div>
  );
}

export default function Tickets() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  // AI assignment/review is a reviewer/admin capability — its endpoints are
  // reviewer-gated server-side. Agents/viewers must not see those affordances
  // (otherwise the sparkle button just 401s on click).
  const wsRole = useWorkspaceRole();
  const canReview = wsRole === 'admin' || wsRole === 'reviewer';
  const [searchParams, setSearchParams] = useSearchParams();

  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState(null);
  const [stats, setStats] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortMenuRef = useRef(null);
  useEffect(() => {
    if (!sortMenuOpen) return undefined;
    const onDoc = (e) => { if (sortMenuRef.current && !sortMenuRef.current.contains(e.target)) setSortMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setSortMenuOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [sortMenuOpen]);

  // ---- URL-persisted list state (shareable, refresh/back-proof) ----
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const statuses = useMemo(() => {
    const raw = searchParams.get('status');
    if (raw === 'any') return [];
    return raw ? raw.split(',').filter((s) => STATUS_FILTERS.includes(s)) : DEFAULT_STATUSES;
  }, [searchParams]);
  const assignee = searchParams.get('assignee') || '';
  const priority = searchParams.get('priority') || '';
  const origin = searchParams.get('origin') || '';
  const segment = searchParams.get('segment') || 'all';
  const sort = searchParams.get('sort') || 'createdAt';
  const dir = searchParams.get('dir') || 'desc';
  const urlSearch = searchParams.get('q') || '';
  const previewId = Number(searchParams.get('peek')) || null;
  const type = searchParams.get('type') || '';
  const category = searchParams.get('category') || '';
  const subcategory = searchParams.get('subcategory') || '';
  const group = searchParams.get('group') || '';
  const source = searchParams.get('source') || '';
  const createdFrom = searchParams.get('createdFrom') || '';
  const createdTo = searchParams.get('createdTo') || '';
  const due = searchParams.get('due') || '';
  const noise = searchParams.get('noise') || '';
  const tag = searchParams.get('tag') || '';
  const tagMode = searchParams.get('tagMode') || '';
  const view = searchParams.get('view') || '';
  const requesterId = searchParams.get('requesterId') || '';
  const requesterName = searchParams.get('requesterName') || '';

  const [search, setSearch] = useState(urlSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(urlSearch);

  const setParams = useCallback((patch, { resetPage = true } = {}) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '' || v === 'all') next.delete(k);
        else next.set(k, String(v));
      }
      if (resetPage) next.delete('page');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      if ((searchParams.get('q') || '') !== search.trim()) setParams({ q: search.trim() });
    }, 300);
    return () => clearTimeout(timer);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  // The rail's "Clear all" (or a canned view) drops ?q= — mirror it into the box.
  useEffect(() => {
    setSearch((current) => (current.trim() === urlSearch ? current : urlSearch));
  }, [urlSearch]);

  const workspaceId = currentWorkspace?.id;

  useEffect(() => {
    let cancelled = false;
    ticketsAPI.meta()
      .then((res) => { if (!cancelled) { setMeta(res.data); setMetaError(null); } })
      .catch((err) => { if (!cancelled) setMetaError(err.response?.data?.message || err.message); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const fetchStats = useCallback(() => {
    ticketsAPI.stats().then((res) => setStats(res.data)).catch(() => {});
  }, []);
  useEffect(() => { fetchStats(); }, [fetchStats, workspaceId]);

  const queryParams = useMemo(() => {
    const params = { page, pageSize: PAGE_SIZE, sort, dir };
    // A segment supplies its own status scope; the checkboxes apply otherwise.
    if (segment !== 'all') params.segment = segment;
    else if (statuses.length > 0 && statuses.length < STATUS_FILTERS.length) params.status = statuses.join(',');
    if (assignee) params.assignedTechId = assignee;
    if (priority) params.priority = priority;
    if (origin) params.origin = origin;
    if (type) params.type = type;
    if (category) params.internalCategoryId = category;
    if (subcategory) params.internalSubcategoryId = subcategory;
    if (group) params.groupId = group;
    if (source) params.source = source;
    if (createdFrom) params.createdFrom = createdFrom;
    if (createdTo) params.createdTo = createdTo;
    if (due) params.due = due;
    if (noise) params.noise = noise;
    if (tag) {
      params.tagId = tag;
      if (tagMode === 'all') params.tagMode = 'all';
    }
    if (requesterId) params.requesterId = requesterId;
    if (debouncedSearch) params.q = debouncedSearch;
    return params;
  }, [page, statuses, assignee, priority, origin, segment, sort, dir, debouncedSearch,
    type, category, subcategory, group, source, createdFrom, createdTo, due, noise, tag, tagMode, requesterId]);

  const fetchTickets = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setIsLoading(true);
    try {
      const res = await ticketsAPI.list(queryParams);
      setTickets(res.data.items || []);
      setTotal(res.data.total || 0);
      setLoadError(null);
      // Hand the ordered id list to the detail page for prev/next navigation.
      try {
        sessionStorage.setItem('tp_ticket_nav', JSON.stringify((res.data.items || []).map((t) => t.id)));
      } catch { /* sessionStorage unavailable */ }
    } catch (err) {
      setLoadError(err.response?.data?.message || err.message);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [queryParams]);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  // ---- Live updates, resource-conscious ----
  // SSE changes do NOT reload the list (jarring + heavy with many users).
  // Stat cards refresh silently (7 cheap counts, debounced), an open peek
  // re-fetches its single ticket, and everything else accumulates into a
  // "N updates" pill the user applies when ready. Own edits are exempt —
  // they already refresh locally, so their SSE echo is swallowed.
  const refreshTimerRef = useRef(null);
  const [pulse, setPulse] = useState(0); // bumps so an open preview re-fetches
  const pendingIdsRef = useRef(new Set());
  // Row density — helpdesk users live in this list all day; let them trade
  // whitespace for rows-per-screen. Persisted.
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem('tp_ticket_density') || 'comfortable'; } catch { return 'comfortable'; }
  });
  useEffect(() => { try { localStorage.setItem('tp_ticket_density', density); } catch { /* no-op */ } }, [density]);
  const cellPad = { comfortable: 'py-3', compact: 'py-2', dense: 'py-1' }[density] || 'py-3';
  const [pendingCount, setPendingCount] = useState(0);
  const lastLocalMutationRef = useRef(0);

  // ---- AI assignment: live modal + the Assignment Review connector chip ----
  const [aiTicket, setAiTicket] = useState(null); // ticket whose pipeline modal is open
  const [assignSheetTicket, setAssignSheetTicket] = useState(null); // mobile touch-first assign sheet
  const [toast, setToast] = useState(null); // { message, undo? } — instant-save feedback (QA 07-06 #3)
  const toastTimerRef = useRef(null);
  const showToast = useCallback((message, undo = null) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, undo });
    toastTimerRef.current = setTimeout(() => setToast(null), undo ? 5000 : 3000);
  }, []);
  const [aiReviewTotal, setAiReviewTotal] = useState(0);
  const fetchAiReviewTotal = useCallback(async () => {
    try {
      const res = await assignmentAPI.getQueue({ limit: 1 });
      setAiReviewTotal(Number(res?.total) || 0);
    } catch { /* pipeline disabled or no reviewer rights — the chip just hides */ }
  }, []);
  useEffect(() => { if (workspaceId && canReview) fetchAiReviewTotal(); }, [workspaceId, canReview, fetchAiReviewTotal]);

  const applyPendingUpdates = useCallback(() => {
    pendingIdsRef.current = new Set();
    setPendingCount(0);
    fetchTickets({ silent: true });
    fetchStats();
  }, [fetchTickets, fetchStats]);

  const onTicketChange = useCallback((data) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      fetchStats();
      setPulse((p) => p + 1);
    }, 400);
    // Pipeline lifecycle events also move the "awaiting review" connector chip.
    if (data?.action === 'pipeline') fetchAiReviewTotal();
    // Our own mutation's echo — the list is already fresh.
    if (Date.now() - lastLocalMutationRef.current < 2500) return;
    pendingIdsRef.current.add(data?.ticketId ?? `evt-${Date.now()}`);
    setPendingCount(pendingIdsRef.current.size);
  }, [fetchStats, fetchAiReviewTotal]);
  useSSE({ onTicketChange, enabled: Boolean(workspaceId) });
  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);
  // A filter/page change reloads the list anyway — drop stale pending state.
  useEffect(() => { pendingIdsRef.current = new Set(); setPendingCount(0); }, [queryParams]);

  const refreshAfterEdit = useCallback(() => {
    lastLocalMutationRef.current = Date.now(); // swallow our own SSE echo
    fetchTickets({ silent: true });
    fetchStats();
    setPulse((p) => p + 1); // keeps an open preview in sync
  }, [fetchTickets, fetchStats]);

  // ---- FS-born reassignment from the list: confirmed FreshService write-back ----
  const [fsConfirm, setFsConfirm] = useState(null); // { ticketId, fsRef, changes, payload, resolve, reject }
  const [fsBusy, setFsBusy] = useState(false);
  const [fsError, setFsError] = useState(null);
  const fsAssign = useCallback((ticket, techId) => {
    const tech = techId ? (meta?.technicians || []).find((t) => t.id === techId) : null;
    return new Promise((resolve, reject) => {
      setFsError(null);
      setFsConfirm({
        ticketId: ticket.id,
        fsRef: String(ticket.freshserviceTicketId),
        changes: [{ field: 'Assignee', from: ticket.assignedTech?.name || 'Unassigned', to: tech?.name || 'Unassigned' }],
        payload: { assignedTechId: techId },
        resolve,
        reject,
      });
    });
  }, [meta?.technicians]);
  // FS-born status change from the queue: same confirmed write-back flow
  // (fails first if FreshService rejects), per QA 07-06 #2.
  const fsStatusChange = useCallback((ticket, nextStatus) => new Promise((resolve, reject) => {
    setFsError(null);
    setFsConfirm({
      ticketId: ticket.id,
      fsRef: String(ticket.freshserviceTicketId),
      changes: [{ field: 'Status', from: ticket.status, to: nextStatus }],
      payload: { status: nextStatus },
      resolve,
      reject,
    });
  }), []);
  const runFsSync = async () => {
    if (!fsConfirm) return;
    setFsBusy(true); setFsError(null);
    try {
      await ticketsAPI.fsUpdate(fsConfirm.ticketId, fsConfirm.payload);
      refreshAfterEdit();
      fsConfirm.resolve?.();
      setFsConfirm(null);
    } catch (err) {
      setFsError(err.response?.data?.message || err.message || 'FreshService rejected the change');
      // A timeout can fire while the write actually lands (QA 231648) —
      // refresh so the list shows the TRUE state alongside the error.
      refreshAfterEdit();
    } finally {
      setFsBusy(false);
    }
  };
  const cancelFsSync = () => { fsConfirm?.reject?.(new Error('cancelled')); setFsConfirm(null); setFsError(null); };

  // ---- Peek drawer: single-click peeks, double-click opens the full page ----
  const clickTimerRef = useRef(null);
  const openPreview = useCallback((id) => {
    setParams({ peek: id }, { resetPage: false });
  }, [setParams]);
  const closePreview = useCallback(() => {
    setParams({ peek: null }, { resetPage: false });
  }, [setParams]);
  const onRowClick = (id) => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      // The drawer needs desktop room; on small screens go straight to detail.
      if (window.matchMedia('(min-width: 1024px)').matches) openPreview(id);
      else navigate(`/tickets/${id}`);
    }, 220);
  };
  const onRowDoubleClick = (id) => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    navigate(`/tickets/${id}`);
  };
  useEffect(() => () => { if (clickTimerRef.current) clearTimeout(clickTimerRef.current); }, []);

  // Step the open peek through the current page's rows (buttons + ↑/↓ keys).
  const previewIndex = previewId ? tickets.findIndex((t) => t.id === previewId) : -1;
  const stepPreview = useCallback((delta) => {
    const idx = tickets.findIndex((t) => t.id === Number(searchParams.get('peek')));
    const next = tickets[idx + delta];
    if (next) setParams({ peek: next.id }, { resetPage: false });
  }, [tickets, searchParams, setParams]);

  useEffect(() => {
    if (!previewId) return undefined;
    const onKey = (e) => {
      const target = e.target;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); stepPreview(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); stepPreview(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); navigate(`/tickets/${previewId}`); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [previewId, stepPreview, navigate]);

  // ---- Bulk selection & actions (page-scoped, or query-scoped via "Select all N") ----
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkAction, setBulkAction] = useState(null); // { type: 'assign'|'status', value, label }
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState(null); // { ok, failed: [{ref, message}], skipped }
  // Query scope (gap plan P2.2): the action applies to EVERYTHING matching the
  // current filter, not just the visible page. Set via the preview call.
  const [queryScope, setQueryScope] = useState(null); // { total, editable, skippedFsBorn }
  useEffect(() => { setSelectedIds(new Set()); setBulkAction(null); setQueryScope(null); }, [queryParams]);

  const bulkQueryParams = useMemo(() => {
    const { page: _p, pageSize: _s, sort: _sort, dir: _dir, ...rest } = queryParams;
    return rest;
  }, [queryParams]);

  const selectAllMatching = async () => {
    try {
      const res = await ticketsAPI.bulkByQuery({ query: bulkQueryParams, action: { type: 'status', value: 'Open' }, preview: true });
      setQueryScope(res.data);
    } catch (e) {
      setBulkResult({ ok: 0, failed: [{ ref: 'preview', message: e.response?.data?.message || e.message }], skipped: 0, label: 'select all' });
    }
  };

  const pageIds = tickets.map((t) => t.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const toggleSelect = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(pageIds));
  const selectedTickets = tickets.filter((t) => selectedIds.has(t.id));
  // Only TP-born tickets are writable; FS-born rows are mirrors and get skipped.
  const editableSelected = selectedTickets.filter((t) => t.origin === 'ticketpulse');
  const bulkSkipCount = selectedTickets.length - editableSelected.length;

  const runBulk = async () => {
    if (!bulkAction || bulkBusy) return;
    if (!queryScope && editableSelected.length === 0) return;
    setBulkBusy(true);
    lastLocalMutationRef.current = Date.now();

    if (queryScope) {
      // Query-scoped: the server re-resolves the filter and applies with a cap.
      try {
        const res = await ticketsAPI.bulkByQuery({
          query: bulkQueryParams,
          action: { type: bulkAction.type, value: bulkAction.value },
          expectedTotal: queryScope.total,
        });
        setBulkResult({
          ok: res.data.applied,
          failed: res.data.failed || [],
          skipped: res.data.skippedFsBorn || 0,
          label: bulkAction.label,
        });
      } catch (e) {
        setBulkResult({ ok: 0, failed: [{ ref: 'bulk', message: e.response?.data?.message || e.message }], skipped: 0, label: bulkAction.label });
      }
      setBulkBusy(false);
      setBulkAction(null);
      setQueryScope(null);
      setSelectedIds(new Set());
      refreshAfterEdit();
      return;
    }

    const targets = editableSelected;
    const results = await Promise.allSettled(targets.map((t) => (
      bulkAction.type === 'assign'
        ? ticketsAPI.assign(t.id, bulkAction.value)
        : ticketsAPI.setStatus(t.id, bulkAction.value)
    )));
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed.push({
          ref: targets[i].displayRef,
          message: r.reason?.response?.data?.message || r.reason?.message || 'failed',
        });
      }
    });
    setBulkResult({ ok: targets.length - failed.length, failed, skipped: bulkSkipCount, label: bulkAction.label });
    setBulkBusy(false);
    setBulkAction(null);
    setSelectedIds(new Set());
    refreshAfterEdit();
  };

  const setSort = (field, direction) => {
    setParams({ sort: field === 'createdAt' ? null : field, dir: direction === 'desc' ? null : direction }, { resetPage: false });
    setSortMenuOpen(false);
  };
  const headerSort = (field) => {
    if (sort === field) setSort(field, dir === 'desc' ? 'asc' : 'desc');
    else setSort(field, 'desc');
  };
  const sortIndicator = (field) => (sort === field ? (dir === 'desc' ? ' ↓' : ' ↑') : '');

  const goPage = (p) => {
    setParams({ page: p === 1 ? null : p }, { resetPage: false });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const exportCsv = async () => {
    setIsExporting(true);
    try {
      const { page: _p, pageSize: _s, ...rest } = queryParams;
      await ticketsAPI.exportCsv(rest);
    } catch { /* toastless — download either happens or the browser shows the error */ }
    setIsExporting(false);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const ticketingOn = meta ? meta.nativeTicketingEnabled : true;
  const isAgent = user?.role === 'agent';
  const sortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label || 'Last activity';
  const groupNames = useMemo(() => {
    const map = new Map();
    for (const g of meta?.groups || []) map.set(String(g.freshserviceId), g.name);
    return map;
  }, [meta?.groups]);

  const activeFilterCount = [
    segment !== 'all', searchParams.has('status'), assignee, priority, type, origin,
    category, subcategory, group, source, createdFrom || createdTo, due, noise, view, urlSearch,
  ].filter(Boolean).length;

  return (
    <div className="tp-tickets-backdrop min-h-screen">
      <AppHeader activePage="tickets" />

      {/* pb clears the mobile bottom tab bar (QA 07-06 #11) */}
      <main className="max-w-[2200px] mx-auto px-4 sm:px-6 py-6 pb-20 md:pb-6 animate-fadeIn">
        {/* Hero band: gpt-image-2 artwork, content sits on the white fade */}
        <div className="relative overflow-hidden rounded-2xl border border-white/70 shadow-subtle mb-4">
          <img src={ticketsHeroArt} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover object-right" />
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-white/95 via-white/75 to-white/25" />
          <div className="relative px-4 sm:px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold text-slate-900">Tickets</h1>
                <p className="text-sm text-slate-500">
                  {currentWorkspace?.name ? `${currentWorkspace.name} workspace` : 'Workspace'} · tickets born here and synced from FreshService
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={exportCsv}
                  disabled={isExporting || isLoading}
                  className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 bg-white/90 border border-slate-200 rounded-lg hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
                  title="Export the current filtered list as CSV (up to 5000 rows)"
                >
                  <Download className="w-4 h-4" aria-hidden="true" />
                  {isExporting ? 'Exporting…' : 'Export'}
                </button>
                {ticketingOn && (
                  <button
                    onClick={() => navigate('/tickets/new')}
                    className="tp-focus-ring inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-semibold rounded-lg shadow-subtle hover:bg-blue-700 transition-colors"
                  >
                    <Plus className="w-4 h-4" aria-hidden="true" />
                    New ticket
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {metaError && (
          <div className="tp-card rounded-xl p-8 text-center">
            <ShieldCheck className="w-10 h-10 text-slate-300 mx-auto mb-3" aria-hidden="true" />
            <p className="text-slate-700 font-medium">{metaError}</p>
            {isAgent && (
              <p className="text-sm text-slate-500 mt-2">
                You can still manage your skills on <Link to="/my-competencies" className="text-blue-600 hover:underline">My Competencies</Link>.
              </p>
            )}
          </div>
        )}

        {!metaError && meta && !ticketingOn && (
          <div className="tp-card rounded-xl p-8 text-center mb-5">
            <Inbox className="w-10 h-10 text-slate-300 mx-auto mb-3" aria-hidden="true" />
            <p className="text-slate-800 font-semibold">Native ticketing is off for this workspace</p>
            <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
              Tickets still sync in from FreshService below. An admin can enable ticket creation in
              Settings → Workspace Management.
            </p>
          </div>
        )}

        {!metaError && (
          <>
            {/* KPI stat cards — colored icon tile + large number + label */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4" role="group" aria-label="Quick segments">
              {SEGMENTS.map((seg) => {
                const active = segment === seg.key || (seg.key === 'all' && segment === 'all');
                const count = stats?.[SEGMENT_COUNT_KEY[seg.key]];
                const Icon = seg.Icon;
                return (
                  <button
                    key={seg.key}
                    onClick={() => setParams({ segment: seg.key === 'all' ? null : seg.key, status: null })}
                    aria-pressed={active}
                    className={`tp-focus-ring flex items-center gap-3 text-left px-3.5 py-3 rounded-xl bg-white border transition-all ${
                      active ? 'border-blue-300 ring-2 ring-blue-400/40 shadow-soft' : 'border-slate-100 shadow-subtle hover:border-slate-200 hover:shadow-soft'
                    }`}
                  >
                    <span className={`h-10 w-10 rounded-lg inline-flex items-center justify-center flex-shrink-0 ${seg.tile}`}>
                      <Icon className="w-5 h-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-2xl font-bold leading-none tabular-nums ${seg.num}`}>
                        {count == null ? '–' : count.toLocaleString()}
                      </span>
                      <span className="block text-[11px] font-medium text-slate-500 truncate mt-1">{seg.label}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Docked filter rail | main column (rail width animates; the grid
                auto track follows, so collapsing reclaims the space smoothly) */}
            <div className="lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-4 lg:items-start">
              <TicketFilterRail meta={meta} stats={stats} />

              <div className="min-w-0">
                {requesterId && (
                  <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800">
                    <UserRound className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">
                      Showing tickets from <span className="font-semibold">{requesterName || 'this requester'}</span>
                    </span>
                    <button
                      onClick={() => setParams({ requesterId: null, requesterName: null })}
                      className="tp-focus-ring ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-blue-700 hover:bg-blue-100"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" /> Clear
                    </button>
                  </div>
                )}
                <ActiveFilterBar meta={meta} />
                {/* Slim toolbar: search + sort (filters live in the rail) */}
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <button
                    onClick={() => setMobileFilters(true)}
                    className="tp-focus-ring lg:hidden relative inline-flex items-center gap-1.5 px-3 min-h-[44px] py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg order-1"
                  >
                    <ListFilter className="w-4 h-4" aria-hidden="true" />
                    Filters
                    {activeFilterCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-blue-600 text-white text-[10px] font-bold">
                        {activeFilterCount}
                      </span>
                    )}
                  </button>
                  <div className="relative order-3 basis-full min-w-0 sm:order-2 sm:basis-auto sm:flex-1 sm:min-w-[200px]">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                    <input
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search subject, requester, TP-1042 or #12345…"
                      aria-label="Search tickets"
                      className="tp-focus-ring w-full pl-9 pr-8 min-h-[44px] py-2 text-sm bg-white border border-input rounded-lg placeholder:text-slate-400"
                    />
                    {search && (
                      <button
                        onClick={() => setSearch('')}
                        aria-label="Clear search"
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 rounded"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <div ref={sortMenuRef} className="relative order-2 sm:order-3">
                    <button
                      onClick={() => setSortMenuOpen((v) => !v)}
                      aria-expanded={sortMenuOpen}
                      className="tp-focus-ring inline-flex items-center gap-1.5 text-sm bg-white border border-input rounded-lg px-2.5 min-h-[44px] py-2 text-slate-700 hover:border-blue-300"
                    >
                      {dir === 'desc'
                        ? <ArrowDownWideNarrow className="w-4 h-4 text-slate-400" aria-hidden="true" />
                        : <ArrowUpNarrowWide className="w-4 h-4 text-slate-400" aria-hidden="true" />}
                      {sortLabel}
                    </button>
                    {sortMenuOpen && (
                      <div className="absolute right-0 top-full mt-1 z-20 w-48 tp-card rounded-lg shadow-soft p-1" role="menu">
                        {SORT_OPTIONS.map((o) => (
                          <button
                            key={o.value}
                            onClick={() => setSort(o.value, sort === o.value ? dir : 'desc')}
                            className={`tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md hover:bg-blue-50 ${sort === o.value ? 'font-semibold text-blue-700' : 'text-slate-600'}`}
                            role="menuitem"
                          >
                            {o.label}{sort === o.value ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}
                          </button>
                        ))}
                        <div className="border-t border-slate-100 my-1" />
                        <button
                          onClick={() => setSort(sort, dir === 'desc' ? 'asc' : 'desc')}
                          className="tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md hover:bg-blue-50 text-slate-600"
                          role="menuitem"
                        >
                          Switch to {dir === 'desc' ? 'ascending' : 'descending'}
                        </button>
                      </div>
                    )}
                  </div>
                  {/* Row density — trade whitespace for rows-per-screen */}
                  <div className="hidden md:inline-flex items-center rounded-lg border border-input bg-white overflow-hidden" role="group" aria-label="Row density">
                    {[
                      { key: 'comfortable', Icon: Rows2, label: 'Comfortable' },
                      { key: 'compact', Icon: Rows3, label: 'Compact' },
                      { key: 'dense', Icon: Rows4, label: 'Dense' },
                    ].map(({ key, Icon, label }) => (
                      <button
                        key={key}
                        onClick={() => setDensity(key)}
                        aria-pressed={density === key}
                        title={`${label} rows`}
                        className={`tp-focus-ring p-2 transition-colors ${density === key ? 'bg-blue-50 text-blue-600' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
                      >
                        <Icon className="w-4 h-4" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </div>

                {/* Top pagination + Assignment Review connector — controls at both ends */}
                {view !== 'scheduled' && !isLoading && !loadError && (tickets.length > 0 || aiReviewTotal > 0) && (
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    {aiReviewTotal > 0 && (
                      <Link
                        to="/assignments/queue"
                        className="tp-focus-ring inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full border border-indigo-200 bg-indigo-50/80 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 shadow-subtle"
                        title="AI recommendations waiting for a human decision — opens Assignment Review"
                      >
                        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                        {aiReviewTotal} AI suggestion{aiReviewTotal === 1 ? '' : 's'} awaiting review
                        <ChevronRight className="w-3 h-3" aria-hidden="true" />
                      </Link>
                    )}
                    {tickets.length > 0 && (
                      <div className="ml-auto">
                        <Pagination page={page} totalPages={totalPages} total={total} pageSize={PAGE_SIZE} onPage={goPage} compact />
                      </div>
                    )}
                  </div>
                )}

                {/* Results — the peek is a fixed overlay drawer, so nothing here reflows */}
                <div className="relative">
                  {pendingCount > 0 && view !== 'scheduled' && (
                    <div className="absolute top-1.5 left-1/2 -translate-x-1/2 z-20 animate-fadeIn">
                      <button
                        onClick={applyPendingUpdates}
                        className="tp-focus-ring inline-flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-full bg-blue-600 text-white text-xs font-semibold shadow-soft hover:bg-blue-700"
                      >
                        <span aria-hidden="true" className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white/70" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
                        </span>
                        {pendingCount} update{pendingCount === 1 ? '' : 's'} — refresh
                      </button>
                    </div>
                  )}

                  {view === 'scheduled' ? (
                    <ScheduledTicketsPanel ticketingOn={ticketingOn} />
                  ) : isLoading ? (
                    <div className="tp-card rounded-xl p-16 flex items-center justify-center">
                      <Activity className="w-8 h-8 animate-spin text-blue-600" aria-label="Loading tickets" />
                    </div>
                  ) : loadError ? (
                    <div className="tp-card rounded-xl p-8 text-center">
                      <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-2" aria-hidden="true" />
                      <p className="text-slate-700">{loadError}</p>
                      <button onClick={() => fetchTickets()} className="tp-focus-ring mt-3 px-3 py-1.5 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100">
                        Try again
                      </button>
                    </div>
                  ) : tickets.length === 0 ? (
                    <div className="tp-card rounded-xl p-12 text-center">
                      <Inbox className="w-10 h-10 text-slate-300 mx-auto mb-3" aria-hidden="true" />
                      <p className="text-slate-700 font-medium">No tickets match these filters</p>
                      <p className="text-sm text-slate-500 mt-1">Try a different segment or clear the filters in the rail.</p>
                    </div>
                  ) : (
                    <div className="tp-card rounded-xl overflow-hidden">
                      {/* Header */}
                      <div className="hidden md:flex items-stretch border-b border-slate-200 bg-slate-50/80">
                        <span className="flex items-center justify-center w-9 flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleSelectAll}
                            aria-label="Select all tickets on this page"
                            title="Select page"
                            className="tp-focus-ring rounded border-slate-300 text-blue-600"
                          />
                        </span>
                        <div className={`flex-1 ${ROW_GRID} text-[11px] font-semibold uppercase tracking-wide text-slate-400`}>
                          <span aria-hidden="true" />
                          <span className={`${CELL} ${cellPad}`}>
                            <button onClick={() => headerSort('subject')} className="tp-focus-ring uppercase tracking-wide hover:text-blue-600 rounded">
                              Subject{sortIndicator('subject')}
                            </button>
                          </span>
                          <span className={`${CELL} ${cellPad}`}>Type</span>
                          <span className={`${CELL} ${cellPad}`}>Category</span>
                          <span className={`${CELL} ${cellPad}`}>Assignee</span>
                          <span className={`${CELL} ${cellPad}`}>Status</span>
                          <span className={`${CELL} ${cellPad}`}>Due</span>
                          <span className={`${CELL} ${cellPad} justify-end`}>
                            <button onClick={() => headerSort('updatedAt')} className="tp-focus-ring uppercase tracking-wide hover:text-blue-600 rounded text-right">
                              Updated{sortIndicator('updatedAt')}
                            </button>
                          </span>
                        </div>
                      </div>

                      <ul className="divide-y divide-slate-100">
                        {tickets.map((ticket) => {
                          const previewing = previewId === ticket.id;
                          // Left accent bar: blue when this row is the open preview (focus without
                          // washing the whole row), otherwise the priority strip for High/Urgent.
                          const accent = previewing
                            ? 'bg-blue-500'
                            : ticket.priority >= 3 ? (PRIORITY_STRIP_COLORS[ticket.priority] || 'bg-transparent') : 'bg-transparent';
                          const isEditable = ticket.origin === 'ticketpulse' && ticketingOn;
                          // FS-born rows can be reassigned too, via a confirmed FreshService write-back.
                          const fsRowEditable = ticket.origin !== 'ticketpulse' && Boolean(ticket.freshserviceTicketId);
                          const resolvedLike = ['Resolved', 'Closed'].includes(ticket.status);
                          // Deleted/Spam are removed — no SLA/due date applies.
                          const removedLike = ['Deleted', 'Spam'].includes(ticket.status);
                          const mobileAssignable = isEditable || fsRowEditable;
                          // Assignee not in the active team list = deactivated / FS-only (read-only here).
                          const assigneeReadOnly = ticket.assignedTech
                            && !(meta?.technicians || []).some((t) => t.id === ticket.assignedTechId);
                          return (
                            <li
                              key={ticket.id}
                              className={`group flex items-stretch transition-colors cursor-pointer ${
                                previewing ? 'bg-blue-50/50'
                                  : selectedIds.has(ticket.id) ? 'bg-blue-50/40' : 'hover:bg-slate-50'
                              }`}
                              onClick={() => onRowClick(ticket.id)}
                              onDoubleClick={() => onRowDoubleClick(ticket.id)}
                              title="Click to preview (double-click opens)"
                            >
                              <span
                                className="hidden md:flex items-center justify-center w-9 flex-shrink-0"
                                onClick={(e) => e.stopPropagation()}
                                onDoubleClick={(e) => e.stopPropagation()}
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedIds.has(ticket.id)}
                                  onChange={() => toggleSelect(ticket.id)}
                                  aria-label={`Select ${ticket.displayRef}`}
                                  className="tp-focus-ring rounded border-slate-300 text-blue-600"
                                />
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="hidden md:flex">
                                  <div className={`flex-1 ${ROW_GRID}`}>
                                    <span aria-hidden="true" className={`self-stretch ${accent}`} />
                                    {/* Subject block */}
                                    <span className={`${CELL} ${cellPad} flex-col !items-start justify-center gap-0.5`}>
                                      <span className="flex items-center gap-1.5 min-w-0 w-full">
                                        {isEditable
                                          ? <InlinePriorityPicker ticket={ticket} onChanged={refreshAfterEdit} />
                                          : <span title="Synced from FreshService — read-only here"><PriorityDot priority={ticket.priority} /></span>}
                                        <button
                                          onClick={(e) => { e.stopPropagation(); onRowClick(ticket.id); }}
                                          onDoubleClick={(e) => { e.stopPropagation(); onRowDoubleClick(ticket.id); }}
                                          className="tp-focus-ring rounded text-left text-sm font-medium text-slate-800 truncate"
                                        >
                                          {ticket.subject || '(no subject)'}
                                        </button>
                                        <StateChip state={ticket.stateChip} />
                                        {(ticket.tags || []).slice(0, 3).map((tag) => (
                                          <TagChip key={tag.id} tag={tag} size="xs" className="shrink-0" />
                                        ))}
                                        {(ticket.tags || []).length > 3 && (
                                          <span className="shrink-0 text-[10px] text-slate-400" title={ticket.tags.slice(3).map((t) => t.name).join(', ')}>
                                            +{ticket.tags.length - 3}
                                          </span>
                                        )}
                                      </span>
                                      <span className="block w-full text-[11px] text-slate-400 truncate pl-4">
                                        <span className="font-mono">{ticket.displayRef}</span>
                                        {' · '}
                                        {ticket.requester?.name || 'Unknown requester'}
                                        {ticket.requester?.entraCity || ticket.requester?.entraOfficeLocation
                                          ? ` · ${ticket.requester.entraOfficeLocation || ticket.requester.entraCity}` : ''}
                                        {ticket.groupId && groupNames.get(String(ticket.groupId)) && (
                                          <span className="ml-1.5 text-indigo-500 font-medium">· {groupNames.get(String(ticket.groupId))}</span>
                                        )}
                                        {ticket.origin === 'ticketpulse' && <span className="ml-1.5 text-sky-600 font-medium">· TP-born</span>}
                                      </span>
                                    </span>
                                    <span className={`${CELL} ${cellPad}`}><TypePill type={ticket.ticketType} /></span>
                                    {/* Category, leaf-first: the SUBCATEGORY is the most specific
                                        (= most useful) piece, so it gets the primary line; the
                                        parent sits under it and the tooltip carries the full path.
                                        Precedence: TP taxonomy first, legacy single box last. */}
                                    {(() => {
                                      const { category: catLabel, subcategory: subLabel } = ticketCategoryLabels(ticket);
                                      return (
                                        <span
                                          className={`${CELL} ${cellPad} flex-col !items-start justify-center gap-0.5`}
                                          title={[catLabel, subLabel].filter(Boolean).join(' / ') || undefined}
                                        >
                                          {subLabel ? (
                                            <>
                                              <span className="block w-full text-xs font-medium text-slate-700 truncate">{subLabel}</span>
                                              {catLabel && <span className="block w-full text-[10px] text-slate-400 truncate">in {catLabel}</span>}
                                            </>
                                          ) : (
                                            <span className="block w-full text-xs text-slate-600 truncate">{catLabel || '—'}</span>
                                          )}
                                        </span>
                                      );
                                    })()}
                                    {(isEditable || fsRowEditable) ? (
                                      <span className={`${CELL} py-1 gap-1`}>
                                        {ticket.aiBypass && <BypassBadge bypass={ticket.aiBypass} />}
                                        <AssigneePicker
                                          ticketId={ticket.id}
                                          value={ticket.assignedTechId}
                                          currentTech={ticket.assignedTech}
                                          technicians={meta?.technicians || []}
                                          ticketOrigin={ticket.origin}
                                          assignFn={fsRowEditable ? ((techId) => fsAssign(ticket, techId)) : undefined}
                                          onAssigned={refreshAfterEdit}
                                          size="sm"
                                          align="right"
                                          showAi={canReview}
                                          aiSuggestion={canReview ? ticket.ai : null}
                                          onAiAssign={canReview ? () => setAiTicket(ticket) : null}
                                        />
                                      </span>
                                    ) : (
                                      <span
                                        className={`${CELL} py-1 gap-1.5`}
                                        onClick={(e) => e.stopPropagation()}
                                        onDoubleClick={(e) => e.stopPropagation()}
                                      >
                                        {canReview && ticket.ai?.state === 'suggested' && !ticket.assignedTech ? (
                                          <button
                                            onClick={() => setAiTicket(ticket)}
                                            title={`AI suggests ${ticket.ai.techName || 'a technician'}${typeof ticket.ai.score === 'number' ? ` — ${Math.round(ticket.ai.score * 100)}% match` : ''}${ticket.ai.count > 1 ? ` (+${ticket.ai.count - 1} more candidate${ticket.ai.count - 1 === 1 ? '' : 's'})` : ''} · click to review & approve`}
                                            className="tp-focus-ring group flex items-center gap-2 min-w-0 w-full pl-1 pr-2 py-0.5 rounded-full border border-indigo-200/80 bg-gradient-to-r from-indigo-50 to-violet-50 hover:from-indigo-100 hover:to-violet-100 transition-colors text-left"
                                          >
                                            <span className="relative flex-shrink-0">
                                              <PersonAvatar name={ticket.ai.techName} photoUrl={(meta?.technicians || []).find((t) => t.id === ticket.ai.techId)?.photoUrl} size="h-6 w-6" textSize="text-[9px]" />
                                              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-indigo-600 ring-2 ring-white inline-flex items-center justify-center" aria-hidden="true">
                                                <Sparkles className="w-[7px] h-[7px] text-white" />
                                              </span>
                                            </span>
                                            <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">{ticket.ai.techName || 'AI suggestion'}</span>
                                            {typeof ticket.ai.score === 'number' && (
                                              <span className="text-[10px] font-bold text-indigo-600 tabular-nums flex-shrink-0">{Math.round(ticket.ai.score * 100)}%</span>
                                            )}
                                            {ticket.ai.count > 1 && (
                                              <span className="text-[9px] font-medium text-indigo-400 flex-shrink-0">+{ticket.ai.count - 1}</span>
                                            )}
                                          </button>
                                        ) : (
                                          <>
                                            <span className="flex items-center gap-2 min-w-0 flex-1" title="Synced from FreshService — read-only here">
                                              {ticket.assignedTech ? (
                                                <>
                                                  <PersonAvatar name={ticket.assignedTech.name} photoUrl={ticket.assignedTech.photoUrl} />
                                                  <span className="text-xs text-slate-600 truncate">{ticket.assignedTech.name}</span>
                                                </>
                                              ) : (
                                                <UnassignedBadge variant="muted" />
                                              )}
                                            </span>
                                            {!canReview ? null : ticket.ai?.state === 'suggested' ? (
                                              <button
                                                onClick={() => setAiTicket(ticket)}
                                                title={ticket.assignedTech
                                                  ? `Already assigned to ${ticket.assignedTech.name} — AI suggested ${ticket.ai.techName || 'someone'} (informational)`
                                                  : `AI suggests ${ticket.ai.techName || 'a technician'} — review`}
                                                aria-label={ticket.assignedTech ? 'AI suggestion (already assigned)' : 'Review AI suggestion'}
                                                className={`tp-focus-ring p-1 rounded-md flex-shrink-0 ${
                                                  ticket.assignedTech
                                                    ? 'text-slate-300 hover:text-slate-500 hover:bg-slate-50'
                                                    : 'text-indigo-500 hover:bg-indigo-50'
                                                }`}
                                              >
                                                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                                              </button>
                                            ) : ticket.ai?.state === 'analyzing' || ticket.ai?.state === 'queued' ? (
                                              <button
                                                onClick={() => setAiTicket(ticket)}
                                                title={ticket.ai.state === 'analyzing' ? 'AI is analyzing this ticket — watch live' : 'AI run queued for business hours'}
                                                aria-label="AI run in progress"
                                                className="tp-focus-ring p-1 rounded-md text-indigo-400 hover:bg-indigo-50 flex-shrink-0"
                                              >
                                                {ticket.ai.state === 'analyzing'
                                                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                                                  : <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />}
                                              </button>
                                            ) : !ticket.assignedTech && !resolvedLike ? (
                                              <button
                                                onClick={() => setAiTicket(ticket)}
                                                title="Ask AI to assign"
                                                aria-label="Ask AI to assign"
                                                className="tp-focus-ring p-1 rounded-md text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 flex-shrink-0"
                                              >
                                                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                                              </button>
                                            ) : null}
                                          </>
                                        )}
                                      </span>
                                    )}
                                    <span className={`${CELL} py-1`}>
                                      {(isEditable || fsRowEditable) && !removedLike ? (
                                        <StatusPicker
                                          ticketId={ticket.id}
                                          value={ticket.status}
                                          fsChange={fsRowEditable ? ((next) => fsStatusChange(ticket, next)) : null}
                                          onChanged={(next, prev) => {
                                            refreshAfterEdit();
                                            showToast(`${ticket.displayRef} → ${next}`, isEditable ? (async () => {
                                              try { await ticketsAPI.setStatus(ticket.id, prev); refreshAfterEdit(); } catch { /* refresh shows truth */ }
                                            }) : null);
                                          }}
                                        />
                                      ) : (
                                        <StatusPill status={ticket.status} size="sm" />
                                      )}
                                    </span>
                                    <span className={`${CELL} ${cellPad}`}>
                                      {removedLike
                                        ? <span className="text-xs text-slate-300">—</span>
                                        : resolvedLike
                                          ? <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">Done</span>
                                          : ticket.dueBy
                                            ? <SlaChip value={ticket.dueBy} className="!px-1.5 !text-[10px]" />
                                            : <span className="text-xs text-slate-300">—</span>}
                                    </span>
                                    <span
                                      className={`${CELL} ${cellPad} justify-end relative`}
                                      title={ticket.lastActivityAt ? new Date(ticket.lastActivityAt).toLocaleString() : ''}
                                    >
                                      <span className="text-xs text-slate-400 whitespace-nowrap transition-opacity group-hover:opacity-0">
                                        {timeAgo(ticket.lastActivityAt || ticket.updatedAt)}
                                      </span>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); onRowDoubleClick(ticket.id); }}
                                        title="Open full ticket"
                                        aria-label={`Open ${ticket.displayRef}`}
                                        className="tp-focus-ring absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50"
                                      >
                                        <ChevronRight className="w-4 h-4" aria-hidden="true" />
                                      </button>
                                    </span>
                                  </div>
                                </div>

                                {/* Mobile card */}
                                <div className="md:hidden relative px-4 py-3">
                                  <div className="flex items-center gap-2 mb-1">
                                    <PriorityDot priority={ticket.priority} />
                                    <span className="font-mono text-[11px] font-semibold text-slate-500">{ticket.displayRef}</span>
                                    <StateChip state={ticket.stateChip} />
                                    <StatusPill status={ticket.status} className="ml-auto" />
                                  </div>
                                  <p className="text-sm font-medium text-slate-800 line-clamp-2">{ticket.subject || '(no subject)'}</p>
                                  {(() => {
                                    const { category: catLabel, subcategory: subLabel } = ticketCategoryLabels(ticket);
                                    const label = subLabel || catLabel;
                                    return (
                                      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400 min-w-0">
                                        <span className="truncate">{ticket.requester?.name || 'Unknown requester'}</span>
                                        {label && (<><span aria-hidden="true">·</span><span className="truncate text-slate-500">{label}</span></>)}
                                      </div>
                                    );
                                  })()}
                                  <div className="mt-2 flex items-center gap-2">
                                    {mobileAssignable ? (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setAssignSheetTicket(ticket); }}
                                        aria-label={ticket.assignedTech ? `Assignee ${ticket.assignedTech.name} — tap to change` : 'Assign this ticket'}
                                        className="tp-focus-ring flex items-center gap-1.5 min-w-0 max-w-[70%] min-h-[36px] pl-1 pr-2 rounded-lg border border-slate-200 bg-white active:bg-slate-100 transition-colors"
                                      >
                                        {ticket.assignedTech ? (
                                          <>
                                            <PersonAvatar name={ticket.assignedTech.name} photoUrl={ticket.assignedTech.photoUrl} size="h-6 w-6" textSize="text-[9px]" />
                                            <span className="text-xs font-medium text-slate-700 truncate">{ticket.assignedTech.name}</span>
                                            {assigneeReadOnly && (
                                              <span className="flex-shrink-0 text-[8px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded bg-amber-100 text-amber-700">read-only</span>
                                            )}
                                          </>
                                        ) : canReview && ticket.ai?.state === 'suggested' ? (
                                          <>
                                            <span className="h-6 w-6 rounded-full border-[1.5px] border-dashed border-indigo-300 bg-indigo-50 text-indigo-500 inline-flex items-center justify-center flex-shrink-0">
                                              <Sparkles className="w-3 h-3" aria-hidden="true" />
                                            </span>
                                            <span className="text-xs font-semibold text-indigo-700 truncate">AI: {ticket.ai.techName || 'suggestion'}</span>
                                          </>
                                        ) : (
                                          <>
                                            <span className="h-6 w-6 rounded-full border-[1.5px] border-dashed border-slate-300 text-slate-400 inline-flex items-center justify-center flex-shrink-0">
                                              <UserRound className="w-3 h-3" aria-hidden="true" />
                                            </span>
                                            <span className="text-xs font-medium text-slate-500">Assign</span>
                                          </>
                                        )}
                                        <ChevronDown className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" aria-hidden="true" />
                                      </button>
                                    ) : (
                                      <span className="flex items-center gap-1.5 min-w-0 max-w-[70%] text-xs text-slate-500">
                                        {ticket.assignedTech ? (
                                          <>
                                            <PersonAvatar name={ticket.assignedTech.name} photoUrl={ticket.assignedTech.photoUrl} size="h-6 w-6" textSize="text-[9px]" />
                                            <span className="truncate">{ticket.assignedTech.name}</span>
                                          </>
                                        ) : <span className="text-slate-400">Unassigned</span>}
                                      </span>
                                    )}
                                    {ticket.aiBypass && <BypassBadge bypass={ticket.aiBypass} />}
                                    <span className="ml-auto whitespace-nowrap text-[11px] text-slate-400">{timeAgo(ticket.lastActivityAt || ticket.updatedAt)}</span>
                                  </div>
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>

                      {/* Full pagination */}
                      <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50">
                        <Pagination page={page} totalPages={totalPages} total={total} pageSize={PAGE_SIZE} onPage={goPage} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* Peek drawer: fixed overlay, zero layout impact on the list */}
      {previewId && meta && (
        <TicketPreview
          ticketId={previewId}
          meta={meta}
          pulse={pulse}
          onClose={closePreview}
          onChanged={refreshAfterEdit}
          onStep={stepPreview}
          stepInfo={previewIndex >= 0 ? { index: previewIndex, total: tickets.length } : null}
        />
      )}

      {/* Mobile filter bottom sheet (vaul) — always mounted so it animates in/out */}
      <TicketFilterRail meta={meta} stats={stats} sheet mobileOpen={mobileFilters} onMobileClose={() => setMobileFilters(false)} />

      {/* Instant-save toast with Undo (QA 07-06 #3) */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-20 md:bottom-5 right-5 z-[70] flex items-center gap-3 px-4 py-2.5 rounded-lg shadow-soft text-sm font-medium bg-emerald-600 text-white animate-slideInLeft"
        >
          {toast.message}
          {toast.undo && (
            <button
              onClick={() => { const fn = toast.undo; setToast(null); fn(); }}
              className="tp-focus-ring px-2 py-0.5 rounded-md bg-white/20 hover:bg-white/30 text-xs font-bold uppercase tracking-wide"
            >
              Undo
            </button>
          )}
        </div>
      )}

      {/* Mobile touch-first assignment (bottom sheet) */}
      <MobileAssignSheet
        ticket={assignSheetTicket}
        open={Boolean(assignSheetTicket)}
        onClose={() => setAssignSheetTicket(null)}
        technicians={meta?.technicians || []}
        assignFn={assignSheetTicket && assignSheetTicket.origin !== 'ticketpulse' && assignSheetTicket.freshserviceTicketId
          ? ((techId) => fsAssign(assignSheetTicket, techId))
          : null}
        onAssigned={refreshAfterEdit}
        canReview={canReview}
        onAiAssign={canReview && assignSheetTicket ? () => setAiTicket(assignSheetTicket) : null}
      />

      {/* Live AI assignment — full pipeline stream + inline approve */}
      {aiTicket && (
        <AiAssignModal
          ticket={aiTicket}
          onClose={() => setAiTicket(null)}
          onDone={refreshAfterEdit}
        />
      )}

      {fsConfirm && (
        <FsSyncConfirm
          fsRef={fsConfirm.fsRef}
          changes={fsConfirm.changes}
          busy={fsBusy}
          error={fsError}
          onConfirm={runFsSync}
          onCancel={cancelFsSync}
        />
      )}

      {/* Bulk action bar */}
      {(selectedIds.size > 0 || bulkResult || queryScope) && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 tp-card rounded-xl shadow-soft px-4 py-3 flex flex-wrap items-center gap-3 max-w-[94vw] animate-fadeIn border border-slate-200">
          {bulkResult ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                {bulkResult.failed.length === 0
                  ? <Check className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                  : <AlertCircle className="w-4 h-4 text-amber-500" aria-hidden="true" />}
                {bulkResult.ok} updated ({bulkResult.label})
              </span>
              {bulkResult.skipped > 0 && (
                <span className="text-xs text-slate-500">{bulkResult.skipped} FS-born skipped (read-only)</span>
              )}
              {bulkResult.failed.length > 0 && (
                <span className="text-xs text-red-600 max-w-xs truncate" title={bulkResult.failed.map((f) => `${f.ref}: ${f.message}`).join('\n')}>
                  {bulkResult.failed.length} failed — {bulkResult.failed.slice(0, 3).map((f) => f.ref).join(', ')}{bulkResult.failed.length > 3 ? '…' : ''}
                </span>
              )}
              <button
                onClick={() => setBulkResult(null)}
                aria-label="Dismiss result"
                className="tp-focus-ring p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </>
          ) : bulkAction ? (
            <>
              <span className="text-sm text-slate-700">
                {bulkAction.type === 'assign' ? 'Assign' : 'Set'} <strong>{queryScope ? queryScope.editable : editableSelected.length}</strong> ticket{(queryScope ? queryScope.editable : editableSelected.length) === 1 ? '' : 's'}{queryScope ? ' (everything matching this filter)' : ''} to <strong>{bulkAction.label}</strong>?
                {(queryScope ? queryScope.skippedFsBorn : bulkSkipCount) > 0 && <span className="text-xs text-slate-400"> ({queryScope ? queryScope.skippedFsBorn : bulkSkipCount} FS-born skipped)</span>}
              </span>
              <button
                onClick={runBulk}
                disabled={bulkBusy || (queryScope ? queryScope.editable === 0 : editableSelected.length === 0)}
                className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
              >
                {bulkBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Check className="w-4 h-4" aria-hidden="true" />}
                Confirm
              </button>
              <button
                onClick={() => setBulkAction(null)}
                disabled={bulkBusy}
                className="tp-focus-ring px-3 py-1.5 text-sm font-medium rounded-lg text-slate-600 bg-white border border-slate-200 hover:border-slate-300"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="text-sm font-semibold text-slate-800">
                {queryScope ? `All ${queryScope.total} matching selected` : `${selectedIds.size} selected`}
              </span>
              {!queryScope && bulkSkipCount > 0 && (
                <span className="text-xs text-slate-400" title="FreshService-born tickets are mirrors and stay read-only here">
                  {bulkSkipCount} FS-born read-only
                </span>
              )}
              {!queryScope && allSelected && total > pageIds.length && (
                <button
                  onClick={selectAllMatching}
                  className="tp-focus-ring text-xs font-semibold text-blue-600 hover:text-blue-700 px-1.5 py-0.5 rounded"
                >
                  Select all {total} matching
                </button>
              )}
              {queryScope && (
                <button
                  onClick={() => setQueryScope(null)}
                  className="tp-focus-ring text-xs font-medium text-slate-500 hover:text-slate-700 px-1.5 py-0.5 rounded"
                >
                  Back to page selection
                </button>
              )}
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  const tech = (meta?.technicians || []).find((t) => String(t.id) === e.target.value);
                  setBulkAction({
                    type: 'assign',
                    value: e.target.value === 'unassign' ? null : Number(e.target.value),
                    label: e.target.value === 'unassign' ? 'Unassigned' : (tech?.name || 'technician'),
                  });
                }}
                aria-label="Bulk assign"
                className="tp-focus-ring text-sm bg-white border border-input rounded-lg px-2.5 py-1.5 text-slate-700"
              >
                <option value="">Bulk assign…</option>
                <option value="unassign">Unassigned</option>
                {(meta?.technicians || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <select
                value=""
                onChange={(e) => { if (e.target.value) setBulkAction({ type: 'status', value: e.target.value, label: e.target.value }); }}
                aria-label="Bulk status"
                className="tp-focus-ring text-sm bg-white border border-input rounded-lg px-2.5 py-1.5 text-slate-700"
              >
                <option value="">Bulk status…</option>
                {['Open', 'Pending', 'Resolved', 'Closed'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button
                onClick={() => { setSelectedIds(new Set()); setQueryScope(null); }}
                aria-label="Clear selection"
                className="tp-focus-ring p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}

      <MobileTabBar />
    </div>
  );
}
