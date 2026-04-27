import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  Filter,
  Gauge,
  Info,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
  XCircle,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import * as XLSX from 'xlsx';
import AppShell from '../components/AppShell';
import { analyticsAPI, getGlobalExcludeNoise, setGlobalExcludeNoise } from '../services/api';
import { useWorkspace } from '../contexts/WorkspaceContext';

const RANGE_OPTIONS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '12m', label: '12 months' },
  { value: 'custom', label: 'Custom' },
];

const GROUP_OPTIONS = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

const TABS = [
  { id: 'overview', label: 'Overview', Icon: Gauge },
  { id: 'demand', label: 'Demand', Icon: BarChart3 },
  { id: 'team', label: 'Team Balance', Icon: Users },
  { id: 'quality', label: 'Quality', Icon: CheckCircle2 },
  { id: 'ops', label: 'Automation Ops', Icon: RefreshCw },
  { id: 'insights', label: 'Insights', Icon: Sparkles },
];

const ASSIGNMENT_MIX_LABELS = {
  appAssigned: {
    label: 'Assigned by Ticket Pulse',
    shortLabel: 'Ticket Pulse',
    description: 'Assigned by the app service account.',
    color: '#2563eb',
  },
  coordinatorAssigned: {
    label: 'Assigned by coordinator',
    shortLabel: 'Coordinator',
    description: 'Assigned by a person other than the technician.',
    color: '#059669',
  },
  selfPicked: {
    label: 'Self-picked by technician',
    shortLabel: 'Self-picked',
    description: 'Picked up by the technician assigned to the ticket.',
    color: '#f59e0b',
  },
  unknown: {
    label: 'Source unavailable',
    shortLabel: 'Unavailable',
    description: 'Ticket is assigned, but local data does not identify who assigned it.',
    color: '#64748b',
  },
};

const TEAM_TIMELINE_METRICS = [
  { key: 'assigned', label: 'Assigned tickets' },
  { key: 'closed', label: 'Closed / resolved' },
  { key: 'selfPicked', label: 'Self-picked' },
  { key: 'coordinatorAssigned', label: 'Coordinator-assigned' },
  { key: 'appAssigned', label: 'Ticket Pulse-assigned' },
  { key: 'rejected', label: 'Rejected assignments' },
  { key: 'leaveDays', label: 'Leave days' },
  { key: 'wfhDays', label: 'WFH days' },
];

const HIGHCHART_COLORS = ['#2563eb', '#059669', '#f59e0b', '#7c3aed', '#dc2626', '#0891b2', '#64748b', '#0f766e', '#c2410c'];

const RESOLUTION_BUCKET_LABELS = {
  under4h: '< 4h',
  h4to8: '4-8h',
  h8to24: '8-24h',
  d1to3: '1-3d',
  over3d: '> 3d',
};

const OPEN_AGING_LABELS = {
  under1d: '< 1d',
  d1to3: '1-3d',
  d3to7: '3-7d',
  over7d: '> 7d',
  under4h: '< 4h',
  h4to8: '4-8h',
  h8to24: '8-24h',
  over24h: '> 24h',
};

const OPS_LABELS = {
  auto_assigned: 'Auto-assigned',
  approved: 'Approved',
  modified: 'Modified',
  pending: 'Pending',
  rejected: 'Rejected',
  failed: 'Failed',
  completed: 'Completed',
  started: 'Started',
  unknown: 'Unknown',
  ai_suggested: 'AI suggested',
  manual: 'Manual',
  rebound: 'Rebound',
  rebound_exhausted: 'Rebound exhausted',
};

const INSIGHT_SEVERITY = {
  critical: { label: 'Critical', color: '#dc2626', badge: 'border-red-200 bg-red-50 text-red-700' },
  warning: { label: 'Warning', color: '#f59e0b', badge: 'border-amber-200 bg-amber-50 text-amber-700' },
  info: { label: 'Info', color: '#2563eb', badge: 'border-blue-200 bg-blue-50 text-blue-700' },
};

function formatNumber(value) {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString();
}

