import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CheckCircle, XCircle, Loader, Clock, Activity, AlertTriangle,
  Download, Search, ChevronDown, ChevronUp, RefreshCw, X,
  BarChart3, Zap, Timer, Star,
} from 'lucide-react';
import { syncAPI, healthCheck } from '../../services/api';

const STATUS_PILLS = [
  { value: null, label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'started', label: 'Running' },
];

const DATE_RANGES = [
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

function formatDuration(startedAt, completedAt) {
  if (!completedAt) return '...';
  const ms = new Date(completedAt) - new Date(startedAt);
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function formatRelative(dateStr) {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatGap(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (isToday) return `Today ${time}`;
  if (isYesterday) return `Yesterday ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + time;
}

function StatusIcon({ status, className = 'w-4 h-4' }) {
  if (status === 'completed') return <CheckCircle className={`${className} text-emerald-500`} />;
  if (status === 'failed') return <XCircle className={`${className} text-red-500`} />;
  if (status === 'started') return <Loader className={`${className} text-blue-500 animate-spin`} />;
  return <Clock className={`${className} text-gray-400`} />;
}

function StatCard({ icon: Icon, label, value, sub, color = 'blue' }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    gray: 'bg-gray-50 text-gray-700 border-gray-200',
  };
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${colors[color]}`}>
      <div className="flex items-center gap-1.5 mb-0.5">
        <Icon className="w-3.5 h-3.5 opacity-60" />
        <span className="text-[10px] uppercase tracking-wide font-medium opacity-70">{label}</span>
      </div>
      <div className="text-lg font-bold leading-tight">{value}</div>
      {sub && <div className="text-[10px] opacity-60 mt-0.5">{sub}</div>}
    </div>
  );
}

function TimelineStrip({ logs }) {
  if (!logs || logs.length === 0) return null;

  const now = Date.now();
  const windowMs = 48 * 3600000;
  const windowStart = now - windowMs;

  const completedLogs = logs
    .filter(l => l.status === 'completed' && l.completedAt)
    .map(l => ({
      start: Math.max(new Date(l.startedAt).getTime(), windowStart),
      end: Math.min(new Date(l.completedAt).getTime(), now),
    }))
    .filter(l => l.end > windowStart);

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-gray-400">48 hours ago</span>
        <span className="text-[10px] text-gray-400">Now</span>
      </div>
      <div className="h-3 bg-red-100 rounded-full overflow-hidden relative border border-red-200/50">
        {completedLogs.map((l, i) => {
          const left = ((l.start - windowStart) / windowMs) * 100;
          const width = Math.max(((l.end - l.start) / windowMs) * 100, 0.3);
          return (
            <div
              key={i}
              className="absolute top-0 bottom-0 bg-emerald-400 rounded-sm"
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-3 mt-1">
        <span className="flex items-center gap-1 text-[10px] text-gray-400">
          <span className="w-2 h-2 bg-emerald-400 rounded-sm inline-block" /> Sync ran
        </span>
        <span className="flex items-center gap-1 text-[10px] text-gray-400">
          <span className="w-2 h-2 bg-red-100 border border-red-200 rounded-sm inline-block" /> Gap
        </span>
      </div>
    </div>
  );
}

function GapBadge({ minutes }) {
  const isLarge = minutes > 60;
  return (
    <tr>
      <td colSpan={6} className="px-0 py-0">
        <div className={`flex items-center gap-2 px-4 py-1 ${isLarge ? 'bg-red-50' : 'bg-amber-50'}`}>
          <div className={`flex-1 border-t ${isLarge ? 'border-red-200' : 'border-amber-200'} border-dashed`} />
          <span className={`text-[10px] font-medium ${isLarge ? 'text-red-500' : 'text-amber-500'} flex items-center gap-1`}>
            <AlertTriangle className="w-3 h-3" />
            Gap: {formatGap(minutes)}
          </span>
          <div className={`flex-1 border-t ${isLarge ? 'border-red-200' : 'border-amber-200'} border-dashed`} />
        </div>
      </td>
    </tr>
  );
}

function LogDetailModal({ log, onClose }) {
  if (!log) return null;
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <StatusIcon status={log.status} className="w-5 h-5" />
            <h3 className="font-semibold text-gray-900">Sync Log #{log.id}</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-gray-500 text-xs">Status</span>
              <p className="font-medium capitalize">{log.status}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs">Type</span>
              <p className="font-medium">{log.syncType}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs">Started</span>
              <p className="font-medium">{new Date(log.startedAt).toLocaleString()}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs">Completed</span>
              <p className="font-medium">{log.completedAt ? new Date(log.completedAt).toLocaleString() : '—'}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs">Duration</span>
              <p className="font-medium">{formatDuration(log.startedAt, log.completedAt)}</p>
            </div>
            <div>
              <span className="text-gray-500 text-xs">Records Processed</span>
              <p className="font-medium">{log.recordsProcessed}</p>
            </div>
          </div>
          {log.errorMessage && (
            <div>
              <span className="text-gray-500 text-xs">Error</span>
              <pre className="mt-1 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 whitespace-pre-wrap break-words max-h-48 overflow-auto">
                {log.errorMessage}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SyncOperationsPanel() {
  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uptime, setUptime] = useState(null);

  const [statusFilter, setStatusFilter] = useState(null);
  const [dateRange, setDateRange] = useState('7d');
  const [searchText, setSearchText] = useState('');
  const [selectedLog, setSelectedLog] = useState(null);

  const searchDebounceRef = useRef(null);
  const pollRef = useRef(null);

  const getDateRangeParams = useCallback(() => {
    const now = new Date();
    if (dateRange === '24h') return { startDate: new Date(now - 86400000).toISOString() };
    if (dateRange === '7d') return { startDate: new Date(now - 7 * 86400000).toISOString() };
    if (dateRange === '30d') return { startDate: new Date(now - 30 * 86400000).toISOString() };
    return {};
  }, [dateRange]);

  const fetchLogs = useCallback(async (append = false) => {
    try {
      if (!append) setLoading(true);
      else setLoadingMore(true);

      const offset = append ? logs.length : 0;
      const params = {
        limit: 50,
        offset,
        status: statusFilter,
        search: searchText || null,
        ...getDateRangeParams(),
      };

      const result = await syncAPI.getLogs(params);
      const newLogs = result.data || [];
      const pagination = result.pagination || {};

      if (append) {
        setLogs(prev => [...prev, ...newLogs]);
      } else {
        setLogs(newLogs);
      }
      setTotal(pagination.total || newLogs.length);
      setHasMore(pagination.hasMore || false);
    } catch (err) {
      console.error('Failed to fetch sync logs:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [statusFilter, searchText, getDateRangeParams, logs.length]);

  const fetchStats = useCallback(async () => {
    try {
      const result = await syncAPI.getStats();
      setStats(result.data || result);
    } catch (err) {
      console.error('Failed to fetch sync stats:', err);
    }
  }, []);

  const fetchUptime = useCallback(async () => {
    try {
      const result = await healthCheck();
      if (result.appStartedAt) setUptime(result.appStartedAt);
    } catch { /* ignore */ }
  }, []);

  // Initial load
  useEffect(() => {
    fetchStats();
    fetchUptime();
  }, [fetchStats, fetchUptime]);

  // Reload logs when filters change
  useEffect(() => {
    fetchLogs(false);
  }, [statusFilter, dateRange]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => fetchLogs(false), 400);
    return () => clearTimeout(searchDebounceRef.current);
  }, [searchText]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every 30s
  useEffect(() => {
    pollRef.current = setInterval(() => {
      fetchLogs(false);
      fetchStats();
    }, 30000);
    return () => clearInterval(pollRef.current);
  }, [statusFilter, dateRange, searchText]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute gaps between consecutive logs
  const logsWithGaps = [];
  for (let i = 0; i < logs.length; i++) {
    logsWithGaps.push({ type: 'log', data: logs[i] });
    if (i < logs.length - 1 && logs[i].startedAt && logs[i + 1].completedAt) {
      const gapMs = new Date(logs[i].startedAt) - new Date(logs[i + 1].completedAt);
      const gapMinutes = Math.round(gapMs / 60000);
      if (gapMinutes >= 30) {
        logsWithGaps.push({ type: 'gap', minutes: gapMinutes });
      }
    }
  }

  const exportCSV = () => {
    const header = 'ID,Status,Type,Started,Completed,Duration,Records,Error\n';
    const rows = logs.map(l =>
      [
        l.id,
        l.status,
        l.syncType,
        l.startedAt,
        l.completedAt || '',
        formatDuration(l.startedAt, l.completedAt),
        l.recordsProcessed,
        `"${(l.errorMessage || '').replace(/"/g, '""')}"`,
      ].join(','),
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sync-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const successRate = stats ? parseFloat(stats.successRate) : 0;
  const rateColor = successRate >= 95 ? 'emerald' : successRate >= 80 ? 'amber' : 'red';

  const gapMinutes = stats?.longestGap?.gapMinutes || 0;
  const gapColor = gapMinutes > 60 ? 'red' : gapMinutes > 30 ? 'amber' : 'emerald';

  const lastSync = logs.length > 0 ? logs[0] : null;

  return (
    <div className="p-6 space-y-4">
      {/* Health Overview */}
      <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-900">Sync Health</h2>
          {uptime && (
            <span className="text-[10px] text-gray-400 flex items-center gap-1">
              <Zap className="w-3 h-3" /> Uptime: {formatRelative(uptime).replace(' ago', '')}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <StatCard icon={BarChart3} label="Total Syncs" value={stats?.total ?? '—'} sub={`${stats?.failed || 0} failed`} color="blue" />
          <StatCard icon={Activity} label="Success Rate" value={stats ? `${stats.successRate}%` : '—'} sub={`${stats?.completed || 0} completed`} color={rateColor} />
          <StatCard
            icon={Timer}
            label="Last Sync"
            value={lastSync ? formatRelative(lastSync.startedAt) : '—'}
            sub={lastSync ? `${lastSync.status} · ${lastSync.recordsProcessed} records` : null}
            color={lastSync?.status === 'failed' ? 'red' : 'blue'}
          />
          <StatCard
            icon={AlertTriangle}
            label="Longest Gap (7d)"
            value={gapMinutes > 0 ? formatGap(gapMinutes) : 'None'}
            sub={stats?.longestGap?.gapStart ? formatDateTime(stats.longestGap.gapStart) : null}
            color={gapColor}
          />
        </div>

        {stats?.csatPendingCount !== undefined && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-500">
            <Star className="w-3 h-3" />
            <span>{stats.csatPendingCount.toLocaleString()} closed tickets awaiting CSAT response</span>
          </div>
        )}

        <TimelineStrip logs={logs} />
      </div>

      {/* Log Viewer */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="p-4 border-b border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-gray-900">Sync Logs</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{total} total</span>
              <button
                onClick={() => { fetchLogs(false); fetchStats(); }}
                className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600"
                title="Refresh"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={exportCSV}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-50 hover:bg-gray-100 text-gray-600 rounded-lg border border-gray-200"
              >
                <Download className="w-3 h-3" /> CSV
              </button>
            </div>
          </div>

          {/* Filters row */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Status pills */}
            <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
              {STATUS_PILLS.map(pill => (
                <button
                  key={pill.label}
                  onClick={() => setStatusFilter(pill.value)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    statusFilter === pill.value
                      ? 'bg-white shadow-sm text-gray-900 font-medium'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {pill.label}
                </button>
              ))}
            </div>

            {/* Date range */}
            <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
              {DATE_RANGES.map(dr => (
                <button
                  key={dr.value}
                  onClick={() => setDateRange(dr.value)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    dateRange === dr.value
                      ? 'bg-white shadow-sm text-gray-900 font-medium'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {dr.label}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="relative flex-1 min-w-[140px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                type="text"
                placeholder="Search errors..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
              />
            </div>
          </div>
        </div>

        {/* Log table */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader className="w-5 h-5 animate-spin mr-2" /> Loading logs...
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">No sync logs found for the selected filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-gray-400 uppercase tracking-wider border-b border-gray-100">
                  <th className="px-4 py-2 w-8"></th>
                  <th className="px-3 py-2">Started</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2 text-right">Records</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {logsWithGaps.map((item, idx) => {
                  if (item.type === 'gap') {
                    return <GapBadge key={`gap-${idx}`} minutes={item.minutes} />;
                  }

                  const l = item.data;
                  return (
                    <tr
                      key={l.id}
                      onClick={() => setSelectedLog(l)}
                      className={`border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors ${
                        l.status === 'failed' ? 'border-l-2 border-l-red-400' : ''
                      }`}
                    >
                      <td className="px-4 py-2"><StatusIcon status={l.status} /></td>
                      <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{formatDateTime(l.startedAt)}</td>
                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{formatDuration(l.startedAt, l.completedAt)}</td>
                      <td className="px-3 py-2 text-gray-700 text-right tabular-nums">{l.recordsProcessed}</td>
                      <td className="px-3 py-2">
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-600">{l.syncType}</span>
                      </td>
                      <td className="px-3 py-2 text-gray-400 max-w-[200px] truncate text-xs">{l.errorMessage || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {hasMore && (
              <div className="p-3 text-center border-t border-gray-100">
                <button
                  onClick={() => fetchLogs(true)}
                  disabled={loadingMore}
                  className="px-4 py-1.5 text-xs text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
                >
                  {loadingMore ? (
                    <span className="flex items-center gap-1"><Loader className="w-3 h-3 animate-spin" /> Loading...</span>
                  ) : (
                    `Load more (${total - logs.length} remaining)`
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <LogDetailModal log={selectedLog} onClose={() => setSelectedLog(null)} />
    </div>
  );
}
