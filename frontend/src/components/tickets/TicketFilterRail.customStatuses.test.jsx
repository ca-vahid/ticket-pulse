/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], defaultType: null, typeByName: () => null, loading: false, refresh: vi.fn() }),
}));

import TicketFilterRail from './TicketFilterRail';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

afterEach(cleanup);

// Workspace registry with customs (Phase 8b): 'Needs Rework' is Pending-base,
// 'Fixed' is Resolved-base.
const STATUSES = [
  { name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true },
  { name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true },
  { name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true },
  { name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true },
  { name: 'Needs Rework', baseStatus: 'Pending', color: 'orange', sortOrder: 4, isSystem: false },
  { name: 'Fixed', baseStatus: 'Resolved', color: 'violet', sortOrder: 5, isSystem: false },
];
const meta = (overrides = {}) => ({
  workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: { technicianId: 7 }, statuses: STATUSES, ...overrides,
});

const renderRail = (entry = '/tickets', m = meta()) => render(
  <MemoryRouter initialEntries={[entry]}>
    <TicketFilterRail meta={m} />
    <LocationProbe />
  </MemoryRouter>,
);

describe('TicketFilterRail workspace custom statuses (Phase 8b)', () => {
  test('renders every registry status as a facet, custom names included', () => {
    renderRail();
    for (const s of STATUSES) {
      expect(screen.getByRole('checkbox', { name: new RegExp(s.name, 'i') })).toBeInTheDocument();
    }
  });

  test('default scope checks every Open/Pending-BASE status — "Needs Rework" arrives checked', () => {
    renderRail();
    expect(screen.getByRole('checkbox', { name: /needs rework/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^open/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /fixed/i })).not.toBeChecked();
  });

  test('toggling a custom status round-trips it through ?status=', () => {
    renderRail();
    fireEvent.click(screen.getByRole('checkbox', { name: /fixed/i }));
    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('status').split(',')).toEqual(['Open', 'Pending', 'Needs Rework', 'Fixed']);
  });

  test('a custom name arriving via URL stays checked (the old dropper silently discarded it)', () => {
    renderRail('/tickets?status=Needs%20Rework');
    expect(screen.getByRole('checkbox', { name: /needs rework/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^open/i })).not.toBeChecked();
  });

  test('names the workspace does not define are dropped once meta is loaded', () => {
    renderRail('/tickets?status=Bogus,Open');
    expect(screen.getByRole('checkbox', { name: /^open/i })).toBeChecked();
    // Only Open counts toward the facet badge (Bogus was discarded).
    expect(screen.getByRole('checkbox', { name: /needs rework/i })).not.toBeChecked();
  });

  test('meta not loaded → canonical 4 facets, and unknown URL names pass through untouched', () => {
    renderRail('/tickets?status=Needs%20Rework', meta({ statuses: undefined }));
    expect(screen.queryByRole('checkbox', { name: /needs rework/i })).not.toBeInTheDocument();
    // The raw param is preserved for when meta lands.
    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('status')).toBe('Needs Rework');
  });

  test('"My open" pins the full Open/Pending-BASE scope, customs included', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'My open' }));
    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('assignee')).toBe('7');
    expect(search.get('status')).toBe('Open,Pending,Needs Rework');
  });
});
