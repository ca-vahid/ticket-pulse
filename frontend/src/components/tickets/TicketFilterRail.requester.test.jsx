/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// QA 10-27 #5: a Requester section in the Tickets filter rail — the Members
// pattern (search box + checklist), fed by the requester search endpoint.
const api = vi.hoisted(() => ({
  requesterSearch: vi.fn(),
  requesterProfile: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  ticketsAPI: new Proxy({}, {
    get: (_t, key) => (key in api ? api[key] : () => new Promise(() => {})),
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

const meta = { workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: { technicianId: 7 } };
const params = () => new URLSearchParams(screen.getByTestId('search').textContent);

beforeEach(() => {
  api.requesterSearch.mockReset();
  api.requesterProfile.mockReset();
  api.requesterSearch.mockResolvedValue({
    data: {
      requesters: [
        { id: 41, name: 'Ada Example', email: 'ada@example.test' },
        { id: 42, name: 'Adam Sample', email: 'adam@example.test' },
      ],
      // Directory-only people have no requester id yet: not offered.
      directory: [{ id: null, name: 'Adele Directory', email: 'adele@example.test' }],
    },
  });
  api.requesterProfile.mockImplementation((id) => Promise.resolve({ data: { requester: { id: Number(id), name: `Person ${id}` } } }));
});
afterEach(cleanup);

function renderRail(url = '/tickets') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ActiveFilterBar meta={meta} />
      <TicketFilterRail meta={meta} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('Requester filter (QA 10-27 #5)', () => {
  test('search as you type, pick two requesters → requesterId is a comma list', async () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: /Requester/ }));
    const box = screen.getByLabelText('Search requesters');
    fireEvent.change(box, { target: { value: 'ad' } });
    await waitFor(() => expect(api.requesterSearch).toHaveBeenCalledWith('ad'));
    const facet = screen.getByTestId('requester-facet');
    await waitFor(() => expect(within(facet).getByLabelText(/Ada Example/)).toBeInTheDocument());
    expect(within(facet).queryByText('Adele Directory')).toBeNull();

    fireEvent.click(within(facet).getByLabelText(/Ada Example/));
    fireEvent.click(within(facet).getByLabelText(/Adam Sample/));
    expect(params().get('requesterId')).toBe('41,42');
    // Each pick is a removable chip, named from the search results.
    expect(screen.getByRole('button', { name: 'Remove filter Requester: Ada Example' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter Requester: Adam Sample' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Requester: Ada Example' }));
    expect(params().get('requesterId')).toBe('42');
  });

  test('a deep link names its requester from ?requesterName= and drops it on the first change', async () => {
    renderRail('/tickets?requesterId=77&requesterName=Rita%20Requester&status=any');
    expect(await screen.findByRole('button', { name: 'Remove filter Requester: Rita Requester' })).toBeInTheDocument();
    expect(api.requesterProfile).not.toHaveBeenCalled();
    const facet = screen.getByTestId('requester-facet');
    fireEvent.click(within(facet).getByLabelText(/Rita Requester/));
    expect(params().get('requesterId')).toBeNull();
    expect(params().get('requesterName')).toBeNull();
  });

  test('ids without a known name are looked up once', async () => {
    renderRail('/tickets?requesterId=88');
    expect(await screen.findByRole('button', { name: 'Remove filter Requester: Person 88' })).toBeInTheDocument();
    expect(api.requesterProfile).toHaveBeenCalledTimes(1);
  });

  test('Clear all drops the requester filter too', async () => {
    renderRail('/tickets?requesterId=41');
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Clear all/ }));
    expect(params().get('requesterId')).toBeNull();
  });
});
