/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// QA 10-14 #1: an admin hides the feature views a workspace does not use.
vi.mock('../../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], defaultType: null, typeByName: () => null, loading: false, refresh: vi.fn() }),
}));

import TicketFilterRail from './TicketFilterRail';

afterEach(cleanup);

const meta = { workspaceId: 5, technicians: [], groups: [], categoryTree: [], actor: { technicianId: 7 } };
const FEATURE_VIEWS = [/^Verified solutions/, /^Scheduled/, /^Grouped/, /^Parked/, /^Auto-help waiting/];

describe('TicketFilterRail — hidden views', () => {
  test('nothing hidden: all five feature views show', () => {
    render(<MemoryRouter><TicketFilterRail meta={meta} /></MemoryRouter>);
    for (const name of FEATURE_VIEWS) expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0);
  });

  test('hidden views leave the rail; the rest stay', () => {
    render(<MemoryRouter><TicketFilterRail meta={{ ...meta, hiddenViews: ['solutions', 'grouped', 'auto_help_waiting'] }} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /^Verified solutions/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Grouped/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Auto-help waiting/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Scheduled/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Parked/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^All tickets/ })).toBeInTheDocument();
  });
});
