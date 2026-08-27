import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3, Boxes, Building2, CheckCircle2, Command, Link as LinkIcon, LayoutDashboard,
  ListChecks, Loader2, Mail, Map as MapIcon, Plus, Search, Settings as SettingsIcon, Sparkles,
  Stamp, Ticket as TicketIcon, User, UserCheck, Clock,
} from 'lucide-react';
import { searchAPI, ticketsAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useWorkspaceRole } from './nav/navDestinations';
import { APP_VERSION } from '../data/changelog';
import ChangelogModal from './ChangelogModal';

/**
 * Ctrl/Cmd+K command palette (gap plan 2 P4.2): jump to a page, find a ticket,
 * or act on the ticket you're looking at — without touching the mouse.
 * Mounted once in App.jsx; renders nothing until summoned.
 */

const NAV_ITEMS = [
  { id: 'nav-tickets', label: 'Tickets', path: '/tickets', Icon: TicketIcon, keywords: 'queue inbox' },
  { id: 'nav-new-ticket', label: 'New ticket', path: '/tickets/new', Icon: Plus, keywords: 'create compose' },
  { id: 'nav-approvals', label: 'Approvals', path: '/approvals', Icon: Stamp, keywords: 'pending requests decisions' },
  // `admin: true` = workspace-admin only (v3.7.02 role lockdown): viewers and
  // reviewers get the ticket surface (Tickets, New ticket, Approvals) and
  // nothing else — the palette must not advertise pages AdminRoute bounces.
  { id: 'nav-dashboard', label: 'Dashboard', path: '/dashboard', Icon: LayoutDashboard, keywords: 'home workload technicians', full: true, admin: true },
  { id: 'nav-timeline', label: 'Timeline Explorer', path: '/timeline', Icon: Clock, keywords: 'ownership coverage history', full: true, admin: true },
  // Labels mirror the side-rail/page titles exactly (QA 07-28 #1) — a palette
  // entry that says "Assignment Review" for a page titled "Assignment" reads
  // as two different destinations.
  { id: 'nav-analytics', label: 'Analytics', path: '/analytics', Icon: BarChart3, keywords: 'reports charts demand quality insights', full: true, admin: true },
  { id: 'nav-assignments', label: 'Assignment', path: '/assignments', Icon: UserCheck, keywords: 'ai review pipeline assignment review', full: true, admin: true },
  { id: 'nav-workflows', label: 'Mail Workflows', path: '/workflows', Icon: Mail, keywords: 'automation rules triggers templates notifications', full: true, admin: true },
  { id: 'nav-visuals', label: 'Agent Maps', path: '/visuals', Icon: MapIcon, keywords: 'map schedule agents visuals locations', full: true, admin: true },
  { id: 'nav-settings', label: 'Settings', path: '/settings', Icon: SettingsIcon, keywords: 'workflows mail admin config', full: true, admin: true },
  { id: 'nav-competencies', label: 'My Competencies', path: '/my-competencies', Icon: UserCheck, keywords: 'skills profile', agent: true },
];

const STATUS_STYLES = {
  Open: 'bg-blue-50 text-blue-700',
  Pending: 'bg-amber-50 text-amber-700',
  Resolved: 'bg-emerald-50 text-emerald-700',
  Closed: 'bg-slate-100 text-slate-500',
};

// Task lifecycle chips (ticket_tasks.status → label + tint).
const TASK_STATUS = {
  open: { label: 'Open', style: 'bg-blue-50 text-blue-700' },
  in_progress: { label: 'In progress', style: 'bg-amber-50 text-amber-700' },
  done: { label: 'Done', style: 'bg-emerald-50 text-emerald-700' },
};

// Multi-entity search scopes (QA 08-04 #2): the pill row under the input.
// 'all' keeps the classic palette (nav + workspace + actions) alongside every
// entity section; a specific pill narrows both the request and the list.
const SCOPES = [
  { id: 'all', label: 'All' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'agents', label: 'Agents' },
  { id: 'requesters', label: 'Requesters' },
  { id: 'departments', label: 'Departments' },
];

const EMPTY_SECTIONS = { tickets: [], tasks: [], agents: [], requesters: [], departments: [] };

function matches(query, ...haystacks) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystacks.some((h) => (h || '').toLowerCase().includes(q));
}

