/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TicketCreate from './TicketCreate';
import { ticketsAPI } from '../services/api';

// Phase MR3 (QA 08-26 #3) — the create form's Cc block is promoted to
// "Also for (additional requesters)": labeled, with the "they receive every
// reply" hint, real chips (GAL typeahead + typed addresses), and the
// addresses travel as the create payload's ccEmails. Form-config key stays
// `cc`, so "required" keeps working.

const FIELD = (key, extra = {}) => ({ key, visible: true, required: false, defaultValue: null, sortOrder: 0, locked: false, ...extra });
function makeForm(overrides = {}) {
  const byKey = Object.fromEntries((overrides.fields || []).map((f) => [f.key, f]));
  return {
    fields: ['requester', 'subject', 'description', 'type', 'priority', 'category', 'subcategory', 'source', 'group', 'tags', 'cc', 'attachments']
      .map((key, i) => ({ ...FIELD(key, key === 'requester' || key === 'subject' ? { locked: true, required: true } : {}), sortOrder: i, ...(byKey[key] || {}) })),
    defaultSource: 103,
    defaultGroup: null,
    defaults: { notifyRequester: true, aiClassify: true, assignMode: 'none' },
  };
}

const { metaRef } = vi.hoisted(() => ({ metaRef: { value: null } }));

vi.mock('../services/api', () => ({
  ticketsAPI: {
    meta: vi.fn(() => Promise.resolve({ data: metaRef.value })),
    createTemplates: vi.fn(() => Promise.resolve({ data: [] })),
    customFieldDefinitions: vi.fn(() => Promise.resolve({ data: [] })),
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
vi.mock('../components/tickets/StagedFileChip', () => ({ default: () => null }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [], defaultType: null }),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

function setMeta(form) {
  metaRef.value = {
    nativeTicketingEnabled: true,
    actor: { technicianId: 7 },
    technicians: [],
    categoryTree: [{ id: 1, name: 'Hardware', subcategories: [] }],
    categoryGroupLinks: [],
    groups: [{ id: 5, freshserviceId: null, name: 'Internal AP', origin: 'local' }],
    tags: [],
    form,
  };
}

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

const fillMinimum = () => {
  fireEvent.change(screen.getByPlaceholderText('Search people by name or email…'), { target: { value: 'jane@acme.com' } });
  fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: 'Coyote Landslide' } });
};

const alsoForInput = () => screen.getByRole('combobox', { name: 'Also for (additional requesters)' });
const addAlsoFor = (email) => {
  fireEvent.change(alsoForInput(), { target: { value: email } });
  fireEvent.keyDown(alsoForInput(), { key: 'Enter' });
};

describe('TicketCreate — "Also for (additional requesters)" (Phase MR3)', () => {
  test('the block is labeled "Also for", carries the every-reply hint and the chip row reads "Also for" (not "Cc")', async () => {
    setMeta(makeForm());
    await renderPage();
    // The block label + the chip-row prefix both read "Also for".
    expect(screen.getAllByText('Also for')).toHaveLength(2);
    expect(screen.getByText(/\(additional requesters/)).toBeInTheDocument();
    expect(screen.getByText('They receive every reply to the requester')).toBeInTheDocument();
    expect(alsoForInput()).toHaveAttribute('placeholder', 'Add additional requesters by name or email…');
    expect(screen.queryByRole('combobox', { name: 'Cc recipients' })).not.toBeInTheDocument();
  });

  test('two typed addresses become chips and travel as ccEmails in the create payload', async () => {
    setMeta(makeForm());
    await renderPage();
    fillMinimum();
    addAlsoFor('Manager@Example.com');
    addAlsoFor('assistant@example.com');
    expect(screen.getByRole('button', { name: 'Remove manager@example.com from Also for' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove assistant@example.com from Also for' })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0].ccEmails).toEqual(['manager@example.com', 'assistant@example.com']);
  });

  test('form-config key `cc` still drives visibility + required ("Add at least one additional requester")', async () => {
    setMeta(makeForm({ fields: [{ key: 'cc', required: true }] }));
    await renderPage();
    expect(alsoForInput()).toHaveAttribute('placeholder', expect.stringContaining('(required)'));
    fillMinimum();
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    expect(await screen.findByText('Add at least one additional requester')).toBeInTheDocument();
    expect(ticketsAPI.create).not.toHaveBeenCalled();

    cleanup();
    setMeta(makeForm({ fields: [{ key: 'cc', visible: false }] }));
    await renderPage();
    expect(screen.queryByRole('combobox', { name: 'Also for (additional requesters)' })).not.toBeInTheDocument();
  });
});
