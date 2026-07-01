import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity, AlertCircle, ChevronLeft, ChevronRight, Inbox, Plus, Search, ShieldCheck, X,
} from 'lucide-react';
import AppHeader from '../components/AppHeader';
import TicketComposer from '../components/tickets/TicketComposer';
import {
  PersonAvatar, PriorityDot, StatusPill, timeAgo,
} from '../components/tickets/ticketUi';
import { ticketsAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useSSE } from '../hooks/useSSE';

const STATUS_FILTERS = ['Open', 'Pending', 'Resolved', 'Closed'];
const DEFAULT_STATUSES = ['Open', 'Pending'];
const PAGE_SIZE = 25;

export default function Tickets() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();

  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [composerOpen, setComposerOpen] = useState(false);

  const [statuses, setStatuses] = useState(DEFAULT_STATUSES);
  const [assignee, setAssignee] = useState('all');
  const [priority, setPriority] = useState('all');
  const [origin, setOrigin] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const workspaceId = currentWorkspace?.id;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    ticketsAPI.meta()
      .then((res) => { if (!cancelled) { setMeta(res.data); setMetaError(null); } })
      .catch((err) => { if (!cancelled) setMetaError(err.response?.data?.message || err.message); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const queryParams = useMemo(() => {
    const params = { page, pageSize: PAGE_SIZE, sort: 'updatedAt', dir: 'desc' };
    if (statuses.length > 0 && statuses.length < STATUS_FILTERS.length) params.status = statuses.join(',');
    if (assignee === 'me' && meta?.actor?.technicianId) params.assignedTechId = meta.actor.technicianId;
    else if (assignee !== 'all' && assignee !== 'me') params.assignedTechId = assignee;
    if (priority !== 'all') params.priority = priority;
    if (origin !== 'all') params.origin = origin;
    if (debouncedSearch) params.q = debouncedSearch;
    return params;
  }, [page, statuses, assignee, priority, origin, debouncedSearch, meta?.actor?.technicianId]);

  const fetchTickets = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setIsLoading(true);
    try {
      const res = await ticketsAPI.list(queryParams);
      setTickets(res.data.items || []);
      setTotal(res.data.total || 0);
      setLoadError(null);
    } catch (err) {
      setLoadError(err.response?.data?.message || err.message);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [queryParams]);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  // Live refresh: any native ticket mutation in this workspace re-fetches the
  // current page quietly (debounced so bursts collapse into one request).
  const refreshTimerRef = useRef(null);
  const onTicketChange = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => fetchTickets({ silent: true }), 400);
  }, [fetchTickets]);
  useSSE({ onTicketChange, enabled: Boolean(workspaceId) });
  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);

  const toggleStatus = (status) => {
    setPage(1);
    setStatuses((prev) => (prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]));
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const ticketingOn = meta ? meta.nativeTicketingEnabled : true;
  const isAgent = user?.role === 'agent';

  return (
    <div className="tp-page-backdrop min-h-screen">
      <AppHeader activePage="tickets" />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 animate-fadeIn">
        {/* Page heading */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Tickets</h1>
            <p className="text-sm text-slate-500">
              {currentWorkspace?.name ? `${currentWorkspace.name} workspace` : 'Workspace'} · tickets born here and synced from FreshService
            </p>
          </div>
          {ticketingOn && (
            <button
              onClick={() => setComposerOpen(true)}
              className="tp-focus-ring inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-semibold rounded-lg shadow-subtle hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              New ticket
            </button>
          )}
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
              {isAgent && (
                <> In the meantime, your <Link to="/my-competencies" className="text-blue-600 hover:underline">competency profile</Link> is always available.</>
              )}
            </p>
          </div>
        )}

        {!metaError && (
          <>
            {/* Filter toolbar */}
            <div className="tp-surface rounded-xl p-3 mb-4 flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => { setPage(1); setSearch(e.target.value); }}
                  placeholder="Search subject, requester, TP-1042 or #12345…"
                  aria-label="Search tickets"
                  className="tp-focus-ring w-full pl-9 pr-8 py-2 text-sm bg-white border border-input rounded-lg placeholder:text-slate-400"
                />
                {search && (
                  <button
                    onClick={() => { setSearch(''); setPage(1); }}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 rounded"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>

              <div role="group" aria-label="Filter by status" className="flex items-center gap-1">
                {STATUS_FILTERS.map((status) => {
                  const active = statuses.includes(status);
                  return (
                    <button
                      key={status}
                      onClick={() => toggleStatus(status)}
                      aria-pressed={active}
                      className={`tp-focus-ring px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                        active
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-700'
                      }`}
                    >
                      {status}
                    </button>
                  );
                })}
              </div>

              <select
                value={assignee}
                onChange={(e) => { setPage(1); setAssignee(e.target.value); }}
                aria-label="Filter by assignee"
                className="tp-focus-ring text-sm bg-white border border-input rounded-lg px-2.5 py-2 text-slate-700"
              >
                <option value="all">All assignees</option>
                {meta?.actor?.technicianId && <option value="me">Assigned to me</option>}
                <option value="unassigned">Unassigned</option>
                {(meta?.technicians || []).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>

              <select
                value={priority}
                onChange={(e) => { setPage(1); setPriority(e.target.value); }}
                aria-label="Filter by priority"
                className="tp-focus-ring text-sm bg-white border border-input rounded-lg px-2.5 py-2 text-slate-700"
              >
                <option value="all">All priorities</option>
                {(meta?.priorities || []).map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>

              <select
                value={origin}
                onChange={(e) => { setPage(1); setOrigin(e.target.value); }}
                aria-label="Filter by origin"
                className="tp-focus-ring text-sm bg-white border border-input rounded-lg px-2.5 py-2 text-slate-700"
              >
                <option value="all">All origins</option>
                <option value="ticketpulse">Born in Ticket Pulse</option>
                <option value="freshservice">From FreshService</option>
              </select>
            </div>

            {/* Results */}
            {isLoading ? (
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
                <p className="text-sm text-slate-500 mt-1">Try widening the status filter or clearing the search.</p>
              </div>
            ) : (
              <div className="tp-card rounded-xl overflow-hidden">
                {/* Desktop header row */}
                <div className="hidden md:grid grid-cols-[14px_100px_minmax(0,1fr)_150px_170px_96px_90px] gap-3 items-center px-4 py-2.5 border-b border-slate-100 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  <span aria-hidden="true" />
                  <span>Ref</span>
                  <span>Subject</span>
                  <span>Category</span>
                  <span>Assignee</span>
                  <span>Status</span>
                  <span className="text-right">Updated</span>
                </div>
                <ul className="divide-y divide-slate-100">
                  {tickets.map((ticket) => (
                    <li key={ticket.id}>
                      <button
                        onClick={() => navigate(`/tickets/${ticket.id}`)}
                        className="tp-focus-ring w-full text-left hover:bg-blue-50/40 transition-colors"
                      >
                        {/* Desktop row */}
                        <div className="hidden md:grid grid-cols-[14px_100px_minmax(0,1fr)_150px_170px_96px_90px] gap-3 items-center px-4 py-3">
                          <PriorityDot priority={ticket.priority} />
                          <span className="font-mono text-xs font-semibold text-slate-600 truncate">{ticket.displayRef}</span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-slate-800 truncate">{ticket.subject || '(no subject)'}</span>
                            <span className="block text-xs text-slate-400 truncate">
                              {ticket.requester?.name || 'Unknown requester'}
                              {ticket.origin === 'ticketpulse' && <span className="ml-2 text-sky-600 font-medium">· TP-born</span>}
                            </span>
                          </span>
                          <span className="text-xs text-slate-500 truncate">
                            {ticket.internalCategory?.name || ticket.ticketCategory || '—'}
                            {ticket.internalSubcategory?.name ? ` / ${ticket.internalSubcategory.name}` : ''}
                          </span>
                          <span className="flex items-center gap-2 min-w-0">
                            <PersonAvatar name={ticket.assignedTech?.name} photoUrl={ticket.assignedTech?.photoUrl} />
                            <span className="text-xs text-slate-600 truncate">{ticket.assignedTech?.name || 'Unassigned'}</span>
                          </span>
                          <StatusPill status={ticket.status} />
                          <span className="text-xs text-slate-400 text-right whitespace-nowrap">{timeAgo(ticket.updatedAt)}</span>
                        </div>

                        {/* Mobile card */}
                        <div className="md:hidden px-4 py-3">
                          <div className="flex items-center gap-2 mb-1">
                            <PriorityDot priority={ticket.priority} />
                            <span className="font-mono text-[11px] font-semibold text-slate-500">{ticket.displayRef}</span>
                            <StatusPill status={ticket.status} className="ml-auto" />
                          </div>
                          <p className="text-sm font-medium text-slate-800 line-clamp-2">{ticket.subject || '(no subject)'}</p>
                          <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-400">
                            <span className="truncate">{ticket.requester?.name || 'Unknown requester'}</span>
                            <span aria-hidden="true">·</span>
                            <span className="truncate">{ticket.assignedTech?.name || 'Unassigned'}</span>
                            <span className="ml-auto whitespace-nowrap">{timeAgo(ticket.updatedAt)}</span>
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>

                {/* Pagination */}
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 bg-slate-50/50">
                  <span className="text-xs text-slate-500">
                    {total} ticket{total === 1 ? '' : 's'} · page {page} of {totalPages}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      aria-label="Previous page"
                      className="tp-focus-ring p-1.5 rounded-lg border border-slate-200 bg-white text-slate-500 disabled:opacity-40 hover:border-blue-300 hover:text-blue-700"
                    >
                      <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                      aria-label="Next page"
                      className="tp-focus-ring p-1.5 rounded-lg border border-slate-200 bg-white text-slate-500 disabled:opacity-40 hover:border-blue-300 hover:text-blue-700"
                    >
                      <ChevronRight className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {composerOpen && meta && (
        <TicketComposer
          meta={meta}
          onClose={() => setComposerOpen(false)}
          onCreated={(ticket) => {
            setComposerOpen(false);
            navigate(`/tickets/${ticket.id}`);
          }}
        />
      )}
    </div>
  );
}
