/** @vitest-environment jsdom */
import { describe, expect, test, vi } from 'vitest';

// "Source unavailable" explained + split (QA 08-25 #2 — Phase SU): the
// Team Balance source chart carries five buckets, the two actor-less ones
// last and muted; the shared tooltip footnotes them; the glossary explains
// them without "pre-dates" framing or person-metric language.
vi.mock('highcharts', () => ({ default: {} }));
vi.mock('highcharts/highcharts-more', () => ({}));
vi.mock('highcharts/modules/treemap', () => ({}));
vi.mock('highcharts/modules/heatmap', () => ({}));
vi.mock('highcharts/modules/sankey', () => ({}));
vi.mock('highcharts/modules/accessibility', () => ({}));
vi.mock('highcharts-react-official', () => ({ default: () => null }));
vi.mock('xlsx', () => ({ utils: {}, writeFile: vi.fn() }));
vi.mock('../services/api', () => ({
  analyticsAPI: {},
  getGlobalExcludeNoise: () => false,
  setGlobalExcludeNoise: vi.fn(),
}));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: null }) }));
vi.mock('../components/AppShell', () => ({ default: ({ children }) => children }));
vi.mock('../components/analytics/AnalyticsReports', () => ({ default: () => null }));
vi.mock('../components/CategoryFilter', () => ({ default: () => null }));
vi.mock('../components/CanonicalCategoryFilter', () => ({ default: () => null }));

import {
  ASSIGNMENT_SOURCE_COLORS, ASSIGNMENT_SOURCE_SERIES, assignmentSourceTooltipHtml, buildAssignmentSourceSeries,
} from './Analytics';
import { METRICS_GLOSSARY, metricHintText } from '../utils/metricsGlossary';

const rows = [
  { technicianId: 1, name: 'Mehdi', selfPicked: 4, coordinatorAssigned: 2, appAssigned: 1, workflowAssigned: 3, unknown: 1 },
  { technicianId: 2, name: 'Gaby', selfPicked: 0, coordinatorAssigned: 5, appAssigned: 0, workflowAssigned: 0, unknown: 0 },
];

describe('Assignment Source by Agent — series contract', () => {
  test('five buckets in order, the actor-less pair last with muted colours', () => {
    expect(ASSIGNMENT_SOURCE_SERIES.map((s) => s.key)).toEqual(['selfPicked', 'coordinatorAssigned', 'appAssigned', 'workflowAssigned', 'unknown']);
    const series = buildAssignmentSourceSeries(rows);
    expect(series.map((s) => s.name)).toEqual(['Self-picked', 'Coordinator', 'Ticket Pulse', 'Assigned at creation / workflow', 'Source unavailable']);
    expect(series[3].color).toBe(ASSIGNMENT_SOURCE_COLORS.workflowAssigned);
    expect(series[4].color).toBe(ASSIGNMENT_SOURCE_COLORS.unknown);
    expect(series[3].data).toEqual([{ y: 3, technicianId: 1 }, { y: 0, technicianId: 2 }]);
    expect(series[4].data).toEqual([{ y: 1, technicianId: 1 }, { y: 0, technicianId: 2 }]);
    // Rows from an older backend (no workflowAssigned) still render as zeros.
    expect(buildAssignmentSourceSeries([{ technicianId: 9, selfPicked: 1 }])[3].data).toEqual([{ y: 0, technicianId: 9 }]);
  });

  test('tooltip: per-series lines + total, footnotes only when the unattributed points are > 0', () => {
    const pts = (row) => ASSIGNMENT_SOURCE_SERIES.map(({ key, name }) => ({ y: row[key], series: { name }, color: ASSIGNMENT_SOURCE_COLORS[key] }));
    const withUnknown = assignmentSourceTooltipHtml(pts(rows[0]), 'Mehdi');
    expect(withUnknown).toContain('Mehdi');
    expect(withUnknown).toContain('Self-picked: <b>4</b>');
    expect(withUnknown).toContain('Total: <b>11</b>');
    expect(withUnknown).toContain('Source unavailable: activity history not synced yet');
    expect(withUnknown).toContain('Assigned at creation / workflow: FreshService set the owner');

    const clean = assignmentSourceTooltipHtml(pts(rows[1]), 'Gaby');
    expect(clean).toContain('Total: <b>5</b>');
    expect(clean).not.toContain('activity history not synced');
    expect(clean).not.toContain('FreshService set the owner');
    // Agent names are escaped.
    expect(assignmentSourceTooltipHtml([], '<img>')).toContain('&lt;img&gt;');
  });
});

describe('glossary — unattributed buckets (SU1)', () => {
  test('entries exist and use structural, team-safe wording', () => {
    for (const key of ['assignmentMixUnknown', 'agentSourceUnavailable', 'agentWorkflowAssigned']) {
      expect(METRICS_GLOSSARY[key], key).toBeTruthy();
      const text = metricHintText(key).toLowerCase();
      expect(text, key).not.toMatch(/pre-?date|cutoff|before ticket pulse/);
      expect(text, key).not.toMatch(/leaderboard|winner|loser|fault|blame/);
      expect(text, key).toMatch(/excluded from self-pick/);
    }
    expect(metricHintText('assignmentMixUnknown')).toMatch(/workflow|automator|email rule/i);
    expect(metricHintText('agentSourceUnavailable')).toMatch(/not synced|sync failed/i);
  });
});
