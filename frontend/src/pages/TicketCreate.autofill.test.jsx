/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TicketCreate from './TicketCreate';
import { ticketsAPI } from '../services/api';

// Mega 08-31 Phase AF — applying Autofill proposals to the composer: only
// UNTOUCHED fields fill, a user-typed subject survives, the requester is
// auto-picked only on a single exact-email match (0 / many / fuzzy name →
// the typeahead opens pre-filled), and accepting a classification turns the
// "Classify & assess with AI" box off with a one-line notice.

const FIELD = (key, extra = {}) => ({ key, visible: true, required: false, defaultValue: null, sortOrder: 0, locked: false, ...extra });
const META = {
  nativeTicketingEnabled: true,
  actor: { technicianId: 7 },
  technicians: [{ id: 5, name: 'Soheil Nasiri' }, { id: 7, name: 'Me Myself' }],
  categoryTree: [{ id: 1, name: 'Hardware', subcategories: [{ id: 11, name: 'Laptop' }] }, { id: 2, name: 'Accounts', subcategories: [] }],
  categoryGroupLinks: [],
  groups: [],
  tags: [],
  form: {
    fields: ['requester', 'subject', 'description', 'type', 'priority', 'category', 'subcategory', 'source', 'group', 'tags', 'cc', 'attachments']
      .map((key, i) => ({ ...FIELD(key, key === 'requester' || key === 'subject' ? { locked: true, required: true } : {}), sortOrder: i })),
    defaultSource: 103,
    defaultGroup: null,
    defaults: { notifyRequester: true, aiClassify: true, assignMode: 'none' },
  },
};

const JANE = { id: 41, name: 'Jane Doe', email: 'jane.doe@acme.com', jobTitle: 'Analyst' };
// v2 shape. requesterMatch 'none' = the server found nobody, so the form
// falls back to its own exact-email search (the v1 behaviour).
const RESULT = {
  subject: 'Laptop won’t boot after Windows update',
  description: { request: 'Blue screen on boot since this morning’s update.', details: ['Restarted twice, same result'], nextStep: 'Roll back the update.', discussedWith: [] },
  descriptionHtml: '<p><strong>Request:</strong> Blue screen on boot since this morning’s update.</p><ul><li>Restarted twice, same result</li></ul><p><strong>Next step:</strong> Roll back the update.</p>',
  descriptionText: 'Request: Blue screen on boot since this morning’s update.\n- Restarted twice, same result\nNext step: Roll back the update.',
  requesterNameOrEmail: 'jane.doe@acme.com',
  requesterMatch: { status: 'none', candidate: null, candidates: [], reason: 'not found' },
  conversingAgent: null,
  assigneeHint: null,
  assigneeMatch: { status: 'none', technician: null, candidates: [], reason: 'nobody named' },
  categoryHint: 'hardware > laptop',
  categoryLevel: 'leaf',
  priorityHint: 3,
  typeHint: 'service request',
  peopleMentioned: [],
  sourceSummary: 'Teams chat',
  confidence: { subject: 0.9, description: 0.9, requester: 0.9, category: 0.8, priority: 0.8, type: 0.8, assignee: 0 },
};
const SIMON = { requesterId: 41, email: 'sdickinson@acme.com', name: 'Simon Dickinson', source: 'requester' };
const SOHEIL_MATCH = { status: 'matched', technician: { id: 5, name: 'Soheil Nasiri', email: 'soheil@acme.com' }, candidates: [], reason: 'unique first name' };
const ALL = { subject: true, description: true, requester: true, category: true, priority: true, type: true };

const { stub } = vi.hoisted(() => ({ stub: { payload: null, lastLocked: null } }));

