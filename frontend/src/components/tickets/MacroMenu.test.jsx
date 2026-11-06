/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MacroMenu } from './MacroMenu';
import { ticketsAPI } from '../../services/api';

// QA 11-05 #2: applying a macro shows what it will do on this ticket first.

vi.mock('../../services/api', () => ({
  ticketsAPI: { macros: vi.fn(), previewMacro: vi.fn(), applyMacro: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  ticketsAPI.macros.mockResolvedValue({ success: true, data: [{ id: 9, name: 'Spam / phishing', description: 'Thank, note, close' }] });
  ticketsAPI.previewMacro.mockResolvedValue({ success: true, data: {
    macro: { id: 9, name: 'Spam / phishing' },
    ticket: { id: 501, ref: '#230002', origin: 'freshservice' },
    steps: [
      { index: 0, type: 'reply', run: false, summary: 'Reply to the requester', reason: 'The requester is an unattended mailbox (an alert or integration sender) — replies to it are not e-mailed' },
      { index: 1, type: 'note', run: true, summary: 'Add an internal note', html: '<p>Reported by Alex</p>' },
      { index: 2, type: 'group', run: false, summary: 'Set group to Service Desk', reason: 'FreshService owns this field on FreshService tickets' },
      { index: 3, type: 'status', run: true, summary: 'Set status to Closed' },
    ],
  } });
  ticketsAPI.applyMacro.mockResolvedValue({ success: true, data: { ok: true, macro: { id: 9, name: 'Spam / phishing' }, steps: [] } });
});
afterEach(cleanup);

describe('MacroMenu', () => {
  test('picking a macro previews it (with skipped steps and why) and applies only on confirm', async () => {
    const onApplied = vi.fn();
    render(<MacroMenu ticketId={501} onApplied={onApplied} />);
    fireEvent.click(screen.getByRole('button', { name: /Macros/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Spam \/ phishing/ }));

    expect(await screen.findByRole('dialog', { name: /Apply “Spam \/ phishing” to #230002/ })).toBeInTheDocument();
    // QA 11-05b #4: the exact order, no "status runs last" rule.
    expect(screen.getByText('2 of 4 actions will run, in exactly this order.')).toBeInTheDocument();
    expect(screen.queryByText(/runs last/)).not.toBeInTheDocument();
    expect(screen.getByText(/Skipped: The requester is an unattended mailbox/)).toBeInTheDocument();
    expect(screen.getByText(/Skipped: FreshService owns this field/)).toBeInTheDocument();
    expect(screen.getByText('Reported by Alex')).toBeInTheDocument();
    expect(ticketsAPI.applyMacro).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('macro-apply'));
    await waitFor(() => expect(ticketsAPI.applyMacro).toHaveBeenCalledWith(501, 9));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('steps show in the macro order, a close before the reply, with the after-close notice', async () => {
    ticketsAPI.previewMacro.mockResolvedValueOnce({ success: true, data: {
      macro: { id: 9, name: 'Spam / phishing' },
      ticket: { id: 502, ref: 'TP-1201', origin: 'ticketpulse' },
      steps: [
        { index: 0, type: 'status', run: true, summary: 'Set status to Closed' },
        { index: 1, type: 'reply', run: true, summary: 'Reply to the requester', html: '<p>Thanks, Sam</p>', notice: 'This reply runs after the ticket is set to Closed: it is still sent, and the ticket stays Closed.' },
      ],
    } });
    render(<MacroMenu ticketId={502} />);
    fireEvent.click(screen.getByRole('button', { name: /Macros/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Spam \/ phishing/ }));
    const list = await screen.findByTestId('macro-preview-steps');
    const items = [...list.querySelectorAll('li')].map((li) => li.getAttribute('data-testid'));
    expect(items).toEqual(['macro-preview-status', 'macro-preview-reply']);
    expect(screen.getByText(/This reply runs after the ticket is set to Closed: it is still sent/)).toBeInTheDocument();
  });

  test('Cancel closes the preview without applying', async () => {
    render(<MacroMenu ticketId={501} />);
    fireEvent.click(screen.getByRole('button', { name: /Macros/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Spam \/ phishing/ }));
    await screen.findByText('Set status to Closed');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(ticketsAPI.applyMacro).not.toHaveBeenCalled();
  });
});
