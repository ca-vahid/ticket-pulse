/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

describe('TicketFilterRail canned views (QA 08-04 #15)', () => {
  test('"My open" pins an explicit Open-only status scope next to the assignee filter (QA 10-16 #5)', () => {
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <TicketFilterRail meta={{ workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: { technicianId: 7 } }} />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'My open' }));

    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('assignee')).toBe('7');
    // Board and list read the same param — closed cards can never sneak in.
    // Pending / Pending Response are not "open" (QA 10-16 #5).
    expect(search.get('status')).toBe('Open');
  });

  test('"My tickets" = Open + Pending bases + parked, with counts from the matching stats maps', () => {
    const meta = {
      workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: { technicianId: 7 },
      statuses: [
        { name: 'Open', baseStatus: 'Open' }, { name: 'Pending', baseStatus: 'Pending' },
        { name: 'Pending Response', baseStatus: 'Pending' }, { name: 'Resolved', baseStatus: 'Resolved' }, { name: 'Closed', baseStatus: 'Closed' },
      ],
    };
    const stats = { byTechnician: { 7: 9 }, byTechnicianOpenOnly: { 7: 1 }, byTechnicianActive: { 7: 4 } };
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <TicketFilterRail meta={meta} stats={stats} />
        <LocationProbe />
      </MemoryRouter>,
    );

    const myOpen = screen.getByRole('button', { name: /^My open/ });
    const myTickets = screen.getByRole('button', { name: /^My tickets/ });
    expect(myOpen).toHaveTextContent('1');
    expect(myTickets).toHaveTextContent('4');
    // "My tickets" sits right after "My open".
    expect(myOpen.nextElementSibling).toBe(myTickets);

    fireEvent.click(myTickets);
    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('assignee')).toBe('7');
    expect(search.get('status')).toBe('Open,Pending,Pending Response,parked');
  });

  test('"All tickets" view stays status=any (the stat card now mirrors this)', () => {
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <TicketFilterRail meta={{ workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: {} }} />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /All tickets/ }));

    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('status')).toBe('any');
  });
});

// Mega 08-23 Phase FC (FC4): the Created presets gain "This year" so the rail
// agrees with the created_week/month/year quick cards.
describe('TicketFilterRail created presets', () => {
  test('"This year" applies Jan 1 → today', () => {
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <TicketFilterRail meta={{ workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: {} }} />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Created/ }));
    fireEvent.click(screen.getByRole('button', { name: 'This year' }));

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('createdFrom')).toBe(`${now.getFullYear()}-01-01`);
    expect(search.get('createdTo')).toBe(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  });
});

// QA 10-16 #7: the Created section carries the same date window as the toolbar.
describe('TicketFilterRail date window', () => {
  const META = { workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: {} };

  test('standalone: a window choice writes ?created= and drops explicit dates', () => {
    render(
      <MemoryRouter initialEntries={['/tickets?createdFrom=2026-01-01&createdTo=2026-01-31']}>
        <TicketFilterRail meta={META} />
        <LocationProbe />
      </MemoryRouter>,
    );
    // Explicit dates already open the Created section.
    const group = screen.getByTestId('rail-window');
    fireEvent.click(within(group).getByRole('button', { name: 'All time' }));
    const search = new URLSearchParams(screen.getByTestId('search').textContent);
    expect(search.get('created')).toBe('all');
    expect(search.get('createdFrom')).toBeNull();
    expect(within(group).getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('on the Tickets page it shows the page window and hands picks back', () => {
    const onPick = vi.fn();
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <TicketFilterRail meta={META} createdWindow={{ key: '90d', custom: false, applied: true, statsKey: '90d', searching: false }} onCreatedWindow={onPick} />
        <LocationProbe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Created/ }));
    const group = screen.getByTestId('rail-window');
    expect(within(group).getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(group).getByRole('button', { name: '7 days' }));
    expect(onPick).toHaveBeenCalledWith('7d');
    // The page owns the default; the rail never writes a token for it.
    expect(new URLSearchParams(screen.getByTestId('search').textContent).get('created')).toBeNull();
  });
});
