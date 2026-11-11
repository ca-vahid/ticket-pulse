/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Tickets → Mail review (11 Nov 2026): held e-mail with the AI's suggestion.
// The API is mocked exactly per the lane contract (MAIL_TRIAGE_BRIEF.md).
const api = vi.hoisted(() => ({
  mailReviewList: vi.fn(),
  mailReviewGet: vi.fn(),
  mailReviewResolve: vi.fn(),
  mailReviewBulkAccept: vi.fn(),
  mailReviewUndo: vi.fn(),
  mailReviewRejudge: vi.fn(),
  mailReviewTicketSearch: vi.fn(),
}));
const who = vi.hoisted(() => ({ admin: true }));
vi.mock('../services/api', () => ({ ticketsAPI: api }));
vi.mock('../components/AppHeader', () => ({ default: () => null }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { email: 'robin.vale@example.com', role: 'agent' } }) }));
vi.mock('../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 2, name: 'Accounting' } }) }));
vi.mock('../contexts/LayoutContext', () => ({ applyWidth: (c) => c, useLayoutWidth: () => ({ width: 'default' }) }));
vi.mock('../components/nav/navDestinations', () => ({ useWorkspaceRole: () => 'agent', isWorkspaceAdmin: () => who.admin }));

const { default: MailReview } = await import('./MailReview');

const CLOSED = { id: 9001, ref: '249132', subject: 'Reminder: invoice 4053377', status: 'Closed', statusBase: 'closed', closedAt: '2026-10-27T19:00:00Z', requesterName: 'Dana Whitlock' };
const OPEN = { id: 9002, ref: 'TP-11340', subject: 'Statement request', status: 'Open', statusBase: 'open', closedAt: null, requesterName: 'Lee Marsh' };
const mail = (heldId, suggestion, over = {}) => ({
  heldId, receivedAt: '2026-11-10T20:36:00Z', from: { email: 'robin.vale@example.com', name: 'Robin Vale' },
  to: ['dana.whitlock@client.example.com', 'ar@example.com'], cc: [], subject: `Subject ${heldId}`, snippet: `Snippet ${heldId}`,
  holdReason: 'agent_bcc_mailbox', holdReasonLabel: 'The mailbox was not on the To or Cc line', suggestion, resolution: null, ...over,
});
const sug = (over = {}) => ({
  decisionId: 700, action: 'attach', ticket: CLOSED, reopen: true, requester: null, relatedTicketIds: [],
  confidence: 'sure', reason: 'Same invoice number and thread; it asks for an update.', evidence: ['invoice 4053377'], mode: 'on', judgedAt: '2026-11-10T20:37:00Z', ...over,
});

let waiting;
let mode;
beforeEach(() => {
  who.admin = true;
  mode = 'on';
  waiting = [
    mail(1, sug()),
    mail(2, sug({ decisionId: 701, action: 'attach', ticket: OPEN, reopen: false, confidence: 'likely' })),
    mail(3, sug({ decisionId: 702, action: 'create', ticket: null, reopen: false, requester: { email: 'dana.whitlock@client.example.com', name: 'Dana Whitlock' } })),
    mail(4, sug({ decisionId: 703, action: 'no_ticket', ticket: null, reopen: false, confidence: 'likely' })),
    mail(5, sug({ decisionId: 704, action: 'attach', ticket: OPEN, reopen: false, confidence: 'unsure' })),
    mail(6, null),
  ];
  api.mailReviewList.mockImplementation(({ tab }) => {
    if (tab === 'done') {
      return Promise.resolve({ data: [
        mail(20, sug(), { resolution: { status: 'attached', ticket: { id: 9001, ref: '249132', subject: 'Reminder: invoice 4053377' }, by: null, at: '2026-11-11T17:00:00Z', via: 'ai', undoable: true } }),
        mail(21, null, { resolution: { status: 'discarded', ticket: null, by: 'Robin Vale', at: '2026-11-11T16:00:00Z', via: 'person', undoable: false } }),
      ], meta: {} });
    }
    if (tab === 'log') {
      return Promise.resolve({ data: [
        { id: 801, heldId: 30, subject: 'Remittance advice', fromEmail: 'bank@example.com', mode: 'shadow', action: 'attach', ticket: { id: 9002, ref: 'TP-11340', subject: 'Statement request' }, reopen: false, confidence: 'sure', reason: 'x', evidence: [], candidateIds: [9002], provider: 'p', model: 'economy-model', inputTokens: 2100, outputTokens: 90, costUsd: 0.0021, latencyMs: 1800, outcome: 'changed', finalAction: 'no_ticket', finalTicket: null, decidedBy: 'Robin Vale', decidedAt: '2026-11-11T17:00:00Z', createdAt: '2026-11-11T16:00:00Z', error: null },
        { id: 800, heldId: 31, subject: 'Invoice question', fromEmail: 'lee@example.com', mode: 'on', action: 'create', ticket: null, reopen: false, confidence: 'sure', reason: 'y', evidence: [], candidateIds: [], provider: 'p', model: 'economy-model', inputTokens: 1900, outputTokens: 80, costUsd: 0.0019, latencyMs: 1500, outcome: 'applied', finalAction: null, finalTicket: null, decidedBy: null, decidedAt: null, createdAt: '2026-11-11T15:00:00Z', error: null },
      ], meta: { stats: { last30: { judged: 140, sureAccepted: 61, sureChanged: 5, agreementPct: 92 } } } });
    }
    return Promise.resolve({ data: [...waiting], meta: { waiting: waiting.length, doneToday: 11, mode, sureCount: 2 } });
  });
  api.mailReviewGet.mockImplementation((heldId) => Promise.resolve({ data: {
    ...(waiting.find((w) => w.heldId === heldId) || mail(heldId, sug())),
    bodyHtml: '<p>Do you have any updates on this invoice?</p><img src="https://tracker.example.com/p.gif">',
    candidates: [
      { ticket: { ...CLOSED, createdAt: '2026-10-01T10:00:00Z' }, why: ['same invoice number 4053377', 'same thread'], score: 0.91, aiNote: 'Same matter.' },
      { ticket: { ...OPEN, createdAt: '2026-11-01T10:00:00Z' }, why: ['same sender in the last 90 days'], score: 0.4, aiNote: null },
    ],
    decisions: [
      { id: 700, heldId, action: 'attach', ticket: CLOSED, reopen: true, confidence: 'sure', reason: 'now', model: 'economy-model', inputTokens: 2140, outputTokens: 96, costUsd: 0.0021, latencyMs: 1800, outcome: 'suggested', mode: 'on', createdAt: '2026-11-10T20:37:00Z' },
      { id: 650, heldId, action: 'unsure', ticket: null, reopen: false, confidence: 'unsure', reason: 'No candidates yet.', model: 'economy-model', outcome: 'superseded', mode: 'on', createdAt: '2026-11-10T20:07:00Z' },
    ],
  } }));
  api.mailReviewResolve.mockImplementation((heldId, body) => {
    waiting = waiting.filter((w) => w.heldId !== heldId);
    return Promise.resolve({ data: mail(heldId, null, { resolution: { status: body.action === 'attach' ? 'attached' : body.action === 'create' ? 'created' : 'discarded', ticket: body.action === 'create' ? { id: 9100, ref: 'TP-12001', subject: 'Subject' } : null, by: 'Robin Vale', at: '2026-11-11T18:00:00Z', via: 'person', undoable: true } }) });
  });
  api.mailReviewBulkAccept.mockImplementation((ids) => {
    waiting = waiting.filter((w) => !ids.includes(w.heldId));
    return Promise.resolve({ data: { accepted: ids, skipped: [] } });
  });
  api.mailReviewUndo.mockResolvedValue({ data: {} });
  api.mailReviewRejudge.mockImplementation((heldId) => Promise.resolve({ data: mail(heldId, sug()) }));
  api.mailReviewTicketSearch.mockResolvedValue({ data: [{ id: 9050, ref: 'TP-11999', subject: 'Found by search', status: 'Open', statusBase: 'open', requesterName: 'Lee Marsh', createdAt: '2026-11-02T10:00:00Z' }] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const mount = (path = '/tickets/mail-review') => render(<MemoryRouter initialEntries={[path]}><MailReview /></MemoryRouter>);
const rows = () => screen.getAllByTestId('mr-row');
const key = (k, target = document.body) => fireEvent.keyDown(target, { key: k });

describe('Mail review: Waiting', () => {
  test('header, text tabs with counts and one row per e-mail', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Mail review · Accounting');
    expect(screen.getByTestId('mr-stats')).toHaveTextContent('Waiting 6');
    expect(screen.getByTestId('mr-stats')).toHaveTextContent('Done today 11');
    expect(screen.getByTestId('mr-stats')).toHaveTextContent('AI: On');
    expect(screen.getByRole('tab', { name: /Waiting/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Waiting/ })).toHaveTextContent('Waiting6');
    // Sender by name with the address on hover, the time in Pacific.
    expect(within(rows()[0]).getByText('Robin Vale')).toHaveAttribute('title', 'robin.vale@example.com');
    expect(within(rows()[0]).getByText('Tue 10 Nov, 12:36 PM')).toBeInTheDocument();
  });

  test('the suggestion line: verb, ticket link, the consequence, confidence as a word', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    const line = (i) => within(rows()[i]).getByTestId('mr-suggestion');
    expect(line(0)).toHaveTextContent('AI suggests: Add to #249132 · Reminder: invoice 4053377 (Closed 27 Oct) reopens it · sure');
    const link = within(line(0)).getByRole('link', { name: '#249132' });
    expect(link).toHaveAttribute('href', '/tickets?peek=9001');
    expect(link).toHaveAttribute('target', '_blank');
    expect(line(1)).toHaveTextContent('AI suggests: Add to TP-11340 · Statement request · likely');
    expect(line(2)).toHaveTextContent('AI suggests: New ticket for Dana Whitlock · sure');
    expect(line(3)).toHaveTextContent('AI suggests: No ticket needed · likely');
    expect(line(5)).toHaveTextContent('AI suggests: No good match');
    expect(within(rows()[0]).getByTestId('mr-why')).toHaveTextContent('Why: Same invoice number and thread; it asks for an update.');
    expect(line(0).textContent).not.toMatch(/%/);
  });

  test('the server’s effects are on the line before anyone clicks', async () => {
    waiting[0].suggestion.effects = ['reopens it', 'notifies Alex Rivera'];
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(within(rows()[0]).getByTestId('mr-suggestion')).toHaveTextContent('reopens it and notifies Alex Rivera');
  });

  test('Shadow says so on every row', async () => {
    mode = 'shadow';
    waiting.forEach((w) => { if (w.suggestion) w.suggestion.mode = 'shadow'; });
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    for (const row of rows()) expect(within(row).getByTestId('mr-suggestion')).toHaveTextContent('Shadow: shown, not applied');
    expect(screen.getByTestId('mr-stats')).toHaveTextContent('AI: Shadow');
  });

  test('the primary button follows confidence', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    const primary = (i) => within(rows()[i]).getByTestId('mr-primary');
    const secondary = (i) => within(rows()[i]).getByTestId('mr-secondary');
    expect(primary(0)).toHaveTextContent('Accept');
    expect(secondary(0)).toHaveTextContent('Pick another ticket');
    expect(primary(1)).toHaveTextContent('Accept');
    expect(primary(4)).toHaveTextContent('Pick another ticket'); // unsure
    expect(secondary(4)).toHaveTextContent('Accept');
    expect(primary(5)).toHaveTextContent('New ticket'); // nothing suggested
    expect(secondary(5)).toHaveTextContent('Pick another ticket');
  });

  test('phone layout: the primary button fills the row and the second one moves into More', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    const row = rows()[0];
    expect(within(row).getByTestId('mr-primary').className).toMatch(/\bflex-1\b/);
    expect(within(row).getByTestId('mr-primary').className).toMatch(/sm:flex-none/);
    expect(within(row).getByTestId('mr-secondary').className).toMatch(/\bhidden\b.*sm:inline-flex/);
    fireEvent.click(within(row).getByTestId('mr-more'));
    const items = within(row).getAllByRole('menuitem').map((el) => el.textContent);
    expect(items).toEqual(['Pick another ticket', 'New ticket', 'No ticket needed', 'Details']);
    expect(within(row).getByRole('menuitem', { name: 'Pick another ticket' }).parentElement.className).toMatch(/sm:hidden/);
  });

  test('Accept posts the suggestion, removes the row at once and offers Undo in a toast', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    fireEvent.click(within(rows()[0]).getByTestId('mr-primary'));
    expect(rows()).toHaveLength(5); // optimistic
    expect(api.mailReviewResolve).toHaveBeenCalledWith(1, { action: 'attach', ticketId: 9001, reopen: true, decisionId: 700 });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('mr-toast')).toHaveTextContent('Added to #249132 and reopened it.'));
    expect(screen.getByTestId('mr-live')).toHaveTextContent('Added to #249132 and reopened it.');
    expect(screen.getByTestId('mr-stats')).toHaveTextContent('Waiting 5');
    fireEvent.click(screen.getByTestId('mr-toast-undo'));
    await waitFor(() => expect(api.mailReviewUndo).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.getByTestId('mr-toast')).toHaveTextContent('Undone. The e-mail is back in Waiting.'));
  });

  test('a refused action puts the row back with the server’s message', async () => {
    api.mailReviewResolve.mockRejectedValueOnce(Object.assign(new Error('That ticket was deleted.'), { status: 409 }));
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    fireEvent.click(within(rows()[0]).getByTestId('mr-primary'));
    expect(rows()).toHaveLength(5);
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(rows()[0]).toHaveAttribute('data-held-id', '1');
    expect(within(rows()[0]).getByRole('alert')).toHaveTextContent('That ticket was deleted.');
    expect(screen.getByTestId('mr-stats')).toHaveTextContent('Waiting 6');
  });

  test('Pick another ticket: candidates with why, search, and "Reopen it?" for a closed one', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    fireEvent.click(within(rows()[1]).getByTestId('mr-secondary'));
    const pop = await screen.findByTestId('mr-pick');
    await waitFor(() => expect(within(pop).getAllByTestId('mr-pick-option')).toHaveLength(2));
    expect(api.mailReviewGet).toHaveBeenCalledWith(2);
    expect(pop).toHaveTextContent('same invoice number 4053377 · same thread');
    // A closed ticket asks before anything is sent.
    fireEvent.click(within(pop).getAllByTestId('mr-pick-option')[0]);
    expect(within(pop).getByTestId('mr-reopen-ask')).toBeInTheDocument();
    expect(pop).toHaveTextContent('#249132 is closed. Reopen it?');
    expect(api.mailReviewResolve).not.toHaveBeenCalled();
    fireEvent.click(within(pop).getByRole('button', { name: 'Add, leave it closed' }));
    expect(api.mailReviewResolve).toHaveBeenCalledWith(2, { action: 'attach', ticketId: 9001, reopen: false, decisionId: 701 });
  });

  test('the search box asks ticket-search and an open ticket is added straight away', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    fireEvent.click(within(rows()[0]).getByTestId('mr-secondary'));
    const pop = await screen.findByTestId('mr-pick');
    fireEvent.change(within(pop).getByRole('searchbox'), { target: { value: 'found' } });
    await waitFor(() => expect(api.mailReviewTicketSearch).toHaveBeenCalledWith('found'));
    fireEvent.click(await within(pop).findByText(/Found by search/));
    expect(api.mailReviewResolve).toHaveBeenCalledWith(1, { action: 'attach', ticketId: 9050, reopen: false, decisionId: 700 });
  });

  test('New ticket: the requester is prefilled with the first outside address and posted', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    fireEvent.click(within(rows()[5]).getByTestId('mr-primary'));
    const form = within(rows()[5]).getByTestId('mr-new-form');
    const input = within(form).getByLabelText('New ticket for');
    expect(input).toHaveValue('dana.whitlock@client.example.com');
    fireEvent.change(input, { target: { value: 'Lee.Marsh@client.example.com' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Make the ticket' }));
    expect(api.mailReviewResolve).toHaveBeenCalledWith(6, { action: 'create', requesterEmail: 'lee.marsh@client.example.com' });
    await waitFor(() => expect(screen.getByTestId('mr-toast')).toHaveTextContent('New ticket TP-12001 made.'));
  });

  test('bulk accept: no confirm, only the sure attach/create rows, Undo in the toast', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    const bulk = screen.getByTestId('mr-bulk');
    expect(bulk).toHaveTextContent('Accept all sure suggestions (2)');
    fireEvent.click(bulk);
    expect(api.mailReviewBulkAccept).toHaveBeenCalledWith([1, 3]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('mr-toast')).toHaveTextContent('Accepted 2 suggestions.'));
    await waitFor(() => expect(rows()).toHaveLength(4));
    fireEvent.click(screen.getByTestId('mr-toast-undo'));
    await waitFor(() => expect(api.mailReviewUndo).toHaveBeenCalledTimes(2));
  });

  test('keyboard: J/K move a roving focus, A accepts, D needs no ticket, N opens New ticket', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(rows()[0]).toHaveAttribute('tabindex', '0');
    expect(rows()[1]).toHaveAttribute('tabindex', '-1');
    key('j');
    await waitFor(() => expect(rows()[1]).toHaveAttribute('tabindex', '0'));
    expect(document.activeElement).toBe(rows()[1]);
    key('k');
    await waitFor(() => expect(document.activeElement).toBe(rows()[0]));
    key('a');
    expect(api.mailReviewResolve).toHaveBeenLastCalledWith(1, { action: 'attach', ticketId: 9001, reopen: true, decisionId: 700 });
    await waitFor(() => expect(rows()).toHaveLength(5));
    key('d');
    expect(api.mailReviewResolve).toHaveBeenLastCalledWith(2, { action: 'no_ticket', decisionId: 701 });
    await waitFor(() => expect(rows()).toHaveLength(4));
    key('n');
    expect(await screen.findByTestId('mr-new-form')).toBeInTheDocument();
    // Typing in the field never triggers a shortcut.
    const calls = api.mailReviewResolve.mock.calls.length;
    key('a', within(screen.getByTestId('mr-new-form')).getByLabelText('New ticket for'));
    key('d', within(screen.getByTestId('mr-new-form')).getByLabelText('New ticket for'));
    expect(api.mailReviewResolve.mock.calls.length).toBe(calls);
    key('Escape');
    await waitFor(() => expect(screen.queryByTestId('mr-new-form')).not.toBeInTheDocument());
  });

  test('"?" and the Keyboard button list the shortcuts', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(screen.queryByTestId('mr-keys')).not.toBeInTheDocument();
    key('?');
    expect(screen.getByTestId('mr-keys')).toHaveTextContent('J / K');
    fireEvent.click(screen.getByTestId('mr-keys-toggle'));
    expect(screen.queryByTestId('mr-keys')).not.toBeInTheDocument();
  });

  test('empty state', async () => {
    waiting = [];
    mount();
    expect(await screen.findByTestId('mr-empty')).toHaveTextContent('Nothing waiting. Held e-mail shows up here when Ticket Pulse can’t tell which ticket it belongs to.');
  });

  test('a failed refetch keeps the rows and says so inline; a slow one dims after 150 ms', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    let finish;
    api.mailReviewList.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = reject; }));
    fireEvent.click(screen.getByTestId('mr-bulk'));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(screen.getByTestId('mr-panel').className).not.toMatch(/opacity-60/);
    await waitFor(() => expect(screen.getByTestId('mr-panel').className).toMatch(/opacity-60/));
    expect(rows().length).toBeGreaterThan(0);
    await act(async () => { finish(new Error('The server did not answer.')); });
    expect(await screen.findByText('The server did not answer.')).toBeInTheDocument();
    expect(rows().length).toBeGreaterThan(0);
  });
});

