/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import StatusPicker from './StatusPicker';

const setStatus = vi.fn().mockResolvedValue({});
vi.mock('../../services/api', () => ({
  ticketsAPI: { setStatus: (...a) => setStatus(...a) },
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('StatusPicker (queue rows)', () => {
  test('TP-born: selecting a status asks for confirmation before applying', async () => {
    const onChanged = vi.fn();
    render(<StatusPicker ticketId={501} value="Open" onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /status: open/i }));
    fireEvent.click(await screen.findByRole('option', { name: /resolved/i }));
    // Confirm step first — nothing applied yet.
    expect(setStatus).not.toHaveBeenCalled();
    expect(screen.getByText(/change status to/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith(501, 'Resolved'));
    expect(onChanged).toHaveBeenCalledWith('Resolved', 'Open');
  });

  test('TP-born: cancel keeps everything unchanged', async () => {
    render(<StatusPicker ticketId={501} value="Open" onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /status: open/i }));
    fireEvent.click(await screen.findByRole('option', { name: /pending/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(setStatus).not.toHaveBeenCalled();
  });

  test('FS-born: selection hands off to the sync-confirm flow (no inline confirm)', async () => {
    const fsChange = vi.fn().mockResolvedValue({});
    const onChanged = vi.fn();
    render(<StatusPicker ticketId={501} value="Open" fsChange={fsChange} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /status: open/i }));
    fireEvent.click(await screen.findByRole('option', { name: /closed/i }));
    await waitFor(() => expect(fsChange).toHaveBeenCalledWith('Closed'));
    expect(setStatus).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledWith('Closed', 'Open');
  });

  test('FS-born: a rejected sync does not report success', async () => {
    const fsChange = vi.fn().mockRejectedValue(new Error('cancelled'));
    const onChanged = vi.fn();
    render(<StatusPicker ticketId={501} value="Open" fsChange={fsChange} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /status: open/i }));
    fireEvent.click(await screen.findByRole('option', { name: /resolved/i }));
    await waitFor(() => expect(fsChange).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
  });
});
