/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * MEGA 11-14 Part H — "Mentions me" is a filter beside Members, not only a
 * view: it combines with status and search, has "Not opened yet / All" and a
 * period, reads as one chip, the Mentions view just sets it, and it is hidden
 * for someone who has no agent row here (they can never be mentioned here).
 */

vi.mock('../../services/api', () => ({
  ticketsAPI: new Proxy({}, {
    get: (_t, key) => (key === 'mentionsUnseenCount'
      ? () => Promise.resolve({ data: { count: 2 } })
      : () => new Promise(() => {})),
  }),
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], defaultType: null, typeByName: () => null, loading: false, refresh: vi.fn() }),
}));

import TicketFilterRail, { ActiveFilterBar } from './TicketFilterRail';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}
const params = () => new URLSearchParams(screen.getByTestId('search').textContent);
const meta = (technicianId = 7) => ({
  workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: technicianId ? { technicianId } : { technicianId: null },
  statuses: [{ name: 'Open', baseStatus: 'Open' }, { name: 'Pending', baseStatus: 'Pending' }, { name: 'Closed', baseStatus: 'Closed' }],
});
const renderRail = (url = '/tickets', m = meta()) => render(
  <MemoryRouter initialEntries={[url]}>
    <TicketFilterRail meta={m} />
    <ActiveFilterBar meta={m} />
    <LocationProbe />
  </MemoryRouter>,
);

afterEach(cleanup);

describe('the Mentions filter', () => {
  test('sits next to Members and combines with a status pick and the search', async () => {
    renderRail('/tickets?status=Open&q=printer');
    await act(async () => {});
    const box = screen.getByTestId('mentions-filter');
    expect(within(box).getByText('2 new')).toBeInTheDocument();
    fireEvent.click(within(box).getByRole('checkbox'));
    const p = params();
    expect(p.get('mentioned')).toBe('me');
    expect(p.get('status')).toBe('Open');
    expect(p.get('q')).toBe('printer');
    // No id ever goes in the URL: the server reads "me" from the session.
    expect(p.get('mentionedTechnicianId')).toBeNull();
  });

  test('Not opened yet / All, and 30 days · 90 days · Any time', () => {
    renderRail('/tickets?mentioned=me');
    const options = screen.getByTestId('mentions-options');
    const show = within(options).getByRole('radiogroup', { name: 'Show' });
    const from = within(options).getByRole('radiogroup', { name: 'From' });
    expect(within(show).getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    expect(within(from).getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(within(show).getByRole('radio', { name: 'Not opened yet' }));
    fireEvent.click(within(from).getByRole('radio', { name: '90 days' }));
    expect(params().get('mentionedUnseen')).toBe('1');
    expect(params().get('mentionedSince')).toBe('90');

    fireEvent.click(within(from).getByRole('radio', { name: 'Any time' }));
    expect(params().get('mentionedSince')).toBe('any');
    fireEvent.click(within(from).getByRole('radio', { name: '30 days' }));
    expect(params().get('mentionedSince')).toBeNull(); // the default is not written
    fireEvent.click(within(show).getByRole('radio', { name: 'All' }));
    expect(params().get('mentionedUnseen')).toBeNull();
  });

  test('one chip says the choices; removing it clears all three', () => {
    renderRail('/tickets?mentioned=me&mentionedUnseen=1&mentionedSince=90&status=Open');
    const chip = screen.getByText('Mentions of me · not opened yet · 90 days');
    const remove = chip.closest('span')?.querySelector('button') || chip.parentElement.querySelector('button');
    fireEvent.click(remove);
    const p = params();
    expect(p.get('mentioned')).toBeNull();
    expect(p.get('mentionedUnseen')).toBeNull();
    expect(p.get('mentionedSince')).toBeNull();
    expect(p.get('status')).toBe('Open');
  });

  test('turning the filter off drops its choices too', () => {
    renderRail('/tickets?mentioned=me&mentionedSince=any');
    fireEvent.click(within(screen.getByTestId('mentions-filter')).getByRole('checkbox'));
    expect(params().get('mentioned')).toBeNull();
    expect(params().get('mentionedSince')).toBeNull();
  });

  test('the Mentions view stays and just sets this filter', () => {
    renderRail('/tickets');
    // The view row (the section header with the same word is a disclosure button).
    const viewButton = screen.getAllByRole('button', { name: /^Mentions/ }).find((b) => !b.hasAttribute('aria-expanded'));
    fireEvent.click(viewButton);
    expect(params().get('mentioned')).toBe('me');
    expect(within(screen.getByTestId('mentions-filter')).getByRole('checkbox')).toBeChecked();
  });

  test('hidden, with no error, for someone with no agent row in this workspace', () => {
    renderRail('/tickets', meta(null));
    expect(screen.queryByTestId('mentions-filter')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /^Mentions/ })).toHaveLength(0);
  });
});
