/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], defaultType: null, typeByName: () => null, loading: false, refresh: vi.fn() }),
}));

import TicketFilterRail from './TicketFilterRail';

afterEach(cleanup);

const META = { workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: {} };

// 16 Oct 2026 (Vahid): the filter rail got long; "Find a filter" narrows it to
// the sections whose name matches, like FreshService's "Search fields".
describe('TicketFilterRail — Find a filter', () => {
  test('typing keeps only matching sections; Escape brings them all back', () => {
    render(<MemoryRouter initialEntries={['/tickets']}><TicketFilterRail meta={META} docked /></MemoryRouter>);
    const rail = screen.getByRole('complementary', { name: 'Ticket filters' });
    expect(within(rail).getByText('Views')).toBeInTheDocument();
    expect(within(rail).getByText('Priority')).toBeInTheDocument();

    const box = within(rail).getByTestId('rail-find');
    fireEvent.change(box, { target: { value: 'PRI' } });
    expect(within(rail).getByText('Priority')).toBeInTheDocument();
    expect(within(rail).queryByText('Views')).not.toBeInTheDocument();
    expect(within(rail).queryByText('Status')).not.toBeInTheDocument();

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box).toHaveValue('');
    expect(within(rail).getByText('Views')).toBeInTheDocument();
  });

  test('docked: the rail fills its pane instead of sticking to the page', () => {
    const { rerender } = render(<MemoryRouter><TicketFilterRail meta={META} docked /></MemoryRouter>);
    const rail = () => screen.getByRole('complementary', { name: 'Ticket filters' });
    expect(rail().className).toContain('h-full');
    // The slim layer (absolute) needs a containing block, or a collapsed rail's
    // expand button floats to the top of the page (4.2.78 regression).
    expect(rail().className).toContain('relative');
    expect(rail().className).not.toContain('sticky');
    rerender(<MemoryRouter><TicketFilterRail meta={META} /></MemoryRouter>);
    // Page-scroll mode docks UNDER the app header (it used to slide beneath it).
    expect(rail().className).toContain('sticky');
    expect(rail().className).toContain('--tp-app-header-h');
  });
});
