/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AgentStatusPill from './AgentStatusPill';
import { getLeaveBadge } from '../utils/leaveInfo';

afterEach(cleanup);

describe('AgentStatusPill (dashboard simple-view caption pill)', () => {
  test('default tone: "Steady week" in a muted pill', () => {
    render(<AgentStatusPill />);
    const pill = screen.getByText('Steady week');
    // Dark-mode migration: the calm default rides the muted tokens now
    // (bg-muted/50 text-muted-foreground), not raw slate classes.
    expect(pill).toHaveClass('rounded-full', 'border', 'bg-muted/50', 'text-muted-foreground');
  });

  test('topLoad tone: "Heaviest load on the team" in a violet pill', () => {
    render(<AgentStatusPill topLoad />);
    const pill = screen.getByText('Heaviest load on the team');
    expect(pill).toHaveClass('bg-violet-50', 'text-violet-700', 'border-violet-200');
    expect(pill).not.toHaveClass('bg-slate-50');
  });

  test('leave tone: uses the leave badge classes and the leave tooltip first line', () => {
    const leave = { category: 'OFF', isFullDay: true, typeName: 'Vacation' };
    const badge = getLeaveBadge(leave);
    render(<AgentStatusPill leaveBadge={badge} activeLeave={leave} topLoad />);
    // Leave wins over topLoad; full-day OFF renders "🏖️ Vacation".
    const pill = screen.getByText(/Vacation/);
    expect(pill).toHaveClass('bg-amber-100', 'text-amber-800', 'border-amber-300');
    expect(screen.queryByText('Heaviest load on the team')).not.toBeInTheDocument();
  });

  test('WFH leave tone: teal badge classes', () => {
    const leave = { category: 'WFH', isFullDay: true };
    const badge = getLeaveBadge(leave);
    render(<AgentStatusPill leaveBadge={badge} activeLeave={leave} />);
    const pill = screen.getByText(/WFH/);
    expect(pill).toHaveClass('bg-teal-100', 'text-teal-800', 'border-teal-300');
  });
});
