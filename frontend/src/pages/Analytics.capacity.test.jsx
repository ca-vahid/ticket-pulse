/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { forwardRef } from 'react';

// Phase 6 (FR 08-07 item 5): the Capacity tab is a second, team-safe view over
// the Team Balance payload — no new fetch. These tests pin the binding rules:
// alphabetical server order preserved (never re-sorted by volume), the payload
// notes rendered in a quiet footer, coaching detail hidden behind a toggle,
// CSAT always with its response count, and the Capacity export sheet.

vi.mock('highcharts', () => ({ default: {} }));
vi.mock('highcharts/highcharts-more', () => ({}));
vi.mock('highcharts/modules/treemap', () => ({}));
vi.mock('highcharts/modules/heatmap', () => ({}));
vi.mock('highcharts/modules/sankey', () => ({}));
vi.mock('highcharts/modules/accessibility', () => ({}));
vi.mock('highcharts-react-official', () => ({
  // forwardRef so HighchartsBlock's chartRef doesn't warn in jsdom.
  default: forwardRef(function HighchartsReactMock(props, ref) {
    void ref;
    return <div data-testid="highcharts-mock" />;
  }),
}));
vi.mock('xlsx', () => ({
  utils: {
    book_new: vi.fn(() => ({ sheets: [] })),
    json_to_sheet: vi.fn((rows) => rows),
    book_append_sheet: vi.fn(),
  },
  writeFile: vi.fn(),
}));

const TEAM_FIXTURE = {
  metadata: { range: { start: '2026-07-09', end: '2026-08-08', timezone: 'America/Los_Angeles' } },
  summary: {
    activeTechnicians: 3,
    rangeBusinessDays: 21,
    totalAssigned: 90,
    avgAssignedPerTech: 30,
    avgAssignedPerAvailableDay: 1.5,
    balanceScore: 82,
    spread: 40,
    openAgeBuckets: { under4h: 1, h4to8: 0, h8to24: 2, over24h: 3 },
  },
  // Server order is alphabetical BY DESIGN; Bob has the highest volume so a
  // volume re-sort would move him first — the tests assert he stays second.
  technicians: [
    {
      technicianId: 1, name: 'Alice Anders', assigned: 20, closed: 10, closeRatePct: 50,
      openNow: 4, pendingNow: 1, selfPicked: 5, coordinatorAssigned: 10, appAssigned: 5,
      availableDays: 21, assignedPerAvailableDay: 1.0, capacityLeaveDays: 0,
      leaveDays: 0, wfhDays: 2, leaveTypes: [], csatAverage: 3.8, csatCount: 12,
    },
    {
      technicianId: 2, name: 'Bob Baker', assigned: 55, closed: 44, closeRatePct: 80,
      openNow: 8, pendingNow: 2, selfPicked: 30, coordinatorAssigned: 15, appAssigned: 10,
      availableDays: 16.5, assignedPerAvailableDay: 3.3, capacityLeaveDays: 4.5,
      leaveDays: 4.5, wfhDays: 0, leaveTypes: [{ name: 'Vacation', days: 4.5 }], csatAverage: null, csatCount: 0,
    },
    {
      technicianId: 3, name: 'Cara Cruz', assigned: 15, closed: 12, closeRatePct: 80,
      openNow: 2, pendingNow: 0, selfPicked: 2, coordinatorAssigned: 8, appAssigned: 5,
      availableDays: 20, assignedPerAvailableDay: 0.8, capacityLeaveDays: 1,
      leaveDays: 1, wfhDays: 1, leaveTypes: [{ name: 'Sick', days: 1 }], csatAverage: 4.5, csatCount: 3,
    },
  ],
  timeline: [
    { technicianId: 1, name: 'Alice Anders', period: '2026-W28', assigned: 8, closed: 4 },
    { technicianId: 2, name: 'Bob Baker', period: '2026-W28', assigned: 25, closed: 20 },
    { technicianId: 3, name: 'Cara Cruz', period: '2026-W28', assigned: 7, closed: 6 },
    { technicianId: 1, name: 'Alice Anders', period: '2026-W29', assigned: 12, closed: 6 },
    { technicianId: 2, name: 'Bob Baker', period: '2026-W29', assigned: 30, closed: 24 },
    { technicianId: 3, name: 'Cara Cruz', period: '2026-W29', assigned: 8, closed: 6 },
  ],
  notes: [
    'Team Balance is sorted alphabetically and avoids ranked winner/loser framing by design.',
    'Balance Score uses assignments per available weekday, subtracting OFF/OTHER leave days from either Vacation Tracker or shared mailbox sync.',
  ],
};

let teamResponse = TEAM_FIXTURE;

vi.mock('../services/api', () => ({
  analyticsAPI: {
    getOverview: vi.fn(() => Promise.resolve({ data: {} })),
    getDemandFlow: vi.fn(() => Promise.resolve({ data: {} })),
    getCategoryIntelligence: vi.fn(() => Promise.resolve({ data: {} })),
    getTeamBalance: vi.fn(() => Promise.resolve({ data: teamResponse })),
    getQuality: vi.fn(() => Promise.resolve({ data: {} })),
    getAutomationOps: vi.fn(() => Promise.resolve({ data: {} })),
    getInsights: vi.fn(() => Promise.resolve({ data: {} })),
    getCategories: vi.fn(() => Promise.resolve({ data: null })),
  },
  getGlobalExcludeNoise: vi.fn(() => false),
  setGlobalExcludeNoise: vi.fn(),
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT', slug: 'it' } }),
}));
vi.mock('../components/AppShell', () => ({ default: ({ children, extraActions }) => <div>{extraActions}{children}</div> }));
vi.mock('../components/analytics/AnalyticsReports', () => ({ default: () => null }));
vi.mock('../components/CategoryFilter', () => ({ default: () => null }));
vi.mock('../components/CanonicalCategoryFilter', () => ({ default: () => null }));

