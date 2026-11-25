import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { analyticsAPI } from '../../services/api';
import { chartPalette } from '../../utils/highchartsTheme';
import { motionReduced } from '../../utils/motionPreference';
import { DEFAULT_DEPARTMENT_MAP, useDepartmentMap } from '../../utils/requesterDepartment';

/**
 * Analytics → Demand: "Tickets by department" (QA 11-24, item 2).
 *
 * Deterministic counts from GET /analytics/tickets-by-department — no AI text,
 * no people: tickets CREATED in the page's range (same range, noise switch and
 * category filter as the rest of the page), grouped by the requester's
 * department (Entra job class without its level, through the department table)
 * or, with the switch, by city. A horizontal bar chart of the biggest groups
 * and a table of all of them with count and share. "Unknown" (no department on
 * the requester) is always listed last.
 *
 * Props
 *   params      the page's analytics query
 *   ChartBlock  the page's Highcharts wrapper ({ options, height }); without it only the table renders
 *   isMobile    fewer bars
 *   palette     the page's theme-resolved chart palette (falls back to the current theme's)
 *   data        optional ready payload (tests, screenshots); skips the fetch
 */

const fmt = (value) => Number(value || 0).toLocaleString();
const MAX_BARS = 15;
const MAX_BARS_MOBILE = 8;

const VIEWS = [
  { key: 'departments', label: 'By department', column: 'Department' },
  { key: 'cities', label: 'By city', column: 'City' },
];

/** Bar chart options. Colours come from the theme palette, never hardcoded. */
export function buildDepartmentBarOptions(rows = [], palette = {}, { column = 'Department' } = {}) {
  const animate = !motionReduced();
  return {
    chart: { type: 'bar', backgroundColor: 'transparent', spacing: [4, 8, 4, 4], animation: animate },
    title: { text: null },
    credits: { enabled: false },
    legend: { enabled: false },
    accessibility: { enabled: true, description: `Tickets created in the period by the requester's ${column.toLowerCase()}, biggest first.` },
    xAxis: { categories: rows.map((r) => r.label), labels: { style: { fontSize: '11px' } }, lineWidth: 0 },
    yAxis: { min: 0, allowDecimals: false, title: { text: null }, labels: { style: { fontSize: '11px' } }, gridLineDashStyle: 'Dash' },
    tooltip: { pointFormat: '<b>{point.y}</b> tickets ({point.pct}%)' },
    plotOptions: {
      series: { animation: animate },
      bar: { borderRadius: 3, borderWidth: 0, pointPadding: 0.08, groupPadding: 0.06, dataLabels: { enabled: true, format: '{point.pct}%', style: { fontSize: '11px', fontWeight: '500', textOutline: 'none' } } },
    },
    series: [{
      name: 'Tickets',
      data: rows.map((r) => ({
        y: r.count,
        pct: r.pct,
        color: r.unknown ? (palette.ash || palette.slate) : palette.blue,
      })),
    }],
  };
}

