/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TeamForwardDialog from './TeamForwardDialog';

const forward = vi.fn();
const note = vi.fn();
vi.mock('../../services/api', () => ({
  ticketsAPI: { forward: (...a) => forward(...a), note: (...a) => note(...a) },
}));

afterEach(() => { cleanup(); forward.mockReset(); note.mockReset(); });

const DS = { id: 1, label: 'Digital Solutions Team', email: 'ds@example.com' };

function Harness({ onResolve = vi.fn(async () => true), canResolve = true }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open forward</button>
      {open && (
        <TeamForwardDialog ticketId={9} team={DS} canResolve={canResolve} onResolve={onResolve} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

describe('TeamForwardDialog (QA 09-25 item 6)', () => {
  test('Enter is a new line, Ctrl+Enter sends', async () => {
    forward.mockResolvedValue({});
    render(<TeamForwardDialog ticketId={9} team={DS} onClose={vi.fn()} />);
    const box = screen.getByLabelText(/Note/);
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(forward).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(forward).toHaveBeenCalledWith(9, { to: ['ds@example.com'], note: '' }));
  });

  test('resolve cancelled (false) → no note; resolve true → note after resolve, then close', async () => {
    forward.mockResolvedValue({});
    note.mockResolvedValue({});
    const onResolve = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onClose = vi.fn();
    render(<TeamForwardDialog ticketId={9} team={DS} canResolve onResolve={onResolve} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    const resolveBtn = await screen.findByRole('button', { name: 'Resolve as forwarded' });
    fireEvent.click(resolveBtn);
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(resolveBtn).not.toBeDisabled());
    expect(note).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(resolveBtn);
    await waitFor(() => expect(note).toHaveBeenCalledTimes(1));
    expect(onResolve.mock.invocationCallOrder[1]).toBeLessThan(note.mock.invocationCallOrder[0]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test('Esc is ignored while a send is in flight', async () => {
    let finish;
    forward.mockImplementation(() => new Promise((r) => { finish = r; }));
    const onClose = vi.fn();
    render(<TeamForwardDialog ticketId={9} team={DS} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish({}); });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  test('Tab wraps inside the dialog and focus returns to the trigger on close', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open forward' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByTestId('team-forward-dialog');
    const forwardBtn = screen.getByRole('button', { name: 'Forward' });
    forwardBtn.focus();
    fireEvent.keyDown(forwardBtn, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(forwardBtn);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
