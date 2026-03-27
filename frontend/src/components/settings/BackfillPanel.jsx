import { useState, useCallback, useRef } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { syncAPI } from '../../services/api';
import {
  Download, Play, Square, CheckCircle, XCircle, Loader,
  Calendar, Clock, SkipForward, Zap, BarChart3, AlertTriangle,
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
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function BackfillPanel() {
  const { currentWorkspace } = useWorkspace();

  const [preset, setPreset] = useState(TIMEFRAME_PRESETS[1]);
  const [startDate, setStartDate] = useState(formatDateInput(daysAgo(30)));
  const [endDate, setEndDate] = useState(formatDateInput(new Date()));
  const [skipExisting, setSkipExisting] = useState(true);
  const [concurrency, setConcurrency] = useState(3);

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [logs, setLogs] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const [elapsed, setElapsed] = useState(0);

  const abortRef = useRef(null);
  const startTimeRef = useRef(null);
  const timerRef = useRef(null);

  const addLog = useCallback((msg, type = 'info') => {
    setLogs(prev => [...prev, { msg, type, time: new Date().toLocaleTimeString() }]);
  }, []);

  const handlePresetChange = useCallback((p) => {
    setPreset(p);
    if (p.days) {
      setStartDate(formatDateInput(daysAgo(p.days)));
      setEndDate(formatDateInput(new Date()));
    }
  }, []);

  const startBackfill = useCallback(async () => {
    setIsRunning(true);
    setProgress(null);
    setResult(null);
    setError(null);
    setLogs([]);
    setElapsed(0);
    startTimeRef.current = Date.now();

    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);

    addLog(`Starting backfill: ${startDate} → ${endDate}`);
    addLog(`Workspace: ${currentWorkspace?.name || 'Default'}`);
    addLog(`Options: skipExisting=${skipExisting}, concurrency=${concurrency}`);

    try {
      const response = await syncAPI.startBackfill({
        startDate,
        endDate,
        skipExisting,
        activityConcurrency: concurrency,
      });

      abortRef.current = response;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ') && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSEEvent(currentEvent, data);
            } catch { /* skip bad JSON */ }
            currentEvent = null;
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Backfill failed');
        addLog(`Error: ${err.message}`, 'error');
      }
    } finally {
      setIsRunning(false);
      if (timerRef.current) clearInterval(timerRef.current);
      abortRef.current = null;
    }
  }, [startDate, endDate, skipExisting, concurrency, currentWorkspace, addLog]);

  const handleSSEEvent = useCallback((event, data) => {
    if (event === 'backfill-progress') {
      setProgress(data);
      if (data.step) addLog(data.step, data.phase === 'error' ? 'error' : 'info');
    } else if (event === 'backfill-complete') {
      setResult(data);
      setProgress(prev => ({ ...prev, pct: 100, phase: 'done' }));
      addLog(`Backfill complete! ${data.ticketsSynced} tickets synced, ${data.activitiesAnalyzed} activities analyzed in ${data.elapsed}`, 'success');
    } else if (event === 'backfill-error') {
      setError(data.message);
      addLog(`Error: ${data.message}`, 'error');
    }
  }, [addLog]);

  const pct = progress?.pct ?? 0;
  const estimatedTotal = pct > 5 ? Math.round(elapsed / (pct / 100)) : null;
  const eta = estimatedTotal ? formatElapsed(Math.max(0, estimatedTotal - elapsed)) : null;

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

      {/* Current workspace indicator */}
      {currentWorkspace && (
        <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm">
          <Zap className="w-4 h-4 text-blue-600" />
          <span className="text-blue-800">
            Backfilling for workspace: <strong>{currentWorkspace.name}</strong>
          </span>
        </div>
      )}

      {/* Configuration */}
      {!isRunning && !result && (
        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-5">
          {/* Timeframe presets */}
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

            {/* Date range inputs */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Start Date</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    setPreset({ label: 'Custom', days: null });
                  }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">End Date</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => {
                    setEndDate(e.target.value);
                    setPreset({ label: 'Custom', days: null });
                  }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* Options */}
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
                <span className="text-xs text-gray-500 block">Won't re-process tickets already in the database</span>
              </div>
            </label>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                API Concurrency
              </label>
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

          {/* Start button */}
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
              <strong>Note:</strong> Large date ranges (90+ days) may take 10-30 minutes due to FreshService API rate limits.
              Activity analysis is the slowest step — each ticket requires a separate API call.
              You can safely close this tab; the backfill continues on the server.
            </div>
          </div>
        </div>
      )}

      {/* Progress display */}
      {(isRunning || result) && (
        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          {/* Progress bar */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {isRunning ? (
                  <Loader className="w-4 h-4 text-indigo-600 animate-spin" />
                ) : result ? (
                  <CheckCircle className="w-4 h-4 text-green-600" />
                ) : error ? (
                  <XCircle className="w-4 h-4 text-red-600" />
                ) : null}
                <span className="text-sm font-medium text-gray-900">
                  {progress?.step || 'Initializing...'}
                </span>
              </div>
              <span className="text-sm font-bold text-indigo-600">{Math.max(0, pct)}%</span>
            </div>

            <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  error ? 'bg-red-500' : pct >= 100 ? 'bg-green-500' : 'bg-indigo-600'
                }`}
                style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
              />
            </div>
          </div>

          {/* Stats cards */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-xs text-gray-500 mb-1 flex items-center justify-center gap-1">
                <Clock className="w-3 h-3" />
                Elapsed
              </div>
              <div className="text-sm font-bold text-gray-900">{formatElapsed(elapsed)}</div>
            </div>
            {eta && isRunning && (
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <div className="text-xs text-gray-500 mb-1">ETA</div>
                <div className="text-sm font-bold text-gray-900">~{eta}</div>
              </div>
            )}
            {(progress?.total || result?.ticketsFetched) && (
              <div className="bg-blue-50 rounded-lg p-3 text-center">
                <div className="text-xs text-blue-600 mb-1 flex items-center justify-center gap-1">
                  <BarChart3 className="w-3 h-3" />
                  Tickets
                </div>
                <div className="text-sm font-bold text-blue-800">
                  {progress?.processed ?? result?.ticketsSynced ?? 0}
                  {progress?.total ? ` / ${progress.total}` : ''}
                </div>
              </div>
            )}
            {(result?.skipped > 0 || progress?.phase === 'dedup') && (
              <div className="bg-yellow-50 rounded-lg p-3 text-center">
                <div className="text-xs text-yellow-600 mb-1 flex items-center justify-center gap-1">
                  <SkipForward className="w-3 h-3" />
                  Skipped
                </div>
                <div className="text-sm font-bold text-yellow-800">{result?.skipped || 0}</div>
              </div>
            )}
          </div>

          {/* Error display */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
              <XCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-red-800">{error}</div>
            </div>
          )}

          {/* Result summary */}
          {result && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <span className="font-semibold text-green-800">Backfill Complete</span>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-green-700">Tickets fetched:</span>
                  <span className="font-medium text-green-900">{result.ticketsFetched}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-green-700">Tickets synced:</span>
                  <span className="font-medium text-green-900">{result.ticketsSynced}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-green-700">Activities analyzed:</span>
                  <span className="font-medium text-green-900">{result.activitiesAnalyzed}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-green-700">Skipped (existing):</span>
                  <span className="font-medium text-green-900">{result.skipped}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-green-700">Date range:</span>
                  <span className="font-medium text-green-900">{result.dateRange}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-green-700">Duration:</span>
                  <span className="font-medium text-green-900">{result.elapsed}</span>
                </div>
              </div>
            </div>
          )}

          {/* Log viewer */}
          {logs.length > 0 && (
            <div>
              <div className="text-xs font-medium text-gray-500 uppercase mb-2">Activity Log</div>
              <div className="bg-gray-900 rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-xs space-y-0.5">
                {logs.map((log, i) => (
                  <div key={i} className={`${
                    log.type === 'error' ? 'text-red-400' :
                    log.type === 'success' ? 'text-green-400' :
                    'text-gray-300'
                  }`}>
                    <span className="text-gray-600">[{log.time}]</span> {log.msg}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3">
            {!isRunning && result && (
              <button
                onClick={() => { setResult(null); setProgress(null); setLogs([]); setError(null); }}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors"
              >
                <Play className="w-4 h-4" />
                Run Another Backfill
              </button>
            )}
            {!isRunning && error && (
              <button
                onClick={startBackfill}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors"
              >
                <Play className="w-4 h-4" />
                Retry Backfill
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
