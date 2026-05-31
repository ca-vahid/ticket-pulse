import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Clock3,
  Info,
  Loader2,
  PauseCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ArrowUpCircle,
  UserRound,
} from 'lucide-react';
import { publicTicketStatusAPI } from '../services/api';

function formatDate(value, options = {}) {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...options,
  });
}

function compactDate(value) {
  if (!value) return 'No expiry';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No expiry';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function initials(name) {
  return String(name || 'TP')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || 'TP';
}

function statusStyle(tone) {
  if (tone === 'resolved') {
    return {
      wrap: 'border-emerald-200 bg-emerald-50 text-emerald-950',
      label: 'text-emerald-700',
      icon: 'bg-emerald-600 text-white',
      glow: 'from-emerald-500 via-teal-400 to-cyan-400',
      Icon: CheckCircle2,
    };
  }
  if (tone === 'waiting') {
    return {
      wrap: 'border-amber-200 bg-amber-50 text-amber-950',
      label: 'text-amber-700',
      icon: 'bg-amber-500 text-white',
      glow: 'from-amber-400 via-orange-400 to-rose-400',
      Icon: PauseCircle,
    };
  }
  if (tone === 'open') {
    return {
      wrap: 'border-blue-200 bg-blue-50 text-blue-950',
      label: 'text-blue-700',
      icon: 'bg-blue-600 text-white',
      glow: 'from-blue-500 via-sky-400 to-cyan-300',
      Icon: Activity,
    };
  }
  return {
    wrap: 'border-slate-200 bg-slate-50 text-slate-950',
    label: 'text-slate-600',
    icon: 'bg-slate-700 text-white',
    glow: 'from-slate-500 via-blue-400 to-emerald-300',
    Icon: CircleDot,
  };
}

function timelineStyle(tone) {
  if (tone === 'emerald') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (tone === 'amber') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (tone === 'indigo') return 'border-indigo-200 bg-indigo-50 text-indigo-700';
  if (tone === 'cyan') return 'border-cyan-200 bg-cyan-50 text-cyan-700';
  return 'border-blue-200 bg-blue-50 text-blue-700';
}

function confidenceClass(confidence) {
  if (confidence === 'high') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (confidence === 'medium') return 'border-blue-200 bg-blue-50 text-blue-800';
  if (confidence === 'low') return 'border-amber-200 bg-amber-50 text-amber-800';
  return 'border-slate-200 bg-slate-50 text-slate-700';
}

function Metric({ label, value, tone = 'blue' }) {
  const color = {
    blue: 'border-blue-200 bg-blue-50 text-blue-950',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-950',
    amber: 'border-amber-200 bg-amber-50 text-amber-950',
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-950',
  }[tone] || 'border-slate-200 bg-slate-50 text-slate-950';

  return (
    <div className={`rounded-lg border p-4 ${color}`}>
      <div className="text-xs font-bold uppercase tracking-normal opacity-70">{label}</div>
      <div className="mt-1 text-3xl font-black tracking-normal">{value ?? 'N/A'}</div>
    </div>
  );
}

function DetailTile({ label, value, tone = 'slate' }) {
  const color = {
    blue: 'border-blue-200 bg-blue-50 text-blue-950',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-950',
    amber: 'border-amber-200 bg-amber-50 text-amber-950',
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-950',
    cyan: 'border-cyan-200 bg-cyan-50 text-cyan-950',
    slate: 'border-slate-200 bg-white text-slate-950',
  }[tone] || 'border-slate-200 bg-white text-slate-950';

  return (
    <div className={`rounded-lg border p-4 shadow-sm ${color}`}>
      <div className="text-xs font-black uppercase tracking-normal opacity-70">{label}</div>
      <div className="mt-1 break-words text-base font-black tracking-normal">{value || 'Not available'}</div>
    </div>
  );
}

