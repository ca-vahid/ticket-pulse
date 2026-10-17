/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], defaultType: null, typeByName: () => null, loading: false, refresh: vi.fn() }),
}));

import TicketFilterRail from './TicketFilterRail';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const META = { workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: {} };
const mount = (props = {}) => render(<MemoryRouter><TicketFilterRail meta={META} docked {...props} /></MemoryRouter>);
const rail = () => screen.getByRole('complementary', { name: 'Ticket filters', hidden: true });

// 16 Oct 2026 (Vahid): pinned is today's rail; unpinned, it tucks away while
// the list is scrolled and slides out over the list on hover.
describe('TicketFilterRail — pin and auto-tuck', () => {
  test('pinned (the default) ignores the scrolled list', () => {
    mount({ tucked: true });
    expect(screen.getByTestId('rail-pin')).toHaveAttribute('aria-pressed', 'true');
    expect(rail()).not.toHaveAttribute('data-tucked');
    expect(rail().className).toContain('w-[clamp(256px,15vw,320px)]');
  });

  test('unpinned: tucks while scrolled, peeks over the list on hover, remembers the choice', () => {
    vi.useFakeTimers();
    const { rerender } = mount({ tucked: false });
    fireEvent.click(screen.getByTestId('rail-pin'));
    expect(localStorage.getItem('tp_filter_rail_pin')).toBe('auto');
    expect(rail()).not.toHaveAttribute('data-tucked');

    rerender(<MemoryRouter><TicketFilterRail meta={META} docked tucked /></MemoryRouter>);
    expect(rail()).toHaveAttribute('data-tucked', 'true');
    expect(rail().className).toContain('w-11');

    fireEvent.mouseEnter(rail());
    act(() => { vi.advanceTimersByTime(400); });
    expect(rail()).toHaveAttribute('data-peek', 'true');
    // The panel floats over the list; the rail itself stays slim.
    expect(screen.getByTestId('rail-panel').className).toContain('absolute');
    expect(rail().className).toContain('w-11');

    fireEvent.mouseLeave(rail());
    act(() => { vi.advanceTimersByTime(400); });
    expect(rail()).not.toHaveAttribute('data-peek');

    // Back at the top of the list the full rail returns.
    rerender(<MemoryRouter><TicketFilterRail meta={META} docked tucked={false} /></MemoryRouter>);
    expect(rail()).not.toHaveAttribute('data-tucked');
  });

  test('the third collapse by hand offers auto-tuck once; "Turn it on" unpins', () => {
    mount();
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse filters', hidden: true }));
      fireEvent.click(screen.getAllByRole('button', { name: 'Expand filters', hidden: true })[0]);
    }
    expect(screen.queryByTestId('rail-tuck-hint')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse filters', hidden: true }));
    expect(screen.getByTestId('rail-tuck-hint')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }));
    expect(screen.queryByTestId('rail-tuck-hint')).not.toBeInTheDocument();
    expect(localStorage.getItem('tp_filter_rail_pin')).toBe('auto');
    expect(rail()).not.toHaveAttribute('data-collapsed');
  });

  test('the hint never comes back once shown', () => {
    localStorage.setItem('tp_filter_rail_hint', 'shown');
    localStorage.setItem('tp_filter_rail_collapses', '9');
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse filters', hidden: true }));
    expect(screen.queryByTestId('rail-tuck-hint')).not.toBeInTheDocument();
  });

  test('no pin off the docked layout', () => {
    render(<MemoryRouter><TicketFilterRail meta={META} /></MemoryRouter>);
    expect(screen.queryByTestId('rail-pin')).not.toBeInTheDocument();
  });
});
