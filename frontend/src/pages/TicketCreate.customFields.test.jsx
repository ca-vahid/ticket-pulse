/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TicketCreate from './TicketCreate';
import { ticketsAPI } from '../services/api';

// FR 08-05 #1 (Phase 1c) — the create form's optional "Custom fields"
// section: defs-driven typed inputs for parity with API intake. Collapsed by
// default, absent when the workspace defines nothing, and only filled values
// travel in the payload.

const META = {
  nativeTicketingEnabled: true,
  actor: { technicianId: 7 },
  technicians: [],
  categoryTree: [],
  categoryGroupLinks: [],
  groups: [],
  tags: [],
};

const DEFS = [
  { id: 1, key: 'client_name', label: 'Client Name', type: 'text', options: [] },
  { id: 2, key: 'region', label: 'Region', type: 'select', options: ['Quebec', 'Ontario'] },
  { id: 3, key: 'record_id', label: 'Record Id', type: 'number', options: [] },
];

vi.mock('../services/api', () => ({
  ticketsAPI: {
    meta: vi.fn(() => Promise.resolve({ data: META })),
    createTemplates: vi.fn(() => Promise.resolve({ data: [] })),
    customFieldDefinitions: vi.fn(() => Promise.resolve({ data: DEFS })),
    requesterSearch: vi.fn(() => Promise.resolve({ data: { requesters: [], directory: [] } })),
    requesterPhoto: vi.fn(() => Promise.resolve({ data: {} })),
    requesterStats: vi.fn(() => Promise.resolve({ data: {} })),
    create: vi.fn(() => Promise.resolve({ data: { id: 9, displayRef: 'TP-9' } })),
    uploadAttachments: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/RichTextEditor', () => ({
  default: () => <div data-testid="rte" />,
  isRichContent: () => false,
}));
vi.mock('../components/tickets/CcChips', () => ({ default: () => <div data-testid="cc" /> }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: () => null }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], defaultType: null }),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderPage() {
  render(
    <MemoryRouter initialEntries={['/tickets/new']}>
      <Routes>
        <Route path="/tickets/new" element={<TicketCreate />} />
        <Route path="/tickets/:id" element={<div>ticket page</div>} />
        <Route path="/tickets" element={<div>queue</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByLabelText(/Subject/)).toBeInTheDocument());
}

describe('TicketCreate — custom fields section (Phase 1c)', () => {
  test('renders collapsed by default and expands to defs-driven typed inputs', async () => {
    await renderPage();
    const toggle = screen.getByRole('button', { name: /Custom fields/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Client Name')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Client Name')).toBeInTheDocument();
    // Typed inputs: select renders its options, number renders a number input.
    expect(screen.getByLabelText('Region').tagName).toBe('SELECT');
    expect(screen.getByRole('option', { name: 'Quebec' })).toBeInTheDocument();
    expect(screen.getByLabelText('Record Id')).toHaveAttribute('type', 'number');
  });

  test('the section is absent when the workspace has no definitions', async () => {
    ticketsAPI.customFieldDefinitions.mockResolvedValueOnce({ data: [] });
    await renderPage();
    expect(screen.queryByRole('button', { name: /Custom fields/ })).not.toBeInTheDocument();
  });

  test('only filled values travel in the create payload', async () => {
    await renderPage();
    // Requester (typed email) + subject make the form submittable.
    fireEvent.change(screen.getByPlaceholderText('Search people by name or email…'), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: 'Coyote Landslide' } });

    fireEvent.click(screen.getByRole('button', { name: /Custom fields/ }));
    fireEvent.change(screen.getByLabelText('Client Name'), { target: { value: 'ACME Inc' } });
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'Quebec' } });
    // Record Id left empty — must NOT appear in the payload.

    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    const payload = ticketsAPI.create.mock.calls[0][0];
    expect(payload.customFields).toEqual({ client_name: 'ACME Inc', region: 'Quebec' });
  });

  test('no custom fields touched → the payload omits customFields entirely', async () => {
    await renderPage();
    fireEvent.change(screen.getByPlaceholderText('Search people by name or email…'), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: 'Plain ticket' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect('customFields' in ticketsAPI.create.mock.calls[0][0]).toBe(false);
  });
});