function MiniFact({ label, value, tone = 'slate' }) {
  const color = {
    blue: 'border-blue-100 bg-blue-50/80 text-blue-950',
    emerald: 'border-emerald-100 bg-emerald-50/80 text-emerald-950',
    amber: 'border-amber-100 bg-amber-50/80 text-amber-950',
    rose: 'border-rose-100 bg-rose-50/80 text-rose-950',
    slate: 'border-slate-100 bg-slate-50 text-slate-950',
  }[tone] || 'border-slate-100 bg-slate-50 text-slate-950';

  return (
    <div className={`rounded-lg border px-3 py-2 ${color}`}>
      <div className="text-[11px] font-black uppercase tracking-normal opacity-65">{label}</div>
      <div className="mt-0.5 text-base font-black">{value || 'Not available'}</div>
    </div>
  );
}

function AgentAvatar({ agent, enabled = true }) {
  const [failed, setFailed] = useState(false);
  const name = agent?.name || 'Assigned agent';
  if (enabled && agent?.photoUrl && !failed) {
    return (
      <img
        src={agent.photoUrl}
        alt=""
        className="h-14 w-14 rounded-full border-2 border-white bg-slate-100 object-cover shadow-sm ring-2 ring-indigo-100"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-lg font-black text-indigo-700 ring-2 ring-indigo-100">
      {agent?.name ? initials(name) : <UserRound className="h-7 w-7" />}
    </span>
  );
}

function ErrorPage({ title, message, onRefresh }) {
  return (
    <main className="min-h-screen bg-gradient-to-br from-rose-50 via-white to-amber-50 px-4 py-10 text-slate-900">
      <div className="mx-auto max-w-2xl rounded-lg border border-red-200 bg-white p-8 shadow-sm">
        <div className="flex items-start gap-4">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-red-50 text-red-600">
            <AlertCircle className="h-6 w-6" />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase text-red-600">Ticket status unavailable</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">{title}</h1>
            <p className="mt-2 text-slate-600">{message}</p>
            <button
              type="button"
              onClick={onRefresh}
              className="mt-5 inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50"
            >
              <RefreshCw className="h-4 w-4" />
              Try again
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function PublicTicketStatus() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await publicTicketStatusAPI.get(token);
      setData(response.data);
    } catch (err) {
      setError({
        status: err.status,
        message: err.message || 'Unable to load this ticket status link.',
      });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const ticket = data?.ticket || {};
  const eta = data?.eta || {};
  const stats = data?.stats || null;
  const branding = data?.branding || {};
  const pageSettings = data?.settings || {};
  const publicActions = data?.publicActions || {};
  const status = statusStyle(ticket.statusTone);
  const StatusIcon = status.Icon;
  const timeline = data?.timeline || [];
  const brandName = branding.brandName || data?.workspace?.name || 'Ticket Pulse';
  const workspaceName = data?.workspace?.name || brandName;
  const accentColor = branding.accentColor || '#2563eb';
  const categoryDetails = useMemo(() => {
    const category = ticket.category || {};
    return {
      category: category.ticketPulseCategory || null,
      subcategory: category.ticketPulseSubcategory || null,
      source: category.source || 'not_classified',
    };
  }, [ticket.category]);
  const etaState = eta.state || (eta.paused ? 'paused' : eta.overdue ? 'overdue' : ticket.statusTone === 'resolved' ? 'resolved' : 'on_track');
  const etaIconTone = {
    resolved: 'bg-emerald-50 text-emerald-700',
    paused: 'bg-amber-50 text-amber-700',
    overdue: 'bg-rose-50 text-rose-700',
    on_track: 'bg-blue-50 text-blue-700',
  }[etaState] || 'bg-slate-50 text-slate-700';
  const etaHeading = eta.statusLabel || (eta.paused ? 'Estimate paused' : eta.overdue ? 'Past estimate' : 'Expected resolution');
  const etaValue = eta.displayLabel || eta.actualResolutionLabel || eta.remainingLabel || eta.estimatedResolutionLabel || eta.label || 'Pending';
  const etaDescription = eta.summary || (eta.paused
    ? 'Pending tickets are waiting on something outside the normal resolution timer, so historical ETA is not treated as overdue.'
    : eta.actualResolutionLabel
      ? `Actual resolution time: ${eta.actualResolutionLabel}`
      : eta.overdue
        ? 'This active ticket is past the historical estimate.'
        : eta.expectedAt
          ? `Historical estimate points to ${formatDate(eta.expectedAt)}.`
          : eta.matchLabel || 'Not enough history yet.');
  const etaEstimateLabel = eta.estimatedResolutionLabel || eta.label || null;

  if (loading && !data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-cyan-50 via-white to-amber-50 text-slate-700">
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          Loading ticket status
        </div>
      </main>
    );
  }

  if (error && !data) {
    const expired = error.status === 403;
    return (
      <ErrorPage
        title={expired ? 'This link is no longer active' : 'We could not find this ticket status link'}
        message={error.message}
        onRefresh={load}
      />
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-cyan-50 via-white to-orange-50 text-slate-900">
      <header className="border-b border-white/70 bg-white/85 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-5">
            {branding.logoDataUrl ? (
              <img
                src={branding.logoDataUrl}
                alt={branding.logoAltText || brandName}
                className="h-28 max-w-72 rounded-lg border border-slate-200 bg-white object-contain p-3 shadow-sm"
              />
            ) : (
              <span
                className="inline-flex h-24 w-24 items-center justify-center rounded-lg text-2xl font-black text-white shadow-sm"
                style={{ backgroundColor: accentColor }}
              >
                {initials(brandName)}
              </span>
            )}
            <div>
              <div className="text-3xl font-black tracking-normal text-slate-950">{workspaceName}</div>
              {brandName !== workspaceName && (
                <div className="mt-1 text-lg font-bold text-slate-700">{brandName}</div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <span>Ticket status snapshot</span>
                <span className="hidden text-slate-300 sm:inline">|</span>
                <span>Updated from Ticket Pulse daily data</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center gap-2 self-start rounded-lg border border-slate-200 bg-white/80 px-3 text-sm font-semibold text-slate-700 shadow-sm hover:bg-white disabled:cursor-wait disabled:opacity-60 lg:self-auto"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Check latest
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {(publicActions.immediateSupportRequested || publicActions.urgencyRaised) && (
          <section className="mb-4 grid gap-3 lg:grid-cols-2">
            {publicActions.immediateSupportRequested && (
              <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-red-950 shadow-sm">
                <ShieldAlert className="mt-1 h-6 w-6 text-red-700" />
                <div>
                  <div className="text-sm font-black uppercase text-red-700">Immediate response requested</div>
                  <div className="mt-1 text-sm leading-6">
                    The requester used the after-hours immediate support link
                    {publicActions.immediateSupportRequestedAt ? ` on ${formatDate(publicActions.immediateSupportRequestedAt)}` : ''}.
                  </div>
                </div>
              </div>
            )}
            {publicActions.urgencyRaised && (
              <div className="flex items-start gap-3 rounded-lg border border-orange-200 bg-orange-50 p-4 text-orange-950 shadow-sm">
                <ArrowUpCircle className="mt-1 h-6 w-6 text-orange-700" />
                <div>
                  <div className="text-sm font-black uppercase text-orange-700">Urgency raised by requester</div>
                  <div className="mt-1 text-sm leading-6">
                    The requester raised this ticket to Urgent
                    {publicActions.urgencyRaisedAt ? ` on ${formatDate(publicActions.urgencyRaisedAt)}` : ''}.
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        <section className="overflow-hidden rounded-lg border border-white bg-white shadow-sm">
          <div className={`h-2 bg-gradient-to-r ${status.glow}`} />
          <div className="grid gap-0 lg:grid-cols-[1.4fr_0.9fr]">
            <div className={`border-b p-6 lg:border-b-0 lg:border-r ${status.wrap}`}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className={`text-sm font-black uppercase tracking-normal ${status.label}`}>Current ticket status</p>
                  <div className="mt-3 flex items-center gap-4">
                    <span className={`inline-flex h-16 w-16 items-center justify-center rounded-lg ${status.icon}`}>
                      <StatusIcon className="h-9 w-9" />
                    </span>
                    <div>
                      <div className="text-5xl font-black tracking-normal">{ticket.status || 'Unknown'}</div>
                      <div className="mt-1 text-sm font-semibold opacity-80">Ticket #{ticket.freshserviceTicketId}</div>
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-white/70 bg-white/70 px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm">
                  Last checked {formatDate(data?.refreshedAt)}
                </div>
              </div>
              <h1 className="mt-6 max-w-4xl break-words text-2xl font-black tracking-normal text-slate-950 sm:text-3xl">
                {ticket.subject}
              </h1>
            </div>

            <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-1">
              <div className="border-b border-slate-100 p-6">
                <div className="flex items-center gap-4">
                  <AgentAvatar agent={ticket.assignedAgent} enabled={pageSettings.showAssignedAgentAvatar} />
                  <div>
                    <p className="text-xs font-bold uppercase text-slate-500">Assigned to</p>
                    <div className="text-xl font-black text-slate-950">
                      {ticket.assignedAgent?.name || 'Not assigned yet'}
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-sm text-slate-500">
                  {ticket.assignedAt ? `Assigned ${formatDate(ticket.assignedAt)}` : 'Assignment details will appear here when available.'}
                </p>
              </div>

              <div className="p-6">
                <div className="flex items-center gap-3">
                  <span className={`inline-flex h-11 w-11 items-center justify-center rounded-lg ${etaIconTone}`}>
                    {etaState === 'paused' ? <PauseCircle className="h-6 w-6" /> : etaState === 'resolved' ? <CheckCircle2 className="h-6 w-6" /> : <Clock3 className="h-6 w-6" />}
                  </span>
                  <div>
                    <p className="text-xs font-bold uppercase text-slate-500">{etaHeading}</p>
                    <div className="text-xl font-black text-slate-950">
                      {etaValue}
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-sm text-slate-500">
                  {etaDescription}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <DetailTile label="Ticket / case number" value={`#${ticket.freshserviceTicketId || 'N/A'}`} tone="emerald" />
          <DetailTile label="Received" value={formatDate(ticket.createdAt)} tone="cyan" />
          <DetailTile label="Priority" value={ticket.priority} tone="blue" />
          <DetailTile
            label="Ticket Pulse category"
            value={categoryDetails.category || 'Not classified yet'}
            tone={categoryDetails.category ? 'indigo' : 'slate'}
          />
          <DetailTile
            label="Ticket Pulse subcategory"
            value={categoryDetails.subcategory || 'Not classified yet'}
            tone={categoryDetails.subcategory ? 'amber' : 'slate'}
          />
          <DetailTile label="Public link" value={`Expires ${compactDate(data?.link?.expiresAt)}`} tone="emerald" />
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <section className="space-y-6">
            <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-black uppercase text-blue-700">Ticket Timeline</p>
                  <h2 className="mt-1 text-2xl font-black tracking-normal text-slate-950">Where things stand</h2>
                </div>
                <Activity className="h-6 w-6 text-cyan-600" />
              </div>
              <div className="mt-6 space-y-0">
                {timeline.map((item, index) => (
                  <div key={`${item.key}-${index}`} className="relative flex gap-4 pb-6 last:pb-0">
                    {index < timeline.length - 1 && (
                      <span className="absolute left-[1.35rem] top-12 h-[calc(100%-2.5rem)] w-0.5 bg-slate-200" />
                    )}
                    <span className={`relative z-10 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border-2 ${timelineStyle(item.tone)}`}>
                      <CircleDot className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-lg font-black text-slate-950">{item.label}</h3>
                        <time className="text-sm font-semibold text-slate-500">{formatDate(item.at)}</time>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-600">{item.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {stats && (
              <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-black uppercase text-emerald-700">Recent service activity</p>
                    <h2 className="mt-1 text-2xl font-black tracking-normal text-slate-950">Today and last 7 days</h2>
                  </div>
                  <ShieldCheck className="h-6 w-6 text-emerald-600" />
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-4">
                  <Metric label="New today" value={stats.todayCreated} tone="blue" />
                  <Metric label="Resolved today" value={stats.todayResolvedOrClosed} tone="emerald" />
                  <Metric label="New 7 days" value={stats.weekCreated} tone="indigo" />
                  <Metric label="Resolved 7 days" value={stats.weekResolvedOrClosed} tone="amber" />
                </div>
              </div>
            )}

            {ticket.summary && (
              <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                <p className="text-sm font-black uppercase text-slate-500">Request Summary</p>
                <p className="mt-3 whitespace-pre-wrap text-base leading-7 text-slate-700">{ticket.summary}</p>
              </div>
            )}
          </section>

          <aside className="space-y-6">
            <div className={`rounded-lg border p-5 shadow-sm ${eta.paused ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-slate-200 bg-white text-slate-900'}`}>
              <div className="flex items-start gap-3">
                {etaState === 'paused' ? <PauseCircle className="mt-1 h-6 w-6 text-amber-600" /> : <Info className="mt-1 h-6 w-6 text-blue-600" />}
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-black">{etaState === 'paused' ? 'ETA paused while pending' : etaState === 'resolved' ? 'ETA and actual resolution' : 'How the ETA is calculated'}</h3>
                  <p className="mt-2 text-sm leading-6 opacity-80">
                    {etaState === 'paused'
                      ? 'The ticket is pending, so the page avoids showing it as late. When FreshService moves it back to active work, the estimate will apply again.'
                      : `Based on ${eta.sampleSize || 0} similar resolved tickets using ${eta.matchLabel || 'workspace history'}. Typical time for this match is ${etaEstimateLabel || 'not available yet'}.`}
                  </p>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <MiniFact label={`${eta.percentileLabel || 'Historical'} estimate`} value={etaEstimateLabel} tone={etaState === 'overdue' ? 'rose' : 'blue'} />
                    <MiniFact label="Sample size" value={eta.sampleSize ? `${eta.sampleSize} tickets` : 'No samples'} tone="slate" />
                    {eta.actualResolutionLabel && (
                      <MiniFact label="Actual time" value={eta.actualResolutionLabel} tone="emerald" />
                    )}
                    {eta.expectedAt && etaState !== 'resolved' && (
                      <MiniFact label="Estimated by" value={formatDate(eta.expectedAt)} tone={etaState === 'overdue' ? 'rose' : 'emerald'} />
                    )}
                  </div>
                  {etaState !== 'paused' && (
                    <div className={`mt-3 inline-flex rounded-lg border px-3 py-2 text-sm font-bold ${confidenceClass(eta.confidence)}`}>
                      Confidence: {eta.confidence || 'none'}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {ticket.statusTone === 'resolved' && (
              <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-emerald-900 shadow-sm">
                <CheckCircle2 className="mt-0.5 h-6 w-6" />
                <div>
                  <div className="font-black">This ticket is resolved or closed.</div>
                  <div className="mt-1 text-sm">
                    {ticket.closedAt
                      ? `Closed ${formatDate(ticket.closedAt)}.`
                      : ticket.resolvedAt
                        ? `Resolved ${formatDate(ticket.resolvedAt)}.`
                        : ticket.completedAt
                          ? `Completed ${formatDate(ticket.completedAt)}.`
                          : 'The helpdesk status marks it as complete.'}
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>

        <footer className="mt-8 flex flex-col gap-2 border-t border-slate-200 py-5 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>{branding.trademarkText || `${brandName} service status powered by Ticket Pulse.`}</span>
          <span>Manual status snapshot. No login is required for this link.</span>
        </footer>
      </div>
    </main>
  );
}
