import { useState, useCallback, useRef, useEffect } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { syncAPI } from '../../services/api';
import {
  Download, Play, CheckCircle, XCircle, Loader,
  Calendar, Clock, SkipForward, Zap, BarChart3, AlertTriangle,
  StopCircle, History, RotateCcw,
} from 'lucide-react';

const TIMEFRAME_PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 6 months', days: 180 },
  { label: 'Last year', days: 365 },
  { label: 'Custom', days: null },
];

function formatDateInput(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function formatElapsed(seconds) {
  if (seconds < 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatElapsedMs(ms) {
  if (!ms || ms < 0) return '—';
  return formatElapsed(Math.floor(ms / 1000));
}

function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const STATUS_BADGES = {
  running:     { label: 'Running',     style: 'bg-indigo-100 text-indigo-700 border-indigo-200', Icon: Loader },
  completed:   { label: 'Completed',   style: 'bg-green-100 text-green-700 border-green-200',    Icon: CheckCircle },
  failed:      { label: 'Failed',      style: 'bg-red-100 text-red-700 border-red-200',          Icon: XCircle },
  cancelled:   { label: 'Cancelled',   style: 'bg-amber-100 text-amber-700 border-amber-200',    Icon: StopCircle },
  interrupted: { label: 'Interrupted', style: 'bg-slate-100 text-slate-700 border-slate-200',    Icon: AlertTriangle },
};

export default function BackfillPanel() {
  const { currentWorkspace } = useWorkspace();

  // --- Configuration form state ---
  const [preset, setPreset] = useState(TIMEFRAME_PRESETS[1]);
  const [startDate, setStartDate] = useState(formatDateInput(daysAgo(30)));
  const [endDate, setEndDate] = useState(formatDateInput(new Date()));
  const [skipExisting, setSkipExisting] = useState(true);
  const [concurrency, setConcurrency] = useState(3);

  // --- Run state ---
  // Two ways to enter the "running" state:
  //  1. User clicks Start → SSE-driven progress
  //  2. User reopens panel mid-run → poll-driven progress (we discover an
  //     existing row server-side and switch into in-progress mode)
  const [activeRun, setActiveRun] = useState(null); // BackfillRun row from server
  const [isStarting, setIsStarting] = useState(false);
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const pollTimerRef = useRef(null);
  const sseAbortRef = useRef(null);

  const addLog = useCallback((msg, type = 'info') => {
    setLogs((prev) => [...prev.slice(-200), { msg, type, time: new Date().toLocaleTimeString() }]);
  }, []);

  const isRunning = activeRun?.status === 'running' || isStarting;

  // --- Fetch history ---
  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await syncAPI.getBackfillHistory(20);
      setHistory(res?.data || []);
    } catch (e) {
      console.error('Failed to load backfill history', e);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // --- On mount & whenever workspace changes: rejoin any in-progress run ---
  useEffect(() => {
    if (!currentWorkspace?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await syncAPI.getCurrentBackfill();
        if (cancelled) return;
        if (res?.data) {
          setActiveRun(res.data);
          addLog(`Rejoined in-progress backfill (id=${res.data.id})`);
        } else {
          setActiveRun(null);
        }
      } catch (e) {
        console.warn('Failed to fetch current backfill', e);
      }
      refreshHistory();
    })();
    return () => { cancelled = true; };
  }, [currentWorkspace?.id, refreshHistory, addLog]);

  // --- Poll while a run is active (covers both new SSE flow and rejoin flow) ---
  useEffect(() => {
    if (!activeRun || activeRun.status !== 'running') {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      return;
    }
    pollTimerRef.current = setInterval(async () => {
      try {
        const res = await syncAPI.getCurrentBackfill();
        const next = res?.data;
        if (!next) {
          // Run finished — fetch the most recent history row to get final state
          const hist = await syncAPI.getBackfillHistory(1);
          const lastRun = hist?.data?.[0];
          if (lastRun && lastRun.id === activeRun.id) {
            setActiveRun(null);
            if (lastRun.status === 'completed') {
              setResult(lastRun);
              addLog(`Backfill complete — ${lastRun.ticketsSynced || 0} synced, ${lastRun.activitiesAnalyzed || 0} activities analyzed in ${formatElapsedMs(lastRun.elapsedMs)}`, 'success');
            } else if (lastRun.status === 'cancelled') {
              addLog('Backfill cancelled', 'info');
            } else if (lastRun.status === 'failed') {
              setError(lastRun.errorMessage || 'Backfill failed');
              addLog(`Backfill failed: ${lastRun.errorMessage || 'unknown'}`, 'error');
            } else {
              addLog(`Backfill ended with status: ${lastRun.status}`, 'info');
            }
          } else {
            setActiveRun(null);
          }
          refreshHistory();
        } else if (next.id === activeRun.id) {
          setActiveRun(next);
          // Add a log line if the step text changed
          if (next.progressStep && next.progressStep !== activeRun.progressStep) {
            addLog(next.progressStep);
          }
        }
      } catch (e) {
        console.warn('Backfill poll error', e);
      }
    }, 1500);
    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
  }, [activeRun?.id, activeRun?.status, activeRun?.progressStep, addLog, refreshHistory]);

  const handlePresetChange = useCallback((p) => {
    setPreset(p);
    if (p.days) {
      setStartDate(formatDateInput(daysAgo(p.days)));
      setEndDate(formatDateInput(new Date()));
    }
  }, []);

  // --- Start a fresh backfill via SSE ---
  const startBackfill = useCallback(async () => {
    setIsStarting(true);
    setResult(null);
    setError(null);
    setLogs([]);
    addLog(`Starting backfill: ${startDate} → ${endDate}`);
    addLog(`Workspace: ${currentWorkspace?.name || 'Default'}`);
    addLog(`Options: skipExisting=${skipExisting}, concurrency=${concurrency}`);

    try {
      const response = await syncAPI.startBackfill({
        startDate, endDate, skipExisting, activityConcurrency: concurrency,
      });
      sseAbortRef.current = response;

      // After a brief moment, check current to grab the new run id and switch
      // to the polling-based UI. SSE is best-effort for log streaming; the
      // canonical state lives in the DB row.
      setTimeout(async () => {
        try {
          const cur = await syncAPI.getCurrentBackfill();
          if (cur?.data) setActiveRun(cur.data);
        } catch { /* ignore */ }
      }, 500);

      // Keep reading SSE for live log lines (extra detail beyond the polled snapshot)
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let readResult = await reader.read();
      while (!readResult.done) {
        const { value } = readResult;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        let currentEvent = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) currentEvent = line.slice(7);
          else if (line.startsWith('data: ') && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === 'backfill-progress' && data.step) {
                addLog(data.step, data.phase === 'error' ? 'error' : 'info');
              }
            } catch { /* skip */ }
            currentEvent = null;
          }
        }
        readResult = await reader.read();
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        addLog(`SSE stream interrupted: ${err.message} (poll will keep tracking)`, 'info');
      }
    } finally {
      setIsStarting(false);
      sseAbortRef.current = null;
    }
  }, [startDate, endDate, skipExisting, concurrency, currentWorkspace, addLog]);

  // --- Cancel running backfill ---
  const handleCancel = useCallback(async () => {
    if (!activeRun || cancelling) return;
    if (!confirm(`Cancel the running backfill?\n\nIt will stop at the next safe checkpoint (~10 seconds). Tickets already saved will remain.`)) return;
    setCancelling(true);
    try {
      await syncAPI.cancelBackfill(activeRun.id);
      addLog('Cancellation requested — stopping at next checkpoint...', 'info');
    } catch (e) {
      addLog(`Cancel failed: ${e.message}`, 'error');
    } finally {
      setCancelling(false);
    }
  }, [activeRun, cancelling, addLog]);

  // --- Computed display values ---
  const elapsedSec = activeRun?.startedAt
    ? Math.floor((Date.now() - new Date(activeRun.startedAt).getTime()) / 1000)
    : 0;
  const pct = activeRun?.progressPct ?? (result?.progressPct ?? 0);
  const estimatedTotal = pct > 5 ? Math.round(elapsedSec / (pct / 100)) : null;
  const eta = estimatedTotal ? formatElapsed(Math.max(0, estimatedTotal - elapsedSec)) : null;
  const showStartForm = !isRunning && !result;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-indigo-100 rounded-lg">
          <Download className="w-5 h-5 text-indigo-600" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Historical Backfill</h3>
          <p className="text-sm text-gray-500">
            Import historical tickets from FreshService. Use this to onboard a new workspace or fill data gaps.
          </p>
        </div>
      </div>

      {currentWorkspace && (
        <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm">
          <Zap className="w-4 h-4 text-blue-600" />
          <span className="text-blue-800">
            Backfilling for workspace: <strong>{currentWorkspace.name}</strong>
          </span>
        </div>
      )}

      {/* --- Configuration form (only when no run is in progress) --- */}
      {showStartForm && (
        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              <Calendar className="w-4 h-4 inline mr-1" />
              Timeframe
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
              {TIMEFRAME_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => handlePresetChange(p)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
                    preset.label === p.label
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:border-indigo-400 hover:bg-indigo-50'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Start Date</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => { setStartDate(e.target.value); setPreset({ label: 'Custom', days: null }); }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">End Date</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => { setEndDate(e.target.value); setPreset({ label: 'Custom', days: null }); }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={skipExisting}
                onChange={(e) => setSkipExisting(e.target.checked)}
                className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
              />
              <div>
                <span className="text-sm font-medium text-gray-700 flex items-center gap-1">
                  <SkipForward className="w-3.5 h-3.5" />
                  Skip existing tickets
                </span>
                <span className="text-xs text-gray-500 block">Won&apos;t re-process tickets already in the database</span>
              </div>
            </label>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">API Concurrency</label>
              <select
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              >
                <option value={1}>1 (Slowest, safest)</option>
                <option value={3}>3 (Balanced)</option>
                <option value={5}>5 (Faster)</option>
                <option value={10}>10 (Fastest, may hit rate limits)</option>
              </select>
            </div>
          </div>

          <button
            onClick={startBackfill}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors shadow-sm"
          >
            <Play className="w-4 h-4" />
            Start Backfill
          </button>

          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-amber-800">
              <strong>Tip:</strong> You can safely close this tab — backfill continues on the server, and progress will resume here when you return.
              Use the Cancel button to stop a running backfill at any time.
            </div>
          </div>
        </div>
      )}

      {/* --- In-progress / completed run display --- */}
      {(isRunning || result) && (
        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          {/* Header with cancel */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              {isRunning ? (
                <Loader className="w-4 h-4 text-indigo-600 animate-spin" />
              ) : result?.status === 'completed' ? (
                <CheckCircle className="w-4 h-4 text-green-600" />
              ) : (
                <XCircle className="w-4 h-4 text-red-600" />
              )}
              <span className="text-sm font-medium text-gray-900">
                {activeRun?.progressStep || result?.progressStep || (isStarting ? 'Initializing...' : 'Complete')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-indigo-600">{Math.max(0, pct)}%</span>
              {isRunning && activeRun?.id && (
                <button
                  onClick={handleCancel}
                  disabled={cancelling || activeRun?.cancelRequested}
                  className="px-3 py-1.5 bg-red-50 hover:bg-red-100 disabled:opacity-50 text-red-700 border border-red-200 rounded-md text-xs font-medium flex items-center gap-1 transition-colors"
                  title={activeRun?.cancelRequested ? 'Cancellation already requested' : 'Stop the running backfill'}
                >
                  <StopCircle className="w-3.5 h-3.5" />
                  {activeRun?.cancelRequested ? 'Cancelling...' : 'Cancel'}
                </button>
              )}
            </div>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                error ? 'bg-red-500' : pct >= 100 ? 'bg-green-500' : 'bg-indigo-600'
              }`}
              style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
            />
          </div>

          {/* Stats cards */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1 flex items-center justify-center gap-1">
                <Clock className="w-3 h-3" />
                Elapsed
              </div>
              <div className="text-sm font-bold text-gray-900">
                {result ? formatElapsedMs(result.elapsedMs) : formatElapsed(elapsedSec)}
              </div>
            </div>
            {eta && isRunning && (
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <div className="text-xs text-gray-500 mb-1">ETA</div>
                <div className="text-sm font-bold text-gray-900">~{eta}</div>
              </div>
            )}
            <div className="bg-blue-50 rounded-lg p-3 text-center">
              <div className="text-xs text-blue-600 mb-1 flex items-center justify-center gap-1">
                <BarChart3 className="w-3 h-3" />
                Tickets
              </div>
              <div className="text-sm font-bold text-blue-800">
                {(activeRun?.ticketsProcessed ?? result?.ticketsSynced) || 0}
                {(activeRun?.ticketsTotal || result?.ticketsFetched)
                  ? ` / ${activeRun?.ticketsTotal || result?.ticketsFetched}`
                  : ''}
              </div>
            </div>
            {(result?.skippedCount > 0) && (
              <div className="bg-yellow-50 rounded-lg p-3 text-center">
                <div className="text-xs text-yellow-600 mb-1 flex items-center justify-center gap-1">
                  <SkipForward className="w-3 h-3" />
                  Skipped
                </div>
                <div className="text-sm font-bold text-yellow-800">{result.skippedCount}</div>
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
              <XCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-red-800">{error}</div>
            </div>
          )}

          {result && result.status === 'completed' && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <span className="font-semibold text-green-800">Backfill Complete</span>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="flex justify-between"><span className="text-green-700">Tickets fetched:</span><span className="font-medium text-green-900">{result.ticketsFetched ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-green-700">Tickets synced:</span><span className="font-medium text-green-900">{result.ticketsSynced ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-green-700">Activities analyzed:</span><span className="font-medium text-green-900">{result.activitiesAnalyzed ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-green-700">Skipped (existing):</span><span className="font-medium text-green-900">{result.skippedCount ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-green-700">Date range:</span><span className="font-medium text-green-900">{result.startDate} → {result.endDate}</span></div>
                <div className="flex justify-between"><span className="text-green-700">Duration:</span><span className="font-medium text-green-900">{formatElapsedMs(result.elapsedMs)}</span></div>
              </div>
            </div>
          )}

          {logs.length > 0 && (
            <div>
              <div className="text-xs font-medium text-gray-500 uppercase mb-2">Activity Log</div>
              <div className="bg-gray-900 rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-xs space-y-0.5">
                {logs.map((log, i) => (
                  <div key={i} className={
                    log.type === 'error' ? 'text-red-400' :
                      log.type === 'success' ? 'text-green-400' :
                        'text-gray-300'
                  }>
                    <span className="text-gray-600">[{log.time}]</span> {log.msg}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!isRunning && (
            <div className="flex gap-3">
              <button
                onClick={() => { setResult(null); setLogs([]); setError(null); }}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors"
              >
                <Play className="w-4 h-4" />
                Run Another Backfill
              </button>
            </div>
          )}
        </div>
      )}

      {/* --- History --- */}
      <div className="bg-white border border-gray-200 rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-slate-500" />
            <h4 className="text-sm font-semibold text-gray-900">Recent backfills</h4>
            <span className="text-xs text-slate-400">({history.length})</span>
          </div>
          <button
            onClick={refreshHistory}
            disabled={historyLoading}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1 disabled:opacity-50"
          >
            <RotateCcw className={`w-3 h-3 ${historyLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {history.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">No backfills have been run yet for this workspace.</p>
        ) : (
          <div className="space-y-2">
            {history.map((row) => {
              const badge = STATUS_BADGES[row.status] || STATUS_BADGES.failed;
              const Icon = badge.Icon;
              return (
                <div key={row.id} className="border border-slate-200 rounded-lg p-3 hover:border-slate-300 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${badge.style} flex items-center gap-1`}>
                          <Icon className={`w-2.5 h-2.5 ${row.status === 'running' ? 'animate-spin' : ''}`} />
                          {badge.label}
                        </span>
                        <span className="text-xs text-slate-600 font-mono">#{row.id}</span>
                        <span className="text-xs text-slate-500">{row.startDate} → {row.endDate}</span>
                        {row.skipExisting && <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">skip existing</span>}
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-slate-500 flex-wrap">
                        <span>Started {formatDateTime(row.startedAt)}</span>
                        {row.completedAt && <span>·  Duration {formatElapsedMs(row.elapsedMs)}</span>}
                        {row.triggeredByEmail && <span>·  by {row.triggeredByEmail}</span>}
                      </div>
                      {row.status === 'completed' && (
                        <div className="text-xs text-slate-600 mt-1">
                          {row.ticketsSynced ?? 0} synced
                          {row.activitiesAnalyzed != null && `, ${row.activitiesAnalyzed} activities analyzed`}
                          {row.skippedCount != null && row.skippedCount > 0 && `, ${row.skippedCount} skipped`}
                        </div>
                      )}
                      {row.status === 'failed' && row.errorMessage && (
                        <div className="text-xs text-red-600 mt-1 truncate" title={row.errorMessage}>{row.errorMessage}</div>
                      )}
                      {row.status === 'cancelled' && row.cancelledByEmail && (
                        <div className="text-xs text-amber-600 mt-1">Cancelled by {row.cancelledByEmail}</div>
                      )}
                      {row.status === 'running' && (
                        <div className="text-xs text-indigo-600 mt-1">{row.progressStep || 'In progress'} ({row.progressPct}%)</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
