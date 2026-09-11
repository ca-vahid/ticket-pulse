/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * QA 09-10 #3 — "When the user clicks on Create & resolve, display a pop-up
 * window asking them to add internal notes to this ticket. Make the notes
 * optional."
 *
 * Create & resolve is the walk-up log: the work already happened at the desk,
 * so the one thing missing afterwards is a record of what was done.
 */

const navigate = vi.fn();
const { api } = vi.hoisted(() => ({
  api: {
    meta: vi.fn(),
    createTemplates: vi.fn(() => Promise.resolve({ data: [] })),
    customFieldDefinitions: vi.fn(() => Promise.resolve({ data: [] })),
    requesterSearch: vi.fn(() => Promise.resolve({ data: { requesters: [], directory: [] } })),
    requesterPhoto: vi.fn(() => Promise.resolve({ data: {} })),
    requesterStats: vi.fn(() => Promise.resolve({ data: {} })),
    create: vi.fn(() => Promise.resolve({ data: { id: 77, displayRef: 'TP-77' } })),
    uploadAttachments: vi.fn(() => Promise.resolve({})),
    setStatus: vi.fn(() => Promise.resolve({ data: {} })),
    note: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

vi.mock('react-router-dom', async (orig) => ({ ...(await orig()), useNavigate: () => navigate }));
vi.mock('../services/api', () => ({ ticketsAPI: api }));
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

const TicketCreate = (await import('./TicketCreate')).default;

api.meta.mockImplementation(() => Promise.resolve({
  data: {
    nativeTicketingEnabled: true,
    actor: { technicianId: 7 },
    technicians: [],
    categoryTree: [],
    groups: [],
    statuses: [],
    customFields: [],
    formConfig: { fields: [] },
  },
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

const renderPage = () => render(<MemoryRouter><TicketCreate /></MemoryRouter>);

// The submit menu is disabled until the form is valid: a typed requester email
// plus a subject is the smallest state that satisfies it.
const fillForm = async () => {
  fireEvent.change(await screen.findByPlaceholderText('Search people by name or email…'), { target: { value: 'david@acme.com' } });
  fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: 'Walk-up: MFA reset' } });
};

const openPrompt = async () => {
  await fillForm();
  const more = await screen.findByLabelText('More create options');
  await waitFor(() => expect(more).toBeEnabled());
  fireEvent.click(more);
  fireEvent.click(await screen.findByText(/Create & resolve/));
  return screen.findByTestId('walkup-note-modal');
};

describe('the prompt', () => {
  test('Create & resolve asks for a note instead of resolving immediately', async () => {
    renderPage();
    expect(await openPrompt()).toBeInTheDocument();
    expect(screen.getByText(/Add an internal note\?/)).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  test('it says plainly that the note is never emailed', async () => {
    renderPage();
    await openPrompt();
    expect(screen.getByText(/never emailed to the requester/i)).toBeInTheDocument();
  });
});

describe('the note is optional', () => {
  test('"Skip & resolve" is always enabled', async () => {
    renderPage();
    await openPrompt();
    expect(screen.getByTestId('walkup-skip')).toBeEnabled();
  });

  test('"Add note & resolve" stays disabled until something is typed', async () => {
    renderPage();
    await openPrompt();
    expect(screen.getByTestId('walkup-submit')).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Internal note/), { target: { value: 'Reset MFA at the desk.' } });
    expect(screen.getByTestId('walkup-submit')).toBeEnabled();
  });
});

describe('what gets written', () => {
  test('a typed note is escaped rather than injected', async () => {
    renderPage();
    await openPrompt();
    fireEvent.change(screen.getByLabelText(/Internal note/), { target: { value: 'Ran <script>alert(1)</script>' } });
    fireEvent.click(screen.getByTestId('walkup-submit'));
    await waitFor(() => expect(api.note).toHaveBeenCalled());
    const body = api.note.mock.calls[0][1];
    expect(body.bodyText).toBe('Ran <script>alert(1)</script>');
    expect(body.bodyHtml).not.toContain('<script>');
    expect(body.bodyHtml).toContain('&lt;script&gt;');
  });

  test('the note is written BEFORE the resolve, so the ticket is never resolved blank', async () => {
    renderPage();
    await openPrompt();
    fireEvent.change(screen.getByLabelText(/Internal note/), { target: { value: 'Reset their MFA at the desk.' } });
    fireEvent.click(screen.getByTestId('walkup-submit'));
    await waitFor(() => expect(api.setStatus).toHaveBeenCalledWith(77, 'Resolved'));
    expect(api.note.mock.invocationCallOrder[0]).toBeLessThan(api.setStatus.mock.invocationCallOrder[0]);
  });

  test('a failed note still resolves the ticket', async () => {
    api.note.mockRejectedValueOnce(new Error('note service down'));
    renderPage();
    await openPrompt();
    fireEvent.change(screen.getByLabelText(/Internal note/), { target: { value: 'Swapped the dock.' } });
    fireEvent.click(screen.getByTestId('walkup-submit'));
    await waitFor(() => expect(api.setStatus).toHaveBeenCalledWith(77, 'Resolved'));
  });
});
