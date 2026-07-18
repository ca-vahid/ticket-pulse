import { useCallback, useEffect, useState } from 'react';
import {
  Activity, AlertTriangle, CheckCircle2, RefreshCw, MailWarning, HelpCircle,
} from 'lucide-react';
import { settingsAPI } from '../../services/api';

const STATUS_META = {
  healthy: {
    label: 'Healthy', Icon: CheckCircle2,
    badge: 'bg-emerald-100 text-emerald-700',
    dot: 'bg-emerald-500',
  },
  degraded: {
    label: 'Degraded', Icon: AlertTriangle,
    badge: 'bg-amber-100 text-amber-700',
    dot: 'bg-amber-500',
  },
  down: {
    label: 'Delivery failing', Icon: MailWarning,
    badge: 'bg-red-100 text-red-700',
    dot: 'bg-red-500',
  },
  unknown: {
    label: 'No recent sends', Icon: HelpCircle,
    badge: 'bg-slate-200 text-slate-600',
    dot: 'bg-slate-400',
  },
};

function relativeTime(iso) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * EmailHealthCard — surfaces outbound-email delivery health so a silent
 * provider outage (e.g. SendGrid dropping the app's IP) is visible instead of
 * swallowed. Powered by GET /api/settings/email-health.
 */
export default function EmailHealthCard() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await settingsAPI.getEmailHealth();
      setHealth(resp?.data || null);
    } catch (err) {
      setError(err?.message || 'Could not load email health');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const status = health?.status || 'unknown';
  // Until the first load resolves, show a neutral "Checking…" badge rather than
  // asserting "No recent sends" (the unknown-state label) before we actually know.
  const checking = loading && !health;
  const meta = checking
    ? { label: 'Checking…', badge: 'bg-slate-100 text-slate-500', dot: 'bg-slate-300' }
    : (STATUS_META[status] || STATUS_META.unknown);
  const failures = health?.recentFailures || [];
  const unhealthy = status === 'down' || status === 'degraded';

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
            <Activity className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-slate-950">Email delivery health</h3>
            <p className="text-xs text-slate-500">
              Every outbound email is checked — failures show up here instead of being silently dropped.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.badge}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </span>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            title="Refresh"
            aria-label="Refresh email health"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-red-600">{error}</p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <div className="text-xs font-medium text-slate-500">Last successful send</div>
              <div className="mt-0.5 text-sm font-semibold text-slate-900">
                {relativeTime(health?.lastSuccessAt)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <div className="text-xs font-medium text-slate-500">Last failure</div>
              <div className="mt-0.5 text-sm font-semibold text-slate-900">
                {relativeTime(health?.lastFailureAt)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <div className="text-xs font-medium text-slate-500">Last 24 hours</div>
              <div className="mt-0.5 text-sm font-semibold text-slate-900">
                <span className="text-emerald-600">{health?.successCount24h ?? 0} sent</span>
                {' · '}
                <span className={health?.failureCount24h ? 'text-red-600' : 'text-slate-500'}>
                  {health?.failureCount24h ?? 0} failed
                </span>
              </div>
            </div>
          </div>

          {unhealthy && health?.hint && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
              <span>{health.hint}</span>
            </div>
          )}

          {failures.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Recent failures
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">When</th>
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium">Provider</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">To</th>
                      <th className="px-3 py-2 font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {failures.map((f) => (
                      <tr key={f.id} className="text-slate-700">
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">{fmtTime(f.createdAt)}</td>
                        <td className="px-3 py-2">{f.context || '—'}</td>
                        <td className="px-3 py-2">{f.provider || '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          <span className="font-medium text-red-600">{f.statusCode || f.errorClass || 'error'}</span>
                        </td>
                        <td className="px-3 py-2 text-slate-500">{f.recipientDomain || '—'}</td>
                        <td className="max-w-[22rem] px-3 py-2 text-slate-500">
                          <span className="line-clamp-2">{f.sanitizedMessage || '—'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loading && status === 'unknown' && (
            <p className="mt-4 text-xs text-slate-500">
              No email sends recorded yet. Send a test below and this will populate.
            </p>
          )}
        </>
      )}
    </section>
  );
}
