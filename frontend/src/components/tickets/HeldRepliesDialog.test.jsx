/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Unmatched replies as a popup (17 Oct 2026): list on the left, the selected
// email on the right with why it is waiting in plain words, the suggested
// ticket's one-click choice, the other choices and the email itself; a
// decision opens the next one.
const api = vi.hoisted(() => ({
  listHeldMessages: vi.fn(),
  getHeldMessage: vi.fn(),
  attachHeldMessage: vi.fn(),
  createTicketFromHeld: vi.fn(),
  discardHeldMessage: vi.fn(),
}));
vi.mock('../../services/api', () => ({ ticketsAPI: api, searchAPI: { global: vi.fn(() => Promise.resolve({ data: { sections: { tickets: [] } } })) } }));

const { default: HeldRepliesDialog } = await import('./HeldRepliesDialog');

const BEST = { id: 63832, displayRef: 'TP-10155', subject: 'Fired: VM down', status: 'Closed', requesterName: 'Microsoft Azure', createdAt: '2026-10-17T12:02:00Z' };
const held = (id, over = {}) => ({
  id, reason: 'sender_burst', subject: `Resolved: VM ${id} back`, fromName: 'Microsoft Azure', fromEmail: 'azure-noreply@microsoft.com',
  toEmails: ['it@example.com'], ccEmails: [], receivedAt: '2026-10-17T12:21:57Z', connectionAddress: 'it@example.com',
  decision: { rule: 'sender_burst', details: { cap: 3, sender: 'azure-noreply@microsoft.com' } }, bestGuessTicket: BEST, candidates: [], ...over,
});

let waiting;
beforeEach(() => {
  vi.clearAllMocks();
  waiting = [held(31), held(32, { reason: 'unknown_reference', bestGuessTicket: null, decision: null })];
  api.listHeldMessages.mockImplementation(() => Promise.resolve({ data: [...waiting], meta: { heldCount: waiting.length } }));
  api.getHeldMessage.mockImplementation((id) => Promise.resolve({ data: { data: { ...waiting.find((r) => r.id === id), bodyHtml: '<p>Alert resolved</p>', bodyText: 'Alert resolved' } } }));
  api.attachHeldMessage.mockImplementation((id) => { waiting = waiting.filter((r) => r.id !== id); return Promise.resolve({ data: {} }); });
  api.discardHeldMessage.mockImplementation((id) => { waiting = waiting.filter((r) => r.id !== id); return Promise.resolve({ data: {} }); });
});
afterEach(cleanup);

const mount = (props = {}) => render(<MemoryRouter><HeldRepliesDialog open onClose={vi.fn()} {...props} /></MemoryRouter>);

describe('HeldRepliesDialog', () => {
  test('lists the waiting emails and opens the first with why, the suggestion and the email', async () => {
    const onCountChange = vi.fn();
    mount({ onCountChange });
    expect(await screen.findByText('Unmatched replies · 2 waiting')).toBeInTheDocument();
    expect(onCountChange).toHaveBeenCalledWith(2);
    const list = screen.getByTestId('held-dialog-list');
    expect(within(list).getByText('Burst from one sender')).toBeInTheDocument();
    expect(screen.getByTestId('held-why')).toHaveTextContent('azure-noreply@microsoft.com sent more than 3 new emails in a single mailbox check');
    expect(screen.getByTestId('held-suggestion')).toHaveTextContent('TP-10155');
    expect(await screen.findByTestId('held-email-frame')).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    expect(screen.getByTestId('held-email-frame').getAttribute('srcdoc')).toContain('<p>Alert resolved</p>');
  });

  test('adding to the suggested ticket files it and opens the next email', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('held-attach-best'));
    await waitFor(() => expect(api.attachHeldMessage).toHaveBeenCalledWith(31, 63832));
    expect(await screen.findByRole('status')).toHaveTextContent('Added to TP-10155 as a reply.');
    await waitFor(() => expect(screen.getByTestId('held-why')).toHaveTextContent('the email it answers is not one Ticket Pulse sent or received'));
    expect(screen.getByTestId('held-suggestion')).toHaveTextContent('No ticket suggested');
  });

  test('when the last one is decided it says nothing is waiting', async () => {
    waiting = [held(31)];
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard this email' }));
    await waitFor(() => expect(api.discardHeldMessage).toHaveBeenCalledWith(31));
    expect(await screen.findByTestId('held-dialog-empty')).toHaveTextContent('Nothing is waiting');
  });

  test('closed: renders nothing and loads nothing', () => {
    render(<MemoryRouter><HeldRepliesDialog open={false} onClose={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByTestId('held-dialog')).toBeNull();
    expect(api.listHeldMessages).not.toHaveBeenCalled();
  });
});
