import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2, CheckSquare, Clock, CornerDownLeft, Globe, History, Loader2, MessageSquareText, Search, Ticket as TicketIcon, UserRound, Users, X,
} from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { searchAPI } from '../../services/api';
import { PersonAvatar, StatusPill, timeAgoShort } from './ticketUi';
import { useRequesterPhoto } from '../../hooks/useRequesterPhoto';
import {
  clearRecentSearches, forgetSearch, getRecentSearches, getRecentTickets, rememberSearch, syncRecentSearches,
} from '../../utils/recentSearches';

/**
 * Search v2 (16 Sep 2026) — the tickets-page search box with a results panel.
 *
 *  - focused + empty  → recent searches (per person, synced) + recently viewed tickets
 *  - typing           → after SEARCH_IDLE_MS a spinner shows in the box and
 *                       /api/search runs: Tickets (+ "View all N"), Requesters,
 *                       Agents, Departments, Tasks — matched text highlighted
 *  - #242054 / 242054 / TP-1042 → one "Open …" row on top
 *  - ↑ ↓ move · Enter opens the highlighted row (or applies the query as the
 *    list filter when nothing is highlighted) · Esc closes · "/" focuses
 *
 * The box still drives the list filter through `value` / `onChange` exactly as
 * before, so typing keeps narrowing the queue underneath the panel.
 */
export const SEARCH_IDLE_MS = 400;
const MIN_QUERY = 2;
const TICKET_ROWS = 5;

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Wrap every occurrence of `q` (case-insensitive) in <mark>. */
export function Highlight({ text, q }) {
  const value = String(text ?? '');
  const needle = String(q || '').trim();
  if (!needle || needle.length < 1) return value;
  const parts = value.split(new RegExp(`(${escapeRegExp(needle)})`, 'ig'));
  return parts.map((part, i) => (part.toLowerCase() === needle.toLowerCase()
    ? <mark key={i} className="rounded-[3px] bg-amber-200/70 px-px text-inherit dark:bg-amber-400/30">{part}</mark>
    : <span key={i}>{part}</span>));
}

/** A bare ticket reference typed into the box: #242054, 242054, TP-1042. */
export function directRef(q) {
  const s = String(q || '').trim();
  const tp = s.match(/^tp-?(\d{1,7})$/i);
  if (tp) return { kind: 'tp', number: Number(tp[1]), label: `TP-${tp[1]}` };
  const fs = s.match(/^#?(\d{4,9})$/);
  if (fs) return { kind: 'fs', number: Number(fs[1]), label: `#${fs[1]}` };
  return null;
}

const CONVERSATIONS_KEY = 'tp_search_conversations';
const SCOPE_KEY = 'tp_search_scope';
const readFlag = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; } };
const writeFlag = (key, on) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* no-op */ } };

/** ts_headline markers → <mark>. */
function Snippet({ text }) {
  const parts = String(text || '').split(/(\[\[.*?\]\])/g);
  return parts.map((p, i) => (p.startsWith('[[') && p.endsWith(']]')
    ? <mark key={i} className="rounded-[3px] bg-amber-200/70 px-px text-inherit dark:bg-amber-400/30">{p.slice(2, -2)}</mark>
    : <span key={i}>{p}</span>));
}

const SECTION_META = {
  tickets: { label: 'Tickets', Icon: TicketIcon },
  conversations: { label: 'In conversations', Icon: MessageSquareText },
  requesters: { label: 'Requesters', Icon: UserRound },
  agents: { label: 'Agents', Icon: Users },
  departments: { label: 'Departments', Icon: Building2 },
  tasks: { label: 'Tasks', Icon: CheckSquare },
};

/** Requester avatar with the directory photo (cached per address). */
function RequesterAvatar({ name, email, photoUrl = null, size = 'h-6 w-6', textSize = 'text-[9px]' }) {
  const photo = useRequesterPhoto(photoUrl ? null : email);
  return <PersonAvatar name={name || email} photoUrl={photoUrl || photo || null} size={size} textSize={textSize} />;
}

function SectionHeading({ icon: Icon, children, right }) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {children}
      </span>
      {right}
    </div>
  );
}

