/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TicketCreate from './TicketCreate';
import { ticketsAPI, teamsAutofillAPI, getWorkspaceId } from '../services/api';

// QA 10-01 #3: /tickets/new?autofill=<token> — the draft the Teams bot made
// lands on the form (fields, source text, pictures) and the create links the run.

const FIELD = (key, extra = {}) => ({ key, visible: true, required: false, defaultValue: null, sortOrder: 0, locked: false, ...extra });
const META = {
  nativeTicketingEnabled: true,
  actor: { technicianId: 7 },
  technicians: [{ id: 7, name: 'Me Myself' }],
  categoryTree: [{ id: 3, name: 'Software', subcategories: [{ id: 31, name: 'Outlook' }] }],
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
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DRAFT = {
  status: 'ready',
  workspace: { id: 1, name: 'IT' },
  runId: 555,
  sourceText: 'Rita: Outlook crashes every morning',
  images: [{ fileName: 'teams-picture-1.png', mimeType: 'image/png', base64: PNG_B64 }],
  data: {
    subject: 'Outlook keeps crashing on start',
    descriptionHtml: '<p><strong>Request:</strong> Rita needs Outlook working</p>',
    descriptionText: 'Request: Rita needs Outlook working',
    requesterNameOrEmail: 'rita@x.io',
    requesterMatch: { status: 'matched', candidate: { requesterId: 41, email: 'rita@x.io', name: 'Rita Moreno', source: 'requester' }, candidates: [] },
    assigneeMatch: { status: 'none', technician: null, candidates: [] },
    categoryHint: 'Software > Outlook',
    categoryLevel: 'leaf',
    priorityHint: 3,
    typeHint: 'Incident',
  },
};

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
  teamsAutofillAPI: { get: vi.fn() },
  getWorkspaceId: vi.fn(() => 1),
}));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/RichTextEditor', () => ({
  default: ({ value }) => <div data-testid="rte" data-html={value} />,
  isRichContent: (html) => /<[a-z][\s\S]*>/i.test(String(html || '')),
  sanitizeRichHtml: (html) => String(html || ''),
}));
vi.mock('../components/tickets/CcChips', () => ({ default: () => <div data-testid="cc" /> }));
vi.mock('../components/tickets/StagedFileChip', () => ({ default: ({ file }) => <li data-testid="staged-file">{file.name}|{file.type}|{file.size}</li> }));
vi.mock('../components/tickets/ImageMarkupModal', () => ({ default: () => null }));
vi.mock('../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ activeTypes: [{ id: 1, name: 'Incident' }], defaultType: { id: 1, name: 'Incident' } }),
}));

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

function renderAt(url) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/tickets/new" element={<><TicketCreate /><Where /></>} />
        <Route path="/tickets/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  teamsAutofillAPI.get.mockResolvedValue({ success: true, data: DRAFT });
  getWorkspaceId.mockReturnValue(1);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('TicketCreate — Autofill draft from Teams', () => {
  test('fills the form, stages the pictures, links the run on create and drops the token from the URL', async () => {
    renderAt('/tickets/new?autofill=tok_abcdefghijklmnop');
    await waitFor(() => expect(screen.getByLabelText(/Subject/)).toHaveValue('Outlook keeps crashing on start'));
    expect(teamsAutofillAPI.get).toHaveBeenCalledWith('tok_abcdefghijklmnop');
    const html = screen.getByTestId('rte').dataset.html;
    expect(html.startsWith(DRAFT.data.descriptionHtml)).toBe(true);
    expect(html).toContain('Rita: Outlook crashes every morning');
    expect(screen.getByTestId('staged-file')).toHaveTextContent('teams-picture-1.png|image/png|');
    expect(screen.getByLabelText('Category')).toHaveValue('3');
    expect(screen.getByLabelText('Subcategory')).toHaveValue('31');
    await waitFor(() => expect(screen.getByTestId('requester-chip')).toHaveTextContent('Rita Moreno'));
    expect(screen.getByTestId('autofill-notice')).toHaveTextContent('Filled in from your Teams message');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/tickets\/new$/));

    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    const payload = ticketsAPI.create.mock.calls[0][0];
    expect(payload).toMatchObject({ subject: 'Outlook keeps crashing on start', priority: 3, intakeRunId: 555, requesterEmail: 'rita@x.io', internalCategoryId: 3, internalSubcategoryId: 31 });
    await waitFor(() => expect(ticketsAPI.uploadAttachments).toHaveBeenCalled());
    const [, files] = ticketsAPI.uploadAttachments.mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('teams-picture-1.png');
  });

  // 5 Oct 2026: "Open in Ticket Pulse" saves the card's choices; the form follows them.
  test('the assignment chosen on the Teams card wins over the form default', async () => {
    teamsAutofillAPI.get.mockResolvedValue({ success: true, data: { ...DRAFT, data: { ...DRAFT.data, cardAssign: 'ai' } } });
    renderAt('/tickets/new?autofill=tok_abcdefghijklmnop');
    await waitFor(() => expect(screen.getByTestId('requester-chip')).toHaveTextContent('Rita Moreno'));
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0]).toMatchObject({ runAiTriage: true });
    expect(ticketsAPI.create.mock.calls[0][0].assignedTechId).toBeUndefined();
  });

  test('"Me" from the card assigns the agent', async () => {
    teamsAutofillAPI.get.mockResolvedValue({ success: true, data: { ...DRAFT, data: { ...DRAFT.data, cardAssign: 'me' } } });
    renderAt('/tickets/new?autofill=tok_abcdefghijklmnop');
    await waitFor(() => expect(screen.getByTestId('requester-chip')).toHaveTextContent('Rita Moreno'));
    fireEvent.click(screen.getAllByRole('button', { name: /Create ticket/ })[0]);
    await waitFor(() => expect(ticketsAPI.create).toHaveBeenCalled());
    expect(ticketsAPI.create.mock.calls[0][0]).toMatchObject({ assignedTechId: 7, runAiTriage: false });
  });

  test('no token → the draft API is never called', async () => {
    renderAt('/tickets/new');
    await waitFor(() => expect(ticketsAPI.meta).toHaveBeenCalled());
    expect(teamsAutofillAPI.get).not.toHaveBeenCalled();
  });

  test('an expired or foreign link shows the server\'s words', async () => {
    teamsAutofillAPI.get.mockRejectedValue(Object.assign(new Error('This Autofill draft has expired. Send the bot your message again.'), { status: 410 }));
    renderAt('/tickets/new?autofill=tok_abcdefghijklmnop');
    await waitFor(() => expect(screen.getByText(/This Autofill draft has expired/)).toBeInTheDocument());
    expect(screen.getByLabelText(/Subject/)).toHaveValue('');
  });

  test('a draft already created in Teams opens that ticket instead', async () => {
    teamsAutofillAPI.get.mockResolvedValue({ success: true, data: { status: 'created', ticketId: 900, ticketRef: 'TP-1234', workspace: { id: 1, name: 'IT' } } });
    renderAt('/tickets/new?autofill=tok_abcdefghijklmnop');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tickets/900'));
  });

  test('a draft for another workspace asks to switch instead of filling the wrong form', async () => {
    getWorkspaceId.mockReturnValue(2);
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
    try {
      sessionStorage.clear();
      renderAt('/tickets/new?autofill=tok_abcdefghijklmnop');
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/tickets/new?autofill=tok_abcdefghijklmnop&ws=1'));
      expect(screen.getByLabelText(/Subject/)).toHaveValue('');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