function MappingTable({ map }) {
  // Group the job classes under the department they roll up to.
  const groups = useMemo(() => {
    const byLabel = new Map();
    for (const [key, label] of Object.entries(map || {})) {
      const name = key.endsWith('*') ? `${key.slice(0, -1).trim()}…` : key;
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(name);
    }
    return [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [map]);
  const changed = useMemo(() => JSON.stringify(map) !== JSON.stringify(DEFAULT_DEPARTMENT_MAP), [map]);
  return (
    <details className="mt-4 text-sm" data-testid="department-mapping">
      <summary className="tp-focus-ring cursor-pointer rounded text-muted-foreground hover:text-foreground">
        How job classes become departments
      </summary>
      <div className="mt-2 space-y-2 text-muted-foreground">
        <p>
          The department is the requester&rsquo;s Entra department with its level taken off
          (&ldquo;Contracts III&rdquo; counts as Contracts). These job classes are renamed; every other one keeps its own name.
          {changed ? ' An admin has changed this table.' : ''}
        </p>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
          {groups.map(([label, keys]) => (
            <div key={label} className="contents">
              <dt className="font-medium text-foreground">{label}</dt>
              <dd>{keys.join(', ')}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs">
          The city is the requester&rsquo;s Entra city or office, else the FreshService department, which is the office here.
        </p>
      </div>
    </details>
  );
}

export default function TicketsByDepartment({ params, ChartBlock = null, isMobile = false, palette: paletteProp = null, data: dataProp = null }) {
  const palette = useMemo(() => paletteProp || chartPalette(), [paletteProp]);
  const departmentMap = useDepartmentMap();
  const [fetched, setFetched] = useState(null);
  const [loading, setLoading] = useState(!dataProp);
  const [error, setError] = useState(null);
  const [view, setView] = useState('departments');
  const seqRef = useRef(0);
  const paramsKey = JSON.stringify(params || {});

  const load = useCallback(async () => {
    if (dataProp) return;
    const query = JSON.parse(paramsKey);
    if (query.range === 'custom' && (!query.start || !query.end)) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await analyticsAPI.getTicketsByDepartment(query);
      if (seqRef.current === seq) setFetched(res?.data || null);
    } catch (err) {
      if (seqRef.current === seq) setError(err?.message || 'This section failed to load.');
    } finally {
      if (seqRef.current === seq) setLoading(false);
    }
  }, [dataProp, paramsKey]);

  useEffect(() => { load(); }, [load]);

  const data = dataProp || fetched;
  const active = VIEWS.find((v) => v.key === view) || VIEWS[0];
  const rows = useMemo(() => data?.[active.key] || [], [data, active.key]);
  const total = data?.total || 0;
  const known = active.key === 'departments' ? data?.coverage?.departmentKnown : data?.coverage?.cityKnown;
  const barRows = useMemo(() => {
    const limit = isMobile ? MAX_BARS_MOBILE : MAX_BARS;
    const named = rows.filter((r) => !r.unknown);
    const unknown = rows.find((r) => r.unknown);
    return [...named.slice(0, limit), ...(unknown ? [unknown] : [])];
  }, [rows, isMobile]);
  const chartOptions = useMemo(
    () => buildDepartmentBarOptions(barRows, palette, { column: active.column }),
    [barRows, palette, active.column],
  );
  const hiddenBars = rows.length - barRows.length;

  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card p-3 shadow-sm sm:p-4" data-testid="tickets-by-department" aria-busy={loading}>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Tickets by department</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tickets created in this period, by the requester&rsquo;s {active.column.toLowerCase()}.
            {data ? ` ${fmt(total)} tickets; ${fmt(known)} with a known ${active.column.toLowerCase()}.` : ''}
          </p>
        </div>
        <div role="tablist" aria-label="Group tickets" className="flex flex-none gap-4 self-start border-b border-border">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={active.key === v.key}
              onClick={() => setView(v.key)}
              className={`tp-focus-ring -mb-px border-b-2 px-0.5 pb-1.5 text-sm ${
                active.key === v.key ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="mb-3 flex flex-wrap items-center gap-3 text-sm text-red-700 dark:text-red-200" role="alert">
          {error}
          <button type="button" onClick={load} className="tp-focus-ring inline-flex items-center gap-1 rounded font-medium underline">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </button>
        </p>
      )}

      {!data && loading && (
        <div className="flex min-h-[10rem] items-center justify-center" data-testid="tickets-by-department-loading">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading" />
        </div>
      )}

      {data && total === 0 && (
        <p className="py-6 text-sm text-muted-foreground" data-testid="tickets-by-department-empty">No tickets were created in this period.</p>
      )}

      {data && total > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {ChartBlock ? (
            <div className="min-w-0">
              <ChartBlock options={chartOptions} height={`${Math.max(160, barRows.length * 30 + 40)}px`} />
              {hiddenBars > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">The chart shows the {fmt(barRows.length - (barRows.some((r) => r.unknown) ? 1 : 0))} biggest; the table lists all {fmt(rows.length)}.</p>
              )}
            </div>
          ) : null}
          <div className={`min-w-0 overflow-x-auto ${ChartBlock ? '' : 'lg:col-span-2'}`}>
            <table className="w-full text-sm" data-testid="tickets-by-department-table">
              <caption className="sr-only">Tickets created in this period by {active.column.toLowerCase()}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">{active.column}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">Tickets</th>
                  <th scope="col" className="py-1.5 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label} className="border-b border-border/60 last:border-0">
                    <th scope="row" className={`py-1.5 pr-3 text-left font-normal ${r.unknown ? 'text-muted-foreground' : 'text-foreground'}`}>{r.label}</th>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-foreground">{fmt(r.count)}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{r.pct}%</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border text-xs text-muted-foreground">
                  <th scope="row" className="py-1.5 pr-3 text-left font-medium">All tickets</th>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(total)}</td>
                  <td className="py-1.5 text-right tabular-nums">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {data && active.key === 'departments' && <MappingTable map={departmentMap} />}
    </section>
  );
}
