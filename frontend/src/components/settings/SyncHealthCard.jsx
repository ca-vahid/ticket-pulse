import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Clock3, Database, HelpCircle, RefreshCw,
} from 'lucide-react';
import { syncAPI } from '../../services/api';

const STATUS_META = {
  ok: { label: 'Fresh', Icon: CheckCircle2, badge: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
  late: { label: 'Late', Icon: Clock3, badge: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
  stale: { label: 'Stale', Icon: AlertTriangle, badge: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
  unknown: { label: 'No syncs yet', Icon: HelpCircle, badge: 'bg-slate-200 text-slate-600', dot: 'bg-slate-400' },
};

function relativeAge(ageMs) {
  if (ageMs === null || ageMs === undefined) return 'never';
  const mins = Math.round(ageMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * SyncHealthCard — per-workspace FreshService sync freshness vs the scheduler
 * cadence (realtime plan Phase 3). Stale (>3× interval) means dashboards keep
 * serving old data while looking alive — exactly the "silently dead
 * scheduler" class this card exists to make visible.
 * Powered by GET /api/sync/health (admin).
 */
export default function SyncHealthCard() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await syncAPI.getHealth();
      setHealth(resp?.data || null);
    } catch (err) {
      setError(err?.message || 'Could not load sync health');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const overall = health?.overall || 'unknown';
  const checking = loading && !health;
  const meta = checking
    ? { label: 'Checking…', badge: 'bg-slate-100 text-slate-500', dot: 'bg-slate-300' }
    : (STATUS_META[overall] || STATUS_META.unknown);
  const rows = health?.workspaces || [];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
            <Database className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-slate-950">Sync freshness</h3>
            <p className="text-xs text-slate-500">
              Last completed FreshService sync per workspace vs its schedule — stale means new activity isn&apos;t arriving.
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
            aria-label="Refresh sync health"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-red-600">{error}</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">Workspace</th>
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium">Last completed sync</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const rowMeta = STATUS_META[row.status] || STATUS_META.unknown;
                return (
                  <tr key={row.workspaceId} className="text-slate-700">
                    <td className="px-3 py-2 font-medium text-slate-900">{row.name}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-500">every {row.intervalMinutes}m</td>
                    <td className="whitespace-nowrap px-3 py-2" title={fmtTime(row.lastSyncAt)}>
                      {row.lastSyncAt ? `${relativeAge(row.ageMs)} · ${fmtTime(row.lastSyncAt)}` : 'never'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-semibold ${rowMeta.badge}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${rowMeta.dot}`} />
                        {rowMeta.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-3 text-slate-500">No active workspaces.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[11px] text-slate-400">
        Stale = no completed sync in over 3× the interval (15-minute floor). Admins get one email per stale incident.
      </p>
    </section>
  );
}
