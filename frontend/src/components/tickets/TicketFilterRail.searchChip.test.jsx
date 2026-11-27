/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// QA 11-26 #7: the search term in the "Filtered view" bar stands apart from the
// other chips (search icon, "Search:", an amber tint) with a labelled Clear button.
vi.mock('../../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], defaultType: null, typeByName: () => null, loading: false, refresh: vi.fn() }),
}));

import { ActiveFilterBar } from './TicketFilterRail';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

const meta = { workspaceId: 1, technicians: [{ id: 7, name: 'Avery Stone' }], groups: [], categoryTree: [], actor: { technicianId: 7 } };
afterEach(cleanup);

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <ActiveFilterBar meta={meta} />
    <LocationProbe />
  </MemoryRouter>,
);
const params = () => new URLSearchParams(screen.getByTestId('search').textContent);

describe('the search chip', () => {
  test('reads "Search: <term>", is tinted apart, and Clear search drops only ?q=', () => {
    renderAt('/tickets?q=12345&status=Open&assignee=7');
    const chip = screen.getByTestId('search-chip');
    expect(chip).toHaveTextContent('Search: 12345');
    expect(chip.className).toMatch(/bg-amber-50/);
    expect(chip.className).toMatch(/dark:bg-amber-500\/15/);
    expect(chip.querySelector('svg')).not.toBeNull();
    // It comes first, before the other filters.
    expect(chip.parentElement.querySelectorAll(':scope > span')[1]).toBe(chip);
    const clear = within(chip).getByRole('button', { name: 'Clear search' });
    expect(clear).toHaveTextContent('Clear');
    // The other chips keep their plain look and their names.
    expect(screen.getByRole('button', { name: 'Remove filter Open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter Avery Stone' })).toBeInTheDocument();
    fireEvent.click(clear);
    expect(params().get('q')).toBeNull();
    expect(params().get('status')).toBe('Open');
    expect(params().get('assignee')).toBe('7');
    expect(screen.queryByTestId('search-chip')).toBeNull();
  });

  test('a search alone still shows the bar, and the reset counts it', () => {
    renderAt('/tickets?q=printer');
    expect(screen.getByTestId('search-chip')).toHaveTextContent('Search: printer');
    expect(screen.getByRole('button', { name: 'Reset filters (1)' })).toBeInTheDocument();
  });

  test('no search, no search chip', () => {
    renderAt('/tickets?status=Open');
    expect(screen.queryByTestId('search-chip')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });
});
