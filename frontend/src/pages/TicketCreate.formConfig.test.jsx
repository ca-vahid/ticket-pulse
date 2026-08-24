/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TicketCreate from './TicketCreate';
import { ticketsAPI } from '../services/api';

// Mega 08-23 Phase TF (TF4) — the composer consumes meta.form:
//  - initial state from the workspace config (source / group preselects,
//    notifyRequester / aiClassify / assignMode defaults)
//  - hidden built-ins simply don't render
//  - required built-ins block submit with a clear inline error
//  - requester + subject stay hard-required regardless of config

const FIELD = (key, extra = {}) => ({ key, visible: true, required: false, defaultValue: null, sortOrder: 0, locked: false, ...extra });

function makeForm(overrides = {}) {
  const byKey = Object.fromEntries((overrides.fields || []).map((f) => [f.key, f]));
  return {
    fields: ['requester', 'subject', 'description', 'type', 'priority', 'category', 'subcategory', 'source', 'group', 'tags', 'cc', 'attachments']
      .map((key, i) => ({ ...FIELD(key, key === 'requester' || key === 'subject' ? { locked: true, required: true } : {}), sortOrder: i, ...(byKey[key] || {}) })),
    defaultSource: overrides.defaultSource ?? 103,
    defaultGroup: overrides.defaultGroup ?? null,
    defaults: { notifyRequester: true, aiClassify: true, assignMode: 'none', ...(overrides.defaults || {}) },
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
}))
;
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

function setMeta(form) {
  metaRef.value = {
    nativeTicketingEnabled: true,
    actor: { technicianId: 7 },
    technicians: [],
    categoryTree: [{ id: 1, name: 'Hardware', subcategories: [] }],
    categoryGroupLinks: [],
    groups: [
      { id: 5, freshserviceId: null, name: 'Internal AP', origin: 'local' },
      { id: 6, freshserviceId: '9000', name: 'Service Desk', origin: 'freshservice' },
    ],
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

describe('TicketCreate — form config consumption (TF4)', () => {
  test('hidden built-ins do not render (source hidden here); visible ones stay', async () => {
    setMeta(makeForm({ fields: [{ key: 'source', visible: false }] }));
    await renderPage();
    expect(screen.queryByLabelText('Source')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toBeInTheDocument();
  });

  test('workspace defaults preselect: source, group (visibly marked), assignMode, notifyRequester', async () => {
    setMeta(makeForm({
      defaultSource: 3, // Phone
      defaultGroup: { kind: 'internal', id: '5' },
      defaults: { notifyRequester: false, aiClassify: true, assignMode: 'ai' },
    }));
    await renderPage();
    await waitFor(() => expect(screen.getByLabelText('Source')).toHaveValue('3'));
    expect(screen.getByLabelText(/Group/)).toHaveValue('int:5');
    expect(screen.getByText(/Preselected — this workspace's default group/)).toBeInTheDocument();
    // Config assignMode 'ai' checks the AI radio; notifyRequester:false checks the suppress box.
    expect(screen.getByRole('radio', { name: /AI recommends an assignee/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Don.t email the requester/ })).toBeChecked();
  });

  test('a hidden group field still ships the default group in the payload (silent default)', async () => {
    setMeta(makeForm({
      defaultGroup: { kind: 'fs', id: '9000' },
      fields: [{ key: 'group', visible: false }],
    }));
    await renderPage();
    expect(screen.queryByLabelText(/Group/)).not.toBeInTheDocument();
    fillMinimum();
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0].groupId).toBe(9000);
  });

  test('a required description blocks submit with an inline error and no API call', async () => {
    setMeta(makeForm({ fields: [{ key: 'description', required: true }] }));
    await renderPage();
    fillMinimum();
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);

    expect(await screen.findByText('A description is required')).toBeInTheDocument();
    expect(screen.getByText(/requires a few more fields/)).toBeInTheDocument();
    expect(ticketsAPI.create).not.toHaveBeenCalled();
  });

  test('required category blocks manual submits but not AI-classified ones', async () => {
    setMeta(makeForm({ fields: [{ key: 'category', required: true }], defaults: { aiClassify: false, assignMode: 'none' } }));
    await renderPage();
    fillMinimum();
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    expect(await screen.findByText('Pick a category')).toBeInTheDocument();
    expect(ticketsAPI.create).not.toHaveBeenCalled();

    // Turning AI classification on hands the category to the model — submit passes.
    fireEvent.click(screen.getByRole('checkbox', { name: /Classify & assess with AI/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
  });

  test('no form config at all behaves exactly like today (fallbacks, everything visible)', async () => {
    setMeta(undefined);
    await renderPage();
    expect(screen.getByLabelText('Source')).toHaveValue('103');
    expect(screen.getByLabelText('Category')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Leave unassigned/ })).toBeChecked();
    fillMinimum();
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
  });
});