vi.mock('../services/api', () => ({
  ticketsAPI: {
    meta: vi.fn(() => Promise.resolve({ data: META })),
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
  default: ({ value }) => <div data-testid="rte" data-html={value} />,
  isRichContent: (html) => /<[a-z][\s\S]*>/i.test(String(html || '')),
  sanitizeRichHtml: (html) => String(html || ''),
}));
vi.mock('../components/tickets/CcChips', () => ({ default: () => <div data-testid="cc" /> }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: ({ file }) => <li data-testid="staged-file">{file.name}</li> }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({
    activeTypes: [{ id: 1, name: 'Incident' }, { id: 2, name: 'Service Request' }],
    defaultType: { id: 1, name: 'Incident' },
  }),
}));
// The modal has its own tests — here it is a stub that hands a canned payload
// to onApply and records which fields the page said were locked.
vi.mock('../components/tickets/AutofillModal', async () => {
  const actual = await vi.importActual('../components/tickets/AutofillModal');
  return {
    ...actual,
    default: ({ onApply, onClose, lockedFields }) => {
      stub.lastLocked = lockedFields;
      return (
        <div data-testid="autofill-modal">
          <button type="button" onClick={() => onApply(stub.payload)}>apply-stub</button>
          <button type="button" onClick={onClose}>close-stub</button>
        </div>
      );
    },
  };
});