describe('Mail review: Details panel', () => {
  test('Enter opens it with the focus inside; Tab stays inside; Esc closes and gives the focus back', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    rows()[0].focus();
    key('Enter', rows()[0]);
    const panel = await screen.findByTestId('mr-details');
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-modal', 'true');
    const close = within(panel).getByRole('button', { name: 'Close details' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
    await waitFor(() => expect(within(panel).getByTestId('mr-candidates')).toBeInTheDocument());
    // Shortcuts are off while the panel is open.
    key('a', panel);
    expect(api.mailReviewResolve).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('mr-details')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(rows()[0]);
  });

  test('the e-mail in a white well with remote pictures hidden, candidates with why, earlier judgements', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    fireEvent.click(within(rows()[0]).getByTestId('mr-more'));
    fireEvent.click(within(rows()[0]).getByRole('menuitem', { name: 'Details' }));
    const panel = await screen.findByTestId('mr-details');
    const well = await within(panel).findByTestId('mr-email');
    expect(well.querySelector('.tp-light')).toHaveTextContent('Do you have any updates on this invoice?');
    expect(well.querySelector('img')?.getAttribute('src') || '').not.toMatch(/tracker/);
    expect(within(well).getByRole('button', { name: 'Show pictures' })).toBeInTheDocument();
    expect(within(panel).getByTestId('mr-candidates')).toHaveTextContent('Considered because: same invoice number 4053377 · same thread');
    expect(within(panel).getByTestId('mr-candidates')).toHaveTextContent('AI: Same matter.');
    expect(within(panel).getByTestId('mr-earlier')).toHaveTextContent('Not sure · unsure · Judged again');
    expect(within(panel).getByTestId('mr-usage')).toHaveTextContent('economy-model · 2,140 tokens in, 96 out · $0.0021 · 1.8 s');
  });

  test('admins can judge again; everyone else sees neither that nor the model and cost', async () => {
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    rows()[0].focus();
    key('Enter', rows()[0]);
    const panel = await screen.findByTestId('mr-details');
    fireEvent.click(await within(panel).findByTestId('mr-rejudge'));
    await waitFor(() => expect(api.mailReviewRejudge).toHaveBeenCalledWith(1));
    cleanup();
    who.admin = false;
    mount();
    await waitFor(() => expect(rows()).toHaveLength(6));
    rows()[0].focus();
    key('Enter', rows()[0]);
    const plain = await screen.findByTestId('mr-details');
    await within(plain).findByTestId('mr-candidates');
    expect(within(plain).queryByTestId('mr-rejudge')).not.toBeInTheDocument();
    expect(within(plain).queryByTestId('mr-usage')).not.toBeInTheDocument();
  });
});

