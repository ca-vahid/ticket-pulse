import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Wifi } from 'lucide-react';
import { realtimeAPI } from '../../services/api';

/**
 * RealtimeHealthCard — today's sampled client realtime telemetry (realtime
 * plan Phase 3): how often browsers are falling off the live SSE stream onto
 * polling, and who is most affected (truncated emails — a support-triage
 * hint for the proxy-bypass playbook, deliberately NOT a leaderboard).
 * Powered by GET /api/sse/telemetry/summary (admin).
 */
export default function RealtimeHealthCard() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await realtimeAPI.getTelemetrySummary();
      setSummary(resp?.data || null);
    } catch (err) {
      setError(err?.message || 'Could not load realtime health');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const today = summary?.today;
  const yesterday = summary?.yesterday;
  const topUsers = today?.topUsers || [];
  const quietDay = today && today.reports === 0;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
            <Wifi className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-slate-950">Realtime health</h3>
            <p className="text-xs text-slate-500">
              How often browsers fall back from the live stream — sampled from ~10% of sessions (dead-end offline is always reported).
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {summary && (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
              {summary.activeConnections ?? 0} live connection{(summary.activeConnections ?? 0) === 1 ? '' : 's'}
            </span>
          )}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            title="Refresh"
            aria-label="Refresh realtime health"
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
              <div className="text-xs font-medium text-slate-500">Downgrades to polling (today)</div>
              <div className="mt-0.5 text-sm font-semibold text-slate-900">
                {today?.downgrades ?? 0}
                {today?.downgradesByTransport && (today.downgradesByTransport.shortpoll || 0) > 0 && (
                  <span className="ml-1 text-xs font-medium text-slate-500">
                    ({today.downgradesByTransport.shortpoll} to short-poll)
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <div className="text-xs font-medium text-slate-500">Offline transitions</div>
              <div className="mt-0.5 text-sm font-semibold text-slate-900">{today?.offline ?? 0}</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <div className="text-xs font-medium text-slate-500">Dead-end offline (always reported)</div>
              <div className={`mt-0.5 text-sm font-semibold ${today?.offlineTerminal ? 'text-red-600' : 'text-slate-900'}`}>
                {today?.offlineTerminal ?? 0}
              </div>
            </div>
          </div>

          {topUsers.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Most-affected sessions today (support triage)
              </div>
              <ul className="space-y-1">
                {topUsers.map((u) => (
                  <li key={u.user} className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50/60 px-3 py-1.5 text-xs text-slate-700">
                    <span className="font-medium">{u.user}</span>
                    <span className="text-slate-500">{u.events} event{u.events === 1 ? '' : 's'}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-slate-400">
                A recurring name usually means a network problem on that person&apos;s side (VPN / SSL-inspecting proxy) — see the realtime support playbook for the IT bypass request.
              </p>
            </div>
          )}

          {!loading && quietDay && (
            <p className="mt-4 text-xs text-slate-500">
              No degradations reported today — sampled sessions are staying on the live stream.
            </p>
          )}

          {yesterday && yesterday.reports > 0 && (
            <p className="mt-3 text-[11px] text-slate-400">
              Yesterday: {yesterday.downgrades} downgrade{yesterday.downgrades === 1 ? '' : 's'}, {yesterday.offline + yesterday.offlineTerminal} offline. Counters reset on server restart.
            </p>
          )}
        </>
      )}
    </section>
  );
}