function formatPct(value) {
  if (value === null || value === undefined) return '—';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value}%`;
}

function formatHours(value) {
  if (value === null || value === undefined) return '—';
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia(query);
    setMatches(mediaQuery.matches);
    const handleChange = (event) => setMatches(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [query]);

  return matches;
}

function labelFromKey(value, labelMap = {}) {
  if (value === null || value === undefined || value === '') return 'Unknown';
  const raw = String(value);
  if (labelMap[raw]) return labelMap[raw];
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function chartBase(type = 'column') {
  return {
    chart: { type, backgroundColor: 'transparent', spacing: [8, 8, 8, 8] },
    title: { text: null },
    credits: { enabled: false },
    accessibility: { enabled: false },
  };
}

function StatCard({ title, value, subtitle, icon: Icon = Info, tone = 'blue', delta }) {
  const toneClass = {
    blue: 'border-blue-100 bg-blue-50 text-blue-700',
    green: 'border-emerald-100 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-100 bg-amber-50 text-amber-700',
    red: 'border-red-100 bg-red-50 text-red-700',
    slate: 'border-slate-100 bg-slate-50 text-slate-700',
    purple: 'border-purple-100 bg-purple-50 text-purple-700',
  }[tone] || 'border-blue-100 bg-blue-50 text-blue-700';

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-normal text-slate-500">{title}</p>
          <p className="mt-1 text-xl font-bold text-slate-900 sm:text-2xl">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
        </div>
        <div className={`rounded-lg border p-2 ${toneClass}`}>
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
      </div>
      {delta !== undefined && delta !== null && (
        <p className={`mt-3 text-xs font-semibold ${delta > 0 ? 'text-amber-700' : delta < 0 ? 'text-emerald-700' : 'text-slate-500'}`}>
          {formatPct(delta)} vs previous period
        </p>
      )}
    </div>
  );
}

function Panel({ title, subtitle, children, actions }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function AssignmentMixTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const item = payload[0]?.payload;
  if (!item) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-lg">
      <p className="font-semibold text-slate-900">{item.label}</p>
      <p className="text-slate-600">{formatNumber(item.value)} tickets · {item.pct}%</p>
      <p className="mt-1 max-w-64 text-xs text-slate-500">{item.description}</p>
    </div>
  );
}

function buildAssignmentMixRows(mix = {}) {
  const orderedKeys = ['appAssigned', 'coordinatorAssigned', 'selfPicked', 'unknown'];
  const total = orderedKeys.reduce((sum, key) => sum + (mix[key] || 0), 0);
  return orderedKeys
    .map((key) => {
      const config = ASSIGNMENT_MIX_LABELS[key];
      const value = mix[key] || 0;
      return {
        key,
        ...config,
        value,
        pct: total ? Number(((value / total) * 100).toFixed(1)) : 0,
      };
    })
    .filter((row) => row.value > 0);
}

function EmptyState({ text = 'No data for this range.' }) {
  return <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">{text}</div>;
}

function SimpleTable({ columns, rows, maxHeight = 'max-h-80' }) {
  if (!rows?.length) return <EmptyState />;
  return (
    <>
      <div className={`space-y-2 overflow-auto sm:hidden ${maxHeight}`}>
        {rows.map((row, idx) => (
          <div key={row.id || row.freshserviceTicketId || row.name || idx} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="space-y-2">
              {columns.map((col) => (
                <div key={col.key} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 text-sm">
                  <span className="text-xs font-semibold uppercase tracking-normal text-slate-500">{col.label}</span>
                  <span className="min-w-0 break-words text-slate-700">
                    {col.render ? col.render(row) : row[col.key]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className={`hidden overflow-auto rounded-lg border border-slate-200 sm:block ${maxHeight}`}>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="sticky top-0 bg-slate-50">
            <tr>
              {columns.map((col) => (
                <th key={col.key} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-normal text-slate-500">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((row, idx) => (
              <tr key={row.id || row.freshserviceTicketId || row.name || idx} className="hover:bg-slate-50">
                {columns.map((col) => (
                  <td key={col.key} className="px-3 py-2 text-slate-700">
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function normalizeInsightDrilldown(insight) {
  const drilldown = insight?.drilldown;
  if (Array.isArray(drilldown)) return drilldown;
  if (drilldown && typeof drilldown === 'object') {
    return Object.entries(drilldown).map(([key, count]) => ({
      key,
      name: labelFromKey(key, { ...RESOLUTION_BUCKET_LABELS, ...OPEN_AGING_LABELS }),
      count,
    }));
  }
  return [];
}

function insightDrilldownColumns(insight) {
  switch (insight?.id) {
  case 'backlog-growth':
    return [
      { key: 'date', label: 'Date' },
      { key: 'created', label: 'Created', render: (row) => formatNumber(row.created || 0) },
      { key: 'resolved', label: 'Closed / Resolved', render: (row) => formatNumber(row.resolved || 0) },
      { key: 'net', label: 'Net Growth', render: (row) => `+${formatNumber(row.net || 0)}` },
    ];
  case 'load-imbalance':
    return [
      { key: 'name', label: 'Technician' },
      { key: 'assigned', label: 'Assigned', render: (row) => formatNumber(row.assigned || 0) },
      { key: 'openNow', label: 'Open Now', render: (row) => formatNumber(row.openNow || 0) },
      { key: 'closed', label: 'Closed', render: (row) => formatNumber(row.closed || 0) },
      { key: 'rejected', label: 'Rejected', render: (row) => formatNumber(row.rejected || 0) },
      { key: 'leaveDays', label: 'Leave', render: (row) => formatNumber(row.leaveDays || 0) },
      { key: 'wfhDays', label: 'WFH', render: (row) => formatNumber(row.wfhDays || 0) },
    ];
  case 'stale-open-tickets':
    return [
      { key: 'name', label: 'Age Bucket' },
      { key: 'count', label: 'Open Tickets', render: (row) => formatNumber(row.count || 0) },
    ];
  case 'sync-degradation':
    return [
      { key: 'startedAt', label: 'Started', render: (row) => formatDateTime(row.startedAt) },
      { key: 'syncType', label: 'Sync Type', render: (row) => labelFromKey(row.syncType) },
      { key: 'status', label: 'Status', render: (row) => labelFromKey(row.status) },
      { key: 'recordsProcessed', label: 'Records', render: (row) => formatNumber(row.recordsProcessed || 0) },
      { key: 'errorMessage', label: 'Error', render: (row) => row.errorMessage || '—' },
    ];
  case 'csat-warning':
    return [
      { key: 'freshserviceTicketId', label: 'Ticket' },
      {
        key: 'csatScore',
        label: 'Score',
        render: (row) => row.csatScore === null || row.csatScore === undefined ? '—' : `${row.csatScore}/${row.csatTotalScore || 4}`,
      },
      { key: 'csatRatingText', label: 'Rating', render: (row) => row.csatRatingText || '—' },
      { key: 'subject', label: 'Subject' },
      { key: 'assignedTechName', label: 'Tech', render: (row) => row.assignedTechName || 'Unassigned' },
    ];
  case 'category-concentration':
    return [
      { key: 'name', label: 'Category' },
      { key: 'count', label: 'Tickets', render: (row) => formatNumber(row.count || 0) },
      { key: 'pct', label: 'Share', render: (row) => row.pct === undefined ? '—' : `${row.pct}%` },
    ];
  case 'demand-spike':
  case 'overdue-risk':
  default:
    return [
      { key: 'freshserviceTicketId', label: 'Ticket', render: (row) => row.freshserviceTicketId || row.id || '—' },
      { key: 'subject', label: 'Subject', render: (row) => row.subject || row.title || row.name || '—' },
      { key: 'status', label: 'Status', render: (row) => row.status || '—' },
      { key: 'assignedTechName', label: 'Owner', render: (row) => row.assignedTechName || row.requesterName || row.technicianName || row.name || '—' },
    ];
  }
}

function CategoricalBars({ data, nameKey = 'name', valueKey = 'count', height = 260 }) {
  if (!data?.length) return <EmptyState />;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 16, right: 24, top: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" allowDecimals={false} />
          <YAxis type="category" dataKey={nameKey} width={120} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar dataKey={valueKey} fill="#2563eb" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function HotspotRankedBars({ data, totalLabel = 'tickets', compact = false }) {
  if (!data?.length) return <EmptyState />;
  const max = Math.max(...data.map((row) => row.count || 0), 1);
  const total = data.reduce((sum, row) => sum + (row.count || 0), 0);

  return (
    <div className={`${compact ? 'max-h-[18rem] overflow-y-auto pr-1' : ''} space-y-1`}>
      {data.map((row, index) => {
        const count = row.count || 0;
        const pct = total ? Number(((count / total) * 100).toFixed(1)) : 0;
        const width = Math.max(5, (count / max) * 100);
        return (
          <div key={`${row.name}-${index}`} className="rounded-md border border-slate-200 bg-white px-2 py-1.5">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded bg-slate-100 px-1 text-[9px] font-bold leading-none text-slate-600">
                  {index + 1}
                </span>
                <p className="min-w-0 truncate text-[11px] font-semibold leading-3 text-slate-900" title={row.name}>
                  {row.name}
                </p>
              </div>
              <div className="flex flex-none items-baseline gap-1.5">
                <span className="text-[11px] font-bold leading-none text-slate-900">{formatNumber(count)}</span>
                <span className="text-[9px] font-semibold leading-none text-slate-500">{pct}%</span>
              </div>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-600 to-emerald-500"
                style={{ width: `${width}%` }}
                title={`${row.name}: ${count} ${totalLabel}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HighchartsBlock({ options, height = '24rem' }) {
  return (
    <div className="min-w-0" style={{ height }}>
      <HighchartsReact
        highcharts={Highcharts}
        options={options}
        containerProps={{ style: { height: '100%', width: '100%' } }}
      />
    </div>
  );
}

