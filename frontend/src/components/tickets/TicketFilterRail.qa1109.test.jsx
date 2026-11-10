/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// QA 11-09 #4 "Recently closed" (was "Recently resolved") and #7 "All unresolved".
vi.mock('../../services/api', () => ({
  ticketsAPI: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], defaultType: null, typeByName: () => null, loading: false, refresh: vi.fn() }),
}));

import TicketFilterRail, { ActiveFilterBar } from './TicketFilterRail';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

const meta = { workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: {} };
const stats = { all: 120, unresolved: 41, unassigned: 6, resolved: 36 };
afterEach(cleanup);

function mount(entry = '/tickets') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TicketFilterRail meta={meta} stats={stats} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('Views: Recently closed (QA 11-09 #4)', () => {
  test('the view reads "Recently closed", keeps the old segment key and its count', () => {
    mount();
    expect(screen.queryByRole('button', { name: /Recently resolved/ })).not.toBeInTheDocument();
    const view = screen.getByRole('button', { name: /^Recently closed/ });
    expect(view).toHaveTextContent('36');
    fireEvent.click(view);
    expect(new URLSearchParams(screen.getByTestId('search').textContent).get('segment')).toBe('resolved');
  });

  test('an old ?segment=resolved link still lands on the view, and its chip says "Recently closed"', () => {
    render(
      <MemoryRouter initialEntries={['/tickets?segment=resolved']}>
        <TicketFilterRail meta={meta} stats={stats} />
        <ActiveFilterBar meta={meta} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /^Recently closed/ }).className).toMatch(/font-semibold/);
    expect(screen.getByRole('button', { name: 'Remove filter Recently closed' })).toBeInTheDocument();
  });
});

describe('Views: All unresolved (QA 11-09 #7)', () => {
  test('sits right after "All tickets", shows its count and asks for the unresolved segment', () => {
    mount();
    const all = screen.getByRole('button', { name: /^All tickets/ });
    const unresolved = screen.getByRole('button', { name: /^All unresolved/ });
    expect(all.nextElementSibling).toBe(unresolved);
    expect(unresolved).toHaveTextContent('41');
    fireEvent.click(unresolved);
    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('segment')).toBe('unresolved');
    expect(search.get('status')).toBeNull();
    expect(search.get('assignee')).toBeNull();
  });

  test('its chip reads "All unresolved"', () => {
    render(
      <MemoryRouter initialEntries={['/tickets?segment=unresolved']}>
        <ActiveFilterBar meta={meta} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Remove filter All unresolved' })).toBeInTheDocument();
  });
});
