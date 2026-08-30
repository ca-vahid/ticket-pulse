import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  Activity, AlertCircle, ArrowDownWideNarrow, ArrowUpNarrowWide, Check,
  ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, Inbox,
  Columns3, ListFilter, Loader2, Plus, RefreshCw, Rows2, Rows4, Search, Settings2, ShieldCheck, Sparkles, UserRound, X,
} from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import TicketPreview from '../components/tickets/TicketPreview';
import ScheduledTicketsPanel from '../components/tickets/ScheduledTicketsPanel';
import TicketFilterRail, { ActiveFilterBar } from '../components/tickets/TicketFilterRail';
import TicketBoard from '../components/tickets/TicketBoard';
import MobileAssignSheet from '../components/tickets/MobileAssignSheet';
import { OverridePromptToast, useOverridePrompt } from '../components/tickets/OverridePrompt';
import AiAssignModal from '../components/tickets/AiAssignModal';
import LiveUpdatePill from '../components/tickets/LiveUpdatePill';
import FsSyncConfirm from '../components/tickets/FsSyncConfirm';
import {
  ExternalChip, FeaturedFieldChip, PersonAvatar, PriorityDot, StateChip, StatusPill, TagChip, TypePill,
  PRIORITY_LABELS, PRIORITY_STRIP_COLORS, ticketCategoryLabels, timeAgo,
} from '../components/tickets/ticketUi';
import { baseStatusOf, isTerminalStatus, statusDefsFromMeta, statusNamesForBase, statusToneFromDefs } from '../components/tickets/statusDefs';
import {
  BypassBadge, CELL, ColumnResizeHandle, DEFAULT_COLUMN_KEYS, InlinePriorityPicker, QUEUE_COLUMNS, QueueColumnsMenu,
  buildQueueGridMinWidth, buildQueueGridTemplate, isModifiedClick, normalizeColumnKeys, useColumnWidths,
} from '../components/tickets/queueColumns';
import { QUEUE_CARD_REGISTRY, normalizeQueueCards } from '../components/tickets/queueCards';
import { ticketsAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useWorkspaceRole } from '../components/nav/navDestinations';
import { useSSE } from '../hooks/useSSE';
import ticketsHeroArt from '../assets/tickets-hero.png';
import ticketsHeroArtDark from '../assets/tickets-hero-dark.png';

// Status vocabulary comes from the workspace registry in the queue meta
// (Phase 8b, statusDefs.js) — canonical 4 until meta loads.
const PAGE_SIZE = 25;

const SORT_OPTIONS = [
  { value: 'updatedAt', label: 'Last activity' },
  { value: 'createdAt', label: 'Created date' },
  { value: 'priority', label: 'Priority' },
  { value: 'status', label: 'Status' },
  { value: 'dueBy', label: 'Due date' },
  { value: 'subject', label: 'Subject' },
  { value: 'requester', label: 'Requester' },
  // Optional-column sorts (Phase QC) — nulls-last on the backend, like dueBy.
  { value: 'source', label: 'Source' },
  { value: 'department', label: 'Department' },
];
// Fields whose FIRST click sorts ascending — status asc walks the lifecycle
// Open-first (QA 08-04 #14a) and due asc puts the soonest deadline on top;
// categorical columns (source/department) read A→Z. Desc-first only makes
// sense for recency/priority fields.
const ASC_FIRST_SORTS = new Set(['status', 'dueBy', 'source', 'department']);

// KPI stat cards (mockup: colored icon tile + large number + label). Clicking a
// card applies that segment. WHICH six cards render is an admin choice per
// workspace (Mega 08-23 Phase FC): meta.queueCards → the queueCards.js
// registry (labels/icons/tile tokens/count keys), defaulting to the classic
// six until configured.

