/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TicketCreate from './TicketCreate';
import { ticketsAPI } from '../services/api';

// Mega 08-26 Phase TT (QA 08-26 #2 — "the subject line didn't copy") —
// picking a create-form template in the composer fills subject, description,
// priority, type, category and subcategory, and the fill SURVIVES the
// one-time workspace-config seed that runs when /tickets/meta lands and any
// later re-render. (Investigated for QA: the apply path was intact at HEAD and
// in the deployed prod bundle — these tests pin it down.)

const QA_SUBJECT = '{A2XXXX - NAME OF PROPOSAL} is now active in BST';
const TEMPLATES = [
  {
    id: 3, name: 'Internal Proposals', subject: QA_SUBJECT, description: null, priority: null,
    ticketType: null, internalCategoryId: null, internalSubcategoryId: null,
  },
  {
    id: 4, name: 'New starter', subject: 'New starter — laptop + accounts', description: 'Start date:\nManager:',
    priority: 4, ticketType: 'Service Request', internalCategoryId: 1, internalSubcategoryId: 11,
  },
];

const FIELD = (key, extra = {}) => ({ key, visible: true, required: false, defaultValue: null, sortOrder: 0, locked: false, ...extra });
const META = {
  nativeTicketingEnabled: true,
  actor: { technicianId: 7 },
  technicians: [],
  categoryTree: [{ id: 1, name: 'Hardware', subcategories: [{ id: 11, name: 'Laptop' }] }, { id: 2, name: 'Accounts', subcategories: [] }],
  categoryGroupLinks: [],
  groups: [],
  tags: [],
  form: {
    fields: ['requester', 'subject', 'description', 'type', 'priority', 'category', 'subcategory', 'source', 'group', 'tags', 'cc', 'attachments']
      .map((key, i) => ({ ...FIELD(key, key === 'requester' || key === 'subject' ? { locked: true, required: true } : {}), sortOrder: i }))
      // Config default priority = Medium — the seed must NOT clobber a template's Urgent.
      .map((f) => (f.key === 'priority' ? { ...f, defaultValue: '2' } : f)),
    defaultSource: 103,
    defaultGroup: null,
    defaults: { notifyRequester: true, aiClassify: true, assignMode: 'none' },
  },
};

const { metaGate } = vi.hoisted(() => ({ metaGate: { resolve: null, promise: null } }));

vi.mock('../services/api', () => ({
  ticketsAPI: {
    meta: vi.fn(() => metaGate.promise),
    createTemplates: vi.fn(() => Promise.resolve({ data: TEMPLATES })),
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
  default: ({ value }) => <div data-testid="rte" data-html={value} />,
  isRichContent: () => false,
}));
vi.mock('../components/tickets/CcChips', () => ({ default: () => <div data-testid="cc" /> }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: () => null }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({
    activeTypes: [{ id: 1, name: 'Incident' }, { id: 2, name: 'Service Request' }],
    defaultType: { id: 1, name: 'Incident' },
  }),
}));

beforeEach(() => {
  metaGate.promise = new Promise((resolve) => { metaGate.resolve = () => resolve({ data: META }); });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/tickets/new']}>
      <Routes>
        <Route path="/tickets/new" element={<TicketCreate />} />
        <Route path="/tickets/:id" element={<div>ticket page</div>} />
        <Route path="/tickets" element={<div>queue</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const pickTemplate = (id) => fireEvent.change(screen.getByLabelText('Start from a template'), { target: { value: String(id) } });
const landMeta = async () => { await act(async () => { metaGate.resolve(); }); };
const pressedIn = (groupName) => {
  const group = screen.getByRole('group', { name: groupName });
  return within(group).getAllByRole('button').find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent;
};
const pressedPriority = () => pressedIn('Priority');
const pressedType = () => pressedIn('Ticket type');

describe('TicketCreate — applying a create-form template', () => {
  test('meta first, then pick: subject/description/priority/type/category/subcategory all fill', async () => {
    renderPage();
    await landMeta();
    await waitFor(() => expect(screen.getByLabelText('Start from a template')).toBeInTheDocument());
    // Config seed applied (Medium) before the pick.
    expect(pressedPriority()).toBe('Medium');

    pickTemplate(4);
    expect(screen.getByLabelText(/Subject/)).toHaveValue('New starter — laptop + accounts');
    expect(screen.getByTestId('rte').dataset.html).toBe('<p>Start date:<br>Manager:</p>');
    expect(pressedPriority()).toBe('Urgent');
    expect(pressedType()).toBe('Service Request');
    expect(screen.getByLabelText('Category')).toHaveValue('1');
    expect(screen.getByLabelText('Subcategory')).toHaveValue('11');
    // The picker itself snaps back to the placeholder so it can be reused.
    expect(screen.getByLabelText('Start from a template')).toHaveValue('');
  });

  test('QA’s exact template (subject only): the subject fills and everything else is left alone', async () => {
    renderPage();
    await landMeta();
    await waitFor(() => expect(screen.getByLabelText('Start from a template')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '2' } });

    pickTemplate(3);
    expect(screen.getByLabelText(/Subject/)).toHaveValue(QA_SUBJECT);
    expect(pressedPriority()).toBe('Medium'); // untouched (template has none)
    expect(screen.getByLabelText('Category')).toHaveValue('2'); // agent's own pick kept
  });

  test('the fill survives later re-renders (typing elsewhere, re-picking) — nothing seeds over it', async () => {
    // The composer is spinner-gated on meta, so a pick can only happen AFTER
    // the one-time config seed; this guards the seed never re-running over
    // an applied template on subsequent renders.
    renderPage();
    await landMeta();
    await waitFor(() => expect(screen.getByLabelText('Start from a template')).toBeInTheDocument());
    expect(ticketsAPI.meta).toHaveBeenCalledTimes(1);

    pickTemplate(4);
    fireEvent.change(screen.getByPlaceholderText('Search people by name or email…'), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: '3' } });
    expect(screen.getByLabelText(/Subject/)).toHaveValue('New starter — laptop + accounts');
    expect(pressedPriority()).toBe('Urgent');
    expect(pressedType()).toBe('Service Request');
    expect(screen.getByLabelText('Category')).toHaveValue('1');
    expect(screen.getByLabelText('Subcategory')).toHaveValue('11');

    // Picking a subject-only template afterwards replaces the subject but
    // leaves the earlier template's priority/type/category in place.
    pickTemplate(3);
    expect(screen.getByLabelText(/Subject/)).toHaveValue(QA_SUBJECT);
    expect(pressedPriority()).toBe('Urgent');
    expect(screen.getByLabelText('Category')).toHaveValue('1');
  });

  test('the applied subject is what gets created', async () => {
    renderPage();
    await landMeta();
    await waitFor(() => expect(screen.getByLabelText('Start from a template')).toBeInTheDocument());
    pickTemplate(3);
    fireEvent.change(screen.getByPlaceholderText('Search people by name or email…'), { target: { value: 'jane@acme.com' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0].subject).toBe(QA_SUBJECT);
  });
});
