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

describe('StatusPicker workspace custom statuses (Phase 8b)', () => {
  const DEFS = [
    { name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true },
    { name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true },
    { name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true },
    { name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true },
    { name: 'Needs Rework', baseStatus: 'Pending', color: 'orange', sortOrder: 4, isSystem: false },
  ];

  test('TP-born: the menu offers the workspace registry, custom statuses included', async () => {
    render(<StatusPicker ticketId={501} value="Open" statusDefs={DEFS} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /status: open/i }));
    expect(await screen.findByRole('option', { name: /needs rework/i })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });

  test('TP-born: picking a custom status confirms then applies it', async () => {
    const onChanged = vi.fn();
    render(<StatusPicker ticketId={501} value="Open" statusDefs={DEFS} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /status: open/i }));
    fireEvent.click(await screen.findByRole('option', { name: /needs rework/i }));
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith(501, 'Needs Rework'));
    expect(onChanged).toHaveBeenCalledWith('Needs Rework', 'Open');
  });

  test('FS-born: custom statuses never appear — FreshService keeps the canonical 4', async () => {
    render(<StatusPicker ticketId={501} value="Open" statusDefs={DEFS} fsChange={vi.fn()} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /status: open/i }));
    expect(await screen.findByRole('option', { name: /closed/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /needs rework/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  test('no defs (meta still loading) → canonical 4 fallback', async () => {
    render(<StatusPicker ticketId={501} value="Open" onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /status: open/i }));
    await screen.findByRole('option', { name: /resolved/i });
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });
});