function exportAnalyticsWorkbook(payload, activeTab) {
  const wb = XLSX.utils.book_new();
  const addSheet = (name, rows) => {
    if (!rows?.length) return;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
  };

  addSheet('Overview Cards', Object.entries(payload.overview?.cards || {}).map(([key, value]) => ({
    metric: key,
    value: JSON.stringify(value),
  })));
  addSheet('Demand Trend', payload.demand?.trend || []);
  addSheet('Demand Categories', payload.demand?.breakdowns?.category || []);
  addSheet('Team Balance', payload.team?.technicians || []);
  addSheet('Team Timeline', payload.team?.timeline || []);
  addSheet('CSAT Trend', payload.quality?.csat?.trend || []);
  addSheet('CSAT Responses', payload.quality?.csat?.recentResponses || []);
  addSheet('Low CSAT', payload.quality?.csat?.lowScoreTickets || []);
  addSheet('Insights', payload.insights?.insights || []);
  addSheet('Pipeline Steps', payload.ops?.steps || []);

  XLSX.writeFile(wb, `ticket-pulse-analytics-${activeTab}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export default function Analytics() {
  const { currentWorkspace } = useWorkspace();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [activeTab, setActiveTab] = useState('overview');
  const [range, setRange] = useState('30d');
  const [groupBy, setGroupBy] = useState('day');
  const [compare, setCompare] = useState('previous');
  const [excludeNoise, setExcludeNoise] = useState(() => getGlobalExcludeNoise());
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [teamSearch, setTeamSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [teamSort, setTeamSort] = useState({ key: 'assigned', direction: 'desc' });
  const [selectedTeamIds, setSelectedTeamIds] = useState([]);
  const [teamTimelineMetric, setTeamTimelineMetric] = useState('assigned');
  const [selectedInsightId, setSelectedInsightId] = useState(null);
  const [payload, setPayload] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const params = useMemo(() => {
    const p = {
      range,
      groupBy,
      compare,
      excludeNoise: excludeNoise ? 'true' : 'false',
      timezone: currentWorkspace?.defaultTimezone || 'America/Los_Angeles',
    };
    if (range === 'custom' && customStart && customEnd) {
      p.start = customStart;
      p.end = customEnd;
    }
    return p;
  }, [compare, currentWorkspace?.defaultTimezone, customEnd, customStart, excludeNoise, groupBy, range]);

  const fetchAnalytics = useCallback(async () => {
    if (range === 'custom' && (!customStart || !customEnd)) return;
    setLoading(true);
    setError(null);
    try {
      const [overview, demand, team, quality, ops, insights] = await Promise.all([
        analyticsAPI.getOverview(params),
        analyticsAPI.getDemandFlow(params),
        analyticsAPI.getTeamBalance(params),
        analyticsAPI.getQuality(params),
        analyticsAPI.getAutomationOps(params),
        analyticsAPI.getInsights(params),
      ]);
      setPayload({
        overview: overview.data,
        demand: demand.data,
        team: team.data,
        quality: quality.data,
        ops: ops.data,
        insights: insights.data,
      });
    } catch (err) {
      setError(err.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [customEnd, customStart, params, range]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const meta = payload.overview?.metadata || payload.demand?.metadata;
  const overview = payload.overview;
  const demand = payload.demand;
  const team = payload.team;
  const quality = payload.quality;
  const ops = payload.ops;
  const insights = payload.insights;

  const teamRows = useMemo(() => {
    let rows = [...(team?.technicians || [])];
    const q = teamSearch.trim().toLowerCase();
    if (q) {
      rows = rows.filter((row) => row.name?.toLowerCase().includes(q) || row.email?.toLowerCase().includes(q));
    }
    if (selectedTeamIds.length) {
      const selected = new Set(selectedTeamIds);
      rows = rows.filter((row) => selected.has(row.technicianId));
    }
    if (teamFilter === 'onLeave') rows = rows.filter((row) => (row.leaveDays || 0) > 0);
    if (teamFilter === 'highOpen') rows = rows.filter((row) => (row.openNow || 0) >= 20);
    if (teamFilter === 'highRejected') rows = rows.filter((row) => (row.rejected || 0) > 0);
    rows.sort((a, b) => {
      const aValue = a[teamSort.key];
      const bValue = b[teamSort.key];
      const direction = teamSort.direction === 'asc' ? 1 : -1;
      if (typeof aValue === 'string' || typeof bValue === 'string') {
        return String(aValue || '').localeCompare(String(bValue || '')) * direction;
      }
      return ((Number(aValue) || 0) - (Number(bValue) || 0)) * direction;
    });
    return rows;
  }, [selectedTeamIds, team?.technicians, teamFilter, teamSearch, teamSort]);

  const setTeamSortKey = (key) => {
    setTeamSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }));
  };

  const toggleTeamSelection = useCallback((technicianId) => {
    setSelectedTeamIds((current) => (
      current.includes(technicianId)
        ? current.filter((id) => id !== technicianId)
        : [...current, technicianId]
    ));
  }, []);

  const teamTimelineMetricLabel = TEAM_TIMELINE_METRICS.find((metric) => metric.key === teamTimelineMetric)?.label || 'Tickets';

  const workloadChartOptions = useMemo(() => ({
    chart: { type: 'bar', backgroundColor: 'transparent', spacing: [8, 8, 8, 8] },
    title: { text: null },
    credits: { enabled: false },
    accessibility: { enabled: false },
    colors: ['#2563eb', '#f59e0b', '#059669'],
    xAxis: {
      categories: teamRows.map((row) => row.name),
      labels: { style: { color: '#475569', fontSize: '12px' } },
      lineColor: '#cbd5e1',
    },
    yAxis: {
      min: 0,
      allowDecimals: false,
      title: { text: null },
      gridLineDashStyle: 'Dash',
      gridLineColor: '#e2e8f0',
      labels: { style: { color: '#64748b', fontSize: '11px' } },
    },
    legend: { itemStyle: { color: '#334155', fontSize: '12px' } },
    tooltip: {
      shared: true,
      borderColor: '#cbd5e1',
      valueSuffix: ' tickets',
    },
    plotOptions: {
      series: {
        borderRadius: 4,
        cursor: 'pointer',
        point: {
          events: {
            click() {
              const technicianId = this.options.technicianId;
              if (technicianId) toggleTeamSelection(technicianId);
            },
          },
        },
      },
    },
    series: [
      { name: 'Assigned', data: teamRows.map((row) => ({ y: row.assigned || 0, technicianId: row.technicianId })) },
      { name: 'Open now', data: teamRows.map((row) => ({ y: row.openNow || 0, technicianId: row.technicianId })) },
      { name: 'Closed / resolved', data: teamRows.map((row) => ({ y: row.closed || 0, technicianId: row.technicianId })) },
    ],
  }), [teamRows, toggleTeamSelection]);

  const sourceChartOptions = useMemo(() => ({
    chart: { type: 'bar', backgroundColor: 'transparent', spacing: [8, 8, 8, 8] },
    title: { text: null },
    credits: { enabled: false },
    accessibility: { enabled: false },
    colors: ['#f59e0b', '#059669', '#2563eb', '#64748b'],
    xAxis: {
      categories: teamRows.map((row) => row.name),
      labels: { style: { color: '#475569', fontSize: '12px' } },
      lineColor: '#cbd5e1',
    },
    yAxis: {
      min: 0,
      allowDecimals: false,
      title: { text: null },
      stackLabels: {
        enabled: true,
        style: { color: '#334155', fontSize: '10px', textOutline: 'none' },
      },
      gridLineDashStyle: 'Dash',
      gridLineColor: '#e2e8f0',
      labels: { style: { color: '#64748b', fontSize: '11px' } },
    },
    legend: { itemStyle: { color: '#334155', fontSize: '12px' } },
    tooltip: { shared: true, borderColor: '#cbd5e1', valueSuffix: ' tickets' },
    plotOptions: {
      series: {
        stacking: 'normal',
        borderRadius: 4,
        cursor: 'pointer',
        point: {
          events: {
            click() {
              const technicianId = this.options.technicianId;
              if (technicianId) toggleTeamSelection(technicianId);
            },
          },
        },
      },
    },
    series: [
      { name: 'Self-picked', data: teamRows.map((row) => ({ y: row.selfPicked || 0, technicianId: row.technicianId })) },
      { name: 'Coordinator', data: teamRows.map((row) => ({ y: row.coordinatorAssigned || 0, technicianId: row.technicianId })) },
      { name: 'Ticket Pulse', data: teamRows.map((row) => ({ y: row.appAssigned || 0, technicianId: row.technicianId })) },
      { name: 'Source unavailable', data: teamRows.map((row) => ({ y: row.unknown || 0, technicianId: row.technicianId })) },
    ],
  }), [teamRows, toggleTeamSelection]);

  const timelineChartOptions = useMemo(() => {
    const visibleIds = new Set(teamRows.map((row) => row.technicianId));
    const timelineRows = (team?.timeline || []).filter((row) => visibleIds.has(row.technicianId));
    const periods = Array.from(new Set(timelineRows.map((row) => row.period))).sort((a, b) => a.localeCompare(b));
    const rowsByTech = new Map();
    for (const row of timelineRows) {
      if (!rowsByTech.has(row.technicianId)) rowsByTech.set(row.technicianId, { name: row.name, byPeriod: new Map() });
      rowsByTech.get(row.technicianId).byPeriod.set(row.period, row);
    }
    const series = Array.from(rowsByTech.entries()).map(([technicianId, row], index) => ({
      name: row.name,
      color: HIGHCHART_COLORS[index % HIGHCHART_COLORS.length],
      data: periods.map((period) => ({
        y: Number(row.byPeriod.get(period)?.[teamTimelineMetric] || 0),
        period,
        technicianId,
      })),
    }));

    return {
      chart: { type: 'line', backgroundColor: 'transparent', spacing: [8, 8, 8, 8], zoomType: 'x' },
      title: { text: null },
      credits: { enabled: false },
      accessibility: { enabled: false },
      xAxis: {
        categories: periods,
        labels: { style: { color: '#64748b', fontSize: '11px' } },
        lineColor: '#cbd5e1',
      },
      yAxis: {
        min: 0,
        allowDecimals: teamTimelineMetric === 'leaveDays' || teamTimelineMetric === 'wfhDays',
        title: { text: null },
        gridLineDashStyle: 'Dash',
        gridLineColor: '#e2e8f0',
        labels: { style: { color: '#64748b', fontSize: '11px' } },
      },
      legend: {
        align: 'center',
        itemStyle: { color: '#334155', fontSize: '12px' },
      },
      tooltip: {
        shared: true,
        borderColor: '#cbd5e1',
        valueDecimals: teamTimelineMetric === 'leaveDays' || teamTimelineMetric === 'wfhDays' ? 1 : 0,
        valueSuffix: teamTimelineMetric === 'leaveDays' || teamTimelineMetric === 'wfhDays' ? ' days' : ' tickets',
      },
      plotOptions: {
        series: {
          marker: { enabled: periods.length <= 45, radius: 3 },
          lineWidth: 2,
          cursor: 'pointer',
          point: {
            events: {
              click() {
                const technicianId = this.options.technicianId;
                if (technicianId) toggleTeamSelection(technicianId);
              },
            },
          },
        },
      },
      series,
    };
  }, [team?.timeline, teamRows, teamTimelineMetric, toggleTeamSelection]);

  const resolutionBucketRows = useMemo(() => (
    Object.entries(quality?.resolution?.buckets || {}).map(([key, count]) => ({
      key,
      name: labelFromKey(key, RESOLUTION_BUCKET_LABELS),
      count,
    }))
  ), [quality?.resolution?.buckets]);

  const openAgingRows = useMemo(() => (
    Object.entries(quality?.openAging || {}).map(([key, count]) => ({
      key,
      name: labelFromKey(key, OPEN_AGING_LABELS),
      count,
    }))
  ), [quality?.openAging]);

  const qualityDistributionOptions = useMemo(() => ({
    ...chartBase('column'),
    colors: ['#2563eb', '#f59e0b'],
    xAxis: {
      categories: resolutionBucketRows.map((row) => row.name),
      labels: { style: { color: '#475569', fontSize: '12px' } },
    },
    yAxis: {
      min: 0,
      allowDecimals: false,
      title: { text: null },
      gridLineDashStyle: 'Dash',
      gridLineColor: '#e2e8f0',
    },
    legend: { enabled: false },
    tooltip: { borderColor: '#cbd5e1', pointFormat: '<b>{point.y}</b> resolved tickets' },
    plotOptions: {
      column: {
        borderRadius: 5,
        colorByPoint: true,
        colors: ['#059669', '#10b981', '#2563eb', '#f59e0b', '#dc2626'],
      },
    },
    series: [{ name: 'Resolved tickets', data: resolutionBucketRows.map((row) => row.count || 0) }],
  }), [resolutionBucketRows]);

  const openAgingOptions = useMemo(() => ({
    ...chartBase('bar'),
    colors: ['#f59e0b'],
    xAxis: {
      categories: openAgingRows.map((row) => row.name),
      labels: { style: { color: '#475569', fontSize: '12px' } },
    },
    yAxis: {
      min: 0,
      allowDecimals: false,
      title: { text: null },
      gridLineDashStyle: 'Dash',
      gridLineColor: '#e2e8f0',
    },
    legend: { enabled: false },
    tooltip: { borderColor: '#cbd5e1', pointFormat: '<b>{point.y}</b> open tickets' },
    plotOptions: {
      bar: {
        borderRadius: 5,
        colorByPoint: true,
        colors: ['#10b981', '#2563eb', '#f59e0b', '#dc2626'],
      },
    },
    series: [{ name: 'Open tickets', data: openAgingRows.map((row) => row.count || 0) }],
  }), [openAgingRows]);

  const csatTrendOptions = useMemo(() => {
    const rows = quality?.csat?.trend || [];
    return {
      ...chartBase('line'),
      chart: { ...chartBase('line').chart, zoomType: 'x' },
      xAxis: {
        categories: rows.map((row) => row.date),
        labels: { style: { color: '#64748b', fontSize: '11px' } },
      },
      yAxis: [{
        min: 0,
        max: 4,
        title: { text: null },
        gridLineDashStyle: 'Dash',
        gridLineColor: '#e2e8f0',
      }, {
        min: 0,
        allowDecimals: false,
        title: { text: null },
        opposite: true,
        gridLineWidth: 0,
      }],
      legend: { itemStyle: { color: '#334155', fontSize: '12px' } },
      tooltip: { shared: true, borderColor: '#cbd5e1' },
      plotOptions: {
        column: { borderRadius: 4 },
        line: { marker: { enabled: rows.length <= 45, radius: 3 }, lineWidth: 2 },
      },
      series: [
        { type: 'line', name: 'Average CSAT', data: rows.map((row) => row.average), color: '#7c3aed', tooltip: { valueDecimals: 2 } },
        { type: 'column', name: 'Responses', data: rows.map((row) => row.responses || 0), color: '#bfdbfe', yAxis: 1 },
      ],
    };
  }, [quality?.csat?.trend]);

  const lowCsatCount = quality?.csat?.lowScoreCount ?? quality?.csat?.lowScoreTickets?.length ?? 0;
  const csatDrilldownRows = (quality?.csat?.lowScoreTickets || []).length
    ? quality.csat.lowScoreTickets
    : (quality?.csat?.recentResponses || []);
  const showingRecentCsatFallback = lowCsatCount === 0 && (quality?.csat?.responses || 0) > 0;

  const opsFunnelRows = useMemo(() => (
    Object.entries(ops?.pipeline?.funnel || {})
      .map(([key, count]) => ({ key, name: labelFromKey(key, OPS_LABELS), count }))
      .sort((a, b) => b.count - a.count)
  ), [ops?.pipeline?.funnel]);

  const opsTriggerRows = useMemo(() => (
    Object.entries(ops?.pipeline?.triggerSources || {})
      .map(([key, count]) => ({ key, name: labelFromKey(key, OPS_LABELS), count }))
      .sort((a, b) => b.count - a.count)
  ), [ops?.pipeline?.triggerSources]);

  const opsFunnelOptions = useMemo(() => ({
    ...chartBase('pie'),
    colors: HIGHCHART_COLORS,
    tooltip: { borderColor: '#cbd5e1', pointFormat: '<b>{point.y}</b> runs ({point.percentage:.1f}%)' },
    plotOptions: {
      pie: {
        innerSize: '58%',
        borderWidth: 2,
        dataLabels: {
          enabled: true,
          distance: 12,
          style: { fontSize: '11px', color: '#334155', textOutline: 'none' },
          format: '{point.name}: {point.y}',
        },
      },
    },
    series: [{
      name: 'Pipeline outcomes',
      data: opsFunnelRows.map((row) => ({ name: row.name, y: row.count || 0 })),
    }],
  }), [opsFunnelRows]);

  const opsTriggerOptions = useMemo(() => ({
    ...chartBase('bar'),
    colors: ['#2563eb'],
    xAxis: {
      categories: opsTriggerRows.map((row) => row.name),
      labels: { style: { color: '#475569', fontSize: '12px' } },
    },
    yAxis: {
      min: 0,
      allowDecimals: false,
      title: { text: null },
      gridLineDashStyle: 'Dash',
      gridLineColor: '#e2e8f0',
    },
    legend: { enabled: false },
    tooltip: { borderColor: '#cbd5e1', pointFormat: '<b>{point.y}</b> runs' },
    plotOptions: { bar: { borderRadius: 5 } },
    series: [{ name: 'Runs', data: opsTriggerRows.map((row) => row.count || 0) }],
  }), [opsTriggerRows]);

  const opsStepHealthOptions = useMemo(() => {
    const rows = ops?.steps || [];
    return {
      ...chartBase('bar'),
      colors: ['#059669', '#dc2626', '#64748b'],
      xAxis: {
        categories: rows.map((row) => labelFromKey(row.stepName)),
        labels: { style: { color: '#475569', fontSize: '11px' } },
      },
      yAxis: {
        min: 0,
        allowDecimals: false,
        title: { text: null },
        gridLineDashStyle: 'Dash',
        gridLineColor: '#e2e8f0',
      },
      legend: { itemStyle: { color: '#334155', fontSize: '12px' } },
      tooltip: { shared: true, borderColor: '#cbd5e1', valueSuffix: ' steps' },
      plotOptions: { series: { stacking: 'normal', borderRadius: 4 } },
      series: [
        { name: 'Completed', data: rows.map((row) => row.completed || 0) },
        { name: 'Failed', data: rows.map((row) => row.failed || 0) },
        { name: 'Skipped', data: rows.map((row) => row.skipped || 0) },
      ],
    };
  }, [ops?.steps]);

  const opsStepDurationOptions = useMemo(() => {
    const rows = ops?.steps || [];
    return {
      ...chartBase('column'),
      colors: ['#2563eb', '#f59e0b'],
      xAxis: {
        categories: rows.map((row) => labelFromKey(row.stepName)),
        labels: { style: { color: '#475569', fontSize: '11px' } },
      },
      yAxis: {
        min: 0,
        title: { text: 'ms', style: { color: '#64748b' } },
        gridLineDashStyle: 'Dash',
        gridLineColor: '#e2e8f0',
      },
      legend: { itemStyle: { color: '#334155', fontSize: '12px' } },
      tooltip: { shared: true, borderColor: '#cbd5e1', valueSuffix: ' ms' },
      plotOptions: { column: { borderRadius: 4 } },
      series: [
        { name: 'Average', data: rows.map((row) => row.avgDurationMs || 0) },
        { name: 'P90', data: rows.map((row) => row.p90DurationMs || 0) },
      ],
    };
  }, [ops?.steps]);

  const opsTrendOptions = useMemo(() => {
    const pipelineRows = ops?.pipeline?.trend || [];
    const syncRows = ops?.sync?.trend || [];
    const periods = Array.from(new Set([...pipelineRows.map((row) => row.period), ...syncRows.map((row) => row.period)])).sort((a, b) => a.localeCompare(b));
    const pipelineByPeriod = new Map(pipelineRows.map((row) => [row.period, row]));
    const syncByPeriod = new Map(syncRows.map((row) => [row.period, row]));
    return {
      ...chartBase('line'),
      chart: { ...chartBase('line').chart, zoomType: 'x' },
      xAxis: {
        categories: periods,
        labels: { style: { color: '#64748b', fontSize: '11px' } },
      },
      yAxis: {
        min: 0,
        allowDecimals: false,
        title: { text: null },
        gridLineDashStyle: 'Dash',
        gridLineColor: '#e2e8f0',
      },
      legend: { itemStyle: { color: '#334155', fontSize: '12px' } },
      tooltip: { shared: true, borderColor: '#cbd5e1' },
      plotOptions: {
        line: { marker: { enabled: periods.length <= 45, radius: 3 }, lineWidth: 2 },
        column: { borderRadius: 4 },
      },
      series: [
        { type: 'line', name: 'Pipeline runs', data: periods.map((period) => pipelineByPeriod.get(period)?.runs || 0), color: '#7c3aed' },
        { type: 'line', name: 'Pipeline errors', data: periods.map((period) => pipelineByPeriod.get(period)?.errors || 0), color: '#dc2626' },
        { type: 'column', name: 'Sync failures', data: periods.map((period) => syncByPeriod.get(period)?.failed || 0), color: '#f59e0b' },
      ],
    };
  }, [ops?.pipeline?.trend, ops?.sync?.trend]);

  const insightRows = useMemo(() => insights?.insights || [], [insights?.insights]);
  const selectedInsight = useMemo(() => (
    insightRows.find((item) => item.id === selectedInsightId) || insightRows[0] || null
  ), [insightRows, selectedInsightId]);
  const selectedInsightDrilldownRows = useMemo(() => (
    normalizeInsightDrilldown(selectedInsight).slice(0, 15)
  ), [selectedInsight]);
  const selectedInsightDrilldownColumns = useMemo(() => (
    insightDrilldownColumns(selectedInsight)
  ), [selectedInsight]);

  const insightSeverityRows = useMemo(() => {
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const item of insightRows) counts[item.severity || 'info'] = (counts[item.severity || 'info'] || 0) + 1;
    return Object.entries(counts).map(([key, count]) => ({ key, ...INSIGHT_SEVERITY[key], count }));
  }, [insightRows]);

  const insightSeverityOptions = useMemo(() => ({
    ...chartBase('pie'),
    colors: insightSeverityRows.map((row) => row.color),
    tooltip: { borderColor: '#cbd5e1', pointFormat: '<b>{point.y}</b> insights' },
    plotOptions: {
      pie: {
        innerSize: '62%',
        dataLabels: {
          enabled: true,
          distance: 10,
          style: { fontSize: '11px', color: '#334155', textOutline: 'none' },
          format: '{point.name}: {point.y}',
        },
      },
    },
    series: [{
      name: 'Insights',
      data: insightSeverityRows.filter((row) => row.count > 0).map((row) => ({ name: row.label, y: row.count })),
    }],
  }), [insightSeverityRows]);

  const renderOverview = () => (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Created" value={formatNumber(overview?.cards?.created?.current)} subtitle="Tickets created" icon={Calendar} delta={overview?.cards?.created?.pct} />
        <StatCard title="Closed / Resolved" value={formatNumber(overview?.cards?.resolved?.current)} subtitle="Assigned in selected range" icon={CheckCircle2} tone="green" delta={overview?.cards?.resolved?.pct} />
        <StatCard title="Open Backlog" value={formatNumber(overview?.cards?.openBacklog?.current)} subtitle="Current open and pending" icon={Clock} tone="amber" />
        <StatCard title="Overdue Risk" value={formatNumber(overview?.cards?.overdue?.current)} subtitle="Open tickets past dueBy" icon={ShieldAlert} tone={overview?.cards?.overdue?.current > 0 ? 'red' : 'green'} />
        <StatCard title="Net Change" value={formatNumber(overview?.cards?.netChange?.current)} subtitle="Created minus closed/resolved" icon={RefreshCw} tone="slate" delta={overview?.cards?.netChange?.pct} />
        <StatCard title="Avg Resolution" value={formatHours(overview?.cards?.avgResolutionHours?.current)} subtitle={`${formatNumber(overview?.cards?.avgResolutionHours?.sampleSize)} sampled tickets`} icon={Gauge} tone="purple" />
        <StatCard title="CSAT" value={overview?.cards?.csat?.average ?? '—'} subtitle={`${formatNumber(overview?.cards?.csat?.responses)} responses`} icon={CheckCircle2} tone="green" />
        <StatCard title="First Response Risk" value={formatNumber(overview?.cards?.firstResponseRisk?.current)} subtitle="Open tickets past frDueBy" icon={AlertTriangle} tone="amber" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Assignment Mix" subtitle="How assigned tickets entered a technician's queue in the selected range.">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="relative h-64 min-w-0 sm:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={buildAssignmentMixRows(overview?.assignmentMix)}
                    dataKey="value"
                    nameKey="label"
                    innerRadius={68}
                    outerRadius={112}
                    paddingAngle={2}
                    label={false}
                    labelLine={false}
                  >
                    {buildAssignmentMixRows(overview?.assignmentMix).map((row) => <Cell key={row.key} fill={row.color} />)}
                  </Pie>
                  <Tooltip content={<AssignmentMixTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <p className="text-2xl font-bold text-slate-900">
                    {formatNumber(buildAssignmentMixRows(overview?.assignmentMix).reduce((sum, row) => sum + row.value, 0))}
                  </p>
                  <p className="text-xs font-semibold uppercase tracking-normal text-slate-500">assigned tickets</p>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              {buildAssignmentMixRows(overview?.assignmentMix).map((row) => (
                <div key={row.key} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: row.color }} />
                      <p className="truncate text-sm font-semibold text-slate-800">{row.label}</p>
                    </div>
                    <p className="text-sm font-bold text-slate-900">{formatNumber(row.value)}</p>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{row.pct}% · {row.description}</p>
                </div>
              ))}
              {(overview?.assignmentMix?.unknown || 0) > 0 && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  <span className="font-semibold text-slate-800">Source unavailable</span> means FreshService/local activity data did not include a usable `assignedBy` value for that assigned ticket.
                </div>
              )}
            </div>
          </div>
        </Panel>
        <Panel title="Data Quality" subtitle="Coverage labels prevent sparse fields from looking more precise than they are.">
          <div className="grid gap-3 sm:grid-cols-2">
            <StatCard title="Range Tickets" value={formatNumber(overview?.dataQuality?.rangeTicketCount)} icon={Info} tone="slate" />
            <StatCard title="Resolution Coverage" value={`${overview?.dataQuality?.resolutionTimeCoverage ?? 0}%`} icon={Gauge} tone="green" />
            <StatCard title="CSAT Samples" value={formatNumber(overview?.dataQuality?.csatSampleCount)} icon={CheckCircle2} tone="purple" />
            <StatCard title="First Response Populated" value="0" subtitle="Omitted from v1 charts" icon={XCircle} tone="red" />
          </div>
        </Panel>
      </div>
    </div>
  );

  const renderDemand = () => (
    <div className="space-y-4">
      <Panel title="Created vs Closed / Resolved" subtitle="Resolved count uses tickets assigned in the same period because historical closedAt/resolvedAt coverage is sparse.">
        <div className="h-64 sm:h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={demand?.trend || []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Area type="monotone" dataKey="created" stroke="#2563eb" fill="#dbeafe" />
              <Area type="monotone" dataKey="resolved" stroke="#059669" fill="#d1fae5" />
              <Line type="monotone" dataKey="net" stroke="#f59e0b" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Category Hotspots" subtitle="Uses ticketCategory, the populated custom category field.">
          <HotspotRankedBars data={demand?.breakdowns?.category || []} compact />
        </Panel>
        <Panel title="Requester Hotspots">
          <HotspotRankedBars data={demand?.breakdowns?.requester || []} compact />
        </Panel>
        <Panel title="Source Mix">
          <CategoricalBars data={demand?.breakdowns?.source || []} />
        </Panel>
        <Panel title="Priority Mix">
          <CategoricalBars data={demand?.breakdowns?.priority || []} />
        </Panel>
      </div>
    </div>
  );

  const renderTeam = () => (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Balance Score" value={formatNumber(team?.summary?.balanceScore)} subtitle="Higher means more even distribution" icon={Gauge} tone="green" />
        <StatCard title="Avg Assigned" value={formatNumber(team?.summary?.avgAssignedPerTech)} subtitle="Per active technician" icon={Users} />
        <StatCard title="Spread" value={formatNumber(team?.summary?.spread)} subtitle="Max minus min assigned" icon={BarChart3} tone="amber" />
        <StatCard title="Open > 24h" value={formatNumber((team?.summary?.openAgeBuckets?.over24h || 0))} subtitle="Current open queue" icon={Clock} tone="red" />
      </div>
      <Panel
        title="Manager Filters"
        subtitle="Filter the agent-level analytics before reviewing the table and visuals."
      >
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="search"
              value={teamSearch}
              onChange={(e) => setTeamSearch(e.target.value)}
              placeholder="Search agent..."
              className="h-9 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm"
            />
            <select
              value={teamFilter}
              onChange={(e) => setTeamFilter(e.target.value)}
              className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm"
            >
              <option value="all">All agents</option>
              <option value="onLeave">Has leave in range</option>
              <option value="highOpen">20+ open now</option>
              <option value="highRejected">Has rejected tickets</option>
            </select>
            <select
              value={teamTimelineMetric}
              onChange={(e) => setTeamTimelineMetric(e.target.value)}
              className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm"
              title="Timeline metric"
            >
              {TEAM_TIMELINE_METRICS.map((metric) => (
                <option key={metric.key} value={metric.key}>{metric.label}</option>
              ))}
            </select>
            {selectedTeamIds.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedTeamIds([])}
                className="h-9 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Clear selected
              </button>
            )}
          </div>
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
            {(team?.technicians || []).map((row) => {
              const selected = selectedTeamIds.includes(row.technicianId);
              return (
                <button
                  key={row.technicianId}
                  type="button"
                  onClick={() => toggleTeamSelection(row.technicianId)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                    selected
                      ? 'border-blue-600 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {row.name}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-slate-500">
            Click an agent chip or any chart bar/line point to add or remove that technician from the focused list.
          </p>
        </div>
      </Panel>

      <Panel
        title="Timeline by Agent"
        subtitle={`${teamTimelineMetricLabel} over the selected date range. Use the agent chips above to compare specific technicians.`}
      >
        {teamRows.length ? <HighchartsBlock options={timelineChartOptions} height={isMobile ? '20rem' : '26rem'} /> : <EmptyState text="No agents match the current filters." />}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Workload by Agent" subtitle="Assigned tickets, current open queue, and closed count by agent.">
          {teamRows.length ? <HighchartsBlock options={workloadChartOptions} height={isMobile ? '20rem' : '26rem'} /> : <EmptyState text="No agents match the current filters." />}
        </Panel>
        <Panel title="Assignment Source by Agent" subtitle="Shows self-picked, coordinator-assigned, and Ticket Pulse-assigned volume.">
          {teamRows.length ? <HighchartsBlock options={sourceChartOptions} height={isMobile ? '20rem' : '26rem'} /> : <EmptyState text="No agents match the current filters." />}
        </Panel>
      </div>

      <Panel title="Team-Safe Distribution" subtitle="Sortable agent table with context metrics, not public winner/loser framing.">
        <div className="max-h-[31rem] space-y-2 overflow-auto sm:hidden">
          {teamRows.map((row) => (
            <div key={row.technicianId} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900">{row.name}</p>
                  <p className="text-xs text-slate-500">{row.assigned} assigned · {row.openNow} open · {row.closed} closed</p>
                </div>
                <button
                  type="button"
                  onClick={() => toggleTeamSelection(row.technicianId)}
                  className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                    selectedTeamIds.includes(row.technicianId)
                      ? 'border-blue-600 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-slate-50 text-slate-600'
                  }`}
                >
                  {selectedTeamIds.includes(row.technicianId) ? 'Selected' : 'Focus'}
                </button>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-slate-500">Self</p>
                  <p className="font-bold text-slate-900">{row.selfPicked}</p>
                </div>
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-slate-500">Coord.</p>
                  <p className="font-bold text-slate-900">{row.coordinatorAssigned}</p>
                </div>
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-slate-500">App</p>
                  <p className="font-bold text-slate-900">{row.appAssigned}</p>
                </div>
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-slate-500">CSAT</p>
                  <p className="font-bold text-slate-900">{row.csatAverage === null ? '—' : row.csatAverage}</p>
                </div>
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-slate-500">Leave</p>
                  <p className="font-bold text-slate-900">{row.leaveDays}</p>
                </div>
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-slate-500">WFH</p>
                  <p className="font-bold text-slate-900">{row.wfhDays || 0}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="hidden max-h-[31rem] overflow-auto rounded-lg border border-slate-200 sm:block">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="sticky top-0 bg-slate-50">
              <tr>
                {[
                  ['name', 'Technician'],
                  ['assigned', 'Assigned'],
                  ['openNow', 'Open Now'],
                  ['selfPicked', 'Self'],
                  ['coordinatorAssigned', 'Coordinator'],
                  ['appAssigned', 'App'],
                  ['closed', 'Closed'],
                  ['closeRatePct', 'Close %'],
                  ['avgResolutionHours', 'Avg Res.'],
                  ['csatAverage', 'CSAT'],
                  ['rejected', 'Rejected'],
                  ['leaveDays', 'Leave Days'],
                  ['wfhDays', 'WFH Days'],
                ].map(([key, label]) => (
                  <th key={key} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-normal text-slate-500">
                    <button
                      type="button"
                      onClick={() => setTeamSortKey(key)}
                      className="inline-flex items-center gap-1 hover:text-slate-900"
                    >
                      {label}
                      {teamSort.key === key && <span>{teamSort.direction === 'desc' ? '↓' : '↑'}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {teamRows.map((row) => (
                <tr key={row.technicianId} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-semibold text-slate-800">{row.name}</td>
                  <td className="px-3 py-2 text-slate-700">{row.assigned}</td>
                  <td className="px-3 py-2 text-slate-700">{row.openNow}</td>
                  <td className="px-3 py-2 text-slate-700">{row.selfPicked}</td>
                  <td className="px-3 py-2 text-slate-700">{row.coordinatorAssigned}</td>
                  <td className="px-3 py-2 text-slate-700">{row.appAssigned}</td>
                  <td className="px-3 py-2 text-slate-700">{row.closed}</td>
                  <td className="px-3 py-2 text-slate-700">{row.closeRatePct}%</td>
                  <td className="px-3 py-2 text-slate-700">{row.avgResolutionHours === null ? '—' : `${row.avgResolutionHours}h`}</td>
                  <td className="px-3 py-2 text-slate-700">{row.csatAverage === null ? '—' : `${row.csatAverage} (${row.csatCount})`}</td>
                  <td className="px-3 py-2 text-slate-700">{row.rejected}</td>
                  <td className="px-3 py-2 text-slate-700">
                    <span title={row.leaveTypes?.map((leave) => `${leave.name}: ${leave.days}`).join('\n') || ''}>
                      {row.leaveDays}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{row.wfhDays || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Agent Detail Cards" subtitle="Per-agent coaching context: load, throughput, source mix, quality, rejections, leave, and top categories.">
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {teamRows.map((row) => (
            <div key={row.technicianId} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-bold text-slate-900">{row.name}</h3>
                  <p className="text-xs text-slate-500">
                    {row.assigned} assigned · {row.openNow} open · {row.closed} closed
                  </p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                  row.openNow >= 30 ? 'bg-red-50 text-red-700'
                    : row.openNow >= 15 ? 'bg-amber-50 text-amber-700'
                      : 'bg-emerald-50 text-emerald-700'
                }`}>
                  {row.openNow >= 30 ? 'High load' : row.openNow >= 15 ? 'Watch' : 'Normal'}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-xs text-slate-500">Self</p>
                  <p className="text-sm font-bold text-slate-900">{row.selfPickRatePct}%</p>
                </div>
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-xs text-slate-500">Close</p>
                  <p className="text-sm font-bold text-slate-900">{row.closeRatePct}%</p>
                </div>
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-xs text-slate-500">Avg Res.</p>
                  <p className="text-sm font-bold text-slate-900">{row.avgResolutionHours === null ? '—' : `${row.avgResolutionHours}h`}</p>
                </div>
              </div>

              <div className="mt-3 space-y-2 text-xs text-slate-600">
                <p><span className="font-semibold text-slate-800">Sources:</span> {row.selfPicked} self, {row.coordinatorAssigned} coordinator, {row.appAssigned} app</p>
                <p><span className="font-semibold text-slate-800">Rejected:</span> {row.rejected} ({row.rejectionRatePct}%)</p>
                <p><span className="font-semibold text-slate-800">Leave:</span> {row.leaveDays} days{row.leaveHalfDays ? ` (${row.leaveHalfDays} half-day records)` : ''}</p>
                <p><span className="font-semibold text-slate-800">WFH:</span> {row.wfhDays || 0} days</p>
                <p>
                  <span className="font-semibold text-slate-800">Top categories:</span>{' '}
                  {row.topCategories?.length ? row.topCategories.map((cat) => `${cat.name} (${cat.count})`).join(', ') : 'None in range'}
                </p>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );

  const renderQuality = () => (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Avg Resolution" value={formatHours(quality?.resolution?.hours?.avg)} subtitle={`${formatNumber(quality?.resolution?.seconds?.count)} sampled tickets`} icon={Gauge} />
        <StatCard title="Median Resolution" value={formatHours(quality?.resolution?.hours?.median)} icon={Clock} tone="green" />
        <StatCard title="P90 Resolution" value={formatHours(quality?.resolution?.hours?.p90)} icon={AlertTriangle} tone="amber" />
        <StatCard title="CSAT Average" value={quality?.csat?.average ?? '—'} subtitle={`${formatNumber(quality?.csat?.responses)} responses`} icon={CheckCircle2} tone="purple" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
        <Panel
          title="Resolution Distribution"
          subtitle="Resolved tickets grouped by populated resolutionTimeSeconds. Wider right-side bars indicate slower outcomes."
        >
          {resolutionBucketRows.length ? <HighchartsBlock options={qualityDistributionOptions} height={isMobile ? '18rem' : '22rem'} /> : <EmptyState />}
        </Panel>
        <Panel
          title="Open Ticket Aging"
          subtitle="Current open queue age, not historical SLA breach rate."
        >
          {openAgingRows.length ? <HighchartsBlock options={openAgingOptions} height={isMobile ? '18rem' : '22rem'} /> : <EmptyState />}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel
          title="CSAT Trend"
          subtitle="Average score with response count, so sparse survey coverage is visible."
        >
          {(quality?.csat?.trend || []).length ? <HighchartsBlock options={csatTrendOptions} height={isMobile ? '18rem' : '22rem'} /> : <EmptyState text="No CSAT responses in this range." />}
        </Panel>
        <Panel title="Quality Watchlist" subtitle="Useful checks for managers before opening tickets.">
          <div className="space-y-2">
            {[
              {
                label: 'Older than 7 days',
                value: quality?.openAging?.over7d || 0,
                tone: (quality?.openAging?.over7d || 0) > 0 ? 'text-red-700 bg-red-50 border-red-100' : 'text-emerald-700 bg-emerald-50 border-emerald-100',
              },
              {
                label: 'Resolution sample',
                value: quality?.resolution?.seconds?.count || 0,
                tone: 'text-blue-700 bg-blue-50 border-blue-100',
              },
              {
                label: 'Low CSAT tickets',
                value: lowCsatCount,
                tone: lowCsatCount > 0 ? 'text-amber-700 bg-amber-50 border-amber-100' : 'text-emerald-700 bg-emerald-50 border-emerald-100',
              },
            ].map((item) => (
              <div key={item.label} className={`flex items-center justify-between rounded-lg border px-3 py-2 ${item.tone}`}>
                <span className="text-sm font-semibold">{item.label}</span>
                <span className="text-lg font-bold">{formatNumber(item.value)}</span>
              </div>
            ))}
            <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              First-response analytics are intentionally omitted because firstPublicAgentReplyAt is not populated.
            </p>
          </div>
        </Panel>
      </div>

      <Panel
        title="CSAT Response Drilldown"
        subtitle={
          lowCsatCount > 0
            ? 'Showing low-score survey responses first.'
            : showingRecentCsatFallback
              ? 'No low-score responses in this range; showing the latest CSAT responses instead.'
              : 'No CSAT responses in this range.'
        }
      >
        <div className="space-y-3">
          {showingRecentCsatFallback && (
            <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              No low-CSAT tickets found. Showing recent survey responses so this section still validates the source data.
            </div>
          )}
          <SimpleTable
            rows={csatDrilldownRows}
            columns={[
              { key: 'freshserviceTicketId', label: 'Ticket' },
              {
                key: 'csatScore',
                label: 'Score',
                render: (row) => row.csatScore === null || row.csatScore === undefined
                  ? '—'
                  : `${row.csatScore}/${row.csatTotalScore || 4}`,
              },
              { key: 'csatRatingText', label: 'Rating', render: (row) => row.csatRatingText || '—' },
              { key: 'subject', label: 'Subject' },
              { key: 'assignedTechName', label: 'Tech', render: (row) => row.assignedTechName || 'Unassigned' },
              { key: 'requesterName', label: 'Requester', render: (row) => row.requesterName || row.requesterEmail || 'Unknown' },
              { key: 'csatSubmittedAt', label: 'Submitted', render: (row) => formatDateTime(row.csatSubmittedAt) },
            ]}
          />
        </div>
      </Panel>
    </div>
  );

  const renderOps = () => (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Pipeline Runs" value={formatNumber(ops?.pipeline?.totalRuns)} icon={Sparkles} tone="purple" />
        <StatCard title="Rebounds" value={formatNumber(ops?.pipeline?.rebounds)} icon={RefreshCw} tone="amber" />
        <StatCard title="Sync Failure Rate" value={`${ops?.sync?.failureRatePct ?? 0}%`} subtitle={`${formatNumber(ops?.sync?.failed)} failed logs`} icon={AlertTriangle} tone={ops?.sync?.failureRatePct > 5 ? 'red' : 'green'} />
        <StatCard title="Stale Started Syncs" value={formatNumber(ops?.sync?.staleStarted)} icon={Clock} tone={ops?.sync?.staleStarted > 0 ? 'red' : 'green'} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Panel
          title="Operations Timeline"
          subtitle="Pipeline volume, pipeline errors, and sync failures over the selected range."
        >
          {((ops?.pipeline?.trend || []).length || (ops?.sync?.trend || []).length)
            ? <HighchartsBlock options={opsTrendOptions} height={isMobile ? '18rem' : '22rem'} />
            : <EmptyState />}
        </Panel>
        <Panel title="Pipeline Outcomes" subtitle="Outcome mix for assignment pipeline runs.">
          {opsFunnelRows.length ? <HighchartsBlock options={opsFunnelOptions} height={isMobile ? '18rem' : '22rem'} /> : <EmptyState />}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Step Health" subtitle="Completed, failed, and skipped step counts by pipeline stage.">
          {(ops?.steps || []).length ? <HighchartsBlock options={opsStepHealthOptions} height={isMobile ? '20rem' : '26rem'} /> : <EmptyState />}
        </Panel>
        <Panel title="Step Duration Hotspots" subtitle="Average and p90 duration by step, in milliseconds.">
          {(ops?.steps || []).length ? <HighchartsBlock options={opsStepDurationOptions} height={isMobile ? '20rem' : '26rem'} /> : <EmptyState />}
        </Panel>
        <Panel title="Trigger Sources" subtitle="What started pipeline runs in this range.">
          {opsTriggerRows.length ? <HighchartsBlock options={opsTriggerOptions} height={isMobile ? '18rem' : '22rem'} /> : <EmptyState />}
        </Panel>
        <Panel title="Backfill Runs">
          <SimpleTable
            rows={ops?.backfills || []}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'status', label: 'Status' },
              { key: 'startDate', label: 'Start' },
              { key: 'endDate', label: 'End' },
              { key: 'progressPct', label: 'Progress' },
              { key: 'ticketsProcessed', label: 'Processed' },
            ]}
          />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Daily Review Recommendations">
          <SimpleTable
            rows={ops?.dailyReviews?.recommendations || []}
            columns={[
              { key: 'kind', label: 'Kind' },
              { key: 'status', label: 'Status' },
              { key: 'severity', label: 'Severity' },
              { key: 'count', label: 'Count' },
            ]}
          />
        </Panel>
        <Panel title="Recent Sync Failures" subtitle="Most recent failed sync logs in this range.">
          <SimpleTable
            rows={ops?.sync?.recentFailures || []}
            columns={[
              { key: 'syncType', label: 'Type' },
              { key: 'startedAt', label: 'Started' },
              { key: 'recordsProcessed', label: 'Records' },
              { key: 'errorMessage', label: 'Error' },
            ]}
          />
        </Panel>
      </div>
    </div>
  );

  const renderInsights = () => {
    const rows = insightRows;
    if (!rows.length) {
      return (
        <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
          <Panel title="Insight Coverage" subtitle="No deterministic rule crossed its threshold in this range.">
            <EmptyState text={insights?.emptyState || 'No insights crossed thresholds for this range.'} />
          </Panel>
          <Panel title="Rules Checked" subtitle="Rules still evaluated; they simply did not meet alert thresholds.">
            <div className="grid gap-2 sm:grid-cols-2">
              {['Demand spike', 'Backlog growth', 'Overdue risk', 'Load imbalance', 'Stale open tickets', 'Sync degradation', 'Resolution coverage', 'CSAT warning'].map((rule) => (
                <div key={rule} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
                  {rule}
                </div>
              ))}
            </div>
          </Panel>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
          <Panel title="Insight Priority" subtitle="Rule-based alerts grouped by urgency.">
            <HighchartsBlock options={insightSeverityOptions} height={isMobile ? '15rem' : '18rem'} />
            <div className="mt-3 grid grid-cols-3 gap-2">
              {insightSeverityRows.map((row) => (
                <div key={row.key} className={`rounded-lg border px-2 py-1.5 text-center ${row.badge}`}>
                  <p className="text-xs font-semibold">{row.label}</p>
                  <p className="text-lg font-bold">{row.count}</p>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Selected Insight" subtitle="Rule, evidence, affected objects, and drilldown source data.">
            {selectedInsight && (
              <div className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${INSIGHT_SEVERITY[selectedInsight.severity || 'info']?.badge}`}>
                        {INSIGHT_SEVERITY[selectedInsight.severity || 'info']?.label}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-600">
                        {formatNumber(selectedInsight.evidenceCount)} evidence
                      </span>
                    </div>
                    <h2 className="mt-2 text-lg font-bold text-slate-900">{selectedInsight.title}</h2>
                    <p className="mt-1 text-sm text-slate-600">{selectedInsight.rule}</p>
                  </div>
                  {selectedInsight.severity === 'critical' ? <ShieldAlert className="h-6 w-6 text-red-600" /> : <Info className="h-6 w-6 text-blue-600" />}
                </div>
                {selectedInsight.affected?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedInsight.affected.map((label) => (
                      <span key={label} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{label}</span>
                    ))}
                  </div>
                )}
                <SimpleTable
                  rows={selectedInsightDrilldownRows}
                  maxHeight="max-h-72"
                  columns={selectedInsightDrilldownColumns}
                />
              </div>
            )}
          </Panel>
        </div>

        <div className="grid gap-3 xl:grid-cols-2">
          {rows.map((item) => {
            const selected = selectedInsight?.id === item.id;
            const severity = INSIGHT_SEVERITY[item.severity || 'info'] || INSIGHT_SEVERITY.info;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedInsightId(item.id)}
                className={`rounded-lg border bg-white p-4 text-left shadow-sm transition-colors ${
                  selected ? 'border-blue-500 ring-2 ring-blue-100' : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`rounded-lg border p-2 ${severity.badge}`}>
                    {item.severity === 'critical' ? <ShieldAlert className="h-5 w-5" /> : <Info className="h-5 w-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold text-slate-900">{item.title}</h3>
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-600">{formatNumber(item.evidenceCount)}</span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm text-slate-600">{item.rule}</p>
                    {item.affected?.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {item.affected.slice(0, 4).map((label) => (
                          <span key={label} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{label}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderActiveTab = () => {
    if (loading) {
      return (
        <div className="flex min-h-[28rem] items-center justify-center rounded-lg border border-slate-200 bg-white">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      );
    }
    if (error) {
      return (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      );
    }
    switch (activeTab) {
    case 'demand': return renderDemand();
    case 'team': return renderTeam();
    case 'quality': return renderQuality();
    case 'ops': return renderOps();
    case 'insights': return renderInsights();
    default: return renderOverview();
    }
  };

  return (
    <AppShell
      activePage="analytics"
      contentClassName="max-w-7xl mx-auto w-full px-2 py-3 sm:px-4 sm:py-4"
      extraActions={
        <button
          type="button"
          onClick={fetchAnalytics}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          title="Refresh analytics"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      }
    >
      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-slate-900 sm:text-xl">Analytics and Insights</h1>
            <p className="mt-1 break-words text-xs text-slate-500 sm:text-sm">
              {meta ? `${meta.range.start} to ${meta.range.end} ${meta.range.timezone}` : 'Deterministic analytics from local Ticket Pulse data'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <Filter className="hidden h-4 w-4 text-slate-400 sm:block" />
            <select value={range} onChange={(e) => setRange(e.target.value)} className="h-9 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-sm sm:w-auto">
              {RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {range === 'custom' && (
              <>
                <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="h-9 w-full min-w-0 rounded-lg border border-slate-300 px-2 text-sm sm:w-auto" />
                <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="h-9 w-full min-w-0 rounded-lg border border-slate-300 px-2 text-sm sm:w-auto" />
              </>
            )}
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="h-9 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-sm sm:w-auto">
              {GROUP_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select value={compare} onChange={(e) => setCompare(e.target.value)} className="h-9 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-sm sm:w-auto">
              <option value="previous">Compare previous</option>
              <option value="none">No comparison</option>
            </select>
            <label className="inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-lg border border-slate-300 px-2 text-sm text-slate-700 sm:justify-start">
              <input
                type="checkbox"
                checked={excludeNoise}
                onChange={(e) => {
                  setExcludeNoise(e.target.checked);
                  setGlobalExcludeNoise(e.target.checked);
                }}
              />
              Exclude noise
            </label>
            <button
              type="button"
              onClick={() => exportAnalyticsWorkbook(payload, activeTab)}
              disabled={loading || error}
              className="col-span-2 inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 sm:col-span-1"
            >
              <Download className="h-4 w-4" />
              Export
            </button>
          </div>
        </div>

        <div className="-mx-3 mt-4 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
          {TABS.map(({ id, label, Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`inline-flex h-9 flex-none items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${
                  isActive
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {renderActiveTab()}

      {meta?.caveats?.length > 0 && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-500 shadow-sm">
          <p className="mb-2 font-semibold text-slate-700">Data caveats</p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {meta.caveats.map((caveat) => <li key={caveat}>• {caveat}</li>)}
          </ul>
        </div>
      )}
    </AppShell>
  );
}
