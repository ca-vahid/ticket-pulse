/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Phase TB (QA 08-17 #4): on legacy-mode workspaces (ws2 Accounting) the Team
// Balance bar charts rendered garbled — washed-out bars under a phantom 0-400
// colorAxis legend and overlap-stacked agent names. Root cause: the Analytics
// tab trees are same-shaped at the root, so switching Categories → Team let
// React positionally REUSE the mounted Highcharts instances; the Categories
// treemap/heatmap then received the Team bar options via chart.update(), and
// Chart.update's `if (options[coll])` guard can never REMOVE a stale colorAxis
// when the new options simply omit the key. These tests pin the three fixes:
// keyed-per-tab remount, explicit `colorAxis: []` on the team bar configs, and
// the team-safe alphabetical default sort.

const chartLog = vi.hoisted(() => ({ mounts: [] }));

vi.mock('highcharts', () => ({ default: {} }));
vi.mock('highcharts/highcharts-more', () => ({}));
vi.mock('highcharts/modules/treemap', () => ({}));
vi.mock('highcharts/modules/heatmap', () => ({}));
vi.mock('highcharts/modules/sankey', () => ({}));
vi.mock('highcharts/modules/accessibility', () => ({}));
vi.mock('highcharts-react-official', async () => {
  const { forwardRef, useEffect, useRef } = await import('react');
  return {
    // Instance-tracking mock: one record per MOUNTED chart instance. If React
    // reuses an instance across a tab switch (the bug), the record keeps the
    // same identity and only `updates`/`options` change — exactly mirroring
    // how the real HighchartsReact routes new options into chart.update().
    default: forwardRef(function HighchartsReactMock(props, ref) {
      void ref;
      const record = useRef(null);
      if (!record.current) {
        record.current = { options: props.options, updates: 0, unmounted: false };
        chartLog.mounts.push(record.current);
      }
      record.current.options = props.options;
      record.current.updates += 1;
      useEffect(() => {
        const rec = record.current;
        return () => { rec.unmounted = true; };
      }, []);
      return <div data-testid="highcharts-mock" />;
    }),
  };
});
vi.mock('xlsx', () => ({
  utils: {
    book_new: vi.fn(() => ({ sheets: [] })),
    json_to_sheet: vi.fn((rows) => rows),
    book_append_sheet: vi.fn(),
  },
  writeFile: vi.fn(),
}));

// Server order is deliberately NOT alphabetical and NOT ranked-by-volume, so
// the assertions can tell the three orderings apart:
//   server order:      Bob, Cara, Alice
//   ranked (old bug):  Bob (55), Alice (20), Cara (15)
//   alphabetical (fix): Alice, Bob, Cara
const TEAM_FIXTURE = {
  metadata: { range: { start: '2026-07-18', end: '2026-08-17', timezone: 'America/Los_Angeles' } },
  summary: { activeTechnicians: 3, rangeBusinessDays: 21, totalAssigned: 90 },
  technicians: [
    {
      technicianId: 2, name: 'Bob Baker', assigned: 55, closed: 44, closeRatePct: 80,
      openNow: 8, pendingNow: 2, selfPicked: 30, coordinatorAssigned: 15, appAssigned: 10,
      availableDays: 16.5, assignedPerAvailableDay: 3.3, leaveDays: 4.5, wfhDays: 0, leaveTypes: [],
      csatAverage: null, csatCount: 0,
    },
    {
      technicianId: 3, name: 'Cara Cruz', assigned: 15, closed: 12, closeRatePct: 80,
      openNow: 2, pendingNow: 0, selfPicked: 2, coordinatorAssigned: 8, appAssigned: 5,
      availableDays: 20, assignedPerAvailableDay: 0.8, leaveDays: 1, wfhDays: 1, leaveTypes: [],
      csatAverage: 4.5, csatCount: 3,
    },
    {
      technicianId: 1, name: 'Alice Anders', assigned: 20, closed: 10, closeRatePct: 50,
      openNow: 4, pendingNow: 1, selfPicked: 5, coordinatorAssigned: 10, appAssigned: 5,
      availableDays: 21, assignedPerAvailableDay: 1.0, leaveDays: 0, wfhDays: 2, leaveTypes: [],
      csatAverage: 3.8, csatCount: 12,
    },
  ],
  timeline: [
    { technicianId: 1, name: 'Alice Anders', period: '2026-W30', assigned: 8, closed: 4 },
    { technicianId: 2, name: 'Bob Baker', period: '2026-W30', assigned: 25, closed: 20 },
    { technicianId: 3, name: 'Cara Cruz', period: '2026-W30', assigned: 7, closed: 6 },
  ],
  notes: [],
};

// Legacy-mode categories payload (the ws2 Accounting shape): categoryMode
// 'legacy' turns on the amber banner — the conditional first child whose
// presence aligned the Categories tree with the Team tree and triggered the
// positional-reuse bug in prod. The trend rows mount the Demand Heatmap, a
// real colorAxis-bearing chart, on the Categories tab.
const CATEGORIES_FIXTURE = {
  metadata: {
    categoryMode: 'legacy',
    range: { start: '2026-07-18', end: '2026-08-17', timezone: 'America/Los_Angeles' },
  },
  summary: { totalCreated: 42, open: 9, overdue: 1, reviewNeeded: 0, automationFailures: 0, automationRuns: 5 },
  rows: [],
  hierarchy: [],
  trend: [
    { period: '2026-W30', name: 'Invoices', count: 12 },
    { period: '2026-W31', name: 'Invoices', count: 9 },
    { period: '2026-W31', name: 'Expenses', count: 6 },
  ],
  pressure: [],
  agents: [],
};

vi.mock('../services/api', () => ({
  analyticsAPI: {
    getOverview: vi.fn(() => Promise.resolve({ data: {} })),
    getDemandFlow: vi.fn(() => Promise.resolve({ data: {} })),
    getCategoryIntelligence: vi.fn(() => Promise.resolve({ data: CATEGORIES_FIXTURE })),
    getTeamBalance: vi.fn(() => Promise.resolve({ data: TEAM_FIXTURE })),
    getQuality: vi.fn(() => Promise.resolve({ data: {} })),
    getAutomationOps: vi.fn(() => Promise.resolve({ data: {} })),
    getInsights: vi.fn(() => Promise.resolve({ data: {} })),
    getCategories: vi.fn(() => Promise.resolve({ data: null })),
  },
  getGlobalExcludeNoise: vi.fn(() => false),
  setGlobalExcludeNoise: vi.fn(),
}));
// ws2-shaped workspace: non-IT → legacy category fallback paths.
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 2, name: 'Accounting', slug: 'accounting' } }),
}));
vi.mock('../components/AppShell', () => ({ default: ({ children, extraActions }) => <div>{extraActions}{children}</div> }));
vi.mock('../components/analytics/AnalyticsReports', () => ({ default: () => null }));
vi.mock('../components/CategoryFilter', () => ({ default: () => null }));
vi.mock('../components/CanonicalCategoryFilter', () => ({ default: () => null }));

