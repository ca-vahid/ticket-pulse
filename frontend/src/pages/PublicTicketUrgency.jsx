import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ArrowUpCircle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import { publicTicketUrgencyAPI } from '../services/api';

function unwrap(response) {
  return response?.data ?? response ?? null;
}

function reasonText(reason, data) {
  return ({
    business_urgency_disabled: 'This workspace has not enabled requester priority raises.',
    after_hours_use_immediate_support: data?.ticket?.afterHoursEscalationUrl
      ? 'It is outside regular business hours. Use the immediate support page instead.'
      : 'It is outside regular business hours right now.',
    ticket_closed_or_resolved: 'This ticket is already resolved or closed.',
    cooldown_active: 'This ticket was recently raised. Please wait before trying again.',
    already_urgent: 'This ticket is already marked urgent.',
  })[reason] || reason;
}

function LoadingPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-white to-blue-50 p-6">
      <div className="mx-auto flex min-h-[60vh] max-w-3xl items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="text-center text-slate-600">
          <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-orange-600" />
          Loading priority link...
        </div>
      </div>
    </div>
  );
}

export default function PublicTicketUrgency() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const accent = data?.branding?.accentColor || '#ea580c';
  const submitted = data?.status === 'submitted';
  const unavailable = data && !data.available && !submitted;
  const alreadyUrgent = data?.status === 'already_urgent' || data?.alreadyUrgent;

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(unwrap(await publicTicketUrgencyAPI.get(token)));
    } catch (err) {
      setError(err.message || 'This priority link is unavailable.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [token]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      setData(unwrap(await publicTicketUrgencyAPI.submit(token)));
    } catch (err) {
      setError(err.message || 'The ticket priority could not be raised.');
    } finally {
      setSubmitting(false);
    }
  };

  const statusCard = useMemo(() => {
    if (submitted) {
      return {
        tone: 'emerald',
        title: 'Ticket priority raised',
        body: 'Ticket Pulse marked this ticket Urgent. If the ticket is assigned, the assigned agent may be notified based on their notification preferences.',
        Icon: CheckCircle2,
      };
    }
    if (alreadyUrgent) {
      return {
        tone: 'blue',
        title: 'This ticket is already urgent',
        body: 'The public status page will continue to show the latest Ticket Pulse priority and assignment state.',
        Icon: ArrowUpCircle,
      };
    }
    if (unavailable) {
      return {
        tone: 'amber',
        title: 'Priority raise is not available right now',
        body: (data.reasons || []).map((reason) => reasonText(reason, data)).join(' '),
        Icon: Clock3,
      };
    }
    return {
      tone: 'orange',
      title: data?.confirmation?.title || 'Raise this ticket to urgent',
      body: data?.confirmation?.body || 'Use this when the ticket needs priority attention during business hours.',
      Icon: ShieldAlert,
    };
  }, [alreadyUrgent, data, submitted, unavailable]);

  if (loading && !data) return <LoadingPage />;

  const StatusIcon = statusCard.Icon;
  const toneClasses = {
    orange: 'border-orange-200 bg-orange-50 text-orange-950',
    amber: 'border-amber-200 bg-amber-50 text-amber-950',
    blue: 'border-blue-200 bg-blue-50 text-blue-950',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-950',
  }[statusCard.tone] || 'border-slate-200 bg-white text-slate-900';

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-white to-cyan-50 p-4 text-slate-900 sm:p-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-4">
            {data?.branding?.logoDataUrl ? (
              <img
                src={data.branding.logoDataUrl}
                alt={data.branding.logoAltText || ''}
                className="h-16 w-16 rounded-xl border border-slate-200 object-contain p-1"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-xl text-white" style={{ background: accent }}>
                <ShieldAlert className="h-8 w-8" />
              </div>
            )}
            <div>
              <div className="text-sm font-semibold uppercase tracking-wide text-slate-500">{data?.branding?.brandName || data?.workspace?.name || 'Ticket Pulse'}</div>
              <h1 className="text-2xl font-bold text-slate-950">Raise ticket urgency</h1>
              <p className="text-sm text-slate-600">Workspace: {data?.workspace?.name || 'Helpdesk'}</p>
            </div>
          </div>
          {data?.ticket?.publicStatusUrl && (
            <a
              href={data.ticket.publicStatusUrl}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <ExternalLink className="h-4 w-4" />
              View ticket status
            </a>
          )}
        </header>

        {error && (
          <div className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-800">
            {error}
          </div>
        )}

        <main className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <section className={`rounded-2xl border p-6 shadow-sm ${toneClasses}`}>
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-white/70">
                <StatusIcon className="h-8 w-8" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold uppercase tracking-wide opacity-75">Requester priority raise</div>
                <h2 className="mt-1 text-3xl font-bold">{statusCard.title}</h2>
                <p className="mt-3 text-base leading-7 opacity-90">{statusCard.body}</p>
              </div>
            </div>

            {data?.available && !submitted && !alreadyUrgent && (
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-orange-600 px-6 py-3 text-base font-bold text-white shadow-sm transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUpCircle className="h-5 w-5" />}
                {submitting ? 'Raising priority...' : 'Raise ticket to urgent'}
              </button>
            )}

            {data?.afterHours?.active && data?.ticket?.afterHoursEscalationUrl && (
              <a
                href={data.ticket.afterHoursEscalationUrl}
                className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-6 py-3 text-base font-bold text-white shadow-sm transition hover:bg-red-700"
              >
                <ShieldAlert className="h-5 w-5" />
                Request immediate after-hours support
              </a>
            )}
          </section>

          <aside className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-sm font-semibold uppercase tracking-wide text-orange-700">Ticket details</div>
            <h3 className="mt-2 text-xl font-bold text-slate-950">
              #{data?.ticket?.freshserviceTicketId || ''} {data?.ticket?.subject || 'Ticket'}
            </h3>
            <dl className="mt-5 space-y-4">
              <div>
                <dt className="text-xs font-semibold uppercase text-slate-500">Current status</dt>
                <dd className="mt-1 text-lg font-bold text-slate-950">{data?.ticket?.status || 'Unknown'}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase text-slate-500">Current priority</dt>
                <dd className="mt-1 text-lg font-bold text-slate-950">{data?.ticket?.priority || 'Unknown'}</dd>
              </div>
              {data?.ticket?.assignedAgent?.name && (
                <div>
                  <dt className="text-xs font-semibold uppercase text-slate-500">Assigned to</dt>
                  <dd className="mt-2 flex items-center gap-3">
                    {data.ticket.assignedAgent.photoUrl ? (
                      <img src={data.ticket.assignedAgent.photoUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
                    ) : (
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-50 font-semibold text-orange-700">
                        {data.ticket.assignedAgent.name.slice(0, 1)}
                      </span>
                    )}
                    <span className="font-semibold">{data.ticket.assignedAgent.name}</span>
                  </dd>
                </div>
              )}
            </dl>
          </aside>
        </main>
      </div>
    </div>
  );
}
