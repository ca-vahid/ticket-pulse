import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  Activity, AlertCircle, ArrowDownWideNarrow, ArrowUpNarrowWide, CalendarDays, Check,
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CornerUpRight, Download, Inbox,
  ListFilter, Loader2, MessageSquare, Plus, Rows2, Rows4, Search, ShieldCheck, Sparkles, Ticket, UserRound, X,
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
import LiveUpdatePill from '../components/tickets/LiveUpdatePill';
import FsSyncConfirm from '../components/tickets/FsSyncConfirm';
import {
  PersonAvatar, PriorityDot, SlaChip, StateChip, StatusPill, TagChip, TypePill, UnassignedBadge,
  PRIORITY_LABELS, PRIORITY_STRIP_COLORS, ticketCategoryLabels, timeAgo,
} from '../components/tickets/ticketUi';
import { ticketsAPI } from '../services/api';
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

// Two row layouts (user picks via the toolbar toggle). No REF column — the
// number lives small under the subject.
//   COMPACT: the Type (INC/REQ) tag folds into the title line, so its column
//     is gone and that width flows into the subject — kills the truncation
//     that a narrow subject track caused. 7 tracks.
//   ROOMY: the subject spans row 1 full-width; these are the row-2 meta tracks
//     (a slim type slot, then category/assignee/status/due/updated). 7 tracks.
const GRID_COMPACT = 'grid grid-cols-[6px_minmax(0,2.4fr)_minmax(150px,1fr)_210px_116px_88px_74px] items-center';
const GRID_ROOMY = 'grid grid-cols-[6px_60px_minmax(150px,1fr)_210px_116px_88px_74px] items-stretch';
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
  const impactFilter = searchParams.get('impact') || '';
  const urgencyFilter = searchParams.get('urgency') || '';
  const view = searchParams.get('view') || '';
  const aiState = searchParams.get('aiState') || '';
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
    if (impactFilter) params.impact = impactFilter;
    if (urgencyFilter) params.urgency = urgencyFilter;
    if (aiState) params.aiState = aiState;
    if (requesterId) params.requesterId = requesterId;
    if (debouncedSearch) params.q = debouncedSearch;
    return params;
  }, [page, statuses, assignee, priority, origin, segment, sort, dir, debouncedSearch,
    type, category, subcategory, group, source, createdFrom, createdTo, due, noise, tag, tagMode, impactFilter, urgencyFilter, aiState, requesterId]);

  // Post-refresh row highlights: ticketId → 'new' | 'updated'. Set when a
  // refresh is asked to diff against the previous page (update-pill apply,
  // live AI pipeline pings) so what changed glows for a few seconds instead
  // of the list just snapping to a new state.
  const [rowFx, setRowFx] = useState(() => new Map());
  const rowFxTimerRef = useRef(null);
  // AI completion hold: the run-finished ping usually arrives BEFORE the
  // assignment write-back lands on the ticket row, so a refetch at that
  // moment shows the run gone but the assignee still empty. Flashing then
  // celebrates an unchanged "Unassigned" cell, and the name pops in a beat
  // later with no fanfare. Instead, rows whose run just ended without a
  // visible outcome keep the live treatment (halo + "AI choosing…") and the
  // completion flash plays on the refetch that actually delivers the name.
  const [aiHoldIds, setAiHoldIds] = useState(() => new Set());
  const aiHoldRef = useRef(new Map()); // ticketId -> hold expiry (epoch ms)
  const aiHoldTimerRef = useRef(null);
  const syncAiHold = useCallback(() => {
    const now = Date.now();
    for (const [id, expiry] of aiHoldRef.current) {
      if (expiry <= now) aiHoldRef.current.delete(id);
    }
    setAiHoldIds((current) => {
      const next = new Set(aiHoldRef.current.keys());
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
    if (aiHoldTimerRef.current) clearTimeout(aiHoldTimerRef.current);
    if (aiHoldRef.current.size) {
      // Expire on schedule even if no further refetch arrives (failed or
      // classify-only runs never deliver an assignee) — the halo must not
      // breathe forever on a row nothing will update.
      const nextExpiry = Math.min(...aiHoldRef.current.values());
      aiHoldTimerRef.current = setTimeout(syncAiHold, Math.max(300, nextExpiry - now));
    }
  }, []);

  const fetchTickets = useCallback(async ({ silent = false, diffAgainst = null } = {}) => {
    if (!silent) setIsLoading(true);
    try {
      const res = await ticketsAPI.list(queryParams);
      const items = res.data.items || [];
      setTickets(items);
      setTotal(res.data.total || 0);
      setLoadError(null);
      if (diffAgainst) {
        const fx = new Map();
        for (const t of items) {
          const prev = diffAgainst.get(t.id);
          if (!prev) fx.set(t.id, 'new');
          // The AI run this row was showing just finished. Play the completion
          // moment (green flush + subject chip + slot ripple) only when the
          // outcome is already visible on the row — otherwise hold and let the
          // refetch that delivers the name trigger it (see aiHoldRef above).
          else if (prev.ai?.state === 'analyzing' && t.ai?.state !== 'analyzing') {
            if (t.ai?.state === 'suggested' || t.assignedTechId != null) fx.set(t.id, 'aiDone');
            else aiHoldRef.current.set(t.id, Date.now() + 15000);
          }
          else if (aiHoldRef.current.has(t.id)) {
            if (t.ai?.state === 'analyzing') aiHoldRef.current.delete(t.id); // a newer run took over
            else if (t.ai?.state === 'suggested' || t.assignedTechId != null) {
              // The held outcome just landed — flash now, WITH the name showing.
              aiHoldRef.current.delete(t.id);
              fx.set(t.id, 'aiDone');
            }
          }
          else if (
            prev.updatedAt !== t.updatedAt
            || prev.lastActivityAt !== t.lastActivityAt
            || prev.status !== t.status
            || prev.assignedTechId !== t.assignedTechId
            || prev.priority !== t.priority
            || (prev.ai?.state || null) !== (t.ai?.state || null)
          ) fx.set(t.id, 'updated');
        }
        if (fx.size) {
          // Merge (don't replace) so an in-flight flash isn't cut short by a
          // second refresh; identical entries won't restart their animation.
          setRowFx((current) => new Map([...current, ...fx]));
          if (rowFxTimerRef.current) clearTimeout(rowFxTimerRef.current);
          rowFxTimerRef.current = setTimeout(() => setRowFx(new Map()), 3200);
        }
        syncAiHold();
      }
      // Hand the ordered id list to the detail page for prev/next navigation.
      try {
        sessionStorage.setItem('tp_ticket_nav', JSON.stringify(items.map((t) => t.id)));
      } catch { /* sessionStorage unavailable */ }
    } catch (err) {
      setLoadError(err.response?.data?.message || err.message);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [queryParams, syncAiHold]);

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
  // Row layout — the two ends of the old density spectrum, each a real layout:
  //   'compact' — type folds into the title, one tight line per ticket (scan a
  //               big queue). 'roomy' — the title gets its own full-width line
  //               with everything else beneath (read, nothing ever clips).
  // Persisted; migrates the old 3-way density value in place.
  const [layout, setLayout] = useState(() => {
    try {
      const v = localStorage.getItem('tp_ticket_layout');
      if (v === 'compact' || v === 'roomy') return v;
      // Migrate legacy density: comfortable → roomy, compact/dense → compact.
      return localStorage.getItem('tp_ticket_density') === 'comfortable' ? 'roomy' : 'compact';
    } catch { return 'compact'; }
  });
  useEffect(() => { try { localStorage.setItem('tp_ticket_layout', layout); } catch { /* no-op */ } }, [layout]);
  const roomy = layout === 'roomy';
  const cellPad = roomy ? 'py-1.5' : 'py-2.5';
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
  // Mirror of the rendered list for diffing/lookup inside SSE callbacks.
  const ticketsRef = useRef([]);
  useEffect(() => { ticketsRef.current = tickets; }, [tickets]);
  // Latest fetcher behind a stable ref — onTicketChange must keep a stable
  // identity (useSSE re-subscribes when it changes) while queryParams churn.
  const fetchTicketsRef = useRef(fetchTickets);
  useEffect(() => { fetchTicketsRef.current = fetchTickets; }, [fetchTickets]);

  // Update-pill lifecycle: idle → busy (refetching) → done ("Up to date"
  // flash) → idle. Ref-guarded so double-clicks don't stack refreshes.
  const [refreshState, setRefreshState] = useState('idle');
  const refreshBusyRef = useRef(false);
  const refreshStateTimerRef = useRef(null);
  const aiLiveTimerRef = useRef(null);

  const applyPendingUpdates = useCallback(async () => {
    if (refreshBusyRef.current) return;
    refreshBusyRef.current = true;
    setRefreshState('busy');
    const before = new Map(ticketsRef.current.map((t) => [t.id, t]));
    pendingIdsRef.current = new Set();
    setPendingCount(0);
    try {
      await fetchTickets({ silent: true, diffAgainst: before });
      fetchStats();
    } finally {
      refreshBusyRef.current = false;
      setRefreshState('done');
      if (refreshStateTimerRef.current) clearTimeout(refreshStateTimerRef.current);
      refreshStateTimerRef.current = setTimeout(() => setRefreshState('idle'), 1100);
    }
  }, [fetchTickets, fetchStats]);

  const onTicketChange = useCallback((data) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      fetchStats();
      setPulse((p) => p + 1);
    }, 400);
    // Pipeline lifecycle events live-update their row in place (the indigo
    // "AI matching" aura appears/clears, the outcome flashes) instead of
    // counting toward the manual-refresh pill — AI runs aren't "unread
    // updates", they're a process the queue should show happening.
    if (data?.action === 'pipeline') {
      const tid = Number(data.ticketId);
      if (tid && ticketsRef.current.some((t) => t.id === tid)) {
        if (aiLiveTimerRef.current) clearTimeout(aiLiveTimerRef.current);
        aiLiveTimerRef.current = setTimeout(() => {
          // Background tabs skip the fetch; the change joins the pill instead
          // so it isn't silently lost when the user comes back.
          if (document.visibilityState === 'hidden') {
            pendingIdsRef.current.add(tid);
            setPendingCount(pendingIdsRef.current.size);
            return;
          }
          fetchTicketsRef.current({ silent: true, diffAgainst: new Map(ticketsRef.current.map((t) => [t.id, t])) });
        }, 450);
      }
      return;
    }
    // Our own mutation's echo — the list is already fresh.
    if (Date.now() - lastLocalMutationRef.current < 2500) return;
    pendingIdsRef.current.add(data?.ticketId ?? `evt-${Date.now()}`);
    setPendingCount(pendingIdsRef.current.size);
  }, [fetchStats]);
  // Reconnect catch-up: every backend deploy/restart drops the SSE connection,
  // and events emitted during the gap are simply lost — without this, the page
  // sat stale forever showing states (e.g. "AI matching…") that had long since
  // resolved, until a manual F5. On any RE-connect, silently refetch and diff
  // so missed changes appear with their normal highlights.
  const sseConnectsRef = useRef(0);
  const onSseConnected = useCallback(() => {
    sseConnectsRef.current += 1;
    if (sseConnectsRef.current === 1) return; // initial connect — list is fresh
    fetchStats();
    fetchTicketsRef.current({ silent: true, diffAgainst: new Map(ticketsRef.current.map((t) => [t.id, t])) });
  }, [fetchStats]);
  // Presence dots (gap plan 2 P4.1): who has which ticket open right now.
  // Snapshot on load, then live deltas over the same SSE connection.
  const [presenceMap, setPresenceMap] = useState({}); // ticketId -> [{email, name}]
  useEffect(() => {
    if (!workspaceId) return;
    ticketsAPI.presenceSnapshot().then((res) => setPresenceMap(res.data || {})).catch(() => {});
  }, [workspaceId]);
  const onPresence = useCallback((data) => {
    if (!data?.ticketId) return;
    setPresenceMap((prev) => {
      const next = { ...prev };
      if (data.viewers?.length) next[data.ticketId] = data.viewers;
      else delete next[data.ticketId];
      return next;
    });
  }, []);
  useSSE({ onTicketChange, onPresence, onConnected: onSseConnected, enabled: Boolean(workspaceId) });
  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    if (rowFxTimerRef.current) clearTimeout(rowFxTimerRef.current);
    if (refreshStateTimerRef.current) clearTimeout(refreshStateTimerRef.current);
    if (aiLiveTimerRef.current) clearTimeout(aiLiveTimerRef.current);
    if (aiHoldTimerRef.current) clearTimeout(aiHoldTimerRef.current);
  }, []);
  // A filter/page change reloads the list anyway — drop stale pending state.
  useEffect(() => {
    pendingIdsRef.current = new Set(); setPendingCount(0); setRowFx(new Map());
    aiHoldRef.current = new Map(); setAiHoldIds(new Set());
  }, [queryParams]);

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

  // ---- Bulk selection & actions (page-scoped, or query-scoped via "Select all N") ----
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  // Keyboard queue navigation (gap plan 2 P4.2): j/k (or ↑/↓) move the peek
  // selection — j with nothing open starts at the top — Enter opens the
  // peeked ticket, x toggles its bulk-select checkbox. Never fires while the
  // focus is in an input/select/composer.
  useEffect(() => {
    if (tickets.length === 0) return undefined;
    const onKey = (e) => {
      const target = e.target;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const down = e.key === 'ArrowDown' || e.key === 'j';
      const up = e.key === 'ArrowUp' || e.key === 'k';
      if (down || up) {
        e.preventDefault();
        if (previewId) stepPreview(down ? 1 : -1);
        else setParams({ peek: tickets[down ? 0 : tickets.length - 1].id }, { resetPage: false });
      } else if (e.key === 'Enter' && previewId) {
        e.preventDefault();
        navigate(`/tickets/${previewId}`);
      } else if (e.key.toLowerCase() === 'x' && previewId) {
        e.preventDefault();
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(previewId)) next.delete(previewId); else next.add(previewId);
          return next;
        });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [previewId, tickets, stepPreview, navigate, setParams]);
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
    <div className="tp-tickets-backdrop min-h-screen md:pl-[14px]">
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
                  {/* Row layout — Compact (tight, type folds into the title) vs
                      Roomy (title on its own line). The two ends of density. */}
                  <div className="hidden md:inline-flex items-center rounded-lg border border-input bg-white overflow-hidden" role="group" aria-label="Row layout">
                    {[
                      { key: 'compact', Icon: Rows4, label: 'Compact', hint: 'Type folds into the title — one tight line per ticket. Best for scanning.' },
                      { key: 'roomy', Icon: Rows2, label: 'Roomy', hint: 'The title gets its own line, everything else beneath. Best for reading.' },
                    ].map(({ key, Icon, label, hint }) => (
                      <button
                        key={key}
                        onClick={() => setLayout(key)}
                        aria-pressed={layout === key}
                        title={hint}
                        className={`tp-focus-ring inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition-colors ${layout === key ? 'bg-blue-50 text-blue-600' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
                      >
                        <Icon className="w-4 h-4" aria-hidden="true" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Top pagination + AI-approval worklist connector — controls at both ends */}
                {view !== 'scheduled' && !isLoading && !loadError && (tickets.length > 0 || (stats?.awaitingApproval || 0) > 0) && (
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    {(stats?.awaitingApproval || 0) > 0 && (
                      <button
                        onClick={() => setParams({ aiState: aiState === 'suggested' ? null : 'suggested', segment: null })}
                        aria-pressed={aiState === 'suggested'}
                        className={`tp-focus-ring inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full border text-xs font-semibold shadow-subtle transition-colors ${
                          aiState === 'suggested'
                            ? 'border-indigo-400 bg-indigo-100 text-indigo-800'
                            : 'border-indigo-200 bg-indigo-50/80 text-indigo-700 hover:bg-indigo-100'
                        }`}
                        title={aiState === 'suggested'
                          ? 'Showing tickets awaiting your AI-suggestion approval — click to clear'
                          : 'Filter to tickets whose AI recommendation is waiting for your decision'}
                      >
                        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                        {stats.awaitingApproval} awaiting AI approval
                        {aiState === 'suggested'
                          ? <X className="w-3 h-3" aria-hidden="true" />
                          : <ChevronRight className="w-3 h-3" aria-hidden="true" />}
                      </button>
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
                  {(pendingCount > 0 || refreshState !== 'idle') && view !== 'scheduled' && (
                    <LiveUpdatePill count={pendingCount} state={refreshState} onApply={applyPendingUpdates} />
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
                        {roomy ? (
                          <div className="flex-1 flex items-center text-[11px] font-semibold uppercase tracking-wide text-slate-400 py-2">
                            <span className="px-3 flex-1">
                              <button onClick={() => headerSort('subject')} className="tp-focus-ring uppercase tracking-wide hover:text-blue-600 rounded">
                                Ticket{sortIndicator('subject')}
                              </button>
                            </span>
                            <span className="px-3 flex-shrink-0">
                              <button onClick={() => headerSort('updatedAt')} className="tp-focus-ring uppercase tracking-wide hover:text-blue-600 rounded">
                                Status · Due · Updated{sortIndicator('updatedAt')}
                              </button>
                            </span>
                          </div>
                        ) : (
                          <div className={`flex-1 ${GRID_COMPACT} text-[11px] font-semibold uppercase tracking-wide text-slate-400`}>
                            <span aria-hidden="true" />
                            <span className={`${CELL} ${cellPad}`}>
                              <button onClick={() => headerSort('subject')} className="tp-focus-ring uppercase tracking-wide hover:text-blue-600 rounded">
                                Subject{sortIndicator('subject')}
                              </button>
                            </span>
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
                        )}
                      </div>

                      <ul className="divide-y divide-slate-100">
                        {tickets.map((ticket) => {
                          const previewing = previewId === ticket.id;
                          // The AI assignment pipeline is deciding this ticket RIGHT NOW —
                          // the row gets a live indigo aura so watchers see it happening.
                          // Held rows (run done, assignee write-back still in flight) stay
                          // live so the treatment runs straight through to the name + flash.
                          const aiLive = ticket.ai?.state === 'analyzing' || aiHoldIds.has(ticket.id);
                          // Post-refresh flash: this row just arrived / changed.
                          const fx = rowFx.get(ticket.id) || null;
                          // Left accent bar: blue when this row is the open preview (focus without
                          // washing the whole row), flowing indigo while AI is assigning, blue for
                          // fresh arrivals, otherwise the priority strip for High/Urgent.
                          const accent = previewing
                            ? 'bg-blue-500'
                            : aiLive ? 'tp-ai-accent'
                              : fx === 'new' ? 'bg-blue-400'
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

                          // ---- Row cell pieces, arranged per layout below (compact:
                          //      one tight line, type folded into the title; roomy:
                          //      title on its own line, everything else beneath). ----
                          const typePill = <TypePill type={ticket.ticketType} />;
                          const priorityEl = isEditable
                            ? <InlinePriorityPicker ticket={ticket} onChanged={refreshAfterEdit} />
                            : <span title="Synced from FreshService — read-only here"><PriorityDot priority={ticket.priority} /></span>;
                          const subjectBtn = (
                            <button
                              onClick={(e) => { e.stopPropagation(); onRowClick(ticket.id); }}
                              onDoubleClick={(e) => { e.stopPropagation(); onRowDoubleClick(ticket.id); }}
                              className={`tp-focus-ring rounded text-left font-medium text-slate-800 truncate min-w-0 ${roomy ? 'text-[15px]' : 'text-sm'} ${
                                fx === 'new' ? 'tp-subject-flash-new' : fx === 'updated' ? 'tp-subject-flash-updated' : ''
                              }`}
                            >
                              {ticket.subject || '(no subject)'}
                            </button>
                          );
                          const subjectChips = (
                            <>
                              {fx === 'new' && (
                                <span className="tp-new-chip shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[9px] font-extrabold tracking-widest uppercase" aria-hidden="true">
                                  New
                                </span>
                              )}
                              {fx === 'aiDone' && (
                                <span
                                  className="tp-ai-done-chip shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-100 border border-emerald-200 text-[9px] font-extrabold tracking-wide uppercase text-emerald-700"
                                  aria-hidden="true"
                                >
                                  ✓ {ticket.assignedTechId ? 'Assigned' : 'Suggested'}
                                </span>
                              )}
                              <StateChip state={ticket.stateChip} />
                              {ticket.hasProposedReply && (
                                <span
                                  className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-indigo-50 border border-indigo-200 text-[9px] font-bold text-indigo-600 uppercase tracking-wide"
                                  title="A workflow-drafted reply is waiting for approval on this ticket"
                                >
                                  <Sparkles className="w-2.5 h-2.5" aria-hidden="true" /> Draft
                                </span>
                              )}
                              {presenceMap[ticket.id]?.length > 0 && (
                                <span
                                  className="shrink-0 w-2 h-2 rounded-full bg-violet-500 ring-2 ring-violet-200"
                                  title={`Viewing now: ${presenceMap[ticket.id].map((v) => v.name).join(', ')}`}
                                  role="img"
                                  aria-label={`Being viewed by ${presenceMap[ticket.id].map((v) => v.name).join(', ')}`}
                                />
                              )}
                              {(ticket.tags || []).slice(0, 3).map((tag) => (
                                <TagChip key={tag.id} tag={tag} size="xs" className="shrink-0" />
                              ))}
                              {(ticket.tags || []).length > 3 && (
                                <span className="shrink-0 text-[10px] text-slate-400" title={ticket.tags.slice(3).map((t) => t.name).join(', ')}>
                                  +{ticket.tags.length - 3}
                                </span>
                              )}
                            </>
                          );
                          const subjectMeta = (
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
                          );
                          // Category, leaf-first: the SUBCATEGORY is the most specific (= most
                          // useful) piece, so it gets the primary line; parent under it.
                          const { category: catLabel, subcategory: subLabel } = ticketCategoryLabels(ticket);
                          const catCell = (
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
                          const assigneeCell = (isEditable || fsRowEditable) ? (
                            <span className={`${CELL} py-1 gap-1 relative`}>
                              {fx === 'aiDone' && <span className="tp-ai-ripple" aria-hidden="true" />}
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
                                aiSuggestion={canReview ? (ticket.ai || (aiLive ? { state: 'analyzing' } : null)) : null}
                                onAiAssign={canReview ? () => setAiTicket(ticket) : null}
                              />
                            </span>
                          ) : (
                            <span
                              className={`${CELL} py-1 gap-1.5 relative`}
                              onClick={(e) => e.stopPropagation()}
                              onDoubleClick={(e) => e.stopPropagation()}
                            >
                              {fx === 'aiDone' && <span className="tp-ai-ripple" aria-hidden="true" />}
                              {aiLive && !ticket.assignedTech ? (
                                canReview ? (
                                  <button
                                    onClick={() => setAiTicket(ticket)}
                                    title="AI is choosing the best person for this ticket — click to watch live. A manual assignment overrides the pick; category & priority detection still finish."
                                    className="tp-focus-ring tp-ai-think flex items-center gap-2 min-w-0 w-full pl-1 pr-2 py-1 rounded-full text-left"
                                  >
                                    <span className="h-6 w-6 rounded-full bg-violet-100 inline-flex items-center justify-center flex-shrink-0">
                                      <Sparkles className="w-3 h-3 text-violet-600 tp-ai-twinkle" aria-hidden="true" />
                                    </span>
                                    <span className="flex flex-col min-w-0 leading-tight">
                                      <span className="text-[9px] font-bold uppercase tracking-wider text-violet-600">AI choosing…</span>
                                      <span className="text-xs italic text-slate-400 truncate">best person for this</span>
                                    </span>
                                  </button>
                                ) : (
                                  <span
                                    title="AI is choosing the best person for this ticket"
                                    className="tp-ai-think flex items-center gap-2 min-w-0 w-full pl-1 pr-2 py-1 rounded-full"
                                  >
                                    <span className="h-6 w-6 rounded-full bg-violet-100 inline-flex items-center justify-center flex-shrink-0">
                                      <Sparkles className="w-3 h-3 text-violet-600 tp-ai-twinkle" aria-hidden="true" />
                                    </span>
                                    <span className="flex flex-col min-w-0 leading-tight">
                                      <span className="text-[9px] font-bold uppercase tracking-wider text-violet-600">AI choosing…</span>
                                      <span className="text-xs italic text-slate-400 truncate">best person for this</span>
                                    </span>
                                  </span>
                                )
                              ) : canReview && ticket.ai?.state === 'suggested' && !ticket.assignedTech ? (
                                <button
                                  onClick={() => setAiTicket(ticket)}
                                  title={`AI suggests ${ticket.ai.techName || 'a technician'}${typeof ticket.ai.score === 'number' ? ` — ${Math.round(ticket.ai.score * 100)}% match` : ''}${ticket.ai.count > 1 ? ` (+${ticket.ai.count - 1} more candidate${ticket.ai.count - 1 === 1 ? '' : 's'})` : ''} · awaiting your approval`}
                                  className="tp-focus-ring group flex items-center gap-2 min-w-0 w-full pl-1 pr-2 py-1 rounded-full border border-dashed border-violet-300 bg-violet-50/60 hover:bg-violet-50 transition-colors text-left"
                                >
                                  <span className="relative flex-shrink-0">
                                    <PersonAvatar name={ticket.ai.techName} photoUrl={(meta?.technicians || []).find((t) => t.id === ticket.ai.techId)?.photoUrl} size="h-6 w-6" textSize="text-[9px]" />
                                    <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-violet-600 ring-2 ring-white inline-flex items-center justify-center" aria-hidden="true">
                                      <Sparkles className="w-[7px] h-[7px] text-white" />
                                    </span>
                                  </span>
                                  <span className="flex flex-col min-w-0 flex-1 leading-tight">
                                    <span className="text-[9px] font-bold uppercase tracking-wider text-violet-600">
                                      Suggested{typeof ticket.ai.score === 'number' ? ` · ${Math.round(ticket.ai.score * 100)}%` : ''}
                                    </span>
                                    <span className="truncate text-xs font-semibold text-slate-800">{ticket.ai.techName || 'AI pick'}</span>
                                  </span>
                                  {ticket.ai.count > 1 && (
                                    <span className="text-[9px] font-medium text-violet-400 flex-shrink-0">+{ticket.ai.count - 1}</span>
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
                                  ) : ticket.ai?.state === 'queued' ? (
                                    <button
                                      onClick={() => setAiTicket(ticket)}
                                      title="AI run queued for business hours"
                                      aria-label="AI run queued"
                                      className="tp-focus-ring p-1 rounded-md text-indigo-400 hover:bg-indigo-50 flex-shrink-0"
                                    >
                                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                                    </button>
                                  ) : ticket.ai?.state === 'analyzing' ? null : !ticket.assignedTech && !resolvedLike ? (
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
                          );
                          const statusCell = (
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
                          );
                          const dueCell = (
                            <span className={`${CELL} ${cellPad}`}>
                              {removedLike
                                ? <span className="text-xs text-slate-300">—</span>
                                : resolvedLike
                                  ? <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">Done</span>
                                  : ticket.dueBy
                                    ? <SlaChip value={ticket.dueBy} className="!px-1.5 !text-[10px]" />
                                    : <span className="text-xs text-slate-300">—</span>}
                            </span>
                          );
                          const updatedCell = (
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
                          );
                          return (
                            <motion.li
                              key={ticket.id}
                              initial={fx === 'new' ? { opacity: 0, y: -14 } : false}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                              className={`group flex items-stretch transition-colors cursor-pointer ${
                                aiLive ? 'tp-ai-live'
                                  : previewing ? 'bg-blue-50/50'
                                    : selectedIds.has(ticket.id) ? 'bg-blue-50/40' : 'hover:bg-slate-50'
                              } ${fx === 'aiDone' ? 'tp-ai-flush' : ''}`}
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
                                  {roomy ? (
                                    <div className={`flex-1 ${GRID_ROOMY}`}>
                                      <span aria-hidden="true" className={`self-stretch ${accent}`} style={{ gridRow: '1 / 3' }} />
                                      {/* Roomy: the title (+ ref/requester) spans the full width on line 1 */}
                                      <span className="px-3 py-2 flex flex-col items-start justify-center gap-0.5 min-w-0" style={{ gridColumn: '2 / -1', gridRow: 1 }}>
                                        <span className="flex items-center gap-1.5 min-w-0 w-full">
                                          {priorityEl}
                                          {subjectBtn}
                                          {subjectChips}
                                        </span>
                                        {subjectMeta}
                                      </span>
                                      {/* Row 2: type, then the usual columns */}
                                      <span className={`${CELL} ${cellPad}`}>{typePill}</span>
                                      {catCell}
                                      {assigneeCell}
                                      {statusCell}
                                      {dueCell}
                                      {updatedCell}
                                    </div>
                                  ) : (
                                    <div className={`flex-1 ${GRID_COMPACT}`}>
                                      <span aria-hidden="true" className={`self-stretch ${accent}`} />
                                      {/* Compact: type folds into the title line so the subject gets the width */}
                                      <span className={`${CELL} ${cellPad} flex-col !items-start justify-center gap-0.5`}>
                                        <span className="flex items-center gap-1.5 min-w-0 w-full">
                                          {priorityEl}
                                          <span className="shrink-0">{typePill}</span>
                                          {subjectBtn}
                                          {subjectChips}
                                        </span>
                                        {subjectMeta}
                                      </span>
                                      {catCell}
                                      {assigneeCell}
                                      {statusCell}
                                      {dueCell}
                                      {updatedCell}
                                    </div>
                                  )}
                                </div>

                                {/* Mobile card */}
                                <div className="md:hidden relative px-4 py-3">
                                  <div className="flex items-center gap-2 mb-1">
                                    <PriorityDot priority={ticket.priority} />
                                    <span className="font-mono text-[11px] font-semibold text-slate-500">{ticket.displayRef}</span>
                                    <StateChip state={ticket.stateChip} />
                                    {fx === 'new' && (
                                      <span className="tp-new-chip shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[9px] font-extrabold tracking-widest uppercase" aria-hidden="true">
                                        New
                                      </span>
                                    )}
                                    {aiLive && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); if (canReview) setAiTicket(ticket); }}
                                        title="AI is picking the best technician right now"
                                        className="tp-focus-ring tp-ai-chip shrink-0 inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full text-[10px] font-bold text-white"
                                      >
                                        <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                                        AI
                                      </button>
                                    )}
                                    <StatusPill status={ticket.status} className="ml-auto" />
                                  </div>
                                  <p className={`text-sm font-medium text-slate-800 line-clamp-2 ${
                                    fx === 'new' ? 'tp-subject-flash-new' : fx === 'updated' ? 'tp-subject-flash-updated' : ''
                                  }`}
                                  >
                                    {ticket.subject || '(no subject)'}
                                  </p>
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
                                  {(ticket.tags || []).length > 0 && (
                                    <div className="mt-1 flex flex-wrap items-center gap-1">
                                      {ticket.tags.slice(0, 3).map((tag) => <TagChip key={tag.id} tag={tag} size="xs" />)}
                                      {ticket.tags.length > 3 && (
                                        <span className="text-[10px] text-slate-400" title={ticket.tags.slice(3).map((t) => t.name).join(', ')}>+{ticket.tags.length - 3}</span>
                                      )}
                                    </div>
                                  )}
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
                            </motion.li>
                          );
                        })}
                      </ul>

                      {/* Full pagination */}
                      <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50">
                        <Pagination page={page} totalPages={totalPages} total={total} pageSize={PAGE_SIZE} onPage={goPage} />
                        {/* Keyboard hint (gap plan 2 P4.2) — desktop only, keys are pointless on touch */}
                        <p className="hidden lg:flex items-center justify-center gap-3 mt-2 text-[10px] text-slate-400">
                          <span><kbd className="font-mono border border-slate-200 rounded px-1 bg-white">j</kbd>/<kbd className="font-mono border border-slate-200 rounded px-1 bg-white">k</kbd> move</span>
                          <span><kbd className="font-mono border border-slate-200 rounded px-1 bg-white">↵</kbd> open</span>
                          <span><kbd className="font-mono border border-slate-200 rounded px-1 bg-white">x</kbd> select</span>
                          <span><kbd className="font-mono border border-slate-200 rounded px-1 bg-white">Ctrl K</kbd> commands</span>
                        </p>
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
              {queryScope && (meta?.tags?.length || 0) > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    const [op, id] = e.target.value.split(':');
                    const tagObj = (meta?.tags || []).find((t) => String(t.id) === id);
                    setBulkAction({
                      type: op === 'add' ? 'add_tags' : 'remove_tags',
                      value: [Number(id)],
                      label: `${op === 'add' ? 'tag +' : 'tag −'} ${tagObj?.name || id}`,
                    });
                  }}
                  aria-label="Bulk tag"
                  className="tp-focus-ring text-sm bg-white border border-input rounded-lg px-2.5 py-1.5 text-slate-700"
                >
                  <option value="">Bulk tag…</option>
                  <optgroup label="Add tag">
                    {(meta?.tags || []).map((t) => <option key={`add-${t.id}`} value={`add:${t.id}`}>+ {t.name}</option>)}
                  </optgroup>
                  <optgroup label="Remove tag">
                    {(meta?.tags || []).map((t) => <option key={`rm-${t.id}`} value={`rm:${t.id}`}>− {t.name}</option>)}
                  </optgroup>
                </select>
              )}
              {queryScope && (meta?.categoryTree?.length || 0) > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value === '') return;
                    const id = e.target.value === 'none' ? null : Number(e.target.value);
                    const name = id ? (meta?.categoryTree || []).find((c) => c.id === id)?.name : 'Uncategorized';
                    setBulkAction({ type: 'set_category', value: id, label: `category → ${name}` });
                  }}
                  aria-label="Bulk category"
                  className="tp-focus-ring text-sm bg-white border border-input rounded-lg px-2.5 py-1.5 text-slate-700"
                >
                  <option value="">Bulk category…</option>
                  <option value="none">Uncategorized</option>
                  {(meta?.categoryTree || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
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
