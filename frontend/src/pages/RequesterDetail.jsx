import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Building2, Check, Clock, ExternalLink, Globe, Inbox, Loader2, Mail, MapPin, Phone, Plus, Smartphone, Ticket as TicketIcon, UserRound,
} from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import { ticketsAPI } from '../services/api';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { applyWidth, useLayoutWidth } from '../contexts/LayoutContext';
import { PersonAvatar, StatusPill, PriorityDot, formatDayTime, timeAgo } from '../components/tickets/ticketUi';
import { FRESHSERVICE_DOMAIN } from '../components/tech-detail/constants';
import { useRequesterPhoto } from '../hooks/useRequesterPhoto';

/**
 * Search v2 (16 Sep 2026) — the requester page (/requesters/:id): who the
 * person is (directory fields), their service history in this workspace,
 * and their tickets. One person's own history, never a comparison.
 */

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
  const [tickets, setTickets] = useState(null);
  const [ticketsTotal, setTicketsTotal] = useState(null);
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

  useEffect(() => {
    let alive = true;
    ticketsAPI.list({ requesterId: id, pageSize: 50, sort: 'createdAt', dir: 'desc' })
      .then((res) => { if (!alive) return; const body = res?.data || res || {}; setTickets(body.items || []); setTicketsTotal(body.total ?? (body.items || []).length); })
      .catch(() => { if (alive) setTickets([]); });
    return () => { alive = false; };
  }, [id, currentWorkspace?.id]);

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
                    {!r.isActive && <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">inactive</span>}
                    {r.unattended && <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-100" title="Mail from this address is not read by a person">unattended mailbox</span>}
                  </div>
                  {(title || department) && <p className="mt-0.5 text-sm text-muted-foreground">{[title, department].filter(Boolean).join(' · ')}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    {r.email && (
                      <button type="button" onClick={copyEmail} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-muted-foreground hover:border-blue-300 hover:text-blue-700 dark:hover:border-blue-500/40 dark:hover:text-blue-200" title="Copy e-mail address">
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
                  <button type="button" onClick={() => navigate(`/tickets/new?requesterId=${r.id}&requesterEmail=${encodeURIComponent(r.email || '')}`)} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-blue-700">
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
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>Usually asks about</span>
                {stats.topCategories.map((c) => <span key={c.id} className="rounded-full border border-border bg-muted/60 px-2 py-0.5 text-foreground/85">{c.name} · {c.count}</span>)}
              </p>
            )}

            <div role="tablist" className="mt-5 mb-3 flex items-end gap-1 border-b border-border">
              {[{ k: 'tickets', label: 'Tickets', Icon: TicketIcon }, { k: 'profile', label: 'Profile', Icon: UserRound }].map(({ k, label, Icon }) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`tp-focus-ring relative -mb-px inline-flex items-center gap-1.5 rounded-t-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${tab === k ? 'border-border border-b-card bg-card text-primary' : 'border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground/85'}`}>
                  {tab === k && <span className="absolute inset-x-0 top-0 h-0.5 rounded-t bg-primary" aria-hidden="true" />}
                  <Icon className="h-4 w-4" aria-hidden="true" /> {label}
                </button>
              ))}
              <Link to={`/tickets?requesterId=${r.id}&requesterName=${encodeURIComponent(r.name || '')}&status=any`} className="tp-focus-ring ml-auto mb-1 inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline">
                Open in the queue <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>

            {tab === 'tickets' && (
              <section aria-label="Tickets" className="tp-card overflow-hidden rounded-xl">
                {tickets === null ? (
                  <div className="flex items-center justify-center py-16 text-muted-foreground/75"><Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /></div>
                ) : tickets.length === 0 ? (
                  <div className="px-6 py-12 text-center text-sm text-muted-foreground/75"><Inbox className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" aria-hidden="true" />No tickets from this person in this workspace.</div>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {tickets.map((t) => (
                      <li key={t.id}>
                        <Link to={`/tickets/${t.id}`} state={{ from: `${location.pathname}${location.search}` }} className="tp-focus-ring flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                          <PriorityDot priority={t.priority} />
                          <span className="w-[86px] shrink-0 font-mono text-[11px] font-bold text-muted-foreground">{t.displayRef}</span>
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{t.subject || '(no subject)'}</span>
                          {t.assignedTech?.name && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{t.assignedTech.name}</span>}
                          <StatusPill status={t.status} size="sm" />
                          <span className="hidden w-[88px] shrink-0 text-right text-[11px] text-muted-foreground/75 sm:inline" title={t.createdAt ? new Date(t.createdAt).toLocaleString() : undefined}>{t.createdAt ? timeAgo(t.createdAt) : ''}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {ticketsTotal > (tickets?.length || 0) && (
                  <div className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
                    Showing the latest {tickets.length} of {ticketsTotal}. <Link to={`/tickets?requesterId=${r.id}&requesterName=${encodeURIComponent(r.name || '')}&status=any`} className="font-medium text-primary hover:underline">See all in the queue</Link>
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