export default function CommandPalette() {
  const { user, isAuthenticated } = useAuth();
  const { currentWorkspace, availableWorkspaces, switchWorkspace } = useWorkspace();
  const wsRole = useWorkspaceRole();
  const navigate = useNavigate();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [scope, setScope] = useState('all');
  const [sections, setSections] = useState(EMPTY_SECTIONS);
  const [searching, setSearching] = useState(false);
  const [context, setContext] = useState(null); // { ticket, myTechId } when on a detail page
  const [actionError, setActionError] = useState(null);
  const [actionBusy, setActionBusy] = useState(null);
  const inputRef = useRef(null);
  const searchTimerRef = useRef(null);
  const searchSeqRef = useRef(0);

  const ready = isAuthenticated && Boolean(currentWorkspace);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSections(EMPTY_SECTIONS);
    setScope('all');
    setActiveIndex(0);
    setContext(null);
    setActionError(null);
    setActionBusy(null);
  }, []);

  // Global shortcut. Deliberately fires even while typing in an input —
  // Ctrl/Cmd+K is a chorded summon, not a printable character.
  useEffect(() => {
    if (!ready) return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ready]);

  // On open: focus, and load context for the ticket being viewed (if any).
  const detailMatch = location.pathname.match(/^\/tickets\/(\d+)$/);
  const detailId = detailMatch ? Number(detailMatch[1]) : null;
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    let cancelled = false;
    if (detailId) {
      Promise.all([ticketsAPI.get(detailId, { reconcile: false }), ticketsAPI.meta()])
        .then(([tRes, mRes]) => {
          if (cancelled) return;
          const myEmail = user?.email?.toLowerCase();
          const me = (mRes.data?.technicians || []).find((tech) => tech.email?.toLowerCase() === myEmail);
          setContext({
            ticket: tRes.data,
            myTechId: me?.id || null,
            ticketingOn: mRes.data?.nativeTicketingEnabled !== false,
          });
        })
        .catch(() => {});
    }
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, detailId, user?.email]);

  // Debounced multi-entity search once the query looks like one. The scope
  // pill narrows the request server-side (?types=) — 'All' fans out across
  // every section in one call.
  useEffect(() => {
    if (!open) return undefined;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setSections(EMPTY_SECTIONS);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const seq = ++searchSeqRef.current;
    searchTimerRef.current = setTimeout(() => {
      searchAPI.global(q, scope === 'all' ? undefined : scope)
        .then((res) => {
          if (searchSeqRef.current !== seq) return; // stale response
          setSections({ ...EMPTY_SECTIONS, ...(res.data?.sections || {}) });
          setSearching(false);
        })
        .catch(() => { if (searchSeqRef.current === seq) setSearching(false); });
    }, 250);
    return () => clearTimeout(searchTimerRef.current);
  }, [open, query, scope]);

  const runTicketAction = useCallback(async (kind) => {
    if (!context?.ticket) return;
    const { ticket, myTechId } = context;
    const isNative = ticket.origin === 'ticketpulse';
    setActionBusy(kind);
    setActionError(null);
    try {
      if (kind === 'assign-me') {
        if (isNative) await ticketsAPI.assign(ticket.id, myTechId);
        else await ticketsAPI.fsUpdate(ticket.id, { assignedTechId: myTechId });
      } else if (kind === 'resolve') {
        if (isNative) await ticketsAPI.setStatus(ticket.id, 'Resolved');
        else await ticketsAPI.fsUpdate(ticket.id, { status: 'Resolved' });
      }
      close(); // the detail page refetches via its SSE listener
    } catch (err) {
      setActionBusy(null);
      setActionError(err.response?.data?.message || err.message || 'Action failed');
    }
  }, [context, close]);

  // Assemble the visible, keyboard-navigable item list. One flat array —
  // ArrowUp/Down walk straight across section boundaries, section headers are
  // presentation only.
  const items = useMemo(() => {
    if (!open) return [];
    const out = [];
    // Return address so destination pages' Back controls come back to the
    // page the palette was opened from.
    const from = `${location.pathname}${location.search}`;
    // Nav / workspace / actions belong to the classic palette — a specific
    // entity pill means "I'm searching for records", so those step aside.
    const showCommands = scope === 'all';

    if (showCommands && context?.ticket) {
      const { ticket, myTechId, ticketingOn } = context;
      const isNative = ticket.origin === 'ticketpulse';
      const actionable = isNative ? ticketingOn : Boolean(ticket.freshserviceTicketId);
      if (matches(query, 'copy ticket link', 'share url')) {
        out.push({
          id: 'act-copy-link',
          section: `On ${ticket.displayRef}`,
          label: 'Copy ticket link',
          Icon: LinkIcon,
          run: () => {
            navigator.clipboard?.writeText(window.location.href).catch(() => {});
            close();
          },
        });
      }
      if (actionable && myTechId && ticket.assignedTechId !== myTechId && matches(query, 'assign to me', 'take ticket')) {
        out.push({
          id: 'act-assign-me', section: `On ${ticket.displayRef}`, label: 'Assign to me',
          Icon: UserCheck, run: () => runTicketAction('assign-me'), busyKey: 'assign-me',
        });
      }
      if (actionable && !['Resolved', 'Closed'].includes(ticket.status) && matches(query, 'mark resolved', 'resolve ticket close')) {
        out.push({
          id: 'act-resolve', section: `On ${ticket.displayRef}`, label: 'Mark resolved',
          Icon: CheckCircle2, run: () => runTicketAction('resolve'), busyKey: 'resolve',
        });
      }
    }

    const isAgent = user?.role === 'agent';
    const canManage = wsRole === 'admin';
    for (const nav of showCommands ? NAV_ITEMS : []) {
      if (isAgent && nav.full) continue;
      if (!isAgent && nav.agent) continue;
      if (nav.admin && !canManage) continue;
      if (!matches(query, nav.label, nav.keywords)) continue;
      out.push({
        id: nav.id, section: 'Go to', label: nav.label, Icon: nav.Icon,
        run: () => { navigate(nav.path); close(); },
      });
    }

    // Workspace switching — the top bar's switcher, reachable by keyboard.
    for (const ws of (showCommands && availableWorkspaces) || []) {
      if (ws.id === currentWorkspace?.id) continue;
      if (!matches(query, `switch to ${ws.name}`, 'workspace change')) continue;
      out.push({
        id: `ws-${ws.id}`,
        section: 'Workspace',
        label: `Switch to ${ws.name}`,
        sub: ws.role ? `You are ${ws.role} there` : undefined,
        Icon: Boxes,
        run: () => {
          switchWorkspace(ws.id);
          window.location.reload();
        },
      });
    }

    if (showCommands && matches(query, "what's new", 'changelog version release notes updates')) {
      out.push({
        id: 'act-whats-new',
        section: 'App',
        label: "What's new",
        sub: `Changelog · v${APP_VERSION}`,
        Icon: Sparkles,
        run: () => { setOpen(false); setQuery(''); setShowChangelog(true); },
      });
    }

    for (const t of sections.tickets) {
      out.push({
        id: `ticket-${t.id}`,
        section: 'Tickets',
        label: t.subject || '(no subject)',
        sub: `${t.displayRef} · ${t.requesterName || 'Unknown requester'}`,
        status: t.status,
        statusStyle: STATUS_STYLES[t.status],
        Icon: TicketIcon,
        run: () => { navigate(`/tickets/${t.id}`, { state: { from } }); close(); },
      });
    }

    for (const task of sections.tasks) {
      const ts = TASK_STATUS[task.status];
      out.push({
        id: `task-${task.id}`,
        section: 'Tasks',
        label: task.title || '(untitled task)',
        sub: [task.ticket?.displayRef, task.ticket?.subject, task.assignedTechName]
          .filter(Boolean).join(' · '),
        status: ts?.label || task.status,
        statusStyle: ts?.style,
        Icon: ListChecks,
        // Straight into the parent ticket's Tasks tab (?tab=tasks is a real
        // TicketDetail tab param).
        run: () => { navigate(`/tickets/${task.ticket?.id}?tab=tasks`, { state: { from } }); close(); },
      });
    }

    for (const a of sections.agents) {
      out.push({
        id: `agent-${a.id}`,
        section: 'Agents',
        label: a.name,
        sub: [a.location, a.email].filter(Boolean).join(' · ') || undefined,
        Icon: UserCheck,
        run: () => { navigate(`/technician/${a.id}`); close(); },
      });
    }

    for (const r of sections.requesters) {
      out.push({
        id: `requester-${r.id}`,
        section: 'Requesters',
        label: r.name,
        sub: [r.email, r.department].filter(Boolean).join(' · ') || undefined,
        Icon: User,
        // The queue has a first-class requester filter (?requesterId= +
        // ?requesterName= for the banner) — use it.
        run: () => {
          navigate(`/tickets?requesterId=${r.id}&requesterName=${encodeURIComponent(r.name || '')}`);
          close();
        },
      });
    }

    for (const d of sections.departments) {
      out.push({
        id: `department-${d.name}`,
        section: 'Departments',
        label: d.name,
        sub: 'Search the queue for this department',
        Icon: Building2,
        // v1 fallback: the queue has no department filter param yet, so this
        // lands on a text search (subject / requester name+email). Honest
        // best-effort until ?department= exists server-side.
        run: () => { navigate(`/tickets?q=${encodeURIComponent(d.name)}`); close(); },
      });
    }
    return out;
  }, [open, query, scope, context, sections, user?.role, wsRole, availableWorkspaces, currentWorkspace?.id, switchWorkspace, navigate, close, runTicketAction, location.pathname, location.search]);

  useEffect(() => { setActiveIndex(0); }, [query, scope, sections]);

  const onInputKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[activeIndex]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  if (!ready) return null;

  // The changelog modal must survive the palette closing (selecting
  // "What's new" closes the palette and opens the modal).
  if (!open) {
    return <ChangelogModal isOpen={showChangelog} onClose={() => setShowChangelog(false)} />;
  }

  let lastSection = null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[14vh] px-4 bg-slate-900/30 backdrop-blur-[2px] animate-fadeIn"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="tp-card w-full max-w-xl rounded-xl shadow-soft overflow-hidden animate-scaleIn">
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-slate-100">
          <Search className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search tickets, tasks, people, departments — or run an action…"
            aria-label="Command palette search"
            role="combobox"
            aria-expanded="true"
            aria-controls="tp-palette-list"
            aria-activedescendant={items[activeIndex]?.id || undefined}
            className="flex-1 min-w-0 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 outline-none"
          />
          {searching && <Loader2 className="w-4 h-4 text-slate-300 animate-spin shrink-0" aria-hidden="true" />}
          <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] font-mono text-slate-400 border border-slate-200 rounded px-1 py-0.5">esc</kbd>
        </div>

        {/* Entity scope pills (QA 08-04 #2) — All keeps commands + every
            section; a specific pill narrows the search to that entity. */}
        <div
          role="group"
          aria-label="Search scope"
          className="flex items-center gap-1 px-3.5 py-2 border-b border-slate-100 overflow-x-auto"
        >
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={scope === s.id}
              onClick={() => { setScope(s.id); inputRef.current?.focus(); }}
              className={`tp-focus-ring shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                scope === s.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {actionError && (
          <p className="px-4 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">{actionError}</p>
        )}

        <ul id="tp-palette-list" role="listbox" aria-label="Results" className="max-h-[46vh] overflow-y-auto settings-scrollbar py-1.5">
          {items.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-slate-400">
              {query.trim().length >= 2 && !searching
                ? 'No matches.'
                : scope === 'all'
                  ? 'Type to search tickets, tasks, people, and commands.'
                  : `Type to search ${SCOPES.find((s) => s.id === scope)?.label.toLowerCase()}.`}
            </li>
          )}
          {items.map((item, idx) => {
            const showSection = item.section !== lastSection;
            lastSection = item.section;
            return (
              <li key={item.id} role="presentation">
                {showSection && (
                  <p className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{item.section}</p>
                )}
                <button
                  id={item.id}
                  role="option"
                  aria-selected={idx === activeIndex}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => item.run()}
                  className={`w-full flex items-center gap-2.5 px-4 py-2 text-left text-sm ${
                    idx === activeIndex ? 'bg-blue-50 text-blue-900' : 'text-slate-700'
                  }`}
                >
                  {actionBusy && item.busyKey === actionBusy
                    ? <Loader2 className="w-4 h-4 shrink-0 animate-spin text-blue-500" aria-hidden="true" />
                    : <item.Icon className={`w-4 h-4 shrink-0 ${idx === activeIndex ? 'text-blue-500' : 'text-slate-400'}`} aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.label}</span>
                    {item.sub && <span className="block truncate text-[11px] text-slate-400">{item.sub}</span>}
                  </span>
                  {item.status && (
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${item.statusStyle || 'bg-slate-100 text-slate-500'}`}>
                      {item.status}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-100 text-[10px] text-slate-400">
          <span className="inline-flex items-center gap-1"><Command className="w-3 h-3" aria-hidden="true" />K to toggle</span>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
        </div>
      </div>
    </div>
  );
}
