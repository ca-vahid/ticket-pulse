import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Award,
  Bell,
  Boxes,
  Calendar,
  Check,
  ChevronDown,
  LogOut,
  RefreshCw,
  Settings,
  Sparkles,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useDashboard } from '../contexts/DashboardContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useRealtimeStatus } from '../hooks/useRealtimeStatus';
import {
  scrubFreeText as scrubDemoText,
  useDemoLabel,
  useDemoMode,
} from '../utils/demoMode';
import { APP_VERSION } from '../data/changelog';
import { syncAPI } from '../services/api';
import { NAV_DESTINATIONS, useCanAccessSettings, useWorkspaceRole } from './nav/navDestinations';
import SideRail from './nav/SideRail';
import ThemeControl from './nav/ThemeControl';
import ChangelogModal from './ChangelogModal';

// Slim top bar for desktop. Primary navigation lives in the fixed left
// SideRail (rendered here so every AppHeader page gets it); the bar itself
// carries only workspace, page title, page actions, one consolidated status
// pill, and the account menu. On phones the bar disappears entirely — the
// bottom MobileTabBar is the chrome — except for a slim inline row when a
// page passes extraActions (or a background sync needs a stop affordance).
export default function AppHeader({
  activePage = 'dashboard',
  dashboardActions = null,
  extraActions = null,
  backgroundSyncRunning = false,
  backgroundSyncStep = null,
  killingSync = false,
  onKillSync,
  clearCacheOnLogout,
  isColdLoading = false,
}) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const {
    currentWorkspace, availableWorkspaces, switchWorkspace,
    switchError, clearSwitchError, retryWorkspaceSync,
  } = useWorkspace();
  const {
    isRefreshing, lastUpdated, sseConnectionStatus, sseTransportStatus, sseTransport,
    sseRetry, sseGetReconnectChurn, sseGetDiagnostics, sseEnabled, syncSkippedEvent,
  } = useDashboard();
  // Honest pill (QA 08-19 #3): the pill reports the SHARED realtime client —
  // one connection per tab, kept alive on every header page (useApprovalCount
  // + this status-only subscription) — NOT DashboardContext's route-gated
  // consumer. That consumer's `sseEnabled` only means "this route refetches
  // dashboards on sync-completed"; reading it for the pill made /approvals
  // (and any route outside APP_LIVE_SSE_ROUTES) show a red Offline while the
  // tab was genuinely live. The legacy EventSource transport has no shared
  // client — rt.active is false there and everything below falls back to the
  // DashboardContext-derived state (the pre-shared behavior).
  const rt = useRealtimeStatus(currentWorkspace?.id);
  // Manual reconnect: with the shared client Retry is actionable on EVERY
  // page (the client runs wherever the header renders). On the legacy path it
  // keeps the old rule — only where the route-gated feed is supposed to run.
  const canRetrySse = rt.active ? Boolean(rt.retry) : Boolean(sseEnabled && sseRetry);
  const pillRetry = rt.active ? rt.retry : sseRetry;
  const pillTransport = rt.active ? rt.transport : sseTransport;
  const pillGetDiagnostics = rt.active ? rt.getDiagnostics : sseGetDiagnostics;
  const pillGetReconnectChurn = rt.active ? rt.getReconnectChurn : sseGetReconnectChurn;
  const [showChangelog, setShowChangelog] = useState(false);
  const [manualSyncing, setManualSyncing] = useState(false);
  // Response-driven "Sync now" feedback (realtime plan Phase 1 — the trigger
  // used to swallow every outcome, so skipped/forbidden syncs were silent).
  const [syncNotice, setSyncNotice] = useState(null); // { tone: 'ok'|'warn'|'error', text }
  const syncNoticeTimerRef = useRef(null);
  const showSyncNotice = (tone, text) => {
    if (syncNoticeTimerRef.current) clearTimeout(syncNoticeTimerRef.current);
    setSyncNotice({ tone, text });
    syncNoticeTimerRef.current = setTimeout(() => setSyncNotice(null), 6000);
  };
  useEffect(() => () => { if (syncNoticeTimerRef.current) clearTimeout(syncNoticeTimerRef.current); }, []);

  // Publish the bar's MEASURED height as `--tp-app-header-h` on <html> so
  // sticky elements that dock under it (the dashboard's compact column header,
  // `.tp-compact-sticky`) use the real value instead of a hardcoded guess
  // (QA 09-01 #1: the old 57px left a see-through strip above a 53px bar).
  // Cleared while the bar is hidden (<md) so consumers fall back to their
  // default; jsdom has no ResizeObserver, so the effect degrades to no-op.
  const headerRef = useRef(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    const publish = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) root.style.setProperty('--tp-app-header-h', `${h}px`);
      else root.style.removeProperty('--tp-app-header-h');
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return () => root.style.removeProperty('--tp-app-header-h');
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--tp-app-header-h');
    };
  }, []);

  // Server broadcast: someone's "Sync now" hit the already-running guard.
  const lastSkipSeenRef = useRef(null);
  useEffect(() => {
    if (!syncSkippedEvent || syncSkippedEvent.at === lastSkipSeenRef.current) return;
    lastSkipSeenRef.current = syncSkippedEvent.at;
    showSyncNotice('warn', 'A sync is already running');
  }, [syncSkippedEvent]);

  // Pages without their own dashboard refresh handlers still get a "Sync now"
  // in the Live popover (QA 07-08: it only existed on the Dashboard). Fires a
  // workspace-wide sync. Feedback is RESPONSE-driven, never SSE-dependent.
  const triggerManualSync = async () => {
    setManualSyncing(true);
    showSyncNotice('ok', 'Sync started');
    try {
      const res = await syncAPI.trigger();
      if (res?.data?.status === 'skipped') {
        showSyncNotice('warn', 'A sync is already running');
      } else {
        // The trigger endpoint runs the sync to completion before responding.
        showSyncNotice('ok', 'Sync finished — data refreshed');
      }
    } catch (err) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        showSyncNotice('error', 'Only admins can start a sync');
      } else {
        showSyncNotice('error', 'Sync failed to start — try again');
      }
    } finally {
      setManualSyncing(false);
    }
  };
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  // Background-sync row honesty: off-dashboard routes have no sync polling, so
  // the row was a hard-coded "Idle". Fetch the real status lazily when the
  // popover opens (props from Dashboard still win when provided).
  const [lazySyncStatus, setLazySyncStatus] = useState(null); // { running, step }
  useEffect(() => {
    if (!statusOpen) return undefined;
    let cancelled = false;
    syncAPI.getStatus()
      .then((res) => {
        if (cancelled) return;
        setLazySyncStatus({
          running: Boolean(res?.data?.sync?.isRunning),
          step: res?.data?.sync?.progress?.currentStep || null,
        });
      })
      .catch(() => { if (!cancelled) setLazySyncStatus(null); });
    return () => { cancelled = true; };
  }, [statusOpen]);

  const demoMode = useDemoMode();
  const displayUserName = useDemoLabel('name', user?.name || user?.username || 'User');
  const userInitials = String(displayUserName || 'U')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'U';
  // Fails closed (null) until the workspace list has hydrated — admin-only
  // menu rows never flash for a viewer (v3.7.02 role lockdown).
  const wsRole = useWorkspaceRole();
  const canManageWorkspace = wsRole === 'admin';
  const showSettingsMenuItem = useCanAccessSettings();
  const showAdminSummitLink = canManageWorkspace && (Number(currentWorkspace?.id) === 1 || currentWorkspace?.slug === 'it');

  // One outside-click/Escape closer for all three header popups.
  const anyPopupOpen = userMenuOpen || workspaceMenuOpen || statusOpen;
  useEffect(() => {
    if (!anyPopupOpen) return undefined;

    const closeAll = () => {
      setUserMenuOpen(false);
      setWorkspaceMenuOpen(false);
      setStatusOpen(false);
    };
    const handlePointerDown = (event) => {
      if (!event.target.closest('[data-tp-header-popup]')) closeAll();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeAll();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anyPopupOpen]);

  const handleLogout = async () => {
    clearCacheOnLogout?.();
    await logout();
    navigate('/login');
  };

  const navigateFromMenu = (path) => {
    setUserMenuOpen(false);
    navigate(path);
  };

  const pageTitle = activePage === 'settings'
    ? 'Settings'
    : NAV_DESTINATIONS.find((d) => d.id === activePage)?.label
      || (activePage ? activePage.charAt(0).toUpperCase() + activePage.slice(1) : '');

  const workspaceName = currentWorkspace
    ? (demoMode ? scrubDemoText(currentWorkspace.name) : currentWorkspace.name)
    : '';

  const renderWorkspaceControl = () => {
    if (!currentWorkspace) return null;
    const multi = availableWorkspaces.length > 1;

    const pillInner = (
      <>
        <span className="truncate">{workspaceName}</span>
        {wsRole && (
          <span className="flex-none rounded bg-blue-100 px-1 py-px text-[9px] dark:bg-blue-400/20 font-bold uppercase tracking-wide">
            {wsRole}
          </span>
        )}
        {multi && <ChevronDown className={`h-3.5 w-3.5 flex-none text-blue-500 transition-transform dark:text-blue-300 ${workspaceMenuOpen ? 'rotate-180' : ''}`} />}
      </>
    );

    if (!multi) {
      return (
        <span className="inline-flex min-w-0 max-w-[15rem] items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-200">
          {pillInner}
        </span>
      );
    }

    return (
      <div className="relative flex-shrink-0" data-tp-header-popup>
        <button
          type="button"
          onClick={() => { setWorkspaceMenuOpen((o) => !o); setUserMenuOpen(false); setStatusOpen(false); }}
          aria-haspopup="menu"
          aria-expanded={workspaceMenuOpen}
          title="Switch workspace"
          className="inline-flex min-w-0 max-w-[15rem] items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-200 dark:hover:bg-blue-500/25 tp-focus-ring"
        >
          {pillInner}
        </button>
        {workspaceMenuOpen && (
          <div
            role="menu"
            className="absolute left-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-xl shadow-slate-900/10 dark:shadow-black/50"
          >
            <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Workspace</p>
            {availableWorkspaces.map((ws) => {
              const isCurrent = ws.id === currentWorkspace.id;
              return (
                <button
                  key={ws.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceMenuOpen(false);
                    if (isCurrent) return;
                    switchWorkspace(ws.id);
                    window.location.reload();
                  }}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted ${isCurrent ? 'font-semibold text-foreground' : 'text-foreground/85'}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{demoMode ? scrubDemoText(ws.name) : ws.name}</span>
                    {ws.role && <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{ws.role}</span>}
                  </span>
                  {isCurrent && <Check className="h-3.5 w-3.5 flex-none text-primary" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // ---- consolidated status pill -------------------------------------------
  const syncing = backgroundSyncRunning || (isRefreshing && !isColdLoading);
  // Popover "Background sync" row: Dashboard's live props win; other routes
  // fall back to the lazily-fetched status (see effect above).
  const syncRowRunning = backgroundSyncRunning || Boolean(lazySyncStatus?.running);
  const syncRowStep = backgroundSyncRunning ? backgroundSyncStep : (backgroundSyncStep || lazySyncStatus?.step);
  const progressMatch = backgroundSyncStep && backgroundSyncStep.match(/(\d+)\s*\/\s*(\d+)/);
  const syncPct = progressMatch
    ? Math.min(100, Math.max(0, (parseInt(progressMatch[1], 10) / Math.max(1, parseInt(progressMatch[2], 10))) * 100))
    : null;

  // Transport-ladder state (realtime plan Phase 2), read from the SHARED
  // client (see rt above). 'idle' = the client hasn't started for this
  // workspace yet — show it as connecting, never offline. The legacy
  // EventSource path (VITE_REALTIME_TRANSPORT=eventsource) has no ladder —
  // derive an equivalent state from DashboardContext's plain connection
  // status, exactly as before.
  const ladderState = rt.active
    ? (rt.state === 'idle' ? 'connecting' : rt.state)
    : sseTransportStatus && sseTransportStatus !== 'idle'
      ? sseTransportStatus
      : sseConnectionStatus === 'connected'
        ? 'live-sse'
        : sseConnectionStatus === 'connecting' ? 'connecting' : 'offline';

  // Pill vocabulary: Live (SSE) / Auto-refresh (polling, amber) / Offline.
  // Never a spinner-forever "connecting" — after the ladder's budgets it is
  // either degraded (amber, honest) or offline (red, actionable).
  const statusTone = ladderState === 'live-sse'
    ? (syncing ? 'sync' : 'live')
    : ladderState === 'live-poll'
      ? (syncing ? 'sync' : 'poll')
      : ladderState === 'connecting' ? 'connecting' : 'offline';

  const STATUS_PILL = {
    // Accent tints have no token — the dark twins keep the same hue family at
    // ~10–20% strength on the slate ground (Phase DM-A convention).
    live: 'border-emerald-200 bg-emerald-50/80 text-emerald-700 hover:bg-emerald-100/80 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20',
    sync: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-200 dark:hover:bg-blue-500/25',
    poll: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20',
    connecting: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20',
    offline: 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20',
  };

  const STATUS_LABEL = {
    sync: 'Syncing',
    live: 'Live',
    poll: 'Auto-refresh',
    connecting: 'Connecting',
  };

  // Diagnostics for the popover (transport, last event age, churn, channel
  // workspace) — read lazily while open so the support screenshot is
  // self-diagnosing without costing renders the rest of the time.
  const [rtDiag, setRtDiag] = useState(null);
  useEffect(() => {
    if (!statusOpen || !pillGetDiagnostics) {
      setRtDiag(null);
      return undefined;
    }
    const read = () => setRtDiag(pillGetDiagnostics());
    read();
    const timer = setInterval(read, 5000);
    return () => clearInterval(timer);
  }, [statusOpen, pillGetDiagnostics]);

  const formatEventAge = (ts) => {
    if (!ts) return '—';
    const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 90) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
  };

  const TRANSPORT_LABEL = {
    sse: 'Live stream (SSE)',
    longpoll: 'Long-poll fallback',
    shortpoll: 'Periodic refresh (30s)',
  };

  const timeLabel = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : null;

  const renderStatusPill = () => (
    <div className="relative flex-shrink-0" data-tp-header-popup>
      <button
        type="button"
        onClick={() => {
          // Offline pill doubles as the manual retry (QA 08-07 #14): clicking
          // it kicks a reconnect (budget reset) instead of opening the popup —
          // the pill flipping to "Connecting" is the feedback.
          if (statusTone === 'offline' && canRetrySse) {
            pillRetry();
            return;
          }
          setStatusOpen((o) => !o); setUserMenuOpen(false); setWorkspaceMenuOpen(false);
        }}
        aria-haspopup="dialog"
        aria-expanded={statusOpen}
        title={statusTone === 'offline' && canRetrySse ? 'Realtime feed offline — click to reconnect' : 'Data status & sync'}
        className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors tp-focus-ring ${STATUS_PILL[statusTone]}`}
      >
        {statusTone === 'sync' ? (
          <span className="relative flex h-4 w-4 items-center justify-center">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            {syncPct !== null && (
              <svg className="absolute inset-0 h-4 w-4 -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" className="text-blue-200 dark:text-blue-400/30" strokeWidth="2.5" />
                <circle
                  cx="10" cy="10" r="8" fill="none"
                  stroke="currentColor" className="text-blue-600 dark:text-blue-300" strokeWidth="2.5"
                  strokeDasharray={`${(syncPct / 100) * 2 * Math.PI * 8} ${2 * Math.PI * 8}`}
                  strokeLinecap="round"
                />
              </svg>
            )}
          </span>
        ) : statusTone === 'offline' ? (
          <WifiOff className="h-3.5 w-3.5" />
        ) : (
          <span className={`h-2 w-2 rounded-full ${
            statusTone === 'live'
              ? 'bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129/0.18)]'
              : statusTone === 'poll'
                ? 'bg-amber-500 shadow-[0_0_0_3px_rgb(245_158_11/0.18)]'
                : 'bg-amber-400 animate-pulse'
          }`} />
        )}
        <span>
          {STATUS_LABEL[statusTone] || (canRetrySse ? 'Offline — Reconnect' : 'Offline')}
        </span>
        {timeLabel && statusTone !== 'offline' && (
          <span className="hidden font-medium opacity-70 lg:inline">· {timeLabel}</span>
        )}
      </button>

      {statusOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-border bg-card p-3.5 text-xs text-foreground shadow-xl shadow-slate-900/10 dark:shadow-black/50">
          <div className="flex items-center justify-between py-1">
            <span className="text-muted-foreground">Realtime feed</span>
            <span className={`inline-flex items-center gap-1.5 font-semibold ${
              ladderState === 'live-sse' ? 'text-emerald-600 dark:text-emerald-400'
                : ladderState === 'live-poll' || ladderState === 'connecting' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'
            }`}>
              {ladderState === 'live-sse' || ladderState === 'live-poll' ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {ladderState === 'live-sse' ? 'Live'
                : ladderState === 'live-poll' ? 'Auto-refresh'
                  : ladderState === 'connecting' ? 'Connecting…' : 'Disconnected'}
              {ladderState === 'offline' && canRetrySse && (
                <button
                  type="button"
                  onClick={pillRetry}
                  className="tp-focus-ring rounded border border-red-200 bg-red-50 px-1.5 py-0.5 font-semibold text-red-600 hover:bg-red-100 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
                >
                  Reconnect
                </button>
              )}
            </span>
          </div>
          {ladderState === 'live-poll' && (
            <p className="mb-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">
              Live stream unavailable on this network — updating automatically instead.
            </p>
          )}
          {/* Phase 3: the server closes a user's OLDEST stream past the
              per-user cap — say so instead of looking mysteriously offline. */}
          {ladderState === 'offline' && rtDiag?.reason === 'too-many-connections' && (
            <p className="mb-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-200">
              Too many Ticket Pulse tabs are open for your account — this one was disconnected. Close unused tabs, then click Reconnect.
            </p>
          )}
          <div className="flex items-center justify-between py-1">
            <span className="text-muted-foreground">Data refreshed</span>
            <span className="font-medium">{lastUpdated ? new Date(lastUpdated).toLocaleString() : '—'}</span>
          </div>
          {/* Self-diagnosing rows (Phase 2): what support needs from one
              screenshot — transport, freshness, churn, channel. */}
          {rtDiag && (
            <>
              <div className="flex items-center justify-between py-1">
                <span className="text-muted-foreground">Transport</span>
                <span className="font-medium">{TRANSPORT_LABEL[pillTransport || rtDiag.transport] || '—'}</span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-muted-foreground">Last event</span>
                <span className="font-medium">{formatEventAge(rtDiag.lastEventAt)}</span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-muted-foreground">Reconnects</span>
                <span className="font-medium">{pillGetReconnectChurn ? pillGetReconnectChurn() : rtDiag.churn}</span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-muted-foreground">Channel</span>
                <span className="font-medium">
                  {rtDiag.workspaceId != null
                    ? (rtDiag.workspaceId === currentWorkspace?.id ? `${workspaceName} (ws ${rtDiag.workspaceId})` : `ws ${rtDiag.workspaceId}`)
                    : '—'}
                </span>
              </div>
            </>
          )}
          <div className="flex items-center justify-between gap-3 py-1">
            <span className="flex-none text-muted-foreground">Background sync</span>
            {syncRowRunning ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-blue-700 dark:text-blue-300">{syncRowStep || 'Running…'}</span>
                {backgroundSyncRunning && (
                  <button
                    type="button"
                    onClick={onKillSync}
                    disabled={killingSync || !onKillSync}
                    className="flex-none rounded border border-red-200 bg-red-50 px-1.5 py-0.5 font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
                  >
                    Stop
                  </button>
                )}
              </span>
            ) : (
              <span className="font-medium text-muted-foreground">Idle</span>
            )}
          </div>

          {canManageWorkspace && (dashboardActions ? (
            <div className="mt-2 flex gap-2 border-t border-border pt-2.5">
              <button
                type="button"
                onClick={() => { setStatusOpen(false); dashboardActions.onRefresh(); }}
                disabled={dashboardActions.refreshing || syncRowRunning}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-input bg-card px-2 py-1.5 font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Sync now
              </button>
              <button
                type="button"
                onClick={() => { setStatusOpen(false); dashboardActions.onSyncWeek(); }}
                disabled={dashboardActions.refreshing || syncRowRunning}
                title="Full detail sync for the current week"
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-input bg-card px-2 py-1.5 font-semibold text-foreground transition-colors hover:border-primary/40 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Calendar className="h-3.5 w-3.5" /> Full week
              </button>
            </div>
          ) : (
            <div className="mt-2 border-t border-border pt-2.5">
              <button
                type="button"
                onClick={triggerManualSync}
                disabled={manualSyncing || syncRowRunning}
                title="Pull the latest tickets and changes from FreshService"
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-input bg-card px-2 py-1.5 font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${manualSyncing ? 'animate-spin' : ''}`} /> {manualSyncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
          ))}
          {syncNotice && (
            <p
              role="status"
              className={`mt-2 rounded-md border px-2 py-1.5 text-[11px] font-medium ${
                syncNotice.tone === 'ok'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200'
                  : syncNotice.tone === 'warn'
                    ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200'
                    : 'border-red-200 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-200'
              }`}
            >
              {syncNotice.text}
            </p>
          )}
        </div>
      )}
    </div>
  );

  // ---- account menu ---------------------------------------------------------
  const renderUserMenu = () => {
    const menuItems = [
      ...(showAdminSummitLink ? [{
        id: 'summit',
        label: 'Summit',
        description: 'Category workshop',
        path: '/summit-taxonomy',
        Icon: Boxes,
      }] : []),
      {
        id: 'my-skills',
        label: 'My Skills',
        description: 'My competencies',
        path: '/my-competencies',
        Icon: Award,
      },
      {
        id: 'notifications',
        label: 'Notifications',
        description: 'Email, alerts & signature',
        path: '/notifications',
        Icon: Bell,
      },
      ...(canManageWorkspace ? [{
        id: 'skill-matrix',
        label: 'Skill Matrix',
        description: 'Admin competency matrix',
        path: '/assignments/competencies',
        Icon: Award,
      }] : []),
    ];

    return (
      <div className="relative flex-shrink-0" data-tp-header-popup>
        <button
          type="button"
          onClick={() => { setUserMenuOpen((open) => !open); setWorkspaceMenuOpen(false); setStatusOpen(false); }}
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
          className="inline-flex h-9 items-center gap-1 rounded-full border border-border bg-muted pl-2.5 pr-2 text-xs font-bold text-foreground transition-colors hover:border-input hover:bg-secondary touch-manipulation tp-focus-ring"
          title={displayUserName}
        >
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-card text-foreground shadow-sm">
            {userInitials}
          </span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
        </button>

        {userMenuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-xl shadow-slate-900/10 dark:shadow-black/50"
          >
            <div className="border-b border-border px-3 py-2">
              <p className="truncate text-sm font-semibold text-foreground">{displayUserName}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email || user?.username || wsRole}</p>
            </div>

            {menuItems.map(({ id, label, description, path, Icon }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                onClick={() => navigateFromMenu(path)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-foreground hover:bg-muted"
              >
                <Icon className="h-4 w-4 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block font-semibold">{label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{description}</span>
                </span>
              </button>
            ))}

            {showSettingsMenuItem && (
              <button
                type="button"
                role="menuitem"
                onClick={() => navigateFromMenu('/settings')}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-foreground hover:bg-muted"
              >
                <Settings className="h-4 w-4 text-muted-foreground" />
                <span className="font-semibold">Settings</span>
              </button>
            )}

            <button
              type="button"
              role="menuitem"
              onClick={() => { setUserMenuOpen(false); setShowChangelog(true); }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-foreground hover:bg-muted"
            >
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">What&rsquo;s new</span>
                <span className="block truncate text-xs text-muted-foreground">Changelog</span>
              </span>
              <span className="flex-none rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-300">
                v{APP_VERSION}
              </span>
            </button>

            <div className="my-1 border-t border-border" />

            {/* Theme (Phase DM-A): applies immediately and keeps the menu open
                so the user can compare — never routed through navigateFromMenu. */}
            <ThemeControl />

            <div className="my-1 border-t border-border" />

            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-semibold text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <SideRail />

      {/* Desktop bar — phones get no top chrome (MobileTabBar is the nav). */}
      <header ref={headerRef} className="sticky top-0 z-40 hidden border-b border-border bg-card shadow-sm md:block">
        <div className="flex items-center gap-3 px-4 py-2 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {renderWorkspaceControl()}
            <button
              type="button"
              onClick={() => setShowChangelog(true)}
              title="What's new — view changelog"
              className="flex-none rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 transition-colors hover:bg-blue-100 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-300 dark:hover:bg-blue-500/25 tp-focus-ring"
            >
              v{APP_VERSION}
            </button>
            {pageTitle && (
              <h1 className="hidden truncate text-sm font-bold tracking-tight text-foreground lg:block">{pageTitle}</h1>
            )}
          </div>

          <div className="min-w-0 flex-1" />

          {extraActions && <div className="flex min-w-0 items-center gap-2">{extraActions}</div>}
          {renderStatusPill()}
          {renderUserMenu()}
        </div>
      </header>

      {/* Workspace switch failed to reach the server (WorkspaceContext retry
          exhausted) — the session may still point at the previous workspace,
          which is exactly the wrong-SSE-channel zombie setup. Surface it. */}
      {switchError && (
        <div role="alert" className="flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-1.5 text-xs text-red-700 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-200">
          <span className="min-w-0 flex-1 truncate font-medium">{switchError}</span>
          <button
            type="button"
            onClick={() => { retryWorkspaceSync?.(); }}
            className="flex-none rounded border border-red-200 bg-card px-2 py-0.5 font-semibold text-red-600 transition-colors hover:bg-red-100 dark:border-red-400/30 dark:text-red-300 dark:hover:bg-red-500/20 tp-focus-ring"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => clearSwitchError?.()}
            className="flex-none rounded px-1.5 py-0.5 font-semibold text-red-500 transition-colors hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-500/20 tp-focus-ring"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Mobile: page-specific actions only, inline (non-sticky) so content
          keeps the room the old header bar occupied. */}
      {(extraActions || backgroundSyncRunning) && (
        <div className="md:hidden">
          <div className="flex min-w-0 touch-pan-x items-center gap-1.5 overflow-x-auto px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {extraActions}
            {backgroundSyncRunning && (
              <button
                onClick={onKillSync}
                disabled={killingSync || !onKillSync}
                className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-700 touch-manipulation disabled:opacity-50 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-200"
                title={backgroundSyncStep ? `Syncing: ${backgroundSyncStep} (tap to stop)` : 'Syncing... (tap to stop)'}
              >
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              </button>
            )}
          </div>
        </div>
      )}

      <ChangelogModal isOpen={showChangelog} onClose={() => setShowChangelog(false)} />
    </>
  );
}
