import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Clock3, Database, HelpCircle, RefreshCw,
} from 'lucide-react';
import { syncAPI } from '../../services/api';

const STATUS_META = {
  ok: { label: 'Fresh', Icon: CheckCircle2, badge: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200', dot: 'bg-emerald-500' },
  late: { label: 'Late', Icon: Clock3, badge: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200', dot: 'bg-amber-500' },
  stale: { label: 'Stale', Icon: AlertTriangle, badge: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200', dot: 'bg-red-500' },
  unknown: { label: 'No syncs yet', Icon: HelpCircle, badge: 'bg-secondary text-muted-foreground', dot: 'bg-muted-foreground/60' },
};

// Manual refresh feedback: the request often returns in <100ms, which read as
// "the button did nothing" (QA 08-17 #3). Hold the spinner at least this long.
const MIN_REFRESH_SPINNER_MS = 400;
const AUTO_REFRESH_MS = 60 * 1000;

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

function startedAgo(ms) {
  if (ms === null || ms === undefined) return 'started just now';
  const mins = Math.round(ms / 60000);
  return mins < 1 ? 'started just now' : `started ${mins}m ago`;
}

function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString();
}

/**
 * SyncHealthCard — per-workspace FreshService sync freshness vs the scheduler
 * cadence (realtime plan Phase 3). Stale (>3× interval) means dashboards keep
 * serving old data while looking alive — exactly the "silently dead
 * scheduler" class this card exists to make visible.
 * Phase SH: an in-flight run shows as "Syncing now" instead of aging into a
 * false Stale, and each row carries the honest data-freshness signal
 * (newest ticket ingest, which the 60s fast lane keeps bumping).
 * Powered by GET /api/sync/health (admin).
 */
export default function SyncHealthCard() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async ({ minSpinnerMs = 0 } = {}) => {
    setLoading(true);
    setError(null);
    const startedAt = Date.now();
    try {
      const resp = await syncAPI.getHealth();
      if (mountedRef.current) setHealth(resp?.data || null);
    } catch (err) {
      if (mountedRef.current) setError(err?.message || 'Could not load sync health');
    } finally {
      const wait = minSpinnerMs - (Date.now() - startedAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Keep the card honest while the Settings tab sits open — a stale badge
    // from minutes ago is exactly the confusion this card exists to prevent.
    const timer = setInterval(() => load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const overall = health?.overall || 'unknown';
  const checking = loading && !health;
  const meta = checking
    ? { label: 'Checking…', badge: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/40' }
    : (STATUS_META[overall] || STATUS_META.unknown);
  const rows = health?.workspaces || [];

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200">
            <Database className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Sync freshness</h3>
            <p className="text-xs text-muted-foreground">
              Last completed FreshService sync per workspace vs its schedule — stale means new activity isn&apos;t arriving.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {health?.checkedAt && (
            <span className="text-[11px] text-muted-foreground/75">Checked {fmtClock(health.checkedAt)}</span>
          )}
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.badge}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </span>
          <button
            type="button"
            onClick={() => load({ minSpinnerMs: MIN_REFRESH_SPINNER_MS })}
            disabled={loading}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted/50 disabled:opacity-50"
            title="Refresh"
            aria-label="Refresh sync health"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-red-600 dark:text-red-300">{error}</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Workspace</th>
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium">Last completed sync</th>
                <th className="px-3 py-2 font-medium">Data freshness</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((row) => {
                const rowMeta = STATUS_META[row.status] || STATUS_META.unknown;
                return (
                  <tr key={row.workspaceId} className="text-foreground/85">
                    <td className="px-3 py-2 font-medium text-foreground">{row.name}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">every {row.intervalMinutes}m</td>
                    <td className="whitespace-nowrap px-3 py-2" title={fmtTime(row.lastSyncAt)}>
                      {row.lastSyncAt ? `${relativeAge(row.ageMs)} · ${fmtTime(row.lastSyncAt)}` : 'never'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={fmtTime(row.dataFreshAt)}>
                      {row.dataFreshAt ? `Data fresh ${relativeAge(row.dataAgeMs)}` : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {row.syncRunning ? (
                        // An in-flight run is liveness, not lateness — show it
                        // instead of a misleading Stale/Late chip.
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 dark:bg-blue-500/20 px-2 py-0.5 font-semibold text-blue-700 dark:text-blue-200">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          Syncing now · {startedAgo(row.runningForMs)}
                        </span>
                      ) : (
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-semibold ${rowMeta.badge}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${rowMeta.dot}`} />
                          {rowMeta.label}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-3 text-muted-foreground">No active workspaces.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground/75">
        Stale = no completed sync in over 3× the interval (20-minute floor) with no fresh ticket data and no
        healthy run in flight. Admins get one email per confirmed stale incident.
      </p>
    </section>
  );
}
