/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// 5 Nov 2026: ?resolvedFrom / ?resolvedTo (the daily brief's "resolved in the
// last 7 days" link) explain themselves as a removable chip.
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

const meta = { workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: { technicianId: 7 } };
afterEach(cleanup);

describe('Resolved-date chip', () => {
  test('resolvedFrom alone reads "Resolved since …" and removing it clears both keys', () => {
    render(
      <MemoryRouter initialEntries={['/tickets?segment=resolved&assignee=7&resolvedFrom=2026-10-29']}>
        <ActiveFilterBar meta={meta} />
        <LocationProbe />
      </MemoryRouter>,
    );
    const chip = screen.getByRole('button', { name: /Remove filter Resolved since/ });
    expect(chip).toBeInTheDocument();
    fireEvent.click(chip);
    const params = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(params.get('resolvedFrom')).toBeNull();
    expect(params.get('assignee')).toBe('7');
  });

  test('a from–to pair reads as a range', () => {
    render(
      <MemoryRouter initialEntries={['/tickets?resolvedFrom=2026-10-29&resolvedTo=2026-11-04']}>
        <ActiveFilterBar meta={meta} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /Remove filter Resolved .+ – / })).toBeInTheDocument();
  });
});