export default function TicketSearchBox({
  value,
  onChange,
  onApply,          // (q) => apply as the list filter
  onOpenTicket,     // (ticketId, { newTab }) => open (peek by default)
  onOpenRequester,  // (requester) => navigate
  onOpenAgent,      // (agent) => navigate
  onOpenTask,       // (task) => navigate
  onFilterDepartment, // (name) => list filter
  placeholder = 'Search subject, requester, TP-1042 or #12345…',
  inputRef: externalRef = null,
  className = '',
  size = 'md',        // 'md' (44px toolbar) | 'sm' (36px, the app header)
  shortcut = true,    // "/" focuses this box — off for a second, phone-only copy
}) {
  const localRef = useRef(null);
  const inputRef = externalRef || localRef;
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState(() => getRecentSearches());
  const [recentTickets, setRecentTickets] = useState(() => getRecentTickets());
  const [results, setResults] = useState(null); // { sections, totals, query }
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(-1);
  // Search v3: opt-in full-text over conversation bodies, and a workspace scope.
  const [withConversations, setWithConversations] = useState(() => readFlag(CONVERSATIONS_KEY, false));
  const [allWorkspaces, setAllWorkspaces] = useState(() => readFlag(SCOPE_KEY, false));
  const { currentWorkspace, availableWorkspaces, switchWorkspace } = useWorkspace();
  const canSwitchScope = (availableWorkspaces || []).length > 1;
  const timerRef = useRef(null);
  const seqRef = useRef(0);
  const q = String(value || '').trim();

  // Server copy of the recents wins once per mount.
  useEffect(() => {
    let alive = true;
    syncRecentSearches().then((list) => { if (alive) setRecent(list); });
    return () => { alive = false; };
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // "/" focuses the box (FreshService's key) — only outside editable targets.
  useEffect(() => {
    if (!shortcut) return undefined;
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && typeof t.closest === 'function' && t.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]')) return;
      e.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inputRef, shortcut]);

  // Auto-search after the person stops typing.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (q.length < MIN_QUERY) { setResults(null); setSearching(false); return undefined; }
    setSearching(true);
    const seq = ++seqRef.current;
    timerRef.current = setTimeout(() => {
      const types = withConversations ? 'tickets,tasks,agents,requesters,departments,conversations' : undefined;
      searchAPI.global(q, types, { scope: allWorkspaces && canSwitchScope ? 'all' : undefined })
        .then((res) => {
          if (seqRef.current !== seq) return;
          const data = res?.data || res || {};
          setResults({ query: q, sections: data.sections || {}, totals: data.totals || {} });
          setSearching(false);
        })
        .catch(() => { if (seqRef.current === seq) { setResults({ query: q, sections: {}, totals: {}, error: true }); setSearching(false); } });
    }, SEARCH_IDLE_MS);
    return () => clearTimeout(timerRef.current);
  }, [q, withConversations, allWorkspaces, canSwitchScope]);

  // A hit in another workspace: switch there, then open. switchWorkspace()
  // reloads the app, so the destination rides along as the path to land on.
  const openInWorkspace = useCallback((row, open) => {
    if (row.workspaceId && currentWorkspace?.id && Number(row.workspaceId) !== Number(currentWorkspace.id)) {
      switchWorkspace(Number(row.workspaceId), { landOn: `/tickets/${row.ticketId || row.id}` });
      return;
    }
    open();
  }, [currentWorkspace?.id, switchWorkspace]);

  useEffect(() => { setActive(-1); }, [q, results, open]);

  const apply = useCallback((query) => {
    const text = String(query || '').trim();
    if (text) setRecent(rememberSearch(text));
    onChange?.(text);
    onApply?.(text);
    setOpen(false);
  }, [onChange, onApply]);

  // The flat list of actionable rows, in the order they render.
  const rows = useMemo(() => {
    const out = [];
    if (q.length < MIN_QUERY) {
      for (const r of recent) out.push({ key: `recent-${r}`, kind: 'recent', label: r, run: () => apply(r) });
      for (const t of recentTickets) out.push({ key: `viewed-${t.id}`, kind: 'viewed', ticket: t, run: (e) => { onOpenTicket?.(t.id, { newTab: Boolean(e?.metaKey || e?.ctrlKey) }); setOpen(false); } });
      return out;
    }
    const ref = directRef(q);
    const s = results?.sections || {};
    if (ref) {
      const hit = (s.tickets || []).find((t) => String(t.displayRef || '').toLowerCase() === ref.label.toLowerCase());
      out.push({ key: 'direct', kind: 'direct', ref, ticket: hit || null, run: (e) => {
        if (hit) { onOpenTicket?.(hit.id, { newTab: Boolean(e?.metaKey || e?.ctrlKey) }); setOpen(false); }
        else apply(q);
      } });
    }
    for (const t of (s.tickets || []).slice(0, TICKET_ROWS)) {
      out.push({ key: `t-${t.workspaceId || 'w'}-${t.id}`, kind: 'ticket', ticket: t, run: (e) => { setRecent(rememberSearch(q)); openInWorkspace(t, () => onOpenTicket?.(t.id, { newTab: Boolean(e?.metaKey || e?.ctrlKey) })); setOpen(false); } });
    }
    for (const c of (s.conversations || [])) {
      out.push({ key: `c-${c.workspaceId || 'w'}-${c.id}`, kind: 'conversation', conversation: c, run: (e) => { setRecent(rememberSearch(q)); openInWorkspace(c, () => onOpenTicket?.(c.ticketId, { newTab: Boolean(e?.metaKey || e?.ctrlKey) })); setOpen(false); } });
    }
    const total = results?.totals?.tickets;
    if ((s.tickets || []).length > 0) out.push({ key: 'view-all', kind: 'view-all', total, run: () => apply(q) });
    for (const r of (s.requesters || [])) out.push({ key: `r-${r.id}`, kind: 'requester', requester: r, run: () => { setRecent(rememberSearch(q)); onOpenRequester?.(r); setOpen(false); } });
    for (const a of (s.agents || [])) out.push({ key: `a-${a.id}`, kind: 'agent', agent: a, run: () => { onOpenAgent?.(a); setOpen(false); } });
    for (const d of (s.departments || [])) out.push({ key: `d-${d.name}`, kind: 'department', department: d, run: () => { onFilterDepartment?.(d.name); setOpen(false); } });
    for (const task of (s.tasks || [])) out.push({ key: `k-${task.id}`, kind: 'task', task, run: () => { onOpenTask?.(task); setOpen(false); } });
    return out;
  }, [q, recent, recentTickets, results, apply, onOpenTicket, onOpenRequester, onOpenAgent, onFilterDepartment, onOpenTask, openInWorkspace]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return; }
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (rows.length ? (i + 1) % rows.length : -1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (rows.length ? (i <= 0 ? rows.length - 1 : i - 1) : -1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && rows[active]) rows[active].run(e);
      else if (rows.length && rows[0].kind === 'direct') rows[0].run(e);
      else apply(q);
    }
  };

  const showPanel = open;
  const empty = q.length < MIN_QUERY;
  let idx = -1;
  const rowClass = (i) => `tp-focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm ${i === active ? 'bg-blue-50 dark:bg-blue-500/15' : 'hover:bg-muted/60'}`;
  const noResults = !empty && results && !searching && !results.error && Object.values(results.sections || {}).every((list) => !list || list.length === 0) && !directRef(q);

  return (
    <div ref={rootRef} className={`relative ${className}`} data-testid="ticket-search">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => { onChange?.(e.target.value); setOpen(true); }}
        onFocus={() => { setRecent(getRecentSearches()); setRecentTickets(getRecentTickets()); setOpen(true); }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label="Search tickets"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls="ticket-search-panel"
        aria-autocomplete="list"
        autoComplete="off"
        className={`tp-focus-ring w-full rounded-lg border border-input bg-card pl-9 pr-16 text-sm placeholder:text-muted-foreground/75 ${size === 'sm' ? 'h-9 py-1 bg-muted/40 focus:bg-card' : 'min-h-[44px] py-2'}`}
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {searching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Searching" />}
        {value ? (
          <button type="button" onClick={() => { onChange?.(''); onApply?.(''); inputRef.current?.focus(); }} aria-label="Clear search" className="tp-focus-ring rounded p-0.5 text-muted-foreground/75 hover:text-muted-foreground">
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : (
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex" title="Press / to search">/</kbd>
        )}
      </div>

      {showPanel && (empty ? (recent.length > 0 || recentTickets.length > 0) : true) && (
        <div
          id="ticket-search-panel"
          role="listbox"
          aria-label={empty ? 'Recent searches' : 'Search results'}
          className="tp-card absolute left-0 right-0 top-[calc(100%+6px)] z-40 max-h-[70vh] overflow-y-auto rounded-xl border border-border p-1.5 shadow-soft settings-scrollbar animate-fadeIn"
        >
          {empty ? (
            <>
              {recent.length > 0 && (
                <>
                  <SectionHeading icon={History} right={<button type="button" onClick={() => setRecent(clearRecentSearches())} className="tp-focus-ring rounded text-[11px] font-semibold text-primary hover:underline">Clear all</button>}>Recent searches</SectionHeading>
                  {recent.map((r) => { idx += 1; const i = idx; return (
                    <div key={`recent-${r}`} className="group flex items-center">
                      <button type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => apply(r)} className={rowClass(i)}>
                        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-foreground">{r}</span>
                      </button>
                      <button type="button" onClick={() => setRecent(forgetSearch(r))} aria-label={`Remove ${r} from recent searches`} className="tp-focus-ring mr-1 rounded p-1 text-muted-foreground/50 opacity-0 hover:text-muted-foreground group-hover:opacity-100 focus:opacity-100">
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  ); })}
                </>
              )}
              {recentTickets.length > 0 && (
                <>
                  <SectionHeading icon={TicketIcon}>Recently viewed</SectionHeading>
                  {recentTickets.map((t) => { idx += 1; const i = idx; return (
                    <button key={`viewed-${t.id}`} type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={(e) => rows[i]?.run(e)} className={rowClass(i)}>
                      <span className="shrink-0 font-mono text-[11px] font-bold text-muted-foreground">{t.displayRef || `#${t.id}`}</span>
                      <span className="min-w-0 flex-1 truncate text-foreground">{t.subject || '(no subject)'}</span>
                      {t.at && <span className="shrink-0 text-[11px] text-muted-foreground/75">{timeAgoShort(new Date(t.at).toISOString())}</span>}
                    </button>
                  ); })}
                </>
              )}
            </>
          ) : (
            <>
              {rows.map((row, i) => {
                if (row.kind === 'direct') {
                  return (
                    <button key={row.key} type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={(e) => row.run(e)} className={`${rowClass(i)} border-b border-border/60 mb-1 pb-2`}>
                      <CornerDownLeft className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-semibold text-foreground">Open {row.ref.label}</span>
                        {row.ticket ? <span className="text-muted-foreground"> — {row.ticket.subject || '(no subject)'}</span> : <span className="text-muted-foreground"> — press Enter to look it up</span>}
                      </span>
                    </button>
                  );
                }
                const first = rows.findIndex((r) => r.kind === row.kind) === i;
                const meta = SECTION_META[row.kind === 'view-all' ? 'tickets' : row.kind === 'requester' ? 'requesters' : row.kind === 'agent' ? 'agents' : row.kind === 'department' ? 'departments' : row.kind === 'task' ? 'tasks' : row.kind === 'conversation' ? 'conversations' : 'tickets'];
                return (
                  <div key={row.key}>
                    {first && row.kind !== 'view-all' && (
                      <SectionHeading icon={meta.Icon} right={row.kind === 'ticket' && Number.isFinite(results?.totals?.tickets) ? <span className="text-[11px] tabular-nums text-muted-foreground">{results.totals.tickets}</span> : null}>{meta.label}</SectionHeading>
                    )}
                    {row.kind === 'ticket' && (
                      <button type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={(e) => row.run(e)} className={rowClass(i)} title="Open in the peek panel · Ctrl-click for the full page">
                        <span className="shrink-0 font-mono text-[11px] font-bold text-muted-foreground">{row.ticket.displayRef}</span>
                        {row.ticket.workspaceName && <span className="shrink-0 rounded border border-border bg-muted/60 px-1 py-px text-[10px] font-semibold text-muted-foreground">{row.ticket.workspaceName}</span>}
                        <span className="min-w-0 flex-1 truncate text-foreground"><Highlight text={row.ticket.subject || '(no subject)'} q={q} /></span>
                        <span className="hidden shrink-0 items-center gap-2 text-[11px] text-muted-foreground sm:inline-flex">
                          {row.ticket.requesterName && <span className="max-w-[140px] truncate"><Highlight text={row.ticket.requesterName} q={q} /></span>}
                          {row.ticket.assigneeName && <span className="max-w-[120px] truncate">→ {row.ticket.assigneeName}</span>}
                          {row.ticket.status && <StatusPill status={row.ticket.status} size="sm" />}
                        </span>
                      </button>
                    )}
                    {row.kind === 'view-all' && (
                      <button type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => row.run()} className={`${rowClass(i)} text-[13px] font-semibold text-primary`}>
                        <CornerDownLeft className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        View all{Number.isFinite(row.total) ? ` ${row.total}` : ''} in the list
                      </button>
                    )}
                    {row.kind === 'requester' && (
                      <button type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => row.run()} className={rowClass(i)}>
                        <RequesterAvatar name={row.requester.name} email={row.requester.email} photoUrl={row.requester.photoUrl || null} />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium text-foreground"><Highlight text={row.requester.name || row.requester.email} q={q} /></span>
                          <span className="text-muted-foreground"> · <Highlight text={row.requester.email} q={q} />{row.requester.jobTitle ? ` · ${row.requester.jobTitle}` : ''}{row.requester.department ? ` · ${row.requester.department}` : ''}</span>
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{row.requester.ticketCount ? `${row.requester.ticketCount} ticket${row.requester.ticketCount === 1 ? '' : 's'} →` : '→'}</span>
                      </button>
                    )}
                    {row.kind === 'agent' && (
                      <button type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => row.run()} className={rowClass(i)}>
                        <PersonAvatar name={row.agent.name} photoUrl={row.agent.photoUrl || null} size="h-6 w-6" textSize="text-[9px]" />
                        <span className="min-w-0 flex-1 truncate"><span className="font-medium text-foreground"><Highlight text={row.agent.name} q={q} /></span>{row.agent.location ? <span className="text-muted-foreground"> · {row.agent.location}</span> : null}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">agent →</span>
                      </button>
                    )}
                    {row.kind === 'department' && (
                      <button type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => row.run()} className={rowClass(i)}>
                        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-foreground"><Highlight text={row.department.name} q={q} /></span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">filter the list →</span>
                      </button>
                    )}
                    {row.kind === 'conversation' && (
                      <button type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={(e) => row.run(e)} className={`${rowClass(i)} !items-start`} title="Open the ticket">
                        <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-[12px]">
                            <span className="font-mono font-bold text-muted-foreground">{row.conversation.displayRef}</span>
                            {row.conversation.workspaceName && <span className="rounded border border-border bg-muted/60 px-1 py-px text-[10px] font-semibold text-muted-foreground">{row.conversation.workspaceName}</span>}
                            <span className="truncate text-foreground">{row.conversation.subject || '(no subject)'}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                            {row.conversation.where === 'description' ? 'Description' : (row.conversation.authorName || 'Someone')}: <Snippet text={row.conversation.snippet} />
                          </span>
                        </span>
                      </button>
                    )}
                    {row.kind === 'task' && (
                      <button type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => row.run()} className={rowClass(i)}>
                        <CheckSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-foreground"><Highlight text={row.task.title} q={q} /><span className="text-muted-foreground"> · {row.task.ticket?.displayRef}</span></span>
                      </button>
                    )}
                  </div>
                );
              })}
              {noResults && (
                <p className="px-3 py-3 text-sm text-muted-foreground">Nothing matches “{q}”. Press Enter to filter the list anyway.</p>
              )}
              {results?.error && <p className="px-3 py-3 text-sm text-red-700 dark:text-red-200">Search is unavailable right now — Enter still filters the list.</p>}
              {!results && searching && <p className="px-3 py-3 text-sm text-muted-foreground">Searching…</p>}
            </>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 pt-2 pb-1 text-[11px] text-muted-foreground">
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={withConversations} onChange={(e) => { setWithConversations(e.target.checked); writeFlag(CONVERSATIONS_KEY, e.target.checked); }} />
              <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" /> Include conversations
            </label>
            {canSwitchScope && (
              <label className="inline-flex cursor-pointer items-center gap-1.5" title="Search every workspace you can see">
                <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={allWorkspaces} onChange={(e) => { setAllWorkspaces(e.target.checked); writeFlag(SCOPE_KEY, e.target.checked); }} />
                <Globe className="h-3.5 w-3.5" aria-hidden="true" /> All my workspaces
              </label>
            )}
            <span className="ml-auto">Try <span className="font-mono">#12345</span>, <span className="font-mono">TP-1042</span>, a name · ↑↓ · Enter · Esc</span>
          </div>
        </div>
      )}
    </div>
  );
}
