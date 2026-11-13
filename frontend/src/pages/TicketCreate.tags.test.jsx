/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TicketCreate from './TicketCreate';
import { settingsAPI, ticketsAPI } from '../services/api';

// QA 11-12 #3 — a workspace with ~200 tags: the create form shows a search-first
// picker (picked tags as chips, a short list on focus), never a pill per tag.
// Invented tag names only (the repository is public).

const FIELD = (key, extra = {}) => ({ key, visible: true, required: false, defaultValue: null, sortOrder: 0, locked: false, ...extra });
const makeForm = (tagsRequired = false) => ({
  fields: ['requester', 'subject', 'description', 'type', 'priority', 'category', 'subcategory', 'source', 'group', 'tags', 'cc', 'attachments']
    .map((key, i) => ({
      ...FIELD(key, key === 'requester' || key === 'subject' ? { locked: true, required: true } : {}),
      ...(key === 'tags' && tagsRequired ? { required: true } : {}),
      sortOrder: i,
    })),
  defaultSource: 103,
  defaultGroup: null,
  defaults: { notifyRequester: true, aiClassify: false, assignMode: 'none' },
});

const TAGS = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, name: `rig-part-${String(i + 1).padStart(3, '0')}`, color: 'sky' }));

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
  settingsAPI: {
    createTicketTag: vi.fn(({ name }) => Promise.resolve({ data: { data: { id: 501, name, color: 'slate' } } })),
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

function setMeta({ admin = false, tagsRequired = false } = {}) {
  metaRef.value = {
    nativeTicketingEnabled: true,
    actor: admin ? { technicianId: 7, kind: 'admin' } : { technicianId: 7, workspaceRole: 'agent' },
    technicians: [],
    categoryTree: [{ id: 1, name: 'Hardware', subcategories: [] }],
    categoryGroupLinks: [],
    groups: [],
    tags: TAGS,
    form: makeForm(tagsRequired),
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

const tagBox = () => screen.getByRole('combobox', { name: /^Tags/ });
const fillMinimum = () => {
  fireEvent.change(screen.getByPlaceholderText('Search people by name or email…'), { target: { value: 'jane@acme.com' } });
  fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: 'Coyote Landslide' } });
};

describe('TicketCreate — tags with a large palette (QA 11-12 #3)', () => {
  test('200 tags draw no pills: chips for the picks, ≤ 8 rows + Browse all on focus; picks ship in the payload', async () => {
    setMeta();
    await renderPage();
    expect(screen.queryAllByText(/^rig-part-/)).toHaveLength(0);

    fireEvent.focus(tagBox());
    fireEvent.click(screen.getByRole('option', { name: 'rig-part-001' }));
    fireEvent.keyDown(tagBox(), { key: 'Enter' }); // the next row: rig-part-002
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.length).toBeLessThanOrEqual(9);
    expect(options[options.length - 1]).toHaveTextContent('Browse all (200)');
    expect(screen.getAllByRole('button', { name: /^Remove tag rig-part/ })).toHaveLength(2);

    fillMinimum();
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0].tagIds).toEqual([1, 2]);
  });

  test('required tags keep the asterisk and the inline error under the picker', async () => {
    setMeta({ tagsRequired: true });
    await renderPage();
    expect(screen.getByText('Tags', { selector: 'label' }).querySelector('.text-red-500')).toHaveTextContent('*');
    fillMinimum();
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    expect(await screen.findByText('Pick at least one tag')).toBeInTheDocument();
    expect(tagBox()).toHaveAttribute('aria-invalid', 'true');
    expect(tagBox()).toHaveAttribute('aria-describedby', 'tc-tags-error');
    expect(ticketsAPI.create).not.toHaveBeenCalled();
  });

  test('Create “x” is offered to admins only', async () => {
    setMeta({ admin: false });
    await renderPage();
    fireEvent.change(tagBox(), { target: { value: 'mast-clamp' } });
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument();
    cleanup();

    setMeta({ admin: true });
    await renderPage();
    fireEvent.change(tagBox(), { target: { value: 'rig-part-007' } });
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument(); // exact match exists
    fireEvent.change(tagBox(), { target: { value: 'mast-clamp' } });
    fireEvent.click(screen.getByRole('option', { name: /Create “mast-clamp”/ }));
    await waitFor(() => expect(settingsAPI.createTicketTag).toHaveBeenCalledWith({ name: 'mast-clamp' }));
    expect(await screen.findByRole('button', { name: 'Remove tag mast-clamp' })).toBeInTheDocument();
  });
});
