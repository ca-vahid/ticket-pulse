import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Building2, Check, ChevronDown, Clock, ExternalLink, Globe, Inbox, Loader2, Mail, MapPin, Phone, Plus, Smartphone, Ticket as TicketIcon, UserRound, X,
} from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import { ticketsAPI } from '../services/api';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { applyWidth, useLayoutWidth } from '../contexts/LayoutContext';
import { PersonAvatar, StatusPill, PriorityDot, SolutionMark, formatDayTime, timeAgo, ticketCategoryLabels } from '../components/tickets/ticketUi';
import { FRESHSERVICE_DOMAIN } from '../components/tech-detail/constants';
import { useRequesterPhoto } from '../hooks/useRequesterPhoto';

/**
 * Search v2 (16 Sep 2026) — the requester page (/requesters/:id): who the
 * person is (directory fields), their service history in this workspace,
 * and their tickets. One person's own history, never a comparison.
 *
 * QA 09-22 #5: the ticket list reads like the queue — category (leaf first),
 * the assignee with their avatar, status, date — and filters by status,
 * category and agent. Filters go to the server; the option lists come from
 * the person's unfiltered history.
 */

const PAGE_SIZE = 100;

function hoursLabel(h) {
  if (!Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${Math.round(h)} hr`;
  return `${Math.round(h / 24)} days`;
}

function Stat({ label, value, hint }) {
  return (
    <div className="tp-card rounded-xl px-4 py-3">
      <div className="text-2xl font-bold tabular-nums text-foreground">{value ?? '—'}</div>
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}

function Field({ label, children }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{children}</dd>
    </div>
  );
}

/** A small popover picker in the queue's visual language — no native select. */
function FilterMenu({ label, value, options, onChange, renderOption }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const current = options.find((o) => String(o.value) === String(value));
  const active = Boolean(value);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
          active
            ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-200'
            : 'border-border bg-card text-foreground/85 hover:bg-muted'
        }`}
      >
        <span className="text-muted-foreground/75">{label}</span>
        <span className="inline-flex items-center gap-1.5">{current ? (renderOption ? renderOption(current) : current.label) : 'Any'}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/75" aria-hidden="true" />
      </button>
      {open && (
        <ul role="listbox" aria-label={label} className="tp-card absolute left-0 top-full z-30 mt-1 max-h-72 w-56 overflow-auto rounded-xl p-1 shadow-soft settings-scrollbar">
          {[{ value: '', label: 'Any' }, ...options].map((o) => {
            const selected = String(o.value) === String(value || '');
            return (
              <li key={o.value || 'any'}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={`tp-focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${selected ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200' : 'text-foreground/85 hover:bg-muted'}`}
                >
                  <span className="min-w-0 flex-1 truncate inline-flex items-center gap-1.5">{o.value && renderOption ? renderOption(o) : o.label}</span>
                  {o.count != null && <span className="text-[10px] tabular-nums text-muted-foreground/75">{o.count}</span>}
                  {selected && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open & pending' },
  { value: 'resolved', label: 'Resolved & closed' },
];

export default function RequesterDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { currentWorkspace } = useWorkspace();
  const { width: layoutWidth } = useLayoutWidth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('tickets');
  const [history, setHistory] = useState(null); // unfiltered — option lists + the plain view
  const [historyTotal, setHistoryTotal] = useState(null);
  const [tickets, setTickets] = useState(null); // what the list shows (filtered)
  const [ticketsTotal, setTicketsTotal] = useState(null);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ticketsAPI.requesterProfile(id);
      setData(res?.data || res);
      setError(null);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not load this requester');
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [load, currentWorkspace?.id]);

  // The unfiltered history once per requester: feeds the option lists and
  // is the list itself while no filter is set.
  useEffect(() => {
    let alive = true;
    setHistory(null);
    setTickets(null);
    setStatusFilter(''); setCategoryFilter(''); setAgentFilter('');
    ticketsAPI.list({ requesterId: id, status: 'any', pageSize: PAGE_SIZE, sort: 'createdAt', dir: 'desc' })
      .then((res) => {
        if (!alive) return;
        const body = res?.data || res || {};
        const items = body.items || [];
        setHistory(items);
        setHistoryTotal(body.total ?? items.length);
        setTickets(items);
        setTicketsTotal(body.total ?? items.length);
      })
      .catch(() => { if (alive) { setHistory([]); setTickets([]); } });
    return () => { alive = false; };
  }, [id, currentWorkspace?.id]);

  const filtersActive = Boolean(statusFilter || categoryFilter || agentFilter);
  // Filtered views go to the server, so counts and "showing N of M" stay true.
  useEffect(() => {
    if (!history) return undefined;
    if (!filtersActive) { setTickets(history); setTicketsTotal(historyTotal); return undefined; }
    let alive = true;
    setTicketsLoading(true);
    const params = { requesterId: id, pageSize: PAGE_SIZE, sort: 'createdAt', dir: 'desc' };
    if (statusFilter) params.segment = statusFilter; else params.status = 'any';
    if (categoryFilter) params.internalCategoryId = categoryFilter;
    if (agentFilter) params.assignedTechId = agentFilter;
    ticketsAPI.list(params)
      .then((res) => {
        if (!alive) return;
        const body = res?.data || res || {};
        setTickets(body.items || []);
        setTicketsTotal(body.total ?? (body.items || []).length);
      })
      .catch(() => { if (alive) setTickets([]); })
      .finally(() => { if (alive) setTicketsLoading(false); });
    return () => { alive = false; };
  }, [history, historyTotal, filtersActive, statusFilter, categoryFilter, agentFilter, id]);

  const categoryOptions = useMemo(() => {
    const map = new Map();
    for (const t of history || []) {
      const cid = t.internalCategory?.id || t.internalCategoryId;
      const name = t.internalCategory?.name || ticketCategoryLabels(t).category;
      if (!cid || !name) continue;
      const cur = map.get(cid) || { value: String(cid), label: name, count: 0 };
      cur.count += 1;
      map.set(cid, cur);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [history]);
  const agentOptions = useMemo(() => {
    const map = new Map();
    for (const t of history || []) {
      const a = t.assignedTech;
      if (!a?.id) continue;
      const cur = map.get(a.id) || { value: String(a.id), label: a.name, photoUrl: a.photoUrl || null, count: 0 };
      cur.count += 1;
      map.set(a.id, cur);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [history]);
  const renderAgentOption = (o) => (
    <>
      <PersonAvatar name={o.label} photoUrl={o.photoUrl} size="h-5 w-5" textSize="text-[9px]" />
      <span className="truncate">{o.label}</span>
    </>
  );

  const r = data?.requester;
  const stats = data?.stats;
  const photo = useRequesterPhoto(r?.email);
  const title = r?.entraJobTitle || r?.jobTitle || null;
  const department = r?.entraDepartment || r?.department || null;
  const place = useMemo(() => [...new Set([r?.entraOfficeLocation, r?.entraCity, r?.entraState, r?.entraCountry].filter(Boolean))].join(' · '), [r]);
  const backTo = location.state?.from || '/tickets';

  const copyEmail = async () => {
    if (!r?.email) return;
    try { await navigator.clipboard.writeText(r.email); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ }
  };

  const queueHref = `/tickets?requesterId=${r?.id}&requesterName=${encodeURIComponent(r?.name || '')}&status=any`;

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[58px]">
      <AppHeader activePage="tickets" />
      <main className={applyWidth('max-w-6xl mx-auto px-4 py-6 pb-24 sm:px-6 lg:pb-6 animate-fadeIn', layoutWidth)}>
        <Link to={backTo} className="tp-focus-ring mb-4 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
        </Link>

        {loading ? (
          <div className="flex items-center justify-center py-24 text-muted-foreground/75"><Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" /></div>
        ) : error || !r ? (
          <div className="tp-card mx-auto max-w-lg rounded-2xl px-6 py-10 text-center" role="alert">
            <UserRound className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" aria-hidden="true" />
            <h1 className="text-lg font-bold text-foreground">Requester not found</h1>
            <p className="mt-1 text-sm text-muted-foreground">{error || 'This person is not in the directory any more.'}</p>
          </div>
        ) : (
          <>
            <header className="tp-card rounded-2xl p-5 sm:p-6">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <PersonAvatar name={r.name} photoUrl={r.photoUrl || photo || null} size="h-20 w-20" textSize="text-2xl" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-2xl font-bold tracking-tight text-foreground">{r.name || r.email}</h1>
                    {!r.isActive && <span className="text-[11px] font-semibold text-muted-foreground">inactive</span>}
                    {r.unattended && <span className="text-[11px] font-semibold text-amber-800 dark:text-amber-200" title="An automation's mailbox — nobody reads replies sent here">unattended mailbox</span>}
                  </div>
                  {(title || department) && <p className="mt-0.5 text-sm text-muted-foreground">{[title, department].filter(Boolean).join(' · ')}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    {r.email && (
                      <button type="button" onClick={copyEmail} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-muted-foreground hover:text-foreground" title="Copy e-mail address">
                        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Mail className="h-3.5 w-3.5" aria-hidden="true" />}
                        {r.email}
                      </button>
                    )}
                    {r.phone && <a href={`tel:${r.phone}`} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-muted-foreground hover:text-foreground"><Phone className="h-3.5 w-3.5" aria-hidden="true" />{r.phone}</a>}
                    {r.mobile && r.mobile !== r.phone && <a href={`tel:${r.mobile}`} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-muted-foreground hover:text-foreground"><Smartphone className="h-3.5 w-3.5" aria-hidden="true" />{r.mobile}</a>}
                    {place && <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-muted-foreground"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />{place}</span>}
                    {r.timeZone && <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-muted-foreground"><Globe className="h-3.5 w-3.5" aria-hidden="true" />{r.timeZone}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button type="button" onClick={() => navigate(`/tickets/new?requesterId=${r.id}&requesterEmail=${encodeURIComponent(r.email || '')}`)} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
                    <Plus className="h-4 w-4" aria-hidden="true" /> New ticket
                  </button>
                  {r.email && <a href={`mailto:${r.email}`} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"><Mail className="h-4 w-4" aria-hidden="true" /> E-mail</a>}
                  {r.freshserviceId && FRESHSERVICE_DOMAIN && (
                    <a href={`https://${FRESHSERVICE_DOMAIN}/itil/requesters/${r.freshserviceId}`} target="_blank" rel="noopener noreferrer" className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">
                      <ExternalLink className="h-4 w-4" aria-hidden="true" /> FreshService
                    </a>
                  )}
                </div>
              </div>
            </header>

            <section aria-label="Service history" className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Open" value={stats?.open ?? 0} />
              <Stat label="Resolved" value={stats?.resolved ?? 0} />
              <Stat label="Total tickets" value={stats?.total ?? 0} hint={stats?.firstTicketAt ? `since ${formatDayTime(stats.firstTicketAt)}` : null} />
              <Stat label="Last ticket" value={stats?.lastTicketAt ? timeAgo(stats.lastTicketAt) : '—'} hint={stats?.lastTicket?.subject || null} />
              <Stat label="Median resolution" value={hoursLabel(stats?.medianResolutionHours)} hint={stats?.resolutionSample ? `last ${stats.resolutionSample} resolved` : 'no resolved tickets yet'} />
            </section>
            {stats?.topCategories?.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>Usually asks about</span>
                {stats.topCategories.map((c) => <span key={c.id} className="text-foreground/85">{c.name} · {c.count}</span>)}
              </p>
            )}

            <div role="tablist" className="mt-5 mb-3 flex items-end gap-1 border-b border-border">
              {[{ k: 'tickets', label: 'Tickets', Icon: TicketIcon }, { k: 'profile', label: 'Profile', Icon: UserRound }].map(({ k, label, Icon }) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`tp-focus-ring relative -mb-px inline-flex items-center gap-1.5 rounded-t-lg border px-4 py-2.5 text-sm font-medium ${tab === k ? 'border-border border-b-card bg-card text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                  {tab === k && <span className="absolute inset-x-0 top-0 h-0.5 rounded-t bg-primary" aria-hidden="true" />}
                  <Icon className="h-4 w-4" aria-hidden="true" /> {label}
                </button>
              ))}
              <Link to={queueHref} className="tp-focus-ring ml-auto mb-1 inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline">
                Open in the queue <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>

            {tab === 'tickets' && (
              <section aria-label="Tickets" className="tp-card overflow-hidden rounded-xl">
                {/* Filters (QA 09-22 #5): status, category, agent — server-side, options from the person's history */}
                {history && history.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
                    <FilterMenu label="Status" value={statusFilter} options={STATUS_OPTIONS} onChange={setStatusFilter} />
                    {categoryOptions.length > 0 && <FilterMenu label="Category" value={categoryFilter} options={categoryOptions} onChange={setCategoryFilter} />}
                    {agentOptions.length > 0 && <FilterMenu label="Agent" value={agentFilter} options={agentOptions} onChange={setAgentFilter} renderOption={renderAgentOption} />}
                    {filtersActive && (
                      <button type="button" onClick={() => { setStatusFilter(''); setCategoryFilter(''); setAgentFilter(''); }} className="tp-focus-ring inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                        <X className="h-3.5 w-3.5" aria-hidden="true" /> Clear
                      </button>
                    )}
                    {ticketsLoading && <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground/75" aria-label="Loading tickets" />}
                  </div>
                )}
                {tickets === null ? (
                  <div className="flex items-center justify-center py-16 text-muted-foreground/75"><Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /></div>
                ) : tickets.length === 0 ? (
                  <div className="px-6 py-12 text-center text-sm text-muted-foreground/75"><Inbox className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" aria-hidden="true" />{filtersActive ? 'No tickets match these filters.' : 'No tickets from this person in this workspace.'}</div>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {tickets.map((t) => {
                      const { category: catLabel, subcategory: subLabel } = ticketCategoryLabels(t);
                      return (
                        <li key={t.id}>
                          <Link to={`/tickets/${t.id}`} state={{ from: `${location.pathname}${location.search}` }} className="tp-focus-ring flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                            <PriorityDot priority={t.priority} />
                            <span className="w-[86px] shrink-0 font-mono text-[11px] font-bold text-muted-foreground">{t.displayRef}</span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="min-w-0 truncate text-sm text-foreground">{t.subject || '(no subject)'}</span>
                                {t.solutionVerifiedAt && <SolutionMark />}
                              </span>
                              {(subLabel || catLabel) && (
                                <span className="block truncate text-[11px] text-muted-foreground/75" title={[catLabel, subLabel].filter(Boolean).join(' / ')}>
                                  {subLabel ? <>{subLabel}{catLabel && <span className="text-muted-foreground/60"> in {catLabel}</span>}</> : catLabel}
                                </span>
                              )}
                            </span>
                            <span className="hidden w-[150px] shrink-0 items-center gap-1.5 sm:flex" title={t.assignedTech?.name || 'Unassigned'}>
                              {t.assignedTech?.name
                                ? <><PersonAvatar name={t.assignedTech.name} photoUrl={t.assignedTech.photoUrl || null} size="h-6 w-6" /><span className="truncate text-xs text-muted-foreground">{t.assignedTech.name}</span></>
                                : <span className="text-xs text-muted-foreground/60">Unassigned</span>}
                            </span>
                            <StatusPill status={t.status} size="sm" />
                            <span className="hidden w-[88px] shrink-0 text-right text-[11px] text-muted-foreground/75 sm:inline" title={t.createdAt ? new Date(t.createdAt).toLocaleString() : undefined}>{t.createdAt ? timeAgo(t.createdAt) : ''}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {ticketsTotal > (tickets?.length || 0) && (
                  <div className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
                    Showing the latest {tickets.length} of {ticketsTotal}. <Link to={queueHref} className="font-medium text-primary hover:underline">See all in the queue</Link>
                  </div>
                )}
              </section>
            )}

            {tab === 'profile' && (
              <section aria-label="Profile" className="tp-card rounded-xl p-5">
                <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Name">{r.name}</Field>
                  <Field label="E-mail">{r.email}</Field>
                  <Field label="Title">{r.entraJobTitle || r.jobTitle}</Field>
                  <Field label="Department">{r.entraDepartment || r.department}</Field>
                  <Field label="Office">{r.entraOfficeLocation}</Field>
                  <Field label="City">{[r.entraCity, r.entraState].filter(Boolean).join(', ')}</Field>
                  <Field label="Country">{[r.entraCountry, r.entraCountryCode].filter(Boolean).join(' · ')}</Field>
                  <Field label="Work phone">{r.phone}</Field>
                  <Field label="Mobile">{r.mobile}</Field>
                  <Field label="Time zone">{r.timeZone}</Field>
                  <Field label="Language">{r.entraPreferredLanguage || r.language}</Field>
                  <Field label="FreshService id">{r.freshserviceId}</Field>
                  <Field label="First seen">{r.createdAt ? formatDayTime(r.createdAt) : null}</Field>
                  <Field label="Directory synced">{r.entraProfileSyncedAt ? `${formatDayTime(r.entraProfileSyncedAt)} (${timeAgo(r.entraProfileSyncedAt)})` : r.entraMissingAt ? 'Not found in the directory' : null}</Field>
                </dl>
                <p className="mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Building2 className="h-3.5 w-3.5" aria-hidden="true" /> Directory fields come from Entra and refresh on their own; FreshService fields come with the tickets.
                  <Clock className="ml-2 h-3.5 w-3.5" aria-hidden="true" /> Counts are for the {currentWorkspace?.name || 'current'} workspace only.
                </p>
              </section>
            )}
          </>
        )}
      </main>
      <MobileTabBar />
    </div>
  );
}
