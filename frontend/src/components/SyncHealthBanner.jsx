import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DatabaseZap, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSSE } from '../hooks/useSSE';
import { syncAPI } from '../services/api';

const POLL_MS = 3 * 60 * 1000;

/**
 * SyncHealthBanner — app-wide warning shown to global admins when a
 * workspace's FreshService sync has gone STALE (no completed sync in >3× its
 * interval — realtime plan Phase 3). Dashboards keep looking alive on old
 * data in that state, which is exactly why nobody notices without this.
 * Passive; polls the admin-only /sync/health endpoint, refetches on the
 * realtime sync events (so a completed sync clears the banner within seconds,
 * not at the next 3-min poll — Phase SH), and links to the Settings
 * sync-freshness card. Dismissible per incident (the set of stale
 * workspaces) — a NEW workspace going stale re-shows it.
 */
export default function SyncHealthBanner() {
  const { user } = useAuth();
  const isGlobalAdmin = user?.role === 'admin';
  const [health, setHealth] = useState(null);
  const [dismissedKey, setDismissedKey] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const resp = await syncAPI.getHealth();
      setHealth(resp?.data || null);
    } catch {
      // Silent: a non-admin or transient error should never surface here.
    }
  }, []);

  useEffect(() => {
    if (!isGlobalAdmin) return undefined;
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isGlobalAdmin, load]);

  // Shared realtime client: a sync finishing (or being skipped because one is
  // already running) is exactly when this banner's verdict changes — refetch
  // instead of letting a resolved incident linger until the next poll.
  useSSE({
    enabled: isGlobalAdmin,
    onSyncCompleted: load,
    onSyncSkipped: load,
  });

  if (!isGlobalAdmin) return null;
  const stale = (health?.workspaces || []).filter((w) => w.status === 'stale');
  if (stale.length === 0) return null;

  // Incident key = which workspaces are stale. Dismissal survives re-polls of
  // the same incident; a different stale set re-shows the banner.
  const incidentKey = stale.map((w) => w.workspaceId).sort((a, b) => a - b).join(',');
  if (dismissedKey === incidentKey) return null;

  const names = stale.map((w) => w.name).join(', ');
  // Defensive downgrade (Phase SH): if a "stale" row reports a healthy run in
  // flight, the data is about to refresh on its own — soften the copy and
  // never nudge toward a "Sync now" the header has disabled anyway.
  const allRunning = stale.every((w) => w.syncRunning);

  return (
    <div className="max-w-sm animate-fadeIn" role="alert" aria-live="assertive">
      <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-white p-3.5 text-slate-800 shadow-lg">
        <DatabaseZap className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
        <div className="min-w-0 text-sm">
          <div className="font-semibold">
            {allRunning ? 'FreshService sync is catching up' : 'FreshService sync is stale'}
          </div>
          <p className="mt-0.5 text-slate-600">
            {stale.length === 1 ? `${names} hasn't` : `${names} haven't`} completed a sync in over 3× the schedule.
            {allRunning
              ? ' A sync is running now — data should refresh shortly.'
              : ' Dashboards are serving old data.'}
          </p>
          <Link
            to="/settings#notification-providers"
            className="mt-1.5 inline-block font-semibold text-amber-700 underline underline-offset-2 hover:text-amber-800"
          >
            View sync freshness →
          </Link>
        </div>
        <button
          type="button"
          onClick={() => setDismissedKey(incidentKey)}
          className="tp-focus-ring flex-shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