describe('Mail review: Done and Log', () => {
  test('Done lists what happened and by whom, with Undo only where it is safe', async () => {
    mount('/tickets/mail-review?tab=done');
    const done = await screen.findAllByTestId('mr-done-row');
    expect(done).toHaveLength(2);
    expect(done[0]).toHaveTextContent('Added to #249132 · Reminder: invoice 4053377 · by the AI');
    expect(done[1]).toHaveTextContent('No ticket needed · by Robin Vale');
    expect(within(done[0]).getByTestId('mr-undo')).toBeInTheDocument();
    expect(within(done[1]).queryByTestId('mr-undo')).not.toBeInTheDocument();
    expect(api.mailReviewList).toHaveBeenCalledWith({ tab: 'done' });
  });

  test('Undo acts at once; a 409 shows the server’s plain message on the row', async () => {
    api.mailReviewUndo.mockRejectedValueOnce(Object.assign(new Error('Someone has replied on that ticket since, so it can no longer be undone.'), { status: 409 }));
    mount('/tickets/mail-review?tab=done');
    const done = await screen.findAllByTestId('mr-done-row');
    fireEvent.click(within(done[0]).getByTestId('mr-undo'));
    expect(api.mailReviewUndo).toHaveBeenCalledWith(20);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await within(done[0]).findByTestId('mr-undo-error')).toHaveTextContent('Someone has replied on that ticket since, so it can no longer be undone.');
    expect(screen.getAllByTestId('mr-done-row')).toHaveLength(2);
    // The second try works: the row leaves and the mail is back in Waiting.
    fireEvent.click(within(done[0]).getByTestId('mr-undo'));
    await waitFor(() => expect(screen.getAllByTestId('mr-done-row')).toHaveLength(1));
    expect(screen.getByTestId('mr-toast')).toHaveTextContent('is back in Waiting');
  });

  test('Log: the agreement line, both answers on a changed row, filters and load more', async () => {
    mount('/tickets/mail-review?tab=log');
    const log = await screen.findAllByTestId('mr-log-row');
    expect(log).toHaveLength(2);
    expect(screen.getByTestId('mr-agreement')).toHaveTextContent('People kept 92% of sure suggestions, 61 of 66 in the last 30 days.');
    const changed = within(log[0]).getByTestId('mr-log-changed');
    expect(changed).toHaveTextContent('AI: Add to TP-11340');
    expect(changed).toHaveTextContent('Robin Vale: No ticket needed');
    expect(within(log[1]).queryByTestId('mr-log-changed')).not.toBeInTheDocument();
    expect(log[1]).toHaveTextContent('Applied by the AI');
    expect(log[0]).toHaveTextContent('economy-model');
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'changed' } });
    await waitFor(() => expect(api.mailReviewList).toHaveBeenLastCalledWith({ tab: 'log', limit: 50, outcome: 'changed' }));
    fireEvent.change(screen.getByLabelText('Confidence'), { target: { value: 'sure' } });
    await waitFor(() => expect(api.mailReviewList).toHaveBeenLastCalledWith({ tab: 'log', limit: 50, outcome: 'changed', confidence: 'sure' }));
    expect(screen.queryByTestId('mr-log-more')).not.toBeInTheDocument(); // fewer than a page
  });

  test('Log "Load more" asks for the rows before the last one', async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({ id: 900 - i, heldId: i, subject: `Mail ${i}`, action: 'no_ticket', ticket: null, confidence: 'likely', outcome: 'suggested', mode: 'shadow', createdAt: '2026-11-11T15:00:00Z' }));
    api.mailReviewList.mockImplementation(({ tab, before }) => Promise.resolve(tab === 'log'
      ? { data: before ? [{ ...page[0], id: 1, subject: 'Older mail' }] : page, meta: {} }
      : { data: [], meta: { waiting: 0, doneToday: 0, mode: 'shadow' } }));
    mount('/tickets/mail-review?tab=log');
    await waitFor(() => expect(screen.getAllByTestId('mr-log-row')).toHaveLength(50));
    fireEvent.click(screen.getByTestId('mr-log-more'));
    await waitFor(() => expect(api.mailReviewList).toHaveBeenLastCalledWith({ tab: 'log', limit: 50, before: 851 }));
    await waitFor(() => expect(screen.getAllByTestId('mr-log-row')).toHaveLength(51));
    expect(screen.queryByTestId('mr-log-more')).not.toBeInTheDocument();
  });
});