import * as XLSX from 'xlsx';
import Analytics, { buildCapacityExportRows } from './Analytics';

function renderCapacityTab() {
  return render(
    <MemoryRouter initialEntries={['/analytics?tab=capacity']}>
      <Analytics />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  teamResponse = TEAM_FIXTURE;
});

describe('Analytics Capacity tab', () => {
  test('renders every section from the team payload', async () => {
    renderCapacityTab();

    // Headline stat cards frame the TEAM, not individuals.
    expect(await screen.findByText('Balance Score')).toBeInTheDocument();
    expect(screen.getByText('Assignment Spread')).toBeInTheDocument();
    expect(screen.getByText('Team Close Rate')).toBeInTheDocument();
    expect(screen.getByText('Avg / Available Day')).toBeInTheDocument();
    // Team close rate = 66/90 = 73.3%, with its N.
    expect(screen.getByText('73.3%')).toBeInTheDocument();
    expect(screen.getByText('66 of 90 assigned tickets closed')).toBeInTheDocument();

    // Stacked assigned-over-time chart section (chart itself is mocked).
    expect(screen.getByText('Assigned Over Time')).toBeInTheDocument();
    expect(screen.getByText(/stacked by technician/i)).toBeInTheDocument();

    // Distribution / completion / leave-adjusted table + the leave note.
    expect(screen.getByText('Distribution, Completion and Leave-Adjusted Capacity')).toBeInTheDocument();
    expect(screen.getByText(/Leave adjustment: available days/i)).toBeInTheDocument();
    const table = screen.getByRole('table');
    // Close rate shows its N; available days compare against range weekdays.
    expect(within(table).getByText('80% (44/55)')).toBeInTheDocument();
    expect(within(table).getByText('16.5 of 21')).toBeInTheDocument();
    expect(within(table).getByText('3.3')).toBeInTheDocument();
  });

  test('keeps the server alphabetical order — never re-sorted by volume', async () => {
    renderCapacityTab();
    const table = await screen.findByRole('table');
    const names = within(table).getAllByRole('row').slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent);
    // Bob has the highest assigned count (55) but stays second.
    expect(names).toEqual(['Alice Anders', 'Bob Baker', 'Cara Cruz']);
  });

  test('renders the payload notes in the quiet footer', async () => {
    renderCapacityTab();
    expect(await screen.findByText(/sorted alphabetically and avoids ranked winner\/loser framing/i)).toBeInTheDocument();
    expect(screen.getByText(/assignments per available weekday/i)).toBeInTheDocument();
  });

  test('coaching detail is gated behind the hidden-by-default toggle; CSAT shows N', async () => {
    renderCapacityTab();
    await screen.findByText('Optional Coaching Context');

    // Hidden by default: no CSAT figure, placeholder instead.
    expect(screen.getByText('Open coaching context only when a 1:1 needs it.')).toBeInTheDocument();
    expect(screen.queryByText('3.8')).not.toBeInTheDocument();
    expect(screen.queryByText('12 responses')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show coaching context' }));

    // CSAT always renders with its response count (sparse coverage rule).
    expect(screen.getByText('3.8')).toBeInTheDocument();
    expect(screen.getByText('12 responses')).toBeInTheDocument();
    expect(screen.getByText('0 responses')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide coaching context' }));
    expect(screen.queryByText('12 responses')).not.toBeInTheDocument();
  });

  test('empty team payload renders the empty state, not a broken table', async () => {
    teamResponse = { summary: { rangeBusinessDays: 21 }, technicians: [], timeline: [], notes: [] };
    renderCapacityTab();
    expect(await screen.findByText('No active technicians in this range.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('workbook export appends a Capacity sheet with the per-agent rows', async () => {
    renderCapacityTab();
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    const sheetNames = XLSX.utils.book_append_sheet.mock.calls.map((call) => call[2]);
    expect(sheetNames).toContain('Capacity');
    const capacityCall = XLSX.utils.book_append_sheet.mock.calls.find((call) => call[2] === 'Capacity');
    // json_to_sheet is mocked as identity, so the sheet IS the row array.
    expect(capacityCall[1].map((row) => row.technician)).toEqual(['Alice Anders', 'Bob Baker', 'Cara Cruz']);
  });
});

describe('buildCapacityExportRows', () => {
  test('builds per-agent rows with share, completion, leave-adjusted capacity and CSAT N', () => {
    const rows = buildCapacityExportRows(TEAM_FIXTURE);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      technician: 'Alice Anders',
      assigned: 20,
      shareOfTeamPct: 22.2,
      closed: 10,
      closeRatePct: 50,
      availableDays: 21,
      rangeBusinessDays: 21,
      assignedPerAvailableDay: 1.0,
      leaveDays: 0,
      wfhDays: 2,
      csatAverage: 3.8,
      csatResponses: 12,
    });
    // Order preserved from the payload (alphabetical server sort).
    expect(rows.map((row) => row.technician)).toEqual(['Alice Anders', 'Bob Baker', 'Cara Cruz']);
    expect(rows[1].csatAverage).toBeNull();
    expect(rows[1].csatResponses).toBe(0);
  });

  test('returns an empty array for a missing or empty team payload', () => {
    expect(buildCapacityExportRows(undefined)).toEqual([]);
    expect(buildCapacityExportRows({ technicians: [] })).toEqual([]);
  });
});