// Two row layouts (user picks via the toolbar toggle). No REF column — the
// number lives small under the subject.
//   COMPACT: the Type (INC/REQ) tag folds into the title line, so its column
//     is gone and that width flows into the subject — kills the truncation
//     that a narrow subject track caused.
//   ROOMY: the subject spans row 1 full-width; row 2 holds a slim type slot,
//     then the chosen columns.
//
// Tablet band (QA 08-04 #5/#6): below xl the fixed tracks used to claim 644px
// before the subject saw a single pixel — on an iPad (768 portrait, or 1024
// landscape where the docked filter rail eats ~300px) the subject collapsed
// and the type/External pills crashed into the category column. md→xl runs a
// narrower 6-track template: assignee 210→120, status 116→90, category min
// 150→120, and the Updated column is dropped (its time folds into the meta
// line). The cutoff is xl, not lg, because iPad landscape (1024) IS lg and
// shows the rail — the wide template only fits once the viewport clears it.
//
// Per-user columns (Mega 08-23 Phase QC): the xl+ template is COMPUTED from
// the user's chosen columns (queueColumns.jsx registry) and rides the
// `--tp-q-grid` CSS variable set once on the list card. Headers and rows read
// the SAME variable and place their cells with the same computed
// `--tp-q-col` indexes, so the old header/row alignment invariant now holds
// by construction. Below xl the hardcoded 6-track "essentials" templates
// stay exactly as they were — custom columns are an xl+ feature (the tablet
// band has no width budget, 08-04 sweep) and mobile cards are untouched.
const GRID_COMPACT = 'grid md:grid-cols-[6px_minmax(0,2.4fr)_minmax(100px,0.8fr)_118px_96px_84px] xl:[grid-template-columns:var(--tp-q-grid)] items-center';
const GRID_ROOMY = 'grid md:grid-cols-[6px_60px_minmax(100px,1fr)_118px_96px_84px] xl:[grid-template-columns:var(--tp-q-grid)] items-stretch';

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
  const navBtn = 'tp-focus-ring inline-flex items-center gap-0.5 px-2 py-1.5 text-xs font-semibold rounded-lg border border-border bg-card text-muted-foreground hover:border-blue-300 dark:hover:border-blue-500/40 hover:text-blue-700 dark:hover:text-blue-200 disabled:opacity-35 disabled:hover:border-border disabled:hover:text-muted-foreground transition-colors';
  const rangeText = total === 0
    ? '0 tickets'
    : `${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, total).toLocaleString()} of ${total.toLocaleString()}`;

  const jumpBox = (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/75">
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
        className="tp-focus-ring w-14 text-center text-xs bg-card border border-border rounded-lg px-1 py-1.5 text-foreground/85 placeholder:text-muted-foreground/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      of {totalPages.toLocaleString()}
    </span>
  );

  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? '' : 'justify-between'}`}>
      <span className="text-xs text-muted-foreground whitespace-nowrap">{rangeText}</span>
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
              p === page ? 'bg-blue-600 text-white border-blue-600 shadow-subtle' : 'bg-card text-muted-foreground border-border hover:border-blue-300 dark:hover:border-blue-500/40 hover:text-blue-700 dark:hover:text-blue-200'
            }`}
          >
            {p.toLocaleString()}
          </button>
        ) : (
          <span key={`gap-${i}`} className="px-0.5 text-xs text-muted-foreground/75" aria-hidden="true">…</span>
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
  const location = useLocation();
  // Return address so /tickets/:id's Back control comes back to this exact
  // queue view (filters, page, view — everything in the query string).
  const openTicket = useCallback((id) => navigate(`/tickets/${id}`, {
    state: { from: `${location.pathname}${location.search}` },
  }), [navigate, location.pathname, location.search]);
  // Row anchors (QA 08-07 #7) carry the same return address openTicket sends,
  // so a full-page open via anchor keeps the Back control working.
  const linkState = { from: `${location.pathname}${location.search}` };
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  // AI assignment/review ACTIONS are a reviewer/admin capability — decide/
  // latest-run endpoints are reviewer-gated server-side, so agents/viewers
  // must not get clickable affordances (they'd just 403).
  const wsRole = useWorkspaceRole();
  const canReview = wsRole === 'admin' || wsRole === 'reviewer';
  // Read/act split (QA 08-19 #2): every signed-in member may SEE the pending
  // AI suggestion (the backend already sends the `ai` block to everyone; it's
  // a routing hint, not a people metric) — but for non-reviewers the chip
  // renders read-only: a span, never a button, nothing that can fire a
  // reviewer-gated API.
  const canSeeAi = Boolean(user);
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
  const [manualRefreshing, setManualRefreshing] = useState(false); // force-refresh button
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
  // Workspace status registry (Phase 8b): meta.statuses drives the filterable
  // vocabulary, the default Open+Pending-BASE scope, and pill colors. Falls
  // back to the canonical 4 until meta loads.
  const statusDefs = useMemo(() => statusDefsFromMeta(meta), [meta]);
  const statusFilterNames = useMemo(() => statusDefs.map((d) => d.name), [statusDefs]);
  const defaultStatuses = useMemo(() => statusNamesForBase(statusDefs, ['Open', 'Pending']), [statusDefs]);
  const metaStatusesLoaded = (meta?.statuses?.length || 0) > 0;
  // Keyed on the raw ?status VALUE, not the searchParams object — the object
  // changes identity on every unrelated URL write (?peek= open/close, page),
  // and a fresh `statuses` array identity cascades into queryParams → loud
  // refetch + state clears. Value-keying kills that churn (QA 08-07 #10).
  const statusesRaw = searchParams.get('status');
  const statuses = useMemo(() => {
    if (statusesRaw === 'any') return [];
    if (!statusesRaw) return defaultStatuses;
    // Drop names the workspace doesn't define — but only once meta has
    // loaded; before that, custom names in a shared URL must pass through
    // untouched instead of being silently dropped on first paint.
    return statusesRaw.split(',').filter((s) => (metaStatusesLoaded ? statusFilterNames.includes(s) : Boolean(s)));
  }, [statusesRaw, metaStatusesLoaded, statusFilterNames, defaultStatuses]);
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
  // Custom-field filters (Phase 2): the dynamic cf_* param family forwards to
  // the API verbatim. Serialized so unrelated URL churn (peek, page) doesn't
  // recompute queryParams and refetch the list.
  const cfSerialized = useMemo(() => {
    const pairs = [];
    for (const [k, v] of searchParams.entries()) if (k.startsWith('cf_') && v) pairs.push([k, v]);
    return JSON.stringify(pairs);
  }, [searchParams]);

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

  // Featured custom field (Phase 2): the one workspace definition flagged
  // isFeatured renders as a quiet chip on rows that carry a value.
  const [featuredDef, setFeaturedDef] = useState(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => ticketsAPI.customFieldDefinitions())
      .then((res) => { if (!cancelled) setFeaturedDef((res?.data || []).find((d) => d.isFeatured) || null); })
      .catch(() => { if (!cancelled) setFeaturedDef(null); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  // Row layout — the two ends of the old density spectrum plus the drag-drop
  // Board (QA 07-27 #3). Persisted; migrates the old 3-way density value.
  // KEEP DECLARED BEFORE queryParams: a hook below reading boardMode before
  // this declaration is a temporal-dead-zone crash in the production bundle
  // ("Cannot access 'Vt' before initialization" — the /tickets page rendered
  // blank until this moved up. QA 07-28 hotfix; guarded by the smoke test).
  const [layout, setLayout] = useState(() => {
    try {
      const v = localStorage.getItem('tp_ticket_layout');
      if (v === 'compact' || v === 'roomy' || v === 'board') return v;
      // Migrate legacy density: comfortable → roomy, compact/dense → compact.
      return localStorage.getItem('tp_ticket_density') === 'comfortable' ? 'roomy' : 'compact';
    } catch { return 'compact'; }
  });
  useEffect(() => { try { localStorage.setItem('tp_ticket_layout', layout); } catch { /* no-op */ } }, [layout]);
  // ---- Per-user queue columns (Mega 08-23 Phase QC) ----
  // Ordered visible column keys (subject pinned first). localStorage mirror
  // paints the last known layout instantly; the server preference
  // ('queue.columns', keyed workspace+user) then WINS on load so the layout
  // follows the person across browsers. Writes are optimistic: local state +
  // mirror now, debounced PUT behind them (fire-and-forget).
  const [columnKeys, setColumnKeys] = useState(() => {
    try {
      return normalizeColumnKeys(JSON.parse(localStorage.getItem('tp_queue_columns') || 'null'));
    } catch { return [...DEFAULT_COLUMN_KEYS]; }
  });
  const columnsSaveTimerRef = useRef(null);
  const updateColumns = useCallback((nextKeys) => {
    const next = normalizeColumnKeys(nextKeys);
    setColumnKeys(next);
    try { localStorage.setItem('tp_queue_columns', JSON.stringify(next)); } catch { /* no-op */ }
    if (columnsSaveTimerRef.current) clearTimeout(columnsSaveTimerRef.current);
    columnsSaveTimerRef.current = setTimeout(() => {
      ticketsAPI.setQueuePreference('queue.columns', next).catch(() => { /* local mirror still applies */ });
    }, 600);
  }, []);
  useEffect(() => () => { if (columnsSaveTimerRef.current) clearTimeout(columnsSaveTimerRef.current); }, []);
  useEffect(() => {
    let cancelled = false;
    ticketsAPI.getQueuePreference('queue.columns')
      .then((res) => {
        if (cancelled) return;
        const value = res?.data?.value;
        if (!Array.isArray(value)) return; // never customized — keep defaults/mirror
        const next = normalizeColumnKeys(value);
        setColumnKeys(next);
        try { localStorage.setItem('tp_queue_columns', JSON.stringify(next)); } catch { /* no-op */ }
      })
      .catch(() => { /* offline/legacy backend — the mirror already painted */ });
    return () => { cancelled = true; };
  }, [workspaceId]);
  // ---- Per-user column widths (Mega 08-23 Phase QR) ----
  // Drag-resized px per layout under 'queue.columnWidths' — same mirror +
  // server-wins + debounced-PUT choreography as columnKeys above (the hook
  // owns it). Only touched columns are stored; xl+ only by construction.
  const {
    widths: colWidths, setWidth: commitColumnWidth, resetWidth: resetColumnWidth,
    resetAllWidths, hasCustomWidths,
  } = useColumnWidths(layout, workspaceId);
  // Board view (QA 07-27 #3): Open / Pending / Closed columns with drag-drop.
  const boardMode = layout === 'board';
  // Board density (QA 08-07 #12): cards are far shorter than list rows, so the
  // board fetches a DOUBLE page — 50 cards fill the taller columns instead of
  // stranding three shallow stacks above a pager (backend caps pageSize at
  // 100, so no server change). Every PAGE_SIZE consumer below reads this.
  const effectivePageSize = boardMode ? 50 : PAGE_SIZE;

  const queryParams = useMemo(() => {
    const params = { page, pageSize: effectivePageSize, sort, dir };
    // A segment supplies its own status scope; the checkboxes apply otherwise.
    // Board mode sends the SAME status scope as the list (QA 08-04 #16/#15 —
    // silently fetching every status made the board disagree with the rail
    // and show closed cards under "My open"); its Closed column explains
    // itself when the scope excludes terminal statuses.
    if (segment !== 'all') params.segment = segment;
    else if (statuses.length > 0 && statuses.length < statusFilterNames.length) params.status = statuses.join(',');
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
    for (const [k, v] of JSON.parse(cfSerialized)) params[k] = v;
    if (debouncedSearch) params.q = debouncedSearch;
    return params;
  }, [page, effectivePageSize, statuses, statusFilterNames, assignee, priority, origin, segment, sort, dir, debouncedSearch,
    type, category, subcategory, group, source, createdFrom, createdTo, due, noise, tag, tagMode, impactFilter, urgencyFilter, aiState, requesterId, cfSerialized]);

  // Serialized VALUE of queryParams. Effects that RESET live row state (the
  // pending pill, row FX, bulk selection) key on this instead of the object,
  // so an identity rebuild with identical values (meta arriving, URL churn)
  // never blanks state the user is looking at (QA 08-07 #10).
  const queryKey = useMemo(() => JSON.stringify(queryParams), [queryParams]);

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
  // Live analysis progress per ticket (ticketId → { step, tool }) from the
  // per-turn pipeline SSE pings — renders as "matching skills · step 4" in
  // the AI-choosing chip. Updated in place; never triggers refetches.
  const [aiProgress, setAiProgress] = useState(() => new Map());
  // Manual assignment beat the AI to it (QA 07-13): the human's pick takes
  // the row over INSTANTLY — analysis visuals drop, the assign pop plays with
  // the chosen person — while the background run finishes untouched (it
  // stands down at preflight and keeps the history). Rows in this set render
  // no AI treatment and their run's eventual completion plays no fanfare.
  const manualWinRef = useRef(new Set());
  const [manualWinIds, setManualWinIds] = useState(() => new Set());
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
            if (manualWinRef.current.has(t.id)) {
              // The human already had their moment — the run's completion is
              // bookkeeping, not news. Release the override quietly.
              manualWinRef.current.delete(t.id);
              setManualWinIds(new Set(manualWinRef.current));
            } else if (t.ai?.state === 'suggested' || t.assignedTechId != null) fx.set(t.id, 'aiDone');
            else aiHoldRef.current.set(t.id, Date.now() + 90000);
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

  // Loud (spinner) reloads are reserved for REAL param changes. queryParams
  // can rebuild with identical values (meta landing, workspace re-render) —
  // those refetch SILENTLY so the mounted rows never blank into the loading
  // card mid-look (QA 08-07 #10 / deferred Phase-2 item: refreshes stay
  // visibly non-destructive; the refresh pill and row FX carry the signal).
  const lastFetchKeyRef = useRef(null);
  useEffect(() => {
    const silent = lastFetchKeyRef.current === queryKey;
    lastFetchKeyRef.current = queryKey;
    fetchTickets({ silent });
  }, [fetchTickets, queryKey]);

  // Drop progress labels for rows a refetch shows are no longer analyzing
  // (missed terminal pings, page changes, etc.) so stale "step N" text never
  // outlives the run it described.
  useEffect(() => {
    setAiProgress((current) => {
      if (!current.size) return current;
      let changed = false;
      const next = new Map(current);
      for (const id of current.keys()) {
        const row = tickets.find((t) => t.id === id);
        if (!row || (row.ai?.state !== 'analyzing' && !aiHoldIds.has(id))) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [tickets, aiHoldIds]);

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
  const roomy = layout === 'roomy';
  const cellPad = roomy ? 'py-1.5' : 'py-2.5';
  const [pendingCount, setPendingCount] = useState(0);
  const lastLocalMutationRef = useRef(0);

  // ---- AI assignment: live modal + the Assignment Review connector chip ----
  const [aiTicket, setAiTicket] = useState(null); // ticket whose pipeline modal is open
  const [assignSheetTicket, setAssignSheetTicket] = useState(null); // mobile touch-first assign sheet
  // { message, undo?, tone?, action? } — instant-save feedback (QA 07-06 #3);
  // tone 'red' for loud failures (Phase MB3), `action` {label, run} for a
  // one-click follow-up like "Show it" (Phase MB4).
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = useCallback((message, undo = null, { tone = 'emerald', action = null } = {}) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, undo, tone, action });
    toastTimerRef.current = setTimeout(() => setToast(null), undo || action || tone === 'red' ? 6000 : 3000);
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
    // Per-turn progress pings (running + step): update the chip's stage label
    // in place and stop — no stats refresh, no refetch. With up to 10 runs in
    // parallel these arrive every few seconds; refetching on them would be a
    // sustained request storm. The one exception: a step ping for a row the
    // page doesn't yet SHOW as analyzing falls through and arms it below.
    const isStepPing = data?.action === 'pipeline' && data?.status === 'running' && data?.step;
    if (isStepPing) {
      const tid = Number(data.ticketId);
      const row = ticketsRef.current.find((t) => t.id === tid);
      if (row) {
        setAiProgress((current) => {
          const next = new Map(current);
          next.set(tid, { step: Number(data.step), tool: data.tool || null });
          return next;
        });
        if (row.ai?.state === 'analyzing') return;
      }
      // fall through: first sighting of this run — the row is either not yet
      // showing its halo, or (a brand-new ticket) not on the page at all.
      // Refetch-with-diff either way so arrivals show up being processed.
    }
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      fetchStats();
      setPulse((p) => p + 1);
    }, 400);
    // Pipeline lifecycle events live-update their row in place (the indigo
    // "AI matching" aura appears/clears, the outcome flashes) instead of
    // counting toward the manual-refresh pill — AI runs aren't "unread
    // updates", they're a process the queue should show happening.
    // Shared debounced live refetch: coalesces bursts, and background tabs
    // route to the pill instead so nothing is silently lost.
    const scheduleLiveRefetch = (tid) => {
      if (aiLiveTimerRef.current) clearTimeout(aiLiveTimerRef.current);
      aiLiveTimerRef.current = setTimeout(() => {
        if (document.visibilityState === 'hidden') {
          pendingIdsRef.current.add(tid ?? `evt-${Date.now()}`);
          setPendingCount(pendingIdsRef.current.size);
          return;
        }
        fetchTicketsRef.current({ silent: true, diffAgainst: new Map(ticketsRef.current.map((t) => [t.id, t])) });
      }, 450);
    };

    if (data?.action === 'pipeline') {
      const tid = Number(data.ticketId);
      if (data.status && data.status !== 'running') {
        // Run left the in-flight state — drop its progress label.
        setAiProgress((current) => {
          if (!current.has(tid)) return current;
          const next = new Map(current);
          next.delete(tid);
          return next;
        });
      }
      // Live-apply for VISIBLE rows and for rows not on the page yet — a
      // pipeline ping for an unknown id usually means a brand-new ticket
      // being processed; it should appear with its halo, not hide in the
      // pill (QA 07-10).
      if (tid) scheduleLiveRefetch(tid);
      return;
    }
    // Our own mutation's echo — the list is already fresh.
    if (Date.now() - lastLocalMutationRef.current < 2500) return;
    const tid = data?.ticketId ? Number(data.ticketId) : null;
    const isVisible = tid !== null && ticketsRef.current.some((t) => t.id === tid);
    // New arrivals and changes to rows the user is LOOKING AT apply live —
    // that's how the auto-assign landing (which arrives as a plain
    // ticket-change after the FS round-trip, minutes after the run finished)
    // finally triggers the held assignee pop. Everything else — changes to
    // tickets on other pages/filters — stays behind the refresh pill.
    if (data?.action === 'created' || isVisible) {
      scheduleLiveRefetch(tid);
      return;
    }
    pendingIdsRef.current.add(tid ?? `evt-${Date.now()}`);
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
  // reconnectKey: deterministic stream re-key on workspace switch (realtime
  // plan Phase 1) — workspaceId here already derives from useWorkspace().
  useSSE({ onTicketChange, onPresence, onConnected: onSseConnected, enabled: Boolean(workspaceId), reconnectKey: workspaceId });
  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    if (rowFxTimerRef.current) clearTimeout(rowFxTimerRef.current);
    if (refreshStateTimerRef.current) clearTimeout(refreshStateTimerRef.current);
    if (aiLiveTimerRef.current) clearTimeout(aiLiveTimerRef.current);
    if (aiHoldTimerRef.current) clearTimeout(aiHoldTimerRef.current);
  }, []);
  // A REAL filter/page change reloads the list anyway — drop stale pending
  // state. Keyed on queryKey (values), NOT queryParams (identity): silent
  // refreshes and same-value rebuilds must never blank row FX or the pending
  // pill out from under the user (QA 08-07 #10).
  useEffect(() => {
    pendingIdsRef.current = new Set(); setPendingCount(0); setRowFx(new Map());
    aiHoldRef.current = new Map(); setAiHoldIds(new Set());
    manualWinRef.current = new Set(); setManualWinIds(new Set());
  }, [queryKey]);

  const refreshAfterEdit = useCallback(() => {
    lastLocalMutationRef.current = Date.now(); // swallow our own SSE echo
    fetchTickets({ silent: true });
    fetchStats();
    setPulse((p) => p + 1); // keeps an open preview in sync
  }, [fetchTickets, fetchStats]);

  // Applying an AI suggestion (modal Approve / pick-another) can't use
  // refreshAfterEdit alone: the decide endpoint returns BEFORE the
  // FreshService write-back lands, so an immediate refetch still shows the
  // old assignee and the row sat on "Assign" for minutes until the next sync
  // (QA 08-19, #238146). Show the chosen tech now; the write-back's
  // ticket-change SSE then reconciles the row to the truth — including the
  // rare preflight abort where FS rejects the assignment.
  const onAiApplied = useCallback((ticketId, info) => {
    const applied = info?.decision === 'approved' || info?.decision === 'modified';
    const techId = applied ? Number(info?.assignedTechId) || null : null;
    if (!ticketId || !techId) { refreshAfterEdit(); return; }
    const tech = (meta?.technicians || []).find((t) => t.id === techId);
    setTickets((rows) => rows.map((r) => (r.id === ticketId
      ? {
        ...r,
        assignedTechId: techId,
        assignedTech: tech ? { id: tech.id, name: tech.name, photoUrl: tech.photoUrl } : r.assignedTech,
      }
      : r)));
    fetchStats();
    setPulse((p) => p + 1);
    setRowFx((current) => new Map([...current, [ticketId, 'aiDone']]));
    if (rowFxTimerRef.current) clearTimeout(rowFxTimerRef.current);
    rowFxTimerRef.current = setTimeout(() => setRowFx(new Map()), 3200);
  }, [meta?.technicians, refreshAfterEdit, fetchStats]);

  // Manual assignment from the queue (row picker or mobile sheet). If the AI
  // was mid-analysis on this row, the human wins the UI immediately: halo,
  // capsule and progress vanish now, and once the refetch shows the chosen
  // name the assign pop plays for THAT person — not for whatever the run
  // decides minutes later.
  const onManualAssigned = useCallback(async (ticketId, techId) => {
    lastLocalMutationRef.current = Date.now();
    const row = ticketsRef.current.find((t) => t.id === ticketId);
    const aiWasLive = row?.ai?.state === 'analyzing' || row?.ai?.state === 'queued' || aiHoldRef.current.has(ticketId);
    if (aiWasLive) {
      manualWinRef.current.add(ticketId);
      setManualWinIds(new Set(manualWinRef.current));
      aiHoldRef.current.delete(ticketId);
      setAiProgress((current) => {
        if (!current.has(ticketId)) return current;
        const next = new Map(current);
        next.delete(ticketId);
        return next;
      });
    }
    await fetchTickets({ silent: true });
    fetchStats();
    setPulse((p) => p + 1);
    if (techId != null) {
      setRowFx((current) => new Map([...current, [ticketId, 'aiDone']]));
      if (rowFxTimerRef.current) clearTimeout(rowFxTimerRef.current);
      rowFxTimerRef.current = setTimeout(() => setRowFx(new Map()), 3200);
    }
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
    // A terminal → non-terminal move is a REOPEN (Phase MB5): say so in the
    // confirm so the user knows the resolution stamps come off.
    const reopen = isTerminalStatus(statusDefs, ticket.status) && !isTerminalStatus(statusDefs, nextStatus);
    setFsConfirm({
      ticketId: ticket.id,
      fsRef: String(ticket.freshserviceTicketId),
      changes: [{ field: reopen ? 'Reopen' : 'Status', from: ticket.status, to: nextStatus }],
      payload: { status: nextStatus },
      resolve,
      reject,
    });
  }), [statusDefs]);
  const runFsSync = async () => {
    if (!fsConfirm) return;
    setFsBusy(true); setFsError(null);
    try {
      const res = await ticketsAPI.fsUpdate(fsConfirm.ticketId, fsConfirm.payload);
      refreshAfterEdit();
      // Resolve WITH the {success, data} envelope so the awaiting picker sees
      // data.aiOverride and can raise the "why the override?" prompt (QA 08-04 #9).
      fsConfirm.resolve?.(res);
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
      else openTicket(id);
    }, 220);
  };
  const onRowDoubleClick = (id) => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    openTicket(id);
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
        openTicket(previewId);
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
  }, [previewId, tickets, stepPreview, openTicket, setParams]);
  const [bulkAction, setBulkAction] = useState(null); // { type: 'assign'|'status', value, label }
  const [bulkBusy, setBulkBusy] = useState(false);
  // Aggregated correction loop for bulk assign: if any of the assigned tickets
  // overrode a completed AI decision, ONE toast asks why and records the chosen
  // reason for every overridden ticket (QA 08-04 #9).
  const bulkOverride = useOverridePrompt();
  const [bulkResult, setBulkResult] = useState(null); // { ok, failed: [{ref, message}], skipped }
  // Query scope (gap plan P2.2): the action applies to EVERYTHING matching the
  // current filter, not just the visible page. Set via the preview call.
  const [queryScope, setQueryScope] = useState(null); // { total, editable, skippedFsBorn }
  // Value-keyed like the pending-state reset above: bulk selection survives
  // silent refreshes and same-value queryParams rebuilds (QA 08-07 #10).
  useEffect(() => { setSelectedIds(new Set()); setBulkAction(null); setQueryScope(null); }, [queryKey]);

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
    // Bulk assign over completed AI decisions → one aggregated "why?" prompt.
    if (bulkAction.type === 'assign' && bulkAction.value != null) {
      const overriddenIds = targets
        .filter((_, i) => results[i].status === 'fulfilled' && results[i].value?.data?.aiOverride)
        .map((t) => t.id);
      if (overriddenIds.length > 0) bulkOverride.openPrompt(overriddenIds, bulkAction.value);
    }
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
    else setSort(field, ASC_FIRST_SORTS.has(field) ? 'asc' : 'desc');
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

  const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
  const ticketingOn = meta ? meta.nativeTicketingEnabled : true;
  const isAgent = user?.role === 'agent';
  // Admin-chosen quick filter cards (Phase FC): meta.queueCards resolved
  // against the registry; hardcoded classic six until meta lands (and as the
  // fallback for legacy backends that don't send the key).
  const queueCards = useMemo(() => normalizeQueueCards(meta?.queueCards), [meta?.queueCards]);

  // Board drag-drop → the same origin-aware status flow the StatusPicker uses:
  // TP-born saves directly (undo toast); FS-born goes through the confirmed
  // FreshService write-back modal (QA 07-27 #3).
  // Is a status inside what the queue currently fetches? Segments carry
  // their own scope (mirrors buildListWhere); otherwise the rail's status
  // checkboxes decide (empty = every status).
  const statusInScope = useCallback((status) => {
    const base = baseStatusOf(statusDefs, status);
    if (segment === 'all') return statuses.length === 0 || statuses.includes(status);
    if (['open', 'unassigned', 'awaiting'].includes(segment)) return ['Open', 'Pending'].includes(base);
    if (['due_today', 'overdue'].includes(segment)) return base === 'Open';
    if (segment === 'resolved') return ['Resolved', 'Closed'].includes(base);
    return true; // deleted / noise / created_* — status-agnostic
  }, [segment, statuses, statusDefs]);
  const onBoardStatusDrop = useCallback(async (ticket, nextStatus) => {
    const isTpEditable = ticket.origin === 'ticketpulse' && ticketingOn;
    const reopen = isTerminalStatus(statusDefs, ticket.status) && !isTerminalStatus(statusDefs, nextStatus);
    const label = reopen ? `Reopen ${ticket.displayRef} → ${nextStatus}` : `${ticket.displayRef} → ${nextStatus}`;
    try {
      if (isTpEditable) {
        await ticketsAPI.setStatus(ticket.id, nextStatus);
      } else if (ticket.freshserviceTicketId) {
        await fsStatusChange(ticket, nextStatus); // resolves after the confirm modal syncs
      } else {
        return;
      }
    } catch (err) {
      // A dismissed FS confirm rejects with 'cancelled' — nothing happened,
      // nothing to say. Anything else is a real failure and must be loud
      // (Phase MB3, QA 08-27 #6): the old bare catch turned a 400 into a
      // silent snap-back that looked like "the board is broken".
      if (err?.message === 'cancelled') return;
      refreshAfterEdit();
      // api.js re-throws an enhanced Error whose .message IS the server message
      // (response.data.message) — keep the raw axios shape as a first choice.
      showToast(err?.response?.data?.message || err?.message || `Could not move ${ticket.displayRef} to ${nextStatus}`, null, { tone: 'red' });
      return;
    }
    const undo = isTpEditable
      ? async () => { try { await ticketsAPI.setStatus(ticket.id, ticket.status); refreshAfterEdit(); } catch { /* refresh shows truth */ } }
      : null;
    // No vanish-on-success (Phase MB4): a card dropped into a column the
    // current fetch scope excludes would refetch away and look like a
    // failure. Checkbox scope → widen it (a visible, reversible URL change,
    // the same shape as the board's own "Show closed"). Segment scope can't
    // be widened in place → keep the segment and offer a one-click "Show it".
    if (!statusInScope(nextStatus)) {
      if (segment === 'all') {
        setParams({ status: [...new Set([...statuses, nextStatus])].join(',') });
        showToast(`${label} · filter widened to show it`, undo);
      } else {
        refreshAfterEdit();
        showToast(`${label} — outside the current "${segment.replace(/_/g, ' ')}" view`, undo, {
          action: { label: 'Show it', run: () => setParams({ segment: null, status: [...new Set([...defaultStatuses, nextStatus])].join(',') }) },
        });
      }
      return;
    }
    refreshAfterEdit();
    showToast(label, undo);
  }, [ticketingOn, refreshAfterEdit, showToast, fsStatusChange, statusDefs, statusInScope, segment, statuses, defaultStatuses, setParams]);
  const sortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label || 'Last activity';

  // Board "Closed hidden" affordance: does the effective fetch scope exclude
  // terminal statuses? Segments carry their own scope; otherwise the rail's
  // status checkboxes decide (default Open+Pending bases → yes, hidden).
  // Terminal = Resolved/Closed-BASE, so custom terminal statuses count too
  // (Phase 8b).
  const boardClosedExcluded = segment !== 'all'
    ? ['open', 'unassigned', 'awaiting', 'due_today', 'overdue'].includes(segment)
    : statuses.length > 0 && !statuses.some((s) => isTerminalStatus(statusDefs, s));
  // One-click widen — only meaningful in checkbox scope (a segment's scope
  // isn't expressible as a status list, so there the empty-state is text-only).
  const onBoardShowClosed = segment === 'all' && boardClosedExcluded
    ? () => setParams({ status: [...statuses, ...statusNamesForBase(statusDefs, ['Resolved', 'Closed'])].join(',') })
    : null;
  const groupNames = useMemo(() => {
    const map = new Map();
    for (const g of meta?.groups || []) map.set(String(g.freshserviceId), g.name);
    return map;
  }, [meta?.groups]);

  // ---- Computed column placement (Phase QC) ----
  // Cells render in the registry's canonical DOM order (so the hardcoded md
  // templates keep today's exact projection) and are PLACED at xl+ by
  // explicit grid coordinates: `--tp-q-col` carries each visible column's
  // track index in the user's order, `--tp-q-grid` (set on the list card)
  // carries the matching template. Essentials (category/assignee/status/due)
  // always render for the md band — deselecting one only hides it at xl.
  const colMeta = useMemo(() => {
    const nonSubject = columnKeys.filter((k) => k !== 'subject');
    const start = new Map(nonSubject.map((k, i) => [k, i + 3])); // track 1 = accent, 2 = subject/type slot
    const rowStart = roomy ? 'xl:row-start-2' : 'xl:row-start-1';
    const out = {};
    for (const col of QUEUE_COLUMNS) {
      if (col.key === 'subject') continue;
      const visible = start.has(col.key);
      const pos = visible ? `xl:[grid-column:var(--tp-q-col)] ${rowStart}` : '';
      const headerPos = visible ? 'xl:[grid-column:var(--tp-q-col)] xl:row-start-1' : '';
      const mdVisible = Boolean(col.mdEssential);
      // In roomy the md "Ticket" header span covers the category track, so the
      // category header only exists at xl (matches the pre-QC layout).
      const mdHeaderVisible = mdVisible && !(roomy && col.key === 'category');
      out[col.key] = {
        render: visible || mdVisible,
        cls: mdVisible ? (visible ? pos : 'xl:hidden') : `hidden xl:flex ${pos}`,
        headerRender: visible || mdHeaderVisible,
        headerCls: mdHeaderVisible ? (visible ? headerPos : 'xl:hidden') : `hidden xl:flex ${headerPos}`,
        style: visible ? { '--tp-q-col': start.get(col.key) } : undefined,
      };
    }
    return out;
  }, [columnKeys, roomy]);
  const gridTemplate = useMemo(
    () => buildQueueGridTemplate(columnKeys, { roomy, widths: colWidths }),
    [columnKeys, roomy, colWidths],
  );
  // Overflow floor (QR3): once widths are pinned the header+rows wrapper gets
  // min-width = pinned px + every other column's own floor (+36px checkbox
  // rail), and scrolls horizontally instead of crushing cells — the
  // dashboard's .tp-compact-scroll recipe (index.css:62-66) at xl. 0 (and no
  // scroll container at all) until the user actually resizes something.
  const gridMinWidth = useMemo(
    () => buildQueueGridMinWidth(columnKeys, { roomy, widths: colWidths }),
    [columnKeys, roomy, colWidths],
  );
  const widthsPinned = Object.keys(colWidths).length > 0;
  // Live drag preview (QR2): write the recomputed template straight onto the
  // list card's CSS vars — zero React renders per pointermove; the commit on
  // pointerup re-renders once with the identical values.
  const listCardRef = useRef(null);
  const previewColumnWidth = useCallback((key, px) => {
    const el = listCardRef.current;
    if (!el) return;
    const widths = { ...colWidths, [key]: px };
    el.style.setProperty('--tp-q-grid', buildQueueGridTemplate(columnKeys, { roomy, widths }));
    el.style.setProperty('--tp-q-minw', `${buildQueueGridMinWidth(columnKeys, { roomy, widths }) + 36}px`);
  }, [columnKeys, roomy, colWidths]);
  const rowColumns = useMemo(() => QUEUE_COLUMNS.filter((c) => c.render && colMeta[c.key]?.render), [colMeta]);
  // Phase QX: with the Priority column on, the subject line drops its dot at
  // xl (the column carries dot + word); below xl the column never renders
  // (not an md essential), so the dot stays there. Mobile cards keep theirs.
  const priorityColumnOn = columnKeys.includes('priority');
  const headerColumns = useMemo(() => QUEUE_COLUMNS.filter((c) => c.key !== 'subject' && colMeta[c.key]?.headerRender), [colMeta]);
  const headerPad = roomy ? 'py-2' : cellPad;
  const headerCell = (col) => (
    <span key={col.key} className={`${CELL} relative ${colMeta[col.key].headerCls} ${headerPad} ${col.headerClass || ''}`} style={colMeta[col.key].style}>
      {col.sortField ? (
        <button
          onClick={() => headerSort(col.sortField)}
          title={col.headerTitle}
          className={`tp-focus-ring uppercase tracking-wide hover:text-blue-600 dark:hover:text-blue-300 rounded ${col.headerClass === 'justify-end' ? 'text-right' : ''}`}
        >
          {col.label}{sortIndicator(col.sortField)}
        </button>
      ) : col.headerTitle ? (
        /* Unsortable but explained (State, Phase QX): the derivation lives on
           the header tooltip so the "why no sort?" question answers itself. */
        <span title={col.headerTitle} className="cursor-help">{col.label}</span>
      ) : col.label}
      <ColumnResizeHandle
        colKey={col.key}
        label={col.label}
        minPx={col.minPx}
        value={colWidths[col.key]}
        onPreview={previewColumnWidth}
        onCommit={commitColumnWidth}
        onReset={resetColumnWidth}
      />
    </span>
  );

  const activeFilterCount = [
    segment !== 'all', searchParams.has('status'), assignee, priority, type, origin,
    category, subcategory, group, source, createdFrom || createdTo, due, noise, view, urlSearch,
  ].filter(Boolean).length;

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[var(--tp-rail-w,58px)]">
      <AppHeader activePage="tickets" />

      {/* pb clears the mobile bottom tab bar (QA 07-06 #11) */}
      <main className="max-w-[2200px] mx-auto px-4 sm:px-6 py-6 pb-20 md:pb-6 animate-fadeIn">
        {/* Hero band: gpt-image-2 artwork, content sits on the card-coloured
            fade. Two arts (DM-B): the light wallpaper is a light image that
            cannot be inverted, so the night twin swaps in under `.dark` via
            class visibility (no JS, no flash). The veil is lighter in dark —
            the night art is already deep on its left half, so it only needs
            a thin wash to keep the title crisp. */}
        <div className="relative overflow-hidden rounded-2xl border border-card/70 dark:border-border shadow-subtle mb-4">
          <img src={ticketsHeroArt} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover object-right dark:hidden" />
          {/* object-[right_62%]: the night art's glow band sits below its
              vertical middle — the short desktop band would otherwise crop to
              its darkest strip and read as a plain dark rectangle. */}
          <img src={ticketsHeroArtDark} alt="" aria-hidden="true" className="absolute inset-0 hidden h-full w-full object-cover object-[right_62%] dark:block" />
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-card/95 via-card/75 to-white/25 dark:from-card/60 dark:via-card/25 dark:to-transparent" />
          <div className="relative px-4 sm:px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold text-foreground">Tickets</h1>
                <p className="text-sm text-muted-foreground">
                  {currentWorkspace?.name ? `${currentWorkspace.name} workspace` : 'Workspace'} · tickets born here and synced from FreshService
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={exportCsv}
                  disabled={isExporting || isLoading}
                  className="tp-focus-ring inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-muted-foreground bg-card/90 border border-border rounded-lg hover:border-blue-300 dark:hover:border-blue-500/40 hover:text-blue-700 dark:hover:text-blue-200 disabled:opacity-50"
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
            <ShieldCheck className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" aria-hidden="true" />
            <p className="text-foreground/85 font-medium">{metaError}</p>
            {isAgent && (
              <p className="text-sm text-muted-foreground mt-2">
                You can still manage your skills on <Link to="/my-competencies" className="text-blue-600 dark:text-blue-300 hover:underline">My Competencies</Link>.
              </p>
            )}
          </div>
        )}

        {!metaError && meta && !ticketingOn && (
          <div className="tp-card rounded-xl p-8 text-center mb-5">
            <Inbox className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" aria-hidden="true" />
            <p className="text-foreground font-semibold">Native ticketing is off for this workspace</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Tickets still sync in from FreshService below. An admin can enable ticket creation in
              Settings → Workspace Management.
            </p>
          </div>
        )}

        {!metaError && (
          <>
            {/* KPI stat cards — colored icon tile + large number + label.
                The set comes from meta.queueCards (admin-configurable, Phase
                FC); the hover gear deep-links admins to the configurator. */}
            <div className="relative group/cards grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4" role="group" aria-label="Quick segments">
              {queueCards.map((key) => {
                const seg = QUEUE_CARD_REGISTRY[key];
                const active = segment === key || (key === 'all' && segment === 'all');
                const count = stats?.[seg.countKey];
                const Icon = seg.Icon;
                return (
                  <button
                    key={key}
                    // "All tickets" widens the status scope to match its count
                    // (every non-Deleted/Spam status, like the rail's view) —
                    // clearing to the Open+Pending default made the card lie
                    // (QA 08-04 #1). Other cards carry their own segment scope.
                    onClick={() => setParams({ segment: key === 'all' ? null : key, status: key === 'all' ? 'any' : null })}
                    aria-pressed={active}
                    className={`tp-focus-ring flex items-center gap-3 text-left px-3.5 py-3 rounded-xl bg-card border transition-all ${
                      active ? 'border-blue-300 dark:border-blue-500/40 ring-2 ring-blue-400/40 shadow-soft' : 'border-border/60 shadow-subtle hover:border-border hover:shadow-soft'
                    }`}
                  >
                    <span className={`h-10 w-10 rounded-lg inline-flex items-center justify-center flex-shrink-0 ${seg.tile}`}>
                      <Icon className="w-5 h-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-2xl font-bold leading-none tabular-nums ${seg.num}`}>
                        {count == null ? '–' : count.toLocaleString()}
                      </span>
                      <span className="block text-[11px] font-medium text-muted-foreground truncate mt-1">{seg.label}</span>
                    </span>
                  </button>
                );
              })}
              {wsRole === 'admin' && (
                <Link
                  to="/settings#ticket-ops"
                  aria-label="Customize quick filter cards"
                  title="Customize which six cards show here (Settings → Ticket Ops)"
                  className="tp-focus-ring absolute -top-2 -right-2 z-10 p-1.5 rounded-full bg-card border border-border shadow-subtle text-muted-foreground/75 hover:text-blue-600 dark:hover:text-blue-300 hover:border-blue-200 dark:hover:border-blue-500/30 opacity-0 group-hover/cards:opacity-100 focus:opacity-100 transition-opacity"
                >
                  <Settings2 className="w-3.5 h-3.5" aria-hidden="true" />
                </Link>
              )}
            </div>

            {/* Docked filter rail | main column (rail width animates; the grid
                auto track follows, so collapsing reclaims the space smoothly) */}
            <div className="lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-4 lg:items-start">
              <TicketFilterRail meta={meta} stats={stats} />

              <div className="min-w-0">
                {requesterId && (
                  <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30 text-sm text-blue-800 dark:text-blue-200">
                    <UserRound className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">
                      Showing tickets from <span className="font-semibold">{requesterName || 'this requester'}</span>
                    </span>
                    <button
                      onClick={() => setParams({ requesterId: null, requesterName: null })}
                      className="tp-focus-ring ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-blue-700 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-500/20"
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
                    className="tp-focus-ring lg:hidden relative inline-flex items-center gap-1.5 px-3 min-h-[44px] py-2 text-sm font-medium text-muted-foreground bg-card border border-border rounded-lg order-1"
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
                    <Search className="w-4 h-4 text-muted-foreground/75 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                    <input
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search subject, requester, TP-1042 or #12345… · Ctrl-K for everything"
                      aria-label="Search tickets"
                      className="tp-focus-ring w-full pl-9 pr-8 min-h-[44px] py-2 text-sm bg-card border border-input rounded-lg placeholder:text-muted-foreground/75"
                    />
                    {search && (
                      <button
                        onClick={() => setSearch('')}
                        aria-label="Clear search"
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground/75 hover:text-muted-foreground rounded"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {/* Force refresh — belt-and-suspenders next to the live/SSE
                      machinery: refetches the list + stat cards right now. */}
                  <button
                    onClick={() => { if (!manualRefreshing) { setManualRefreshing(true); Promise.allSettled([fetchTickets({ silent: true }), fetchStats()]).finally(() => setManualRefreshing(false)); } }}
                    disabled={manualRefreshing}
                    aria-label="Refresh tickets now"
                    title="Refresh now"
                    className="tp-focus-ring order-2 sm:order-3 inline-flex items-center justify-center bg-card border border-input rounded-lg px-2.5 min-h-[44px] py-2 text-muted-foreground hover:text-blue-600 dark:hover:text-blue-300 hover:border-blue-300 dark:hover:border-blue-500/40 disabled:opacity-60"
                  >
                    <RefreshCw className={`w-4 h-4 ${manualRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                  </button>
                  <div ref={sortMenuRef} className="relative order-2 sm:order-3">
                    <button
                      onClick={() => setSortMenuOpen((v) => !v)}
                      aria-expanded={sortMenuOpen}
                      className="tp-focus-ring inline-flex items-center gap-1.5 text-sm bg-card border border-input rounded-lg px-2.5 min-h-[44px] py-2 text-foreground/85 hover:border-blue-300 dark:hover:border-blue-500/40"
                    >
                      {dir === 'desc'
                        ? <ArrowDownWideNarrow className="w-4 h-4 text-muted-foreground/75" aria-hidden="true" />
                        : <ArrowUpNarrowWide className="w-4 h-4 text-muted-foreground/75" aria-hidden="true" />}
                      {sortLabel}
                    </button>
                    {sortMenuOpen && (
                      <div className="absolute right-0 top-full mt-1 z-20 w-48 tp-card rounded-lg shadow-soft p-1" role="menu">
                        {SORT_OPTIONS.map((o) => (
                          <button
                            key={o.value}
                            onClick={() => setSort(o.value, sort === o.value ? dir : (ASC_FIRST_SORTS.has(o.value) ? 'asc' : 'desc'))}
                            className={`tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md hover:bg-blue-50 dark:hover:bg-blue-500/15 ${sort === o.value ? 'font-semibold text-blue-700 dark:text-blue-200' : 'text-muted-foreground'}`}
                            role="menuitem"
                          >
                            {o.label}{sort === o.value ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}
                          </button>
                        ))}
                        <div className="border-t border-border/60 my-1" />
                        <button
                          onClick={() => setSort(sort, dir === 'desc' ? 'asc' : 'desc')}
                          className="tp-focus-ring w-full text-left px-2.5 py-1.5 text-sm rounded-md hover:bg-blue-50 dark:hover:bg-blue-500/15 text-muted-foreground"
                          role="menuitem"
                        >
                          Switch to {dir === 'desc' ? 'ascending' : 'descending'}
                        </button>
                      </div>
                    )}
                  </div>
                  {/* View — two list densities plus the drag-drop board
                      (Open / Pending / Closed columns, QA 07-27 #3). */}
                  <div className="hidden md:inline-flex items-center rounded-lg border border-input bg-card overflow-hidden" role="group" aria-label="View layout">
                    {[
                      { key: 'compact', Icon: Rows4, label: 'Compact', hint: 'Type folds into the title — one tight line per ticket. Best for scanning.' },
                      { key: 'roomy', Icon: Rows2, label: 'Roomy', hint: 'The title gets its own line, everything else beneath. Best for reading.' },
                      { key: 'board', Icon: Columns3, label: 'Board', hint: 'Open / Pending / Closed columns — drag a card to change its status (Ticket Pulse tickets save directly; FreshService tickets confirm first).' },
                    ].map(({ key, Icon, label, hint }) => (
                      <button
                        key={key}
                        onClick={() => setLayout(key)}
                        aria-pressed={layout === key}
                        title={hint}
                        className={`tp-focus-ring inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold transition-colors ${layout === key ? 'bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300' : 'text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted/50'}`}
                      >
                        <Icon className="w-4 h-4" aria-hidden="true" />
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* Columns customizer (Phase QC) — list layouts only; the
                      board's columns are statuses, not these. Desktop-only:
                      custom columns apply at xl+ and mobile keeps its cards. */}
                  {!boardMode && (
                    <div className="hidden md:block">
                      <QueueColumnsMenu value={columnKeys} onChange={updateColumns} hasCustomWidths={hasCustomWidths} onResetWidths={resetAllWidths} />
                    </div>
                  )}
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
                            ? 'border-indigo-400 bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-200'
                            : 'border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/80 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/20'
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
                        <Pagination page={page} totalPages={totalPages} total={total} pageSize={effectivePageSize} onPage={goPage} compact />
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
                      <Activity className="w-8 h-8 animate-spin text-blue-600 dark:text-blue-300" aria-label="Loading tickets" />
                    </div>
                  ) : loadError ? (
                    <div className="tp-card rounded-xl p-8 text-center">
                      <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-2" aria-hidden="true" />
                      <p className="text-foreground/85">{loadError}</p>
                      <button onClick={() => fetchTickets()} className="tp-focus-ring mt-3 px-3 py-1.5 text-sm font-medium text-blue-700 dark:text-blue-200 bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-500/20">
                        Try again
                      </button>
                    </div>
                  ) : tickets.length === 0 ? (
                    <div className="tp-card rounded-xl p-12 text-center">
                      <Inbox className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" aria-hidden="true" />
                      <p className="text-foreground/85 font-medium">No tickets match these filters</p>
                      <p className="text-sm text-muted-foreground mt-1">Try a different segment or clear the filters in the rail.</p>
                    </div>
                  ) : boardMode ? (
                    <>
                      <TicketBoard
                        tickets={tickets}
                        ticketingOn={ticketingOn}
                        statusDefs={statusDefs}
                        slaCalendarAware={meta?.slaCalendarAware === true}
                        onCardClick={onRowClick}
                        onCardDoubleClick={onRowDoubleClick}
                        onStatusDrop={onBoardStatusDrop}
                        closedExcluded={boardClosedExcluded}
                        onShowClosed={onBoardShowClosed}
                        paginated={total > effectivePageSize}
                      />
                      {/* Same pagination as the list — the board renders one
                          page sliced into columns, so without this the rest of
                          the queue was simply unreachable (QA 08-04 #16). */}
                      <div className="mt-3 tp-card rounded-xl px-4 py-3">
                        <Pagination page={page} totalPages={totalPages} total={total} pageSize={effectivePageSize} onPage={goPage} />
                      </div>
                    </>
                  ) : (
                    /* --tp-q-grid: the ONE computed xl template header + rows
                       share (Phase QC) — set once here, read via the GRID_*
                       classes, so the two can never drift. */
                    <div
                      ref={listCardRef}
                      className="tp-card rounded-xl overflow-hidden"
                      style={{ '--tp-q-grid': gridTemplate, '--tp-q-minw': `${gridMinWidth + 36}px` }}
                    >
                      {/* Overflow wrapper (QR3): only once widths are pinned —
                          header + rows share ONE horizontal scroll container
                          (the dashboard .tp-compact-scroll recipe,
                          index.css:62-66) with the computed min-width floor,
                          so cells never collapse below minPx when the pinned
                          total outgrows the card (filter-rail expansion).
                          Untouched users keep today's exact non-scrolling DOM
                          behavior (and the last row's inline dropdowns keep
                          their room over the pagination footer). */}
                      <div className={widthsPinned ? 'xl:overflow-x-auto settings-scrollbar' : ''}>
                        <div className={widthsPinned ? 'xl:min-w-[var(--tp-q-minw)]' : ''}>
                          {/* Header */}
                          <div className="hidden md:flex items-stretch border-b border-border bg-muted/40">
                            <span className="flex items-center justify-center w-9 flex-shrink-0">
                              <input
                                type="checkbox"
                                checked={allSelected}
                                onChange={toggleSelectAll}
                                aria-label="Select all tickets on this page"
                                title="Select page"
                                className="tp-focus-ring rounded border-input text-blue-600 dark:text-blue-300"
                              />
                            </span>
                            {roomy ? (
                              /* Roomy header rides the SAME grid as the rows so every
                                 label sits over its column — the old flat flex shoved
                                 one "Status · Due · Updated" clump into the corner
                                 (QA 07-30 #1). At md "Ticket" spans the type+category
                                 tracks; at xl it sits on the slim type slot and every
                                 chosen column gets its own label (the columns are
                                 user-ordered now, so no fixed span can cover them). */
                              <div className={`flex-1 ${GRID_ROOMY} text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75`}>
                                <span aria-hidden="true" />
                                <span className={`${CELL} py-2 [grid-column:2/4] xl:[grid-column:2/3] xl:row-start-1 xl:!px-1.5`}>
                                  <button onClick={() => headerSort('subject')} className="tp-focus-ring uppercase tracking-wide hover:text-blue-600 dark:hover:text-blue-300 rounded whitespace-nowrap">
                                    Ticket{sortIndicator('subject')}
                                  </button>
                                </span>
                                {headerColumns.map(headerCell)}
                              </div>
                            ) : (
                              <div className={`flex-1 ${GRID_COMPACT} text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75`}>
                                <span aria-hidden="true" />
                                <span className={`${CELL} relative ${cellPad} xl:col-start-2 xl:row-start-1`}>
                                  <button onClick={() => headerSort('subject')} className="tp-focus-ring uppercase tracking-wide hover:text-blue-600 dark:hover:text-blue-300 rounded">
                                    Subject{sortIndicator('subject')}
                                  </button>
                                  {/* Subject is resizable in compact only — roomy's
                                      col 2 is the fixed 60px type slot (QR2). */}
                                  <ColumnResizeHandle
                                    colKey="subject"
                                    label="Subject"
                                    minPx={QUEUE_COLUMNS[0].minPx}
                                    value={colWidths.subject}
                                    onPreview={previewColumnWidth}
                                    onCommit={commitColumnWidth}
                                    onReset={resetColumnWidth}
                                  />
                                </span>
                                {headerColumns.map(headerCell)}
                              </div>
                            )}
                          </div>

                          {/* Row dividers ride the --border token (Phase QX, QA 08-27 #4):
                              slate-100 on white measured ≈1.08:1 — invisible on most
                              panels; the token (214 32% 88%) lands ≈1.25:1. Decorative
                              lines, so this is "measurably more visible", not a WCAG
                              claim. Mobile cards share these <li>s — one change, both. */}
                          <ul className="divide-y divide-border">
                            {tickets.map((ticket) => {
                              const previewing = previewId === ticket.id;
                              // The AI assignment pipeline is deciding this ticket RIGHT NOW —
                              // the row gets a live indigo aura so watchers see it happening.
                              // Held rows (run done, assignee write-back still in flight) stay
                              // live so the treatment runs straight through to the name + flash.
                              const aiLive = (ticket.ai?.state === 'analyzing' || aiHoldIds.has(ticket.id)) && !manualWinIds.has(ticket.id);
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
                              const resolvedLike = isTerminalStatus(statusDefs, ticket.status);
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
                              const priorityDot = isEditable
                                ? <InlinePriorityPicker ticket={ticket} onChanged={refreshAfterEdit} />
                                : <PriorityDot priority={ticket.priority} title={`Priority: ${PRIORITY_LABELS[ticket.priority] || ticket.priority} — synced from FreshService, read-only here`} />;
                              const priorityEl = priorityColumnOn
                                ? <span className="xl:hidden inline-flex" data-testid="subject-priority-dot">{priorityDot}</span>
                                : priorityDot;
                              // Real anchor (QA 08-07 #7): right-click → "Open in
                              // new tab" and modified clicks work natively; a plain
                              // left-click preventDefaults into the peek flow.
                              const ticketHref = `/tickets/${ticket.id}`;
                              const subjectBtn = (
                                <Link
                                  to={ticketHref}
                                  state={linkState}
                                  onClick={(e) => { e.stopPropagation(); if (isModifiedClick(e)) return; e.preventDefault(); onRowClick(ticket.id); }}
                                  onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); onRowDoubleClick(ticket.id); }}
                                  className={`tp-focus-ring rounded text-left font-medium text-foreground truncate min-w-0 ${roomy ? 'text-[15px]' : 'text-sm'} ${
                                    fx === 'new' ? 'tp-subject-flash-new' : fx === 'updated' ? 'tp-subject-flash-updated' : ''
                                  }`}
                                >
                                  {ticket.subject || '(no subject)'}
                                </Link>
                              );
                              const subjectChips = (
                                <>
                                  {fx === 'new' && (
                                    <span className="tp-new-chip shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[9px] font-extrabold tracking-widest uppercase" aria-hidden="true">
                                      New
                                    </span>
                                  )}
                                  {ticket.isExternal && <ExternalChip />}
                                  <StateChip state={ticket.stateChip} />
                                  {ticket.hasProposedReply && (
                                    <span
                                      className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-500/15 border border-indigo-200 dark:border-indigo-500/30 text-[9px] font-bold text-indigo-600 dark:text-indigo-300 uppercase tracking-wide"
                                      title="A workflow-drafted reply is waiting for approval on this ticket"
                                    >
                                      <Sparkles className="w-2.5 h-2.5" aria-hidden="true" /> Draft
                                    </span>
                                  )}
                                  {presenceMap[ticket.id]?.length > 0 && (
                                    <span
                                      className="shrink-0 w-2 h-2 rounded-full bg-violet-500 ring-2 ring-violet-200 dark:ring-violet-500/30"
                                      title={`Viewing now: ${presenceMap[ticket.id].map((v) => v.name).join(', ')}`}
                                      role="img"
                                      aria-label={`Being viewed by ${presenceMap[ticket.id].map((v) => v.name).join(', ')}`}
                                    />
                                  )}
                                  {(ticket.tags || []).slice(0, 3).map((tag) => (
                                    <TagChip key={tag.id} tag={tag} size="xs" className="shrink-0" />
                                  ))}
                                  {(ticket.tags || []).length > 3 && (
                                    <span className="shrink-0 text-[10px] text-muted-foreground/75" title={ticket.tags.slice(3).map((t) => t.name).join(', ')}>
                                      +{ticket.tags.length - 3}
                                    </span>
                                  )}
                                  {/* Featured custom field (Phase 2): quiet slate chip on rows with a value */}
                                  {featuredDef && <FeaturedFieldChip def={featuredDef} value={ticket.customFields?.[featuredDef.key]} />}
                                </>
                              );
                              const subjectMeta = (
                                <span className="block w-full text-[11px] text-muted-foreground/75 truncate pl-4">
                                  {/* Ref is an anchor too (QA 08-07 #7) — same
                                      modifier-aware behavior as the subject. */}
                                  <Link
                                    to={ticketHref}
                                    state={linkState}
                                    onClick={(e) => { e.stopPropagation(); if (isModifiedClick(e)) return; e.preventDefault(); onRowClick(ticket.id); }}
                                    className="tp-focus-ring rounded font-mono hover:text-blue-600 dark:hover:text-blue-300"
                                  >
                                    {ticket.displayRef}
                                  </Link>
                                  {/* At xl the requester has a real column (QA 08-07
                                      #6); below xl the meta line keeps name+office
                                      so the tablet band loses nothing. */}
                                  <span className="xl:hidden">
                                    {' · '}
                                    {ticket.requester?.name || 'Unknown requester'}
                                    {ticket.requester?.entraCity || ticket.requester?.entraOfficeLocation
                                      ? ` · ${ticket.requester.entraOfficeLocation || ticket.requester.entraCity}` : ''}
                                  </span>
                                  {ticket.groupId && groupNames.get(String(ticket.groupId)) && (
                                    <span className="ml-1.5 text-indigo-500 font-medium">· {groupNames.get(String(ticket.groupId))}</span>
                                  )}
                                  {ticket.origin === 'ticketpulse' && <span className="ml-1.5 text-sky-600 dark:text-sky-300 font-medium">· TP-born</span>}
                                  {/* Below xl the Updated column is dropped (tablet band) —
                                      its relative time folds into this meta line instead. */}
                                  <span className="xl:hidden">{` · updated ${timeAgo(ticket.lastActivityAt || ticket.updatedAt)}`}</span>
                                </span>
                              );
                              // Everything the registry cell renderers need
                              // (queueColumns.jsx) — built per row, per the ctx
                              // contract documented there.
                              const rowCtx = {
                                cell: (key) => `${CELL} ${colMeta[key]?.cls || ''}`,
                                cellStyle: (key) => colMeta[key]?.style,
                                cellPad,
                                roomy,
                                technicians: meta?.technicians || [],
                                statusDefs,
                                groupNames,
                                slaCalendarAware: meta?.slaCalendarAware === true,
                                canReview,
                                canSeeAi,
                                fx,
                                aiLive,
                                aiProgress: aiProgress.get(ticket.id),
                                isEditable,
                                fsRowEditable,
                                removedLike,
                                resolvedLike,
                                priorityColumnOn,
                                ticketHref,
                                linkState,
                                refreshAfterEdit,
                                showToast,
                                setAiTicket,
                                fsAssign,
                                fsStatusChange,
                                onManualAssigned,
                                onOpenFull: onRowDoubleClick,
                              };
                              const columnCells = rowColumns.map((c) => (
                                <Fragment key={c.key}>{c.render(ticket, rowCtx)}</Fragment>
                              ));
                              return (
                                <motion.li
                                  key={ticket.id}
                                  initial={fx === 'new' ? { opacity: 0, y: -14 } : false}
                                  animate={{ opacity: 1, y: 0 }}
                                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                                  className={`group flex items-stretch transition-colors cursor-pointer ${
                                    aiLive ? 'tp-ai-live'
                                      : previewing ? 'bg-blue-50/50 dark:bg-blue-500/10'
                                        : selectedIds.has(ticket.id) ? 'bg-blue-50/40 dark:bg-blue-500/10' : 'hover:bg-muted/70'
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
                                      className="tp-focus-ring rounded border-input text-blue-600 dark:text-blue-300"
                                    />
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <div className="hidden md:flex">
                                      {roomy ? (
                                        <div className={`flex-1 ${GRID_ROOMY}`}>
                                          <span aria-hidden="true" className={`self-stretch ${accent}`} style={{ gridRow: '1 / 3' }} />
                                          {/* Roomy: the title (+ ref/requester) spans the full width on line 1.
                                              Tightened (QA 07-30 #1): the old py-2 + py-1.5 stack read as
                                              dead space — title now hugs its detail line. */}
                                          <span className="px-3 pt-1.5 pb-0.5 flex flex-col items-start justify-center gap-0.5 min-w-0" style={{ gridColumn: '2 / -1', gridRow: 1 }}>
                                            {/* Wrap below xl: chips fall to a second line in normal
                                                flow instead of overlaying the neighbour column when
                                                the tablet-band subject track runs out (QA 08-04 #6).
                                                The dot+subject stay one non-wrapping unit so the
                                                priority dot never strands on a line of its own. */}
                                            <span className="flex flex-wrap xl:flex-nowrap items-center gap-x-1.5 gap-y-0.5 min-w-0 w-full">
                                              <span className="flex items-center gap-1.5 min-w-0">
                                                {priorityEl}
                                                {subjectBtn}
                                              </span>
                                              {subjectChips}
                                            </span>
                                            {subjectMeta}
                                          </span>
                                          {/* Row 2: the slim type slot, then the chosen
                                              columns (canonical DOM order; xl placement
                                              via --tp-q-col — see colMeta). */}
                                          <span className={`${CELL} ${cellPad} xl:col-start-2 xl:row-start-2`}>{typePill}</span>
                                          {columnCells}
                                        </div>
                                      ) : (
                                        <div className={`flex-1 ${GRID_COMPACT}`}>
                                          <span aria-hidden="true" className={`self-stretch ${accent}`} />
                                          {/* Compact: type folds into the title line so the subject gets the width */}
                                          <span className={`${CELL} ${cellPad} xl:col-start-2 xl:row-start-1 flex-col !items-start justify-center gap-0.5`}>
                                            {/* Wrap below xl — same rationale as the roomy row: pills
                                                wrap under the subject rather than colliding into the
                                                category column on iPad widths (QA 08-04 #6). The
                                                dot+type+subject group never wraps internally, so the
                                                SR/INC pill stays glued to its subject line. */}
                                            <span className="flex flex-wrap xl:flex-nowrap items-center gap-x-1.5 gap-y-0.5 min-w-0 w-full">
                                              <span className="flex items-center gap-1.5 min-w-0">
                                                {priorityEl}
                                                <span className="shrink-0">{typePill}</span>
                                                {subjectBtn}
                                              </span>
                                              {subjectChips}
                                            </span>
                                            {subjectMeta}
                                          </span>
                                          {columnCells}
                                        </div>
                                      )}
                                    </div>

                                    {/* Mobile card */}
                                    <div className="md:hidden relative px-4 py-3">
                                      <div className="flex items-center gap-2 mb-1">
                                        <PriorityDot priority={ticket.priority} />
                                        <span className="font-mono text-[11px] font-semibold text-muted-foreground">{ticket.displayRef}</span>
                                        <StateChip state={ticket.stateChip} />
                                        {fx === 'new' && (
                                          <span className="tp-new-chip shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[9px] font-extrabold tracking-widest uppercase" aria-hidden="true">
                                            New
                                          </span>
                                        )}
                                        {aiLive && (canReview ? (
                                          <button
                                            onClick={(e) => { e.stopPropagation(); setAiTicket(ticket); }}
                                            title="AI is picking the best technician right now"
                                            className="tp-focus-ring tp-ai-chip shrink-0 inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full text-[10px] font-bold text-white"
                                          >
                                            <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                                            AI
                                          </button>
                                        ) : (
                                          /* Read-only for non-reviewers — no modal behind it (QA 08-19 #2). */
                                          <span
                                            onClick={(e) => e.stopPropagation()}
                                            title="AI is picking the best technician right now"
                                            className="tp-ai-chip shrink-0 inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full text-[10px] font-bold text-white"
                                          >
                                            <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                                            AI
                                          </span>
                                        ))}
                                        <StatusPill status={ticket.status} className="ml-auto" tone={statusToneFromDefs(statusDefs, ticket.status)} />
                                      </div>
                                      {/* Anchor for long-press / new-tab on touch +
                                          right-click on small windows (QA 08-07 #7);
                                          plain tap keeps the card's open behavior. */}
                                      <Link
                                        to={ticketHref}
                                        state={linkState}
                                        onClick={(e) => { e.stopPropagation(); if (isModifiedClick(e)) return; e.preventDefault(); onRowClick(ticket.id); }}
                                        className={`text-sm font-medium text-foreground line-clamp-2 ${
                                          fx === 'new' ? 'tp-subject-flash-new' : fx === 'updated' ? 'tp-subject-flash-updated' : ''
                                        }`}
                                      >
                                        {ticket.subject || '(no subject)'}
                                      </Link>
                                      {(() => {
                                        const { category: catLabel, subcategory: subLabel } = ticketCategoryLabels(ticket);
                                        const label = subLabel || catLabel;
                                        return (
                                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/75 min-w-0">
                                            <span className="truncate">{ticket.requester?.name || 'Unknown requester'}</span>
                                            {label && (<><span aria-hidden="true">·</span><span className="truncate text-muted-foreground">{label}</span></>)}
                                          </div>
                                        );
                                      })()}
                                      {(ticket.tags || []).length > 0 && (
                                        <div className="mt-1 flex flex-wrap items-center gap-1">
                                          {ticket.tags.slice(0, 3).map((tag) => <TagChip key={tag.id} tag={tag} size="xs" />)}
                                          {ticket.tags.length > 3 && (
                                            <span className="text-[10px] text-muted-foreground/75" title={ticket.tags.slice(3).map((t) => t.name).join(', ')}>+{ticket.tags.length - 3}</span>
                                          )}
                                        </div>
                                      )}
                                      <div className={`relative mt-2 flex items-center gap-2 ${fx === 'aiDone' ? 'tp-assign-pop' : ''}`}>
                                        {mobileAssignable ? (
                                          <button
                                            onClick={(e) => { e.stopPropagation(); setAssignSheetTicket(ticket); }}
                                            aria-label={ticket.assignedTech ? `Assignee ${ticket.assignedTech.name} — tap to change` : 'Assign this ticket'}
                                            className="tp-focus-ring flex items-center gap-1.5 min-w-0 max-w-[70%] min-h-[36px] pl-1 pr-2 rounded-lg border border-border bg-card active:bg-muted transition-colors"
                                          >
                                            {ticket.assignedTech ? (
                                              <>
                                                <PersonAvatar name={ticket.assignedTech.name} photoUrl={ticket.assignedTech.photoUrl} size="h-6 w-6" textSize="text-[9px]" />
                                                <span className="text-xs font-medium text-foreground/85 truncate">{ticket.assignedTech.name}</span>
                                                {assigneeReadOnly && (
                                                  <span className="flex-shrink-0 text-[8px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200">read-only</span>
                                                )}
                                              </>
                                            ) : canSeeAi && ticket.ai?.state === 'suggested' ? (
                                              /* Visible to every member; the sheet it opens keeps
                                                 approve reviewer-only (read/act split, QA 08-19 #2). */
                                              <>
                                                <span className="h-6 w-6 rounded-full border-[1.5px] border-dashed border-indigo-300 dark:border-indigo-500/40 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-500 inline-flex items-center justify-center flex-shrink-0">
                                                  <Sparkles className="w-3 h-3" aria-hidden="true" />
                                                </span>
                                                <span className="text-xs font-semibold text-indigo-700 dark:text-indigo-200 truncate">AI: {ticket.ai.techName || 'suggestion'}</span>
                                              </>
                                            ) : (
                                              <>
                                                <span className="h-6 w-6 rounded-full border-[1.5px] border-dashed border-input text-muted-foreground/75 inline-flex items-center justify-center flex-shrink-0">
                                                  <UserRound className="w-3 h-3" aria-hidden="true" />
                                                </span>
                                                <span className="text-xs font-medium text-muted-foreground">Assign</span>
                                              </>
                                            )}
                                            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" aria-hidden="true" />
                                          </button>
                                        ) : (
                                          <span className="flex items-center gap-1.5 min-w-0 max-w-[70%] text-xs text-muted-foreground">
                                            {ticket.assignedTech ? (
                                              <>
                                                <PersonAvatar name={ticket.assignedTech.name} photoUrl={ticket.assignedTech.photoUrl} size="h-6 w-6" textSize="text-[9px]" />
                                                <span className="truncate">{ticket.assignedTech.name}</span>
                                              </>
                                            ) : <span className="text-muted-foreground/75">Unassigned</span>}
                                          </span>
                                        )}
                                        {ticket.aiBypass && <BypassBadge bypass={ticket.aiBypass} />}
                                        <span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground/75">{timeAgo(ticket.lastActivityAt || ticket.updatedAt)}</span>
                                      </div>
                                    </div>
                                  </div>
                                </motion.li>
                              );
                            })}
                          </ul>
                        </div>
                      </div>

                      {/* Full pagination */}
                      <div className="px-4 py-3 border-t border-border/60 bg-muted/25">
                        <Pagination page={page} totalPages={totalPages} total={total} pageSize={effectivePageSize} onPage={goPage} />
                        {/* Keyboard hint (gap plan 2 P4.2) — desktop only, keys are pointless on touch */}
                        <p className="hidden lg:flex items-center justify-center gap-3 mt-2 text-[10px] text-muted-foreground/75">
                          <span><kbd className="font-mono border border-border rounded px-1 bg-card">j</kbd>/<kbd className="font-mono border border-border rounded px-1 bg-card">k</kbd> move</span>
                          <span><kbd className="font-mono border border-border rounded px-1 bg-card">↵</kbd> open</span>
                          <span><kbd className="font-mono border border-border rounded px-1 bg-card">x</kbd> select</span>
                          <span><kbd className="font-mono border border-border rounded px-1 bg-card">Ctrl K</kbd> commands</span>
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
          role={toast.tone === 'red' ? 'alert' : 'status'}
          data-tone={toast.tone || 'emerald'}
          className={`fixed bottom-20 md:bottom-5 right-5 z-[70] flex items-center gap-3 px-4 py-2.5 rounded-lg shadow-soft text-sm font-medium text-white animate-slideInLeft ${
            toast.tone === 'red' ? 'bg-red-600' : toast.tone === 'sky' ? 'bg-sky-600' : 'bg-emerald-600'
          }`}
        >
          {toast.message}
          {toast.action && (
            <button
              onClick={() => { const fn = toast.action.run; setToast(null); fn(); }}
              className="tp-focus-ring px-2 py-0.5 rounded-md bg-white/20 hover:bg-white/30 text-xs font-bold uppercase tracking-wide"
            >
              {toast.action.label}
            </button>
          )}
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

      {/* Aggregated "why the override?" toast after a bulk assign (QA 08-04 #9) */}
      <OverridePromptToast
        prompt={bulkOverride.prompt}
        state={bulkOverride.state}
        onReason={bulkOverride.sendReason}
        onDismiss={bulkOverride.dismiss}
      />

      {/* Mobile touch-first assignment (bottom sheet) */}
      <MobileAssignSheet
        ticket={assignSheetTicket}
        open={Boolean(assignSheetTicket)}
        onClose={() => setAssignSheetTicket(null)}
        technicians={meta?.technicians || []}
        assignFn={assignSheetTicket && assignSheetTicket.origin !== 'ticketpulse' && assignSheetTicket.freshserviceTicketId
          ? ((techId) => fsAssign(assignSheetTicket, techId))
          : null}
        onAssigned={(techId) => assignSheetTicket && onManualAssigned(assignSheetTicket.id, techId)}
        canReview={canReview}
        canSeeAi={canSeeAi}
        onAiAssign={canReview && assignSheetTicket ? () => setAiTicket(assignSheetTicket) : null}
      />

      {/* Live AI assignment — full pipeline stream + inline approve */}
      {aiTicket && (
        <AiAssignModal
          ticket={aiTicket}
          onClose={() => setAiTicket(null)}
          onDone={(info) => onAiApplied(aiTicket?.id, info)}
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
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 tp-card rounded-xl shadow-soft px-4 py-3 flex flex-wrap items-center gap-3 max-w-[94vw] animate-fadeIn border border-border">
          {bulkResult ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
                {bulkResult.failed.length === 0
                  ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
                  : <AlertCircle className="w-4 h-4 text-amber-500" aria-hidden="true" />}
                {bulkResult.ok} updated ({bulkResult.label})
              </span>
              {bulkResult.skipped > 0 && (
                <span className="text-xs text-muted-foreground">{bulkResult.skipped} FS-born skipped (read-only)</span>
              )}
              {bulkResult.failed.length > 0 && (
                <span className="text-xs text-red-600 dark:text-red-300 max-w-xs truncate" title={bulkResult.failed.map((f) => `${f.ref}: ${f.message}`).join('\n')}>
                  {bulkResult.failed.length} failed — {bulkResult.failed.slice(0, 3).map((f) => f.ref).join(', ')}{bulkResult.failed.length > 3 ? '…' : ''}
                </span>
              )}
              <button
                onClick={() => setBulkResult(null)}
                aria-label="Dismiss result"
                className="tp-focus-ring p-1 rounded-lg text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </>
          ) : bulkAction ? (
            <>
              <span className="text-sm text-foreground/85">
                {bulkAction.type === 'assign' ? 'Assign' : 'Set'} <strong>{queryScope ? queryScope.editable : editableSelected.length}</strong> ticket{(queryScope ? queryScope.editable : editableSelected.length) === 1 ? '' : 's'}{queryScope ? ' (everything matching this filter)' : ''} to <strong>{bulkAction.label}</strong>?
                {(queryScope ? queryScope.skippedFsBorn : bulkSkipCount) > 0 && <span className="text-xs text-muted-foreground/75"> ({queryScope ? queryScope.skippedFsBorn : bulkSkipCount} FS-born skipped)</span>}
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
                className="tp-focus-ring px-3 py-1.5 text-sm font-medium rounded-lg text-muted-foreground bg-card border border-border hover:border-input"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="text-sm font-semibold text-foreground">
                {queryScope ? `All ${queryScope.total} matching selected` : `${selectedIds.size} selected`}
              </span>
              {!queryScope && bulkSkipCount > 0 && (
                <span className="text-xs text-muted-foreground/75" title="FreshService-born tickets are mirrors and stay read-only here">
                  {bulkSkipCount} FS-born read-only
                </span>
              )}
              {!queryScope && allSelected && total > pageIds.length && (
                <button
                  onClick={selectAllMatching}
                  className="tp-focus-ring text-xs font-semibold text-blue-600 dark:text-blue-300 hover:text-blue-700 dark:hover:text-blue-200 px-1.5 py-0.5 rounded"
                >
                  Select all {total} matching
                </button>
              )}
              {queryScope && (
                <button
                  onClick={() => setQueryScope(null)}
                  className="tp-focus-ring text-xs font-medium text-muted-foreground hover:text-foreground/85 px-1.5 py-0.5 rounded"
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
                className="tp-focus-ring text-sm bg-card border border-input rounded-lg px-2.5 py-1.5 text-foreground/85"
              >
                <option value="">Bulk assign…</option>
                <option value="unassign">Unassigned</option>
                {(meta?.technicians || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <select
                value=""
                onChange={(e) => { if (e.target.value) setBulkAction({ type: 'status', value: e.target.value, label: e.target.value }); }}
                aria-label="Bulk status"
                className="tp-focus-ring text-sm bg-card border border-input rounded-lg px-2.5 py-1.5 text-foreground/85"
              >
                {/* Bulk edits are TP-born-only, so the workspace registry
                    (custom statuses included) is the right vocabulary here. */}
                <option value="">Bulk status…</option>
                {statusFilterNames.map((s) => <option key={s} value={s}>{s}</option>)}
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
                  className="tp-focus-ring text-sm bg-card border border-input rounded-lg px-2.5 py-1.5 text-foreground/85"
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
                  className="tp-focus-ring text-sm bg-card border border-input rounded-lg px-2.5 py-1.5 text-foreground/85"
                >
                  <option value="">Bulk category…</option>
                  <option value="none">Uncategorized</option>
                  {(meta?.categoryTree || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <button
                onClick={() => { setSelectedIds(new Set()); setQueryScope(null); }}
                aria-label="Clear selection"
                className="tp-focus-ring p-1 rounded-lg text-muted-foreground/75 hover:text-muted-foreground hover:bg-muted"
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