import Analytics, { HighchartsBlock } from './Analytics';

function renderAnalytics(tab) {
  return render(
    <MemoryRouter initialEntries={[`/analytics?tab=${tab}`]}>
      <Analytics />
    </MemoryRouter>,
  );
}

const liveBarMounts = () => chartLog.mounts.filter(
  (mount) => !mount.unmounted && mount.options?.chart?.type === 'bar',
);

afterEach(() => {
  cleanup();
  chartLog.mounts.length = 0;
  vi.clearAllMocks();
});

describe('Analytics Team Balance charts (Phase TB regression)', () => {
  test('Categories → Team Balance on a legacy workspace remounts charts; no colorAxis reaches the team bars', async () => {
    renderAnalytics('categories');

    // The legacy amber banner must be up — it is the conditional first child
    // whose presence caused the prod-only (ws2) child alignment.
    expect(await screen.findByText(/legacy Freshservice category values/i)).toBeInTheDocument();

    // The Categories tab has a live colorAxis-bearing chart (Demand Heatmap).
    const categoriesMounts = [...chartLog.mounts];
    expect(categoriesMounts.some(
      (mount) => mount.options?.chart?.type === 'heatmap' && mount.options?.colorAxis,
    )).toBe(true);

    // Capture the Categories tab ROOT DOM NODE. Both tab trees root at a
    // `div.space-y-4`, so an unkeyed switch lets React reuse this exact node
    // (positional reconciliation) — the precondition for chart.update() reuse.
    const categoriesRoot = screen.getByText(/legacy Freshservice category values/i).closest('div.space-y-4');
    expect(categoriesRoot).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Team Balance' }));
    expect(await screen.findByText('Workload by Agent')).toBeInTheDocument();
    expect(screen.getByText('Assignment Source by Agent')).toBeInTheDocument();

    // TB1: keyed-per-tab remount — the Team tree must live in a NEW root node.
    // Without `key={activeTab}` React keeps the same div and only patches
    // children, which is exactly how Categories chart instances survived into
    // the Team tab in prod. (Verified discriminating: fails when the key is
    // removed.)
    const teamRoot = screen.getByText('Workload by Agent').closest('div.space-y-4');
    expect(teamRoot).not.toBeNull();
    expect(teamRoot).not.toBe(categoriesRoot);
    expect(categoriesRoot.isConnected).toBe(false);

    // And every chart instance mounted while on the Categories tab is GONE,
    // not updated in place into a team chart.
    for (const mount of categoriesMounts) {
      expect(mount.unmounted).toBe(true);
    }

    // The team bar charts are fresh instances…
    const barMounts = liveBarMounts();
    expect(barMounts).toHaveLength(2);
    for (const mount of barMounts) {
      expect(categoriesMounts).not.toContain(mount);
      // TB2: …and their options carry an explicit EMPTY colorAxis collection
      // (an omitted key could never clear a stale axis through chart.update's
      // `if (options[coll])` guard; [] actively removes it).
      expect(mount.options.colorAxis).toEqual([]);
      // Full roster present as named category labels — one per technician.
      expect(mount.options.xAxis.categories).toHaveLength(TEAM_FIXTURE.technicians.length);
    }
  });

  test('team charts default to alphabetical agent order — team-safe, not a ranked leaderboard', async () => {
    renderAnalytics('team');
    expect(await screen.findByText('Workload by Agent')).toBeInTheDocument();

    const barMounts = liveBarMounts();
    expect(barMounts).toHaveLength(2);
    for (const mount of barMounts) {
      // Server order is Bob, Cara, Alice; the old ranked default would put
      // Bob (55 assigned) first. Alphabetical proves the team-safe default.
      expect(mount.options.xAxis.categories).toEqual(['Alice Anders', 'Bob Baker', 'Cara Cruz']);
    }

    // Series stay aligned with the alphabetical category order.
    const workload = barMounts.find((mount) => mount.options.series.some((series) => series.name === 'Assigned'));
    const assigned = workload.options.series.find((series) => series.name === 'Assigned');
    expect(assigned.data.map((point) => point.y)).toEqual([20, 55, 15]);
  });

  test('the two team bar chart panels sit inside the large-roster scroll container', async () => {
    const { container } = renderAnalytics('team');
    await screen.findByText('Workload by Agent');

    const scroller = container.querySelector('.settings-scrollbar.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller.className).toContain('max-h-[40rem]');
    expect(scroller.textContent).toContain('Workload by Agent');
    expect(scroller.textContent).toContain('Assignment Source by Agent');
  });

  test('HighchartsBlock recreates the chart when the chart TYPE changes, but updates in place within a type', () => {
    // TB2 defence in depth, isolated: even if some future tree shape lets
    // React reuse a HighchartsBlock across surfaces again, a chart-type change
    // (treemap → bar) must DESTROY and recreate the instance — chart.update()
    // can never remove the collections (colorAxis) the new options omit.
    const treemapOptions = { chart: { type: 'treemap' }, colorAxis: { min: 0, maxColor: '#2563eb' }, series: [] };
    const { rerender } = render(<HighchartsBlock options={treemapOptions} />);
    expect(chartLog.mounts).toHaveLength(1);
    const treemapMount = chartLog.mounts[0];

    // Same type, new options object (drill/lens): NO remount — the real
    // component routes this through chart.update() so morph animations live.
    rerender(<HighchartsBlock options={{ ...treemapOptions, series: [{ data: [1] }] }} />);
    expect(chartLog.mounts).toHaveLength(1);
    expect(treemapMount.unmounted).toBe(false);
    expect(treemapMount.updates).toBeGreaterThan(1);

    // Type change: the old instance is destroyed, a fresh one is created.
    rerender(<HighchartsBlock options={{ chart: { type: 'bar' }, colorAxis: [], series: [] }} />);
    expect(treemapMount.unmounted).toBe(true);
    expect(chartLog.mounts).toHaveLength(2);
    expect(chartLog.mounts[1].options.chart.type).toBe('bar');
    expect(chartLog.mounts[1].options.colorAxis).toEqual([]);
  });

  test('table headers still re-sort deliberately after the alphabetical default', async () => {
    renderAnalytics('team');
    await screen.findByText('Workload by Agent');

    // Click the Assigned header: first click sorts desc (ranked on purpose).
    fireEvent.click(screen.getByRole('button', { name: /^Assigned$/ }));
    const workload = liveBarMounts().find(
      (mount) => mount.options.series.some((series) => series.name === 'Assigned'),
    );
    expect(workload.options.xAxis.categories).toEqual(['Bob Baker', 'Alice Anders', 'Cara Cruz']);
  });
});
