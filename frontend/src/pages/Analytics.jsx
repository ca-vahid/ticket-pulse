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
  Tags,
  Users,
  XCircle,
} from 'lucide-react';
import Highcharts from 'highcharts';
import 'highcharts/highcharts-more';
import 'highcharts/modules/treemap';
import 'highcharts/modules/heatmap';
import 'highcharts/modules/sankey';
import 'highcharts/modules/accessibility';
import HighchartsReact from 'highcharts-react-official';
import * as XLSX from 'xlsx';
import AppShell from '../components/AppShell';
import CategoryFilter from '../components/CategoryFilter';
import CanonicalCategoryFilter from '../components/CanonicalCategoryFilter';
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
  { id: 'categories', label: 'Categories', Icon: Tags },
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
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return {
    chart: { type, backgroundColor: 'transparent', spacing: [8, 8, 8, 8], animation: !reducedMotion },
    title: { text: null },
    credits: { enabled: false },
    accessibility: { enabled: true },
    plotOptions: {
      series: {
        animation: !reducedMotion,
      },
    },
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
      { key: 'availableDays', label: 'Available', render: (row) => formatNumber(row.availableDays || 0) },
      { key: 'assignedPerAvailableDay', label: 'Per Avail. Day', render: (row) => row.assignedPerAvailableDay ?? '—' },
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
  case 'category-slow-resolution':
  case 'category-review-needed':
  case 'category-unmapped-drift':
  case 'category-automation-mismatch':
    return [
      { key: 'name', label: 'Category' },
      { key: 'created', label: 'Created', render: (row) => formatNumber(row.created ?? row.count ?? 0) },
      { key: 'open', label: 'Open', render: (row) => formatNumber(row.open || 0) },
      { key: 'p90ResolutionHours', label: 'P90 Res.', render: (row) => row.p90ResolutionHours === null || row.p90ResolutionHours === undefined ? '—' : `${row.p90ResolutionHours}h` },
      { key: 'automationFailureRatePct', label: 'Auto Fail', render: (row) => row.automationFailureRatePct === undefined ? '—' : `${row.automationFailureRatePct}%` },
      { key: 'reviewNeeded', label: 'Review', render: (row) => formatNumber(row.reviewNeeded || 0) },
    ];
  case 'category-rising':
    return [
      { key: 'freshserviceTicketId', label: 'Ticket' },
      { key: 'subject', label: 'Subject' },
      { key: 'status', label: 'Status', render: (row) => row.status || '—' },
      { key: 'assignedTechName', label: 'Owner', render: (row) => row.assignedTechName || 'Unassigned' },
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
  const options = {
    ...chartBase('bar'),
    colors: ['#2563eb'],
    xAxis: {
      categories: data.map((row) => row[nameKey]),
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
    tooltip: { borderColor: '#cbd5e1', pointFormat: '<b>{point.y}</b>' },
    plotOptions: {
      ...chartBase('bar').plotOptions,
      bar: { borderRadius: 5 },
    },
    series: [{ name: 'Count', data: data.map((row) => row[valueKey] || 0) }],
  };
  return (
    <HighchartsBlock options={options} height={`${height}px`} />
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
                {row.source === 'legacyFallback' && (
                  <span className="shrink-0 rounded bg-amber-50 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-amber-700">
                    Legacy
                  </span>
                )}
                {row.reviewNeededCount > 0 && (
                  <span className="shrink-0 rounded bg-orange-50 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-orange-700">
                    Review
                  </span>
                )}
                {row.source === 'unmapped' && (
                  <span className="shrink-0 rounded bg-slate-100 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-slate-500">
                    Unmapped
                  </span>
                )}
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
  addSheet('Category Summary', payload.categories?.rows || []);
  addSheet('Category Trend', payload.categories?.trend || []);
  addSheet('Category Flow', payload.categories?.assignmentFlow || []);
  addSheet('Category Pressure', payload.categories?.pressure || []);
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
  const [showTeamPicker, setShowTeamPicker] = useState(false);
  const [showAgentDetails, setShowAgentDetails] = useState(false);
  const [selectedInsightId, setSelectedInsightId] = useState(null);
  const [selectedCategoryKey, setSelectedCategoryKey] = useState(null);
  const [hoveredCategory, setHoveredCategory] = useState(null);
  const [categoryMetadata, setCategoryMetadata] = useState(null);
  const [selectedLegacyCategories, setSelectedLegacyCategories] = useState([]);
  const [selectedCanonicalCategories, setSelectedCanonicalCategories] = useState({ categoryIds: [], subcategoryIds: [] });
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
    const categoryMode = categoryMetadata?.categoryMode || (Number(currentWorkspace?.id) === 1 || currentWorkspace?.slug === 'it' ? 'canonical' : 'legacy');
    if (categoryMode === 'canonical') {
      if (selectedCanonicalCategories.categoryIds?.length) p.categoryIds = selectedCanonicalCategories.categoryIds.join(',');
      if (selectedCanonicalCategories.subcategoryIds?.length) p.subcategoryIds = selectedCanonicalCategories.subcategoryIds.join(',');
    } else if (selectedLegacyCategories.length) {
      p.legacyCategories = selectedLegacyCategories.join(',');
    }
    return p;
  }, [categoryMetadata?.categoryMode, compare, currentWorkspace?.defaultTimezone, currentWorkspace?.id, currentWorkspace?.slug, customEnd, customStart, excludeNoise, groupBy, range, selectedCanonicalCategories.categoryIds, selectedCanonicalCategories.subcategoryIds, selectedLegacyCategories]);

  const fetchAnalytics = useCallback(async () => {
    if (range === 'custom' && (!customStart || !customEnd)) return;
    setLoading(true);
    setError(null);
    try {
      const [overview, demand, categoryIntelligence, team, quality, ops, insights] = await Promise.all([
        analyticsAPI.getOverview(params),
        analyticsAPI.getDemandFlow(params),
        analyticsAPI.getCategoryIntelligence(params),
        analyticsAPI.getTeamBalance(params),
        analyticsAPI.getQuality(params),
        analyticsAPI.getAutomationOps(params),
        analyticsAPI.getInsights(params),
      ]);
      setPayload({
        overview: overview.data,
        demand: demand.data,
        categories: categoryIntelligence.data,
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

  useEffect(() => {
    let cancelled = false;
    analyticsAPI.getCategories()
      .then((res) => {
        if (!cancelled) setCategoryMetadata(res?.data || res || null);
      })
      .catch(() => {
        if (!cancelled) setCategoryMetadata(null);
      });
    return () => { cancelled = true; };
  }, [currentWorkspace?.id]);

  useEffect(() => {
    const categoryRows = payload.categories?.rows || [];
    if (!categoryRows.length) {
      setSelectedCategoryKey(null);
      return;
    }
    if (!selectedCategoryKey || !categoryRows.some((row) => row.key === selectedCategoryKey)) {
      setSelectedCategoryKey(categoryRows[0].key);
    }
  }, [payload.categories?.rows, selectedCategoryKey]);

  const meta = payload.overview?.metadata || payload.demand?.metadata;
  const overview = payload.overview;
  const demand = payload.demand;
  const categories = payload.categories;
  const categoryMode = categories?.metadata?.categoryMode || categoryMetadata?.categoryMode;
  const legacyMode = categoryMode === 'legacy';
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

  const teamPickerRows = useMemo(() => {
    let rows = [...(team?.technicians || [])];
    const q = teamSearch.trim().toLowerCase();
    if (q) {
      rows = rows.filter((row) => row.name?.toLowerCase().includes(q) || row.email?.toLowerCase().includes(q));
    }
    if (teamFilter === 'onLeave') rows = rows.filter((row) => (row.leaveDays || 0) > 0);
    if (teamFilter === 'highOpen') rows = rows.filter((row) => (row.openNow || 0) >= 20);
    if (teamFilter === 'highRejected') rows = rows.filter((row) => (row.rejected || 0) > 0);
    return rows.sort((a, b) => (b.openNow || 0) - (a.openNow || 0) || (b.assigned || 0) - (a.assigned || 0) || a.name.localeCompare(b.name));
  }, [team?.technicians, teamFilter, teamSearch]);

  const selectedTeamRows = useMemo(() => {
    const selected = new Set(selectedTeamIds);
    return (team?.technicians || [])
      .filter((row) => selected.has(row.technicianId))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedTeamIds, team?.technicians]);

  const setTeamSortKey = (key) => {
    setTeamSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }));
  };

  const focusTopAgents = useCallback((key) => {
    const ids = [...(team?.technicians || [])]
      .sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0) || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map((row) => row.technicianId);
    setSelectedTeamIds(ids);
  }, [team?.technicians]);

  const toggleTeamSelection = useCallback((technicianId) => {
    setSelectedTeamIds((current) => (
      current.includes(technicianId)
        ? current.filter((id) => id !== technicianId)
        : [...current, technicianId]
    ));
  }, []);

  const selectedCategory = useMemo(() => (
    categories?.rows?.find((row) => row.key === selectedCategoryKey)
    || categories?.rows?.find((row) => row.categoryKey === selectedCategoryKey)
    || categories?.rows?.[0]
    || null
  ), [categories?.rows, selectedCategoryKey]);

  const selectedHierarchyCategory = useMemo(() => (
    categories?.hierarchy?.find((node) => node.custom?.key === selectedCategoryKey)?.custom || null
  ), [categories?.hierarchy, selectedCategoryKey]);

  const mapFocusCategory = hoveredCategory || selectedHierarchyCategory || selectedCategory;

  const categoryHierarchyOptions = useMemo(() => {
    const rows = categories?.hierarchy || [];
    return {
      ...chartBase('treemap'),
      colorAxis: {
        min: 0,
        stops: [
          [0, '#dbeafe'],
          [0.22, '#d1fae5'],
          [0.48, '#fef9c3'],
          [0.74, '#fed7aa'],
          [1, '#fecaca'],
        ],
      },
      accessibility: {
        enabled: true,
        description: 'Category hierarchy treemap. Larger blocks mean more created tickets. Warmer colors mean more open, overdue, review-needed, or automation-failure pressure.',
      },
      tooltip: { enabled: false },
      breadcrumbs: {
        showFullPath: true,
        format: '{level.name}',
        buttonTheme: {
          fill: 'none',
          padding: 2,
          'stroke-width': 0,
          style: {
            color: '#2563eb',
            fontSize: '12px',
            fontWeight: '700',
          },
          states: {
            hover: { fill: '#eff6ff' },
            select: { fill: 'none', style: { color: '#0f172a', fontWeight: '800' } },
          },
        },
        separator: { text: '/', style: { color: '#64748b', fontSize: '13px' } },
      },
      plotOptions: {
        ...chartBase('treemap').plotOptions,
        treemap: {
          allowTraversingTree: true,
          interactByLeaf: true,
          layoutAlgorithm: 'squarified',
          borderRadius: 3,
          borderWidth: 2,
          borderColor: '#64748b',
          states: {
            hover: {
              brightness: 0,
              borderColor: '#1d4ed8',
              borderWidth: 3,
              opacity: 1,
              halo: false,
              shadow: false,
            },
            inactive: { opacity: 1 },
          },
          dataLabels: {
            enabled: true,
            useHTML: true,
            allowOverlap: false,
            crop: true,
            overflow: 'justify',
            formatter() {
              const shape = this.point.shapeArgs || {};
              const rootNode = this.series.rootNode || '';
              if (rootNode !== 'root' && this.point.id === rootNode) return '';
              const isParent = this.point.node?.children?.length > 0;
              if (isParent && rootNode !== '') return '';
              if (shape.width < 42 || shape.height < 20) return '';
              const rawName = this.point.name || '';
              const lineHeight = isParent ? 11 : 10;
              const maxChars = Math.max(8, Math.floor((shape.width || 80) / 5.2) * Math.max(1, Math.floor((shape.height || 24) / (lineHeight + 3))));
              const name = rawName.length > maxChars ? `${rawName.slice(0, Math.max(5, maxChars - 1))}...` : rawName;
              const created = this.point.custom?.created ?? this.point.value;
              const nameStyle = isParent ? 'font-size:11px;font-weight:800;line-height:13px' : '';
              return shape.height >= 44 && created
                ? `<span style="${nameStyle}">${name}</span><br/><span style="font-size:8px;font-weight:600">${formatNumber(created)} created</span>`
                : `<span style="${nameStyle}">${name}</span>`;
            },
            style: {
              color: '#0f172a',
              fontSize: '8px',
              fontWeight: '700',
              lineHeight: '10px',
              textOutline: '1px contrast',
              textOverflow: 'ellipsis',
            },
          },
          levels: [{
            level: 1,
            borderWidth: 4,
            borderColor: '#334155',
            groupPadding: 3,
            dataLabels: {
              enabled: true,
              headers: true,
              align: 'left',
              verticalAlign: 'top',
              padding: 5,
              style: {
                fontSize: '10px',
                fontWeight: '800',
                color: '#0f172a',
                lineHeight: '12px',
                textOutline: 'none',
              },
            },
          }, {
            level: 2,
            borderWidth: 1.5,
            borderColor: '#94a3b8',
          }],
          point: {
            events: {
              mouseOver() {
                if (this.custom?.key) {
                  setHoveredCategory({
                    ...this.custom,
                    name: this.name || this.custom.name,
                    created: this.value ?? this.custom.created ?? 0,
                  });
                }
              },
              mouseOut() {
                setHoveredCategory(null);
              },
              click() {
                if (this.custom?.key) setSelectedCategoryKey(this.custom.key);
              },
            },
          },
        },
      },
      series: [{
        type: 'treemap',
        name: legacyMode ? 'Legacy categories' : 'All categories',
        data: rows,
      }],
    };
  }, [categories?.hierarchy, legacyMode]);

  const categoryTrendOptions = useMemo(() => {
    const rows = categories?.trend || [];
    const periods = Array.from(new Set(rows.map((row) => row.period))).sort((a, b) => a.localeCompare(b));
    const names = Array.from(new Set(rows.map((row) => row.name))).slice(0, 8);
    const data = rows
      .filter((row) => names.includes(row.name))
      .map((row) => [periods.indexOf(row.period), names.indexOf(row.name), row.count || 0]);
    return {
      ...chartBase('heatmap'),
      accessibility: {
        enabled: true,
        description: 'Category demand heatmap. Darker cells show more created tickets for a category during a period.',
      },
      colorAxis: {
        min: 0,
        minColor: '#eff6ff',
        maxColor: '#2563eb',
      },
      xAxis: {
        categories: periods,
        labels: { style: { color: '#64748b', fontSize: '11px' } },
      },
      yAxis: {
        categories: names,
        title: { text: null },
        reversed: true,
        labels: { style: { color: '#475569', fontSize: '11px' } },
      },
      legend: { align: 'right', layout: 'vertical', verticalAlign: 'middle' },
      tooltip: {
        borderColor: '#cbd5e1',
        formatter() {
          return `<b>${names[this.point.y]}</b><br/>${periods[this.point.x]}: <b>${formatNumber(this.point.value)}</b> created tickets`;
        },
      },
      series: [{
        type: 'heatmap',
        name: 'Created tickets',
        borderWidth: 1,
        borderColor: '#ffffff',
        data,
        dataLabels: { enabled: periods.length <= 12 && names.length <= 8, color: '#0f172a', style: { textOutline: 'none', fontSize: '10px' } },
      }],
    };
  }, [categories?.trend]);

  const categoryPressureOptions = useMemo(() => ({
    ...chartBase('bubble'),
    accessibility: {
      enabled: true,
      description: 'Category pressure bubble chart. X axis is created tickets, Y axis is p90 resolution hours, and bubble size is current open backlog.',
    },
    xAxis: {
      min: 0,
      title: { text: 'Created tickets' },
      gridLineDashStyle: 'Dash',
      gridLineColor: '#e2e8f0',
    },
    yAxis: {
      min: 0,
      title: { text: 'P90 resolution hours' },
      gridLineDashStyle: 'Dash',
      gridLineColor: '#e2e8f0',
    },
    legend: { enabled: false },
    tooltip: {
      useHTML: true,
      borderColor: '#cbd5e1',
      pointFormatter() {
        return `<b>${this.name}</b><br/>${formatNumber(this.x)} created<br/>${this.y || 0}h p90 resolution<br/>${formatNumber(this.z)} open tickets<br/>${formatNumber(this.reviewNeeded || 0)} review-needed`;
      },
    },
    plotOptions: {
      ...chartBase('bubble').plotOptions,
      bubble: {
        minSize: 10,
        maxSize: 56,
        color: '#2563eb',
        marker: { fillOpacity: 0.55, lineColor: '#1d4ed8', lineWidth: 1 },
        point: {
          events: {
            click() {
              if (this.key) setSelectedCategoryKey(this.key);
            },
          },
        },
      },
    },
    series: [{
      name: 'Category pressure',
      data: (categories?.pressure || []).map((row) => ({
        ...row,
        color: row.overdue > 0 || row.automationFailureRatePct >= 20 ? '#dc2626' : row.reviewNeeded > 0 ? '#f59e0b' : '#2563eb',
      })),
    }],
  }), [categories?.pressure]);

  const categorySankeyOptions = useMemo(() => ({
    ...chartBase('sankey'),
    accessibility: {
      enabled: true,
      description: 'Assignment path flow from assignment source, through category, to automation outcome.',
    },
    tooltip: {
      borderColor: '#cbd5e1',
      pointFormat: '<b>{point.fromNode.name}</b> → <b>{point.toNode.name}</b>: {point.weight}',
    },
    plotOptions: {
      ...chartBase('sankey').plotOptions,
      sankey: {
        nodeWidth: 18,
        nodePadding: 10,
        dataLabels: { style: { color: '#334155', fontSize: '11px', textOutline: 'none' } },
      },
    },
    series: [{
      type: 'sankey',
      name: 'Assignment path',
      data: (categories?.assignmentFlow || []).map((row) => [row.from, row.to, row.weight]),
    }],
  }), [categories?.assignmentFlow]);

  const assignmentMixOptions = useMemo(() => {
    const rows = buildAssignmentMixRows(overview?.assignmentMix);
    return {
      ...chartBase('pie'),
      chart: {
        ...chartBase('pie').chart,
        spacing: [0, 0, 0, 0],
        margin: [0, 0, 0, 0],
      },
      colors: rows.map((row) => row.color),
      accessibility: {
        enabled: true,
        description: 'Assignment source mix for tickets assigned in the selected range.',
      },
      tooltip: {
        useHTML: true,
        borderColor: '#cbd5e1',
        pointFormatter() {
          return `<b>${this.name}</b><br/>${formatNumber(this.y)} tickets · ${this.percentage.toFixed(1)}%`;
        },
      },
      plotOptions: {
        ...chartBase('pie').plotOptions,
        pie: {
          size: '86%',
          innerSize: '58%',
          center: ['50%', '50%'],
          borderWidth: 2,
          dataLabels: {
            enabled: false,
          },
        },
      },
      series: [{
        name: 'Assignment mix',
        data: rows.map((row) => ({ name: row.label, y: row.value, custom: row })),
      }],
    };
  }, [overview?.assignmentMix]);

  const demandTrendOptions = useMemo(() => {
    const rows = demand?.trend || [];
    return {
      ...chartBase('area'),
      accessibility: {
        enabled: true,
        description: 'Created, closed or resolved, and net ticket flow over the selected range.',
      },
      xAxis: {
        categories: rows.map((row) => row.date),
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
        ...chartBase('area').plotOptions,
        area: { fillOpacity: 0.18, marker: { enabled: rows.length <= 45, radius: 3 } },
        line: { marker: { enabled: rows.length <= 45, radius: 3 }, lineWidth: 2 },
      },
      series: [
        { type: 'area', name: 'Created', data: rows.map((row) => row.created || 0), color: '#2563eb' },
        { type: 'area', name: 'Closed / Resolved', data: rows.map((row) => row.resolved || 0), color: '#059669' },
        { type: 'line', name: 'Net', data: rows.map((row) => row.net || 0), color: '#f59e0b' },
      ],
    };
  }, [demand?.trend]);

  const teamTimelineMetricLabel = TEAM_TIMELINE_METRICS.find((metric) => metric.key === teamTimelineMetric)?.label || 'Tickets';

  const workloadChartOptions = useMemo(() => ({
    chart: { type: 'bar', backgroundColor: 'transparent', spacing: [8, 8, 8, 8] },
    title: { text: null },
    credits: { enabled: false },
    accessibility: { enabled: true },
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
    accessibility: { enabled: true },
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
      accessibility: { enabled: true },
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
          <div className="grid gap-4 xl:grid-cols-[minmax(22rem,1fr)_minmax(18rem,24rem)]">
            <div className="relative h-72 min-w-0 sm:h-80">
              <HighchartsBlock options={assignmentMixOptions} height="100%" />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <p className="text-xl font-bold text-slate-900 sm:text-2xl">
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
            <StatCard title="Classified" value={formatNumber(overview?.dataQuality?.canonicalClassifiedCount || 0)} subtitle="Canonical category/subcategory" icon={CheckCircle2} tone="green" />
            <StatCard title="Legacy Fallback" value={formatNumber(overview?.dataQuality?.legacyFallbackCount || 0)} subtitle="Using mirrored or legacy fields" icon={Info} tone="amber" />
            <StatCard title="Review Needed" value={formatNumber(overview?.dataQuality?.categoryReviewNeededCount || 0)} subtitle="Weak or flagged category fit" icon={AlertTriangle} tone="amber" />
            <StatCard title="Unclassified" value={formatNumber(overview?.dataQuality?.unclassifiedCount || 0)} subtitle="No usable category value" icon={XCircle} tone="red" />
          </div>
          <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            First-response analytics are hidden until the source field is populated enough to avoid misleading zero-value charts.
          </p>
        </Panel>
      </div>
    </div>
  );

  const renderDemand = () => (
    <div className="space-y-4">
      <Panel title="Created vs Closed / Resolved" subtitle="Resolved count uses tickets assigned in the same period because historical closedAt/resolvedAt coverage is sparse.">
        <div className="h-64 sm:h-80">
          <HighchartsBlock options={demandTrendOptions} height="100%" />
        </div>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
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

  const renderCategories = () => {
    const selectedRows = selectedCategory?.recentTickets || [];
    const mapFocusType = mapFocusCategory?.nodeType === 'category'
      ? 'Top category'
      : mapFocusCategory?.subcategoryName
        ? 'Subcategory'
        : 'Category';
    const mapFocusAutoFailureRate = mapFocusCategory?.automationRuns
      ? (mapFocusCategory.automationFailureRatePct ?? Math.round(((mapFocusCategory.automationFailures || 0) / mapFocusCategory.automationRuns) * 100))
      : 0;

    return (
      <div className="space-y-4">
        {legacyMode && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            This workspace is still using legacy Freshservice category values. Subcategory hierarchy and canonical coverage metrics stay hidden until this workspace is migrated.
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard title="Created Demand" value={formatNumber(categories?.summary?.totalCreated)} subtitle="Tickets created in range" icon={Tags} />
          <StatCard title="Open in Categories" value={formatNumber(categories?.summary?.open)} subtitle={`${formatNumber(categories?.summary?.overdue || 0)} overdue`} icon={Clock} tone={(categories?.summary?.overdue || 0) > 0 ? 'amber' : 'green'} />
          <StatCard title="Review Needed" value={formatNumber(categories?.summary?.reviewNeeded)} subtitle="Taxonomy fit or migration review" icon={AlertTriangle} tone={(categories?.summary?.reviewNeeded || 0) > 0 ? 'amber' : 'green'} />
          <StatCard title="Automation Failures" value={formatNumber(categories?.summary?.automationFailures)} subtitle={`${formatNumber(categories?.summary?.automationRuns || 0)} category-linked runs`} icon={RefreshCw} tone={(categories?.summary?.automationFailures || 0) > 0 ? 'red' : 'green'} />
        </div>

        <Panel
          title={legacyMode ? 'Legacy Category Map' : 'Category / Subcategory Map'}
          subtitle="Size shows created demand. Color shows pressure from open backlog, overdue tickets, review-needed flags, and automation failures."
        >
          {mapFocusCategory && (
            <div className="mb-3 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900">{mapFocusCategory.name}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {hoveredCategory ? 'Hover focus' : 'Selected focus'} · {mapFocusType}
                  </p>
                </div>
                <div className="grid grid-cols-4 gap-2 text-center text-xs sm:grid-cols-6 lg:min-w-[32rem]">
                  {[
                    ['Created', formatNumber(mapFocusCategory.created)],
                    ['Open', formatNumber(mapFocusCategory.open || 0)],
                    ['Overdue', formatNumber(mapFocusCategory.overdue || 0)],
                    ['Review', formatNumber(mapFocusCategory.reviewNeeded || 0)],
                    ['Auto fail', `${mapFocusAutoFailureRate}%`],
                    ['Rebounds', formatNumber(mapFocusCategory.automationRebounds || 0)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-md bg-slate-50 px-2 py-1 ring-1 ring-slate-200">
                      <p className="font-bold text-slate-900">{value}</p>
                      <p className="text-[10px] font-semibold uppercase tracking-normal text-slate-500">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {(categories?.hierarchy || []).length > 0
            ? <HighchartsBlock options={categoryHierarchyOptions} height={isMobile ? '24rem' : '38rem'} />
            : <EmptyState />}
          {selectedCategory && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-900">{selectedCategory.name}</p>
                  <p className="mt-0.5 text-xs text-slate-500">Selected category from the map or pressure chart</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 xl:grid-cols-8">
                  {[
                    ['Created', formatNumber(selectedCategory.created)],
                    ['Open', formatNumber(selectedCategory.open)],
                    ['Overdue', formatNumber(selectedCategory.overdue)],
                    ['P90', selectedCategory.p90ResolutionHours === null ? '—' : `${selectedCategory.p90ResolutionHours}h`],
                    ['CSAT', selectedCategory.csatAverage === null ? '—' : `${selectedCategory.csatAverage} (${selectedCategory.csatResponses})`],
                    ['Review', formatNumber(selectedCategory.reviewNeeded)],
                    ['Auto fail', `${selectedCategory.automationFailureRatePct}%`],
                    ['Rebounds', formatNumber(selectedCategory.automationRebounds)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-md bg-white px-2 py-1.5 text-center shadow-sm ring-1 ring-slate-200">
                      <p className="font-bold text-slate-900">{value}</p>
                      <p className="text-[10px] font-semibold uppercase tracking-normal text-slate-500">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Panel>

        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Demand Heatmap" subtitle="Top category/subcategory paths by selected time resolution.">
            {(categories?.trend || []).length ? <HighchartsBlock options={categoryTrendOptions} height={isMobile ? '20rem' : '24rem'} /> : <EmptyState />}
          </Panel>
          <Panel title="Pressure Map" subtitle="Created demand vs. resolution tail; bubble size is current open backlog.">
            {(categories?.pressure || []).length ? <HighchartsBlock options={categoryPressureOptions} height={isMobile ? '20rem' : '24rem'} /> : <EmptyState />}
          </Panel>
        </div>

        <Panel title="Assignment Path" subtitle="Flow from assignment source through category into automation outcome. Technician names are intentionally omitted.">
          {(categories?.assignmentFlow || []).length ? <HighchartsBlock options={categorySankeyOptions} height={isMobile ? '20rem' : '26rem'} /> : <EmptyState />}
        </Panel>

        <Panel title="Category Drilldown" subtitle="Click a row to focus the charts and selected-category panel.">
          <SimpleTable
            rows={categories?.rows || []}
            maxHeight="max-h-[30rem]"
            columns={[
              {
                key: 'name',
                label: 'Category',
                render: (row) => (
                  <button
                    type="button"
                    onClick={() => setSelectedCategoryKey(row.key)}
                    className={`text-left font-semibold ${selectedCategory?.key === row.key ? 'text-blue-700' : 'text-slate-800 hover:text-blue-700'}`}
                  >
                    {row.name}
                  </button>
                ),
              },
              { key: 'created', label: 'Created', render: (row) => formatNumber(row.created) },
              { key: 'open', label: 'Open', render: (row) => formatNumber(row.open) },
              { key: 'overdue', label: 'Overdue', render: (row) => formatNumber(row.overdue) },
              { key: 'p90ResolutionHours', label: 'P90 Res.', render: (row) => row.p90ResolutionHours === null ? '—' : `${row.p90ResolutionHours}h (${row.resolutionSample})` },
              { key: 'csatAverage', label: 'CSAT', render: (row) => row.csatAverage === null ? '—' : `${row.csatAverage} (${row.csatResponses})` },
              { key: 'automationFailureRatePct', label: 'Auto Fail', render: (row) => `${row.automationFailureRatePct}%` },
              { key: 'reviewNeeded', label: 'Review', render: (row) => formatNumber(row.reviewNeeded) },
            ]}
          />
        </Panel>

        <Panel title="Recent Tickets in Selected Category">
          <SimpleTable
            rows={selectedRows}
            columns={[
              { key: 'freshserviceTicketId', label: 'Ticket' },
              { key: 'subject', label: 'Subject' },
              { key: 'status', label: 'Status' },
              { key: 'assignedTechName', label: 'Owner', render: (row) => row.assignedTechName || 'Unassigned' },
              { key: 'requesterName', label: 'Requester', render: (row) => row.requesterName || row.requesterEmail || 'Unknown' },
              { key: 'createdAt', label: 'Created', render: (row) => formatDateTime(row.createdAt) },
            ]}
          />
        </Panel>
      </div>
    );
  };

  const renderTeam = () => (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Balance Score" value={formatNumber(team?.summary?.balanceScore)} subtitle="Adjusted for leave days" icon={Gauge} tone="green" />
        <StatCard title="Avg Assigned" value={formatNumber(team?.summary?.avgAssignedPerTech)} subtitle="Per active technician" icon={Users} />
        <StatCard title="Avg / Available Day" value={formatNumber(team?.summary?.avgAssignedPerAvailableDay)} subtitle={`${formatNumber(team?.summary?.rangeBusinessDays || 0)} weekdays in range`} icon={BarChart3} tone="amber" />
        <StatCard title="Open > 24h" value={formatNumber((team?.summary?.openAgeBuckets?.over24h || 0))} subtitle="Current open queue" icon={Clock} tone="red" />
      </div>
      {(team?.summary?.excludedFromDistribution || 0) > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {formatNumber(team.summary.excludedFromDistribution)} range ticket{team.summary.excludedFromDistribution === 1 ? '' : 's'} are excluded from the active-team distribution because they are unassigned or assigned outside the visible active team.
        </div>
      )}
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
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-900">Agent focus</p>
                <p className="text-xs text-slate-500">
                  {selectedTeamIds.length
                    ? `${selectedTeamIds.length} focused agent${selectedTeamIds.length === 1 ? '' : 's'} driving the charts and table.`
                    : `${formatNumber(teamPickerRows.length)} matching active agents included.`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => focusTopAgents('openNow')}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Top open
                </button>
                <button
                  type="button"
                  onClick={() => focusTopAgents('assignedPerAvailableDay')}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Top load rate
                </button>
                <button
                  type="button"
                  onClick={() => setShowTeamPicker((value) => !value)}
                  className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-blue-100"
                >
                  {showTeamPicker ? 'Hide selector' : 'Choose agents'}
                </button>
              </div>
            </div>

            {selectedTeamRows.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {selectedTeamRows.map((row) => (
                  <button
                    key={row.technicianId}
                    type="button"
                    onClick={() => toggleTeamSelection(row.technicianId)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-700 shadow-sm hover:bg-blue-50"
                    title={`Remove ${row.name} from focused agents`}
                  >
                    {row.name}
                    <span className="text-blue-400">x</span>
                  </button>
                ))}
              </div>
            )}

            {showTeamPicker && (
              <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {teamPickerRows.map((row) => {
                  const selected = selectedTeamIds.includes(row.technicianId);
                  return (
                    <button
                      key={row.technicianId}
                      type="button"
                      onClick={() => toggleTeamSelection(row.technicianId)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        selected
                          ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-100'
                          : 'border-slate-200 bg-white hover:border-blue-200 hover:bg-white'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-slate-900">{row.name}</p>
                          <p className="mt-0.5 text-xs text-slate-500">{row.assigned} assigned · {row.openNow} open</p>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          row.openNow >= 30 ? 'bg-red-50 text-red-700'
                            : row.openNow >= 15 ? 'bg-amber-50 text-amber-700'
                              : 'bg-emerald-50 text-emerald-700'
                        }`}>
                          {row.openNow >= 30 ? 'High' : row.openNow >= 15 ? 'Watch' : 'OK'}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-1 text-center text-[11px]">
                        <div className="rounded bg-slate-100 px-1.5 py-1">
                          <p className="font-bold text-slate-900">{row.assignedPerAvailableDay ?? '—'}</p>
                          <p className="text-slate-500">rate</p>
                        </div>
                        <div className="rounded bg-slate-100 px-1.5 py-1">
                          <p className="font-bold text-slate-900">{row.rejected}</p>
                          <p className="text-slate-500">reject</p>
                        </div>
                        <div className="rounded bg-slate-100 px-1.5 py-1">
                          <p className="font-bold text-slate-900">{row.leaveDays}</p>
                          <p className="text-slate-500">leave</p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Agent focus changes every chart and table below. Chart bars and lines can still be clicked to add or remove a technician.
          </p>
        </div>
      </Panel>

      <Panel
        title="Timeline by Agent"
        subtitle={`${teamTimelineMetricLabel} over the selected date range. Use Agent focus above to compare specific technicians.`}
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
                  <p className="text-xs text-slate-500">{row.availableDays} available days · {row.assignedPerAvailableDay ?? '—'} / available day</p>
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
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-slate-500">Avail.</p>
                  <p className="font-bold text-slate-900">{row.availableDays}</p>
                </div>
                <div className="rounded bg-slate-50 p-2">
                  <p className="text-slate-500">Rate</p>
                  <p className="font-bold text-slate-900">{row.assignedPerAvailableDay ?? '—'}</p>
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
                  ['availableDays', 'Available Days'],
                  ['assignedPerAvailableDay', 'Assigned / Avail. Day'],
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
                  <td className="px-3 py-2 text-slate-700">{row.availableDays}</td>
                  <td className="px-3 py-2 text-slate-700">{row.assignedPerAvailableDay ?? '—'}</td>
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

      <Panel
        title="Focused Agent Detail"
        subtitle="Optional coaching context. Hidden by default so Team Balance stays a comparison surface, not a leaderboard."
        actions={(
          <button
            type="button"
            onClick={() => setShowAgentDetails((value) => !value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            {showAgentDetails ? 'Hide details' : 'Show details'}
          </button>
        )}
      >
        {showAgentDetails ? (
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
                  <p><span className="font-semibold text-slate-800">Available:</span> {row.availableDays} days, {row.assignedPerAvailableDay ?? '—'} assigned / available day</p>
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
        ) : (
          <EmptyState text="Open focused detail only when coaching context is needed." />
        )}
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
    case 'categories': return renderCategories();
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
            {(categoryMetadata?.categoryMode || (Number(currentWorkspace?.id) === 1 || currentWorkspace?.slug === 'it' ? 'canonical' : 'legacy')) === 'canonical' ? (
              <div className="col-span-2 sm:col-span-1">
                <CanonicalCategoryFilter
                  categoryTree={categoryMetadata?.categoryTree || []}
                  selectedCategoryIds={selectedCanonicalCategories.categoryIds || []}
                  selectedSubcategoryIds={selectedCanonicalCategories.subcategoryIds || []}
                  onChange={setSelectedCanonicalCategories}
                />
              </div>
            ) : (
              <div className="col-span-2 sm:col-span-1">
                <CategoryFilter
                  categories={categoryMetadata?.legacyCategories || []}
                  selected={selectedLegacyCategories}
                  onChange={setSelectedLegacyCategories}
                  placeholder="Category"
                  className="w-full"
                />
              </div>
            )}
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
