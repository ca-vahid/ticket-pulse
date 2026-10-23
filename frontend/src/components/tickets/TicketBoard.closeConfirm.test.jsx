/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloseConfirm, needsCloseConfirm } from './TicketBoard';

// QA 10-22 #4: dragging a card into Closed asks first. FS-born drops already
// go through the FreshService confirm, so they are not asked twice.
afterEach(cleanup);

describe('Board close confirmation (QA 10-22 #4)', () => {
  test('a TP-born card dropped into Closed needs the confirmation', () => {
    expect(needsCloseConfirm({ id: 1, origin: 'ticketpulse' }, 'Closed')).toBe(true);
  });

  test('other drops do not', () => {
    expect(needsCloseConfirm({ id: 1, origin: 'ticketpulse' }, 'Pending')).toBe(false);
    expect(needsCloseConfirm({ id: 1, origin: 'ticketpulse' }, 'Open')).toBe(false);
    expect(needsCloseConfirm({ id: 2, origin: 'freshservice', freshserviceTicketId: 9 }, 'Closed')).toBe(false);
    expect(needsCloseConfirm(null, 'Closed')).toBe(false);
  });

  test('the dialog names the ticket, focuses "Close ticket", and Esc or Cancel backs out', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<CloseConfirm ticket={{ id: 1, displayRef: 'TP-10477', subject: 'Replace a worn keyboard' }} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole('alertdialog', { name: 'Close TP-10477?' })).toBeInTheDocument();
    expect(screen.getByText('Replace a worn keyboard')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close ticket' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
