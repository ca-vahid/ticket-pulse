/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Analytics.jsx pulls charting/export/app-shell machinery at module scope —
// none of it matters for the StatCard unit, so stub the heavy edges.
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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StatCard } from './Analytics';
import MetricHint from '../components/analytics/MetricHint';
import { METRICS_GLOSSARY, getMetricHint, metricHintText } from '../utils/metricsGlossary';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const INFO = 'Unique tickets that bounced back and re-entered the assignment pipeline at least once.';

describe('Analytics StatCard info popover', () => {
  test('without info there is no ⓘ affordance', () => {
    render(<StatCard title="Pipeline Runs" value="12" />);
    expect(screen.queryByRole('button', { name: /means/i })).not.toBeInTheDocument();
  });

  test('popover is hidden until focus, then announced via aria-describedby', () => {
    render(<StatCard title="Rebounds" value="3" info={INFO} />);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    const btn = screen.getByRole('button', { name: 'What "Rebounds" means' });
    expect(btn).not.toHaveAttribute('aria-describedby');

    fireEvent.focus(btn);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(INFO);
    expect(btn).toHaveAttribute('aria-describedby', tooltip.id);

    fireEvent.blur(btn);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  test('opens on hover and closes on mouse leave', () => {
    render(<StatCard title="Routing accuracy" value="91%" info="Held after 7 days." />);
    const btn = screen.getByRole('button', { name: /routing accuracy/i });
    fireEvent.mouseEnter(btn);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Held after 7 days.');
    fireEvent.mouseLeave(btn);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  test('Escape closes an open popover', () => {
    render(<StatCard title="Rebounds" value="3" info={INFO} />);
    const btn = screen.getByRole('button', { name: /rebounds/i });
    fireEvent.focus(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  test('metric prop resolves the glossary definition (and caveats) on hover', () => {
    render(<StatCard title="CSAT" value="3.8" metric="csat" />);
    const btn = screen.getByRole('button', { name: 'What "CSAT" means' });
    fireEvent.mouseEnter(btn);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(METRICS_GLOSSARY.csat.definition);
    expect(tooltip).toHaveTextContent(METRICS_GLOSSARY.csat.caveats);
  });

  test('explicit info wins over the glossary entry', () => {
    render(<StatCard title="CSAT" value="3.8" metric="csat" info="Bespoke copy." />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /csat/i }));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Bespoke copy.');
    expect(tooltip).not.toHaveTextContent(METRICS_GLOSSARY.csat.definition);
  });
});

describe('MetricHint (standalone)', () => {
  test('renders formula line for entries that have one', () => {
    render(<MetricHint metric="balanceScore" />);
    fireEvent.focus(screen.getByRole('button'));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(METRICS_GLOSSARY.balanceScore.formula);
  });

  test('an unknown metric key renders nothing instead of a dead icon', () => {
    const { container } = render(<MetricHint metric="not-a-real-metric" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('metrics glossary content rules', () => {
  test('every entry has a label and a real definition', () => {
    for (const [key, entry] of Object.entries(METRICS_GLOSSARY)) {
      expect(entry.label, key).toBeTruthy();
      expect(entry.definition?.length, key).toBeGreaterThan(20);
    }
  });

  test('CSAT / survey metrics always point at the response count (binding rule)', () => {
    for (const key of ['csat', 'agentCsat', 'satisfiedTopTwoBox', 'firstPartyFeedback', 'csatSamples']) {
      const text = metricHintText(key).toLowerCase();
      expect(text, key).toMatch(/response|count|rated|sample|n /);
    }
  });

  test('team metrics stay balance/coaching framed, never rankings', () => {
    for (const key of ['balanceScore', 'assignmentSpread', 'agentRejected', 'agentLoadStatus']) {
      const text = metricHintText(key).toLowerCase();
      expect(text, key).not.toMatch(/leaderboard|winner|loser|best performer|worst/);
    }
  });

  test('getMetricHint returns null (never throws) for unknown keys', () => {
    expect(getMetricHint('nope')).toBeNull();
    expect(metricHintText('nope')).toBe('');
  });
});

describe('Analytics metric-hint coverage (source scan)', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const analyticsSource = read('./Analytics.jsx');
  const reportsSource = read('../components/analytics/AnalyticsReports.jsx');

  test('every <StatCard> in Analytics.jsx supplies metric or info', () => {
    const chunks = analyticsSource.split('<StatCard').slice(1);
    expect(chunks.length).toBeGreaterThanOrEqual(42);
    const missing = [];
    for (const chunk of chunks) {
      const tag = chunk.slice(0, chunk.indexOf('/>'));
      if (!/\b(metric|info)=/.test(tag)) {
        missing.push(tag.split('\n')[0].trim() || tag.trim().slice(0, 80));
      }
    }
    expect(missing).toEqual([]);
  });

  test('every metric key referenced in the UI exists in the glossary', () => {
    const keys = new Set();
    for (const source of [analyticsSource, reportsSource]) {
      // Direct props: metric="createdDemand" / plain-text fallbacks:
      // metricHintText('agentLoadStatus').
      for (const match of source.matchAll(/\bmetric="([^"]+)"|metricHintText\('([^']+)'\)/g)) {
        keys.add(match[1] || match[2]);
      }
      // Array-literal metric keys (table column configs, mini-stat maps) —
      // the last element of a tuple, e.g. ['assigned', 'Assigned', 'agentAssigned'].
      for (const match of source.matchAll(/,\s*'((?:agent|report|shareOfTeam)[A-Za-z]*)'\]/g)) {
        keys.add(match[1]);
      }
    }
    expect(keys.size).toBeGreaterThanOrEqual(40);
    const unknown = [...keys].filter((key) => !METRICS_GLOSSARY[key]);
    expect(unknown).toEqual([]);
  });
});
