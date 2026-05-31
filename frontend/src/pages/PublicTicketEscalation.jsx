import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import { publicTicketEscalationAPI } from '../services/api';

function unwrap(response) {
  return response?.data ?? response ?? null;
}

function reasonText(reason) {
  return ({
    self_service_disabled: 'Requester self-escalation is not enabled for this workspace.',
    not_after_hours: 'This link can only be used during configured after-hours or holiday windows.',
    ticket_closed_or_resolved: 'This ticket is already resolved or closed.',
    cooldown_active: 'This ticket was recently escalated. Please wait before trying again.',
    already_escalated: 'This ticket is already marked urgent.',
  })[reason] || reason;
}

function LoadingPage() {
  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto flex min-h-[60vh] max-w-3xl items-center justify-center rounded-2xl border border-slate-200 bg-white">
        <div className="text-center text-slate-600">
          <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-blue-600" />
          Loading escalation link...
        </div>
      </div>
    </div>
  );
}

export default function PublicTicketEscalation() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const accent = data?.branding?.accentColor || '#2563eb';
  const unavailable = data && !data.available && data.status !== 'submitted';
  const submitted = data?.status === 'submitted';
  const alreadyEscalated = data?.status === 'already_escalated' || data?.alreadyEscalated;

  const statusCard = useMemo(() => {
    if (submitted) {
      return {
        tone: 'emerald',
        title: 'Urgent escalation submitted',
        body: 'Ticket Pulse marked this ticket as urgent and notified the workspace escalation roster.',
        Icon: CheckCircle2,
      };
    }
    if (alreadyEscalated) {
      return {
        tone: 'blue',
        title: 'This ticket is already urgent',
        body: 'The helpdesk already has this marked as urgent. The ticket status link will continue to show the latest state.',
        Icon: ArrowUpCircle,
      };
    }
    if (unavailable) {
      return {
        tone: 'amber',
        title: 'Immediate escalation is not available right now',
        body: (data.reasons || []).map(reasonText).join(' '),
        Icon: Clock3,
      };
    }
    return {
      tone: 'red',
      title: 'Confirm urgent after-hours assistance',
      body: data?.confirmation?.body || 'Use this only if the request cannot wait until regular business hours.',
      Icon: ShieldAlert,
    };
  }, [alreadyEscalated, data, submitted, unavailable]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await publicTicketEscalationAPI.get(token);
      setData(unwrap(response));
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'This escalation link is unavailable.');
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
      const response = await publicTicketEscalationAPI.submit(token);
      setData(unwrap(response));
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'The escalation could not be submitted.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !data) return <LoadingPage />;

  const StatusIcon = statusCard.Icon;
  const toneClasses = {
    red: 'border-red-200 bg-red-50 text-red-900',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    blue: 'border-blue-200 bg-blue-50 text-blue-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }[statusCard.tone] || 'border-slate-200 bg-white text-slate-900';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 p-4 text-slate-900 sm:p-8">
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
              <h1 className="text-2xl font-bold text-slate-950">After-hours urgent assistance</h1>
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
                <div className="text-sm font-semibold uppercase tracking-wide opacity-75">Urgent escalation</div>
                <h2 className="mt-1 text-3xl font-bold">{statusCard.title}</h2>
                <p className="mt-3 text-base leading-7 opacity-90">{statusCard.body}</p>
              </div>
            </div>

            {data?.available && !submitted && !alreadyEscalated && (
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-6 py-3 text-base font-bold text-white shadow-sm transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShieldAlert className="h-5 w-5" />}
                {submitting ? 'Submitting escalation...' : 'Yes, request urgent help now'}
              </button>
            )}
          </section>

          <aside className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-sm font-semibold uppercase tracking-wide text-blue-700">Ticket details</div>
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
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 font-semibold text-blue-700">
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

        <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
            <div>
              <h2 className="text-base font-semibold text-slate-950">Use only for immediate after-hours help</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                This page is for requests that cannot wait until the next business-hours window. If the request can wait, the normal ticket queue and status page are the right path.
              </p>
              {data?.afterHours?.availability?.nextBusinessTimeLocal && (
                <p className="mt-2 text-sm font-semibold text-slate-800">
                  Next business-hours window: {data.afterHours.availability.nextBusinessTimeLocal}
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm font-semibold uppercase tracking-wide text-blue-700">Response windows</div>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
              <div className="text-xs font-bold uppercase text-blue-700">During business hours</div>
              <p className="mt-2 text-sm leading-6 text-blue-950">{data?.afterHours?.responseCopy?.businessHours}</p>
            </div>
            <div className="rounded-xl border border-red-100 bg-red-50 p-4">
              <div className="text-xs font-bold uppercase text-red-700">During after-hours</div>
              <p className="mt-2 text-sm leading-6 text-red-950">{data?.afterHours?.responseCopy?.afterHours}</p>
            </div>
            <div className="rounded-xl border border-amber-100 bg-amber-50 p-4">
              <div className="text-xs font-bold uppercase text-amber-700">During late night hours</div>
              <p className="mt-2 text-sm leading-6 text-amber-950">{data?.afterHours?.responseCopy?.lateNight}</p>
            </div>
          </div>
          {data?.afterHours?.responseTable?.rows?.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full border-collapse bg-white text-sm">
                <thead className="bg-slate-50 text-slate-700">
                  <tr>
                    <th className="border-b border-slate-200 px-4 py-3 text-left font-bold">Window</th>
                    <th className="border-b border-slate-200 px-4 py-3 text-left font-bold">Business Hours</th>
                    <th className="border-b border-slate-200 px-4 py-3 text-left font-bold">After-hours</th>
                    <th className="border-b border-slate-200 px-4 py-3 text-left font-bold">Late Night</th>
                  </tr>
                </thead>
                <tbody>
                  {data.afterHours.responseTable.rows.map((row, index) => (
                    <tr key={`${row.label}-${index}`} className="odd:bg-white even:bg-slate-50/70">
                      <td className="border-b border-slate-100 px-4 py-3 font-bold text-slate-900">{row.label}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-slate-700">{row.businessHours}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-slate-700">{row.afterHours}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-slate-700">{row.lateNight}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
