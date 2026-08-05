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

import { StatCard } from './Analytics';

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
});