beforeEach(() => {
  // mockResolvedValue overrides persist across tests — pin the default back.
  ticketsAPI.requesterSearch.mockImplementation(() => Promise.resolve({ data: { requesters: [], directory: [] } }));
  stub.payload = { result: RESULT, meta: {}, selected: ALL, sourceHtml: '<p>Hi IT, my laptop bluescreens</p>', sourceText: 'Hi IT, my laptop bluescreens', files: [] };
  stub.lastLocked = null;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderPage() {
  render(
    <MemoryRouter initialEntries={['/tickets/new']}>
      <Routes>
        <Route path="/tickets/new" element={<TicketCreate />} />
        <Route path="/tickets" element={<div>queue</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Autofill' })).toBeInTheDocument());
}
const openAutofill = () => fireEvent.click(screen.getByRole('button', { name: 'Autofill' }));
const applyStub = async () => { await act(async () => { fireEvent.click(screen.getByText('apply-stub')); }); };
const pressedIn = (groupName) => {
  const group = screen.getByRole('group', { name: groupName });
  return within(group).getAllByRole('button').find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent;
};
const subjectInput = () => screen.getByLabelText(/Subject/);
const requesterInput = () => screen.getByPlaceholderText('Search people by name or email…');
const aiClassifyBox = () => screen.getByRole('checkbox', { name: /Classify & assess with AI/ });

describe('TicketCreate — Autofill apply rules', () => {
  test('a clean form takes every accepted field; category/type resolve case-insensitively; source material is appended', async () => {
    ticketsAPI.requesterSearch.mockResolvedValue({ data: { requesters: [JANE], directory: [] } });
    await renderPage();
    expect(aiClassifyBox()).toBeChecked();
    openAutofill();
    expect(stub.lastLocked).toEqual([]);
    await applyStub();

    expect(subjectInput()).toHaveValue(RESULT.subject);
    const html = screen.getByTestId('rte').dataset.html;
    // v2: the server's structured HTML lands verbatim (sanitized), then the source block.
    expect(html.startsWith(RESULT.descriptionHtml)).toBe(true);
    expect(html).toContain('<strong>— Source material (pasted) —</strong>');
    expect(html).toContain('<div><p>Hi IT, my laptop bluescreens</p></div>');
    expect(html).not.toContain('<details');
    expect(pressedIn('Priority')).toBe('High');
    expect(pressedIn('Ticket type')).toBe('Service Request');
    expect(screen.getByLabelText('Category')).toHaveValue('1');
    expect(screen.getByLabelText('Subcategory')).toHaveValue('11');
    // Single exact-email match → auto-picked.
    await waitFor(() => expect(screen.getByTestId('requester-chip')).toHaveTextContent('Jane Doe'));
    expect(ticketsAPI.requesterSearch).toHaveBeenCalledWith('jane.doe@acme.com');
    // Accepting a classification switches the AI box off, with the notice.
    expect(aiClassifyBox()).not.toBeChecked();
    expect(screen.getByTestId('autofill-notice')).toHaveTextContent('AI classification turned off so your accepted values stick');
    expect(screen.queryByTestId('autofill-modal')).not.toBeInTheDocument();
  });

  test('a user-typed subject survives apply (and the modal is told it is locked)', async () => {
    await renderPage();
    fireEvent.change(subjectInput(), { target: { value: 'My own wording' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Priority' })).getByRole('button', { name: 'Low' }));
    openAutofill();
    expect(stub.lastLocked).toEqual(expect.arrayContaining(['subject']));
    await applyStub();
    expect(subjectInput()).toHaveValue('My own wording');
    // Description was untouched → filled.
    expect(screen.getByTestId('rte').dataset.html).toContain('Blue screen on boot');
  });

  test('a field cleared back to empty is fillable again', async () => {
    await renderPage();
    fireEvent.change(subjectInput(), { target: { value: 'typo' } });
    fireEvent.change(subjectInput(), { target: { value: '' } });
    openAutofill();
    expect(stub.lastLocked).not.toContain('subject');
    await applyStub();
    expect(subjectInput()).toHaveValue(RESULT.subject);
  });

  test('hand-set priority/type/category are kept; unaccepted rows are ignored', async () => {
    await renderPage();
    // Turn the AI box off so the manual controls are clickable.
    fireEvent.click(aiClassifyBox());
    fireEvent.click(within(screen.getByRole('group', { name: 'Priority' })).getByRole('button', { name: 'Urgent' }));
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '2' } });
    stub.payload.selected = { subject: true, priority: true, category: true }; // type NOT accepted
    openAutofill();
    expect(stub.lastLocked).toEqual(expect.arrayContaining(['priority', 'category']));
    await applyStub();
    expect(pressedIn('Priority')).toBe('Urgent');
    expect(screen.getByLabelText('Category')).toHaveValue('2');
    expect(pressedIn('Ticket type')).toBe('Incident'); // default, untouched by the unaccepted hint
    expect(screen.queryByTestId('autofill-notice')).not.toBeInTheDocument(); // nothing classified → no notice
  });

  test('accepting only subject/description leaves AI classification on and shows no notice', async () => {
    stub.payload.selected = { subject: true, description: true };
    await renderPage();
    openAutofill();
    await applyStub();
    expect(aiClassifyBox()).toBeChecked();
    expect(screen.queryByTestId('autofill-notice')).not.toBeInTheDocument();
    expect(pressedIn('Priority')).toBe('Medium');
  });

  test('requester: 0 matches → the typeahead opens pre-filled with the hint, nobody is picked', async () => {
    ticketsAPI.requesterSearch.mockResolvedValue({ data: { requesters: [], directory: [] } });
    await renderPage();
    openAutofill();
    await applyStub();
    await waitFor(() => expect(requesterInput()).toHaveValue('jane.doe@acme.com'));
    expect(screen.queryByTestId('requester-chip')).not.toBeInTheDocument();
  });

  test('requester: many exact matches → never auto-picked, typeahead pre-filled', async () => {
    ticketsAPI.requesterSearch.mockResolvedValue({ data: { requesters: [JANE, { ...JANE, id: 42, name: 'Jane Doe (contractor)' }], directory: [] } });
    await renderPage();
    openAutofill();
    await applyStub();
    await waitFor(() => expect(requesterInput()).toHaveValue('jane.doe@acme.com'));
    expect(screen.queryByTestId('requester-chip')).not.toBeInTheDocument();
  });

  test('requester: a fuzzy NAME with a single hit is still not auto-picked', async () => {
    ticketsAPI.requesterSearch.mockResolvedValue({ data: { requesters: [JANE], directory: [] } });
    stub.payload.result = { ...RESULT, requesterNameOrEmail: 'Jane' };
    await renderPage();
    openAutofill();
    await applyStub();
    await waitFor(() => expect(requesterInput()).toHaveValue('Jane'));
    expect(screen.queryByTestId('requester-chip')).not.toBeInTheDocument();
  });

  test('requester: a single exact match in the Entra directory only is auto-picked as a directory person', async () => {
    ticketsAPI.requesterSearch.mockResolvedValue({ data: { requesters: [], directory: [{ name: 'Jane Doe', email: 'Jane.Doe@acme.com', jobTitle: 'Analyst' }] } });
    await renderPage();
    openAutofill();
    await applyStub();
    await waitFor(() => expect(screen.getByTestId('requester-chip')).toHaveTextContent('Jane Doe'));
    expect(screen.getByTestId('requester-chip')).toHaveTextContent('Entra');
  });

  test('requester already chosen by the agent is left alone (and reported as locked)', async () => {
    await renderPage();
    fireEvent.change(requesterInput(), { target: { value: 'bob@acme.com' } });
    openAutofill();
    expect(stub.lastLocked).toContain('requester');
    await applyStub();
    expect(requesterInput()).toHaveValue('bob@acme.com');
    expect(ticketsAPI.requesterSearch).not.toHaveBeenCalledWith('jane.doe@acme.com');
  });

  test('screenshots from the paste become staged attachments on the form', async () => {
    stub.payload.files = [new File(['a'], 'screenshot-1.png', { type: 'image/png' }), new File(['b'], 'screenshot-2.png', { type: 'image/png' })];
    await renderPage();
    openAutofill();
    await applyStub();
    const staged = screen.getAllByTestId('staged-file').map((li) => li.textContent);
    expect(staged).toEqual(['screenshot-1.png', 'screenshot-2.png']);
    expect(screen.queryByTestId('autofill-notice')).toHaveTextContent('AI classification turned off'); // classification still applied
  });

  test('the applied subject is what gets created, and the run id rides along', async () => {
    stub.payload.meta = { runId: 123, model: 'claude-sonnet-5', durationMs: 7480 };
    await renderPage();
    openAutofill();
    await applyStub();
    await waitFor(() => expect(requesterInput()).toHaveValue('jane.doe@acme.com'));
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    const payload = ticketsAPI.create.mock.calls[0][0];
    expect(payload.subject).toBe(RESULT.subject);
    expect(payload.priority).toBe(3);
    expect(payload.aiClassifyOnly).toBe(false);
    expect(payload.internalCategoryId).toBe(1);
    expect(payload.internalSubcategoryId).toBe(11);
    expect(payload.intakeRunId).toBe(123);
    expect(payload.description.startsWith(RESULT.descriptionHtml)).toBe(true);
  });

  test('no run id (v1 backend) → the create payload has no intakeRunId', async () => {
    await renderPage();
    openAutofill();
    await applyStub();
    await waitFor(() => expect(requesterInput()).toHaveValue('jane.doe@acme.com'));
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0]).not.toHaveProperty('intakeRunId');
  });
});

// Autofill v2 — server-side matches: a matched requester is SELECTED (chip,
// no click, no search), a directory hit becomes an Entra person, an ambiguous
// one opens the typeahead, and a matched assignee lands as "Assign to…".
describe('TicketCreate — Autofill v2 matches', () => {
  const assigneeSelect = () => screen.getByRole('combobox', { name: 'Member to assign' });

  test('requester matched from known requesters → picked immediately, without a search', async () => {
    stub.payload.result = { ...RESULT, requesterNameOrEmail: 'Simon', requesterMatch: { status: 'matched', candidate: SIMON, candidates: [SIMON], reason: 'unique' } };
    await renderPage();
    openAutofill();
    await applyStub();
    const chip = screen.getByTestId('requester-chip');
    expect(chip).toHaveTextContent('Simon Dickinson');
    expect(chip).toHaveTextContent('sdickinson@acme.com');
    expect(chip).not.toHaveTextContent('Entra');
    expect(ticketsAPI.requesterSearch).not.toHaveBeenCalled();
    // The known requester's id is what gets created.
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0].requesterId).toBe(41);
    expect(ticketsAPI.create.mock.calls[0][0].requesterEmail).toBe('sdickinson@acme.com');
  });

  test('requester matched from the directory → picked as an Entra person (id-less, created with the ticket)', async () => {
    const dirHit = { requesterId: null, email: 'New.Hire@acme.com', name: 'New Hire', source: 'directory' };
    stub.payload.result = { ...RESULT, requesterNameOrEmail: 'New Hire', requesterMatch: { status: 'matched', candidate: dirHit, candidates: [dirHit], reason: 'directory' } };
    await renderPage();
    openAutofill();
    await applyStub();
    const chip = screen.getByTestId('requester-chip');
    expect(chip).toHaveTextContent('New Hire');
    expect(chip).toHaveTextContent('Entra');
    expect(ticketsAPI.requesterSearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0].requesterId).toBeNull();
    expect(ticketsAPI.create.mock.calls[0][0].requesterEmail).toBe('new.hire@acme.com');
  });

  test('requester ambiguous → nobody picked, the typeahead opens pre-filled with the hint', async () => {
    stub.payload.result = { ...RESULT, requesterNameOrEmail: 'Jane', requesterMatch: { status: 'ambiguous', candidate: null, candidates: [SIMON, { ...SIMON, requesterId: 42 }], reason: '2 match' } };
    await renderPage();
    openAutofill();
    await applyStub();
    await waitFor(() => expect(requesterInput()).toHaveValue('Jane'));
    expect(screen.queryByTestId('requester-chip')).not.toBeInTheDocument();
  });

  test('a requester the agent already chose is left alone even when the server matched someone', async () => {
    stub.payload.result = { ...RESULT, requesterMatch: { status: 'matched', candidate: SIMON, candidates: [SIMON], reason: 'unique' } };
    await renderPage();
    fireEvent.change(requesterInput(), { target: { value: 'bob@acme.com' } });
    openAutofill();
    await applyStub();
    expect(requesterInput()).toHaveValue('bob@acme.com');
    expect(screen.queryByTestId('requester-chip')).not.toBeInTheDocument();
  });

  test('assignee ticked → "Assign to…" with that member, AI assignment off, and the create payload carries assignedTechId', async () => {
    stub.payload.result = { ...RESULT, assigneeHint: { name: 'Soheil', reason: 'let me ask Soheil to help' }, assigneeMatch: SOHEIL_MATCH, confidence: { ...RESULT.confidence, assignee: 0.8 } };
    stub.payload.selected = { ...ALL, assignee: true };
    await renderPage();
    openAutofill();
    await applyStub();
    expect(assigneeSelect()).toHaveValue('5');
    await waitFor(() => expect(requesterInput()).toHaveValue('jane.doe@acme.com'));
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    const payload = ticketsAPI.create.mock.calls[0][0];
    expect(payload.assignedTechId).toBe(5);
    expect(payload.runAiTriage).toBe(false);
  });

  test('assignee NOT ticked → assignment untouched', async () => {
    stub.payload.result = { ...RESULT, assigneeMatch: SOHEIL_MATCH, confidence: { ...RESULT.confidence, assignee: 0.8 } };
    stub.payload.selected = { ...ALL, assignee: false };
    await renderPage();
    openAutofill();
    await applyStub();
    expect(assigneeSelect()).toHaveValue('');
  });

  test('assignee ticked but the member is not on this workspace → nothing set, a notice explains', async () => {
    stub.payload.result = { ...RESULT, assigneeMatch: { ...SOHEIL_MATCH, technician: { id: 999, name: 'Ghost Tech', email: null } } };
    stub.payload.selected = { ...ALL, assignee: true };
    await renderPage();
    openAutofill();
    await applyStub();
    expect(assigneeSelect()).toHaveValue('');
    expect(screen.getByTestId('autofill-notice')).toHaveTextContent('Ghost Tech isn’t on this workspace’s member list');
  });

  test('an assignee the agent already picked is reported as locked and kept', async () => {
    stub.payload.result = { ...RESULT, assigneeMatch: SOHEIL_MATCH, confidence: { ...RESULT.confidence, assignee: 0.9 } };
    stub.payload.selected = { ...ALL, assignee: true };
    await renderPage();
    fireEvent.change(assigneeSelect(), { target: { value: '7' } });
    openAutofill();
    expect(stub.lastLocked).toContain('assignee');
    await applyStub();
    expect(assigneeSelect()).toHaveValue('7');
  });
});
