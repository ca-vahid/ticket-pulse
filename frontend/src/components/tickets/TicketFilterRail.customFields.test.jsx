/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// Custom Fields Activation Phase 2 — the "Custom fields" facet: defs-driven
// typed inputs writing the cf_* URL param family, dynamic capture into saved
// views, clear-all coverage, and the ActiveFilterBar's generic chip.

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    customFieldDefinitions: vi.fn(() => Promise.resolve({
      data: [
        { id: 1, key: 'client_name', label: 'Client Name', type: 'text', options: [], isActive: true, isFeatured: true, sortOrder: 1 },
        { id: 2, key: 'source_system', label: 'Source System', type: 'select', options: ['Power App', 'SharePoint'], isActive: true, isFeatured: false, sortOrder: 2 },
        { id: 3, key: 'expedite', label: 'Expedite', type: 'boolean', options: [], isActive: true, isFeatured: false, sortOrder: 3 },
        { id: 4, key: 'amount', label: 'Amount', type: 'number', options: [], isActive: true, isFeatured: false, sortOrder: 4 },
      ],
    })),
    listSavedViews: vi.fn(() => Promise.resolve({ data: [] })),
    createSavedView: vi.fn(() => Promise.resolve({ data: { id: 9 } })),
    updateSavedView: vi.fn(() => Promise.resolve({})),
    deleteSavedView: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], types: [], defaultType: null, typeByName: () => null, loading: false, refresh: vi.fn() }),
}));

import TicketFilterRail, { ActiveFilterBar } from './TicketFilterRail';
import { ticketsAPI } from '../../services/api';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

afterEach(cleanup);

const meta = () => ({
  workspaceId: 1, technicians: [], groups: [], categoryTree: [], actor: { technicianId: 7, role: 'admin' }, statuses: [],
});

const renderRail = (entry = '/tickets') => render(
  <MemoryRouter initialEntries={[entry]}>
    <TicketFilterRail meta={meta()} />
    <LocationProbe />
  </MemoryRouter>,
);

const urlParams = () => new URLSearchParams(screen.getByTestId('search').textContent);

const openFacet = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /custom fields/i }));
};

