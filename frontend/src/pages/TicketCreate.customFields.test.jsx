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

// Mega 08-23 Phase TF — required-on-create + defaults on custom fields:
// a required definition auto-opens the section, gets a * marker, and blocks
// submit with an inline error; a defaultValue prefills its input and travels
// in the payload untouched.
describe('TicketCreate — custom fields required + defaults (Phase TF)', () => {
  const REQUIRED_DEFS = [
    { id: 1, key: 'cost_centre', label: 'Cost centre', type: 'text', options: [], isRequiredOnCreate: true, defaultValue: null },
    { id: 2, key: 'region', label: 'Region', type: 'select', options: ['Quebec', 'Ontario'], isRequiredOnCreate: false, defaultValue: 'Quebec' },
  ];

  test('a required definition auto-opens the section and blocks submit with an inline error', async () => {
    ticketsAPI.customFieldDefinitions.mockResolvedValueOnce({ data: REQUIRED_DEFS });
    await renderPage();

    // Auto-opened (required fields must not hide in a collapsed section).
    const toggle = screen.getByRole('button', { name: /Custom fields/ });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    // Region's default already counts as set; the header reflects it.
    expect(screen.getByText('1 set')).toBeInTheDocument();
    // Required marker on the label.
    expect(screen.getByText('Cost centre').closest('label')).toHaveTextContent('*');

    fireEvent.change(screen.getByPlaceholderText('Search people by name or email…'), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: 'Needs the money field' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);

    expect(await screen.findByText('Cost centre is required')).toBeInTheDocument();
    expect(ticketsAPI.create).not.toHaveBeenCalled();

    // Filling it clears the block on the next submit.
    fireEvent.change(screen.getByLabelText(/Cost centre/), { target: { value: 'CC-42' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0].customFields).toEqual(expect.objectContaining({ cost_centre: 'CC-42' }));
  });

  test('defaultValue prefills the input and travels in the payload', async () => {
    ticketsAPI.customFieldDefinitions.mockResolvedValueOnce({ data: [REQUIRED_DEFS[1]] });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Custom fields/ }));
    expect(screen.getByLabelText('Region')).toHaveValue('Quebec');

    fireEvent.change(screen.getByPlaceholderText('Search people by name or email…'), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: 'Default rides along' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0].customFields).toEqual({ region: 'Quebec' });
  });
});