describe('TicketFilterRail — Custom fields facet (Phase 2)', () => {
  test('renders a typed input per definition once the defs load', async () => {
    renderRail();
    await openFacet();
    expect(screen.getByLabelText('Filter by Client Name')).toBeInTheDocument(); // text contains
    const select = screen.getByLabelText('Filter by Source System');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveDisplayValue('Any');
    expect(screen.getByRole('group', { name: 'Filter by Expedite' })).toBeInTheDocument(); // tri-state
    expect(screen.getByLabelText('Amount minimum')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount maximum')).toBeInTheDocument();
  });

  test('select writes cf_<key>= and clears back to Any', async () => {
    renderRail();
    await openFacet();
    fireEvent.change(screen.getByLabelText('Filter by Source System'), { target: { value: 'Power App' } });
    expect(urlParams().get('cf_source_system')).toBe('Power App');
    fireEvent.change(screen.getByLabelText('Filter by Source System'), { target: { value: '' } });
    expect(urlParams().get('cf_source_system')).toBeNull();
  });

  test('boolean tri-state writes true/false and Any clears', async () => {
    renderRail();
    await openFacet();
    const group = screen.getByRole('group', { name: 'Filter by Expedite' });
    fireEvent.click(within(group).getByRole('button', { name: 'Yes' }));
    expect(urlParams().get('cf_expedite')).toBe('true');
    fireEvent.click(within(group).getByRole('button', { name: 'No' }));
    expect(urlParams().get('cf_expedite')).toBe('false');
    fireEvent.click(within(group).getByRole('button', { name: 'Any' }));
    expect(urlParams().get('cf_expedite')).toBeNull();
  });

  test('text contains input debounces into cf_<key>', async () => {
    renderRail();
    await openFacet();
    fireEvent.change(screen.getByLabelText('Filter by Client Name'), { target: { value: 'acme' } });
    await waitFor(() => expect(urlParams().get('cf_client_name')).toBe('acme'), { timeout: 1500 });
  });

  test('number min/max debounce into cf_<key>_gte / _lte', async () => {
    renderRail();
    await openFacet();
    fireEvent.change(screen.getByLabelText('Amount minimum'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Amount maximum'), { target: { value: '99' } });
    await waitFor(() => {
      expect(urlParams().get('cf_amount_gte')).toBe('10');
      expect(urlParams().get('cf_amount_lte')).toBe('99');
    }, { timeout: 1500 });
  });

  test('URL round-trip: cf params arriving via link pre-fill the inputs and pop the section open', async () => {
    renderRail('/tickets?cf_client_name=acme&cf_amount_gte=10&cf_source_system=SharePoint');
    // Section auto-opens (activeCount > 0) — inputs are visible without a click.
    expect(await screen.findByLabelText('Filter by Client Name')).toHaveValue('acme');
    expect(screen.getByLabelText('Amount minimum')).toHaveValue(10);
    expect(screen.getByLabelText('Filter by Source System')).toHaveValue('SharePoint');
  });

  test('the facet clear (X) removes every cf_* param and nothing else', async () => {
    renderRail('/tickets?cf_client_name=acme&cf_amount_gte=10&priority=3');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear Custom fields filter' }));
    const params = urlParams();
    expect(params.get('cf_client_name')).toBeNull();
    expect(params.get('cf_amount_gte')).toBeNull();
    expect(params.get('priority')).toBe('3');
  });

  test('"Clear all" resets cf_* params along with everything else', async () => {
    renderRail('/tickets?cf_client_name=acme&cf_expedite=true');
    fireEvent.click(await screen.findByRole('button', { name: /clear all \(2\)/i }));
    expect(urlParams().get('cf_client_name')).toBeNull();
    expect(urlParams().get('cf_expedite')).toBeNull();
  });

  test('saved views capture the dynamic cf_* family (schema-free params blob)', async () => {
    renderRail('/tickets?cf_client_name=acme&cf_amount_gte=10&priority=3');
    await screen.findByLabelText('Filter by Client Name');
    fireEvent.click(screen.getByRole('button', { name: /save current filters/i }));
    fireEvent.change(screen.getByPlaceholderText('View name…'), { target: { value: 'ACME big' } });
    fireEvent.click(screen.getByTitle('Save view'));
    await waitFor(() => expect(ticketsAPI.createSavedView).toHaveBeenCalledWith({
      name: 'ACME big',
      params: expect.objectContaining({ cf_client_name: 'acme', cf_amount_gte: '10', priority: '3' }),
      shared: false,
    }));
  });

  test('applying a saved view with cf params restores them to the URL', async () => {
    ticketsAPI.listSavedViews.mockResolvedValueOnce({
      data: [{ id: 5, name: 'ACME big', mine: true, shared: false, params: { cf_client_name: 'acme', cf_amount_gte: '10' } }],
    });
    renderRail();
    fireEvent.click(await screen.findByRole('button', { name: 'ACME big' }));
    const params = urlParams();
    expect(params.get('cf_client_name')).toBe('acme');
    expect(params.get('cf_amount_gte')).toBe('10');
  });
});

describe('ActiveFilterBar — generic Custom fields chip (Phase 2)', () => {
  const renderBar = (entry) => render(
    <MemoryRouter initialEntries={[entry]}>
      <ActiveFilterBar meta={meta()} />
      <LocationProbe />
    </MemoryRouter>,
  );

  test('cf params collapse into one generic chip with a count', () => {
    renderBar('/tickets?cf_client_name=acme&cf_amount_gte=10');
    expect(screen.getByText('Custom fields (2)')).toBeInTheDocument();
  });

  test('removing the chip clears every cf_* param', () => {
    renderBar('/tickets?cf_client_name=acme&cf_amount_gte=10&priority=3');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Custom fields (2)' }));
    const params = urlParams();
    expect(params.get('cf_client_name')).toBeNull();
    expect(params.get('cf_amount_gte')).toBeNull();
    expect(params.get('priority')).toBe('3');
  });

  test('a single cf param reads simply "Custom fields"', () => {
    renderBar('/tickets?cf_client_name=acme');
    expect(screen.getByText('Custom fields')).toBeInTheDocument();
  });
});
