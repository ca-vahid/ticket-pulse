/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BulkActionBar from './BulkActionBar';
import { mergeBulkSummaries, summaryLines, APPLY_CHUNK } from './bulkMacroSummary';
import { ticketsAPI } from '../../services/api';

// QA 11-09 #9: macros in the bulk bar — pick one, see what it will do on the
// selected tickets, apply, read one result line.

vi.mock('../../services/api', () => ({
  ticketsAPI: { macros: vi.fn(), previewMacroBulk: vi.fn(), applyMacroBulk: vi.fn() },
}));

const SECURITY = 'Security tickets need a resolution reason to close — add one to this step in Settings → Macros';
const FS_SUBJECT = 'FreshService composes the subject on FreshService tickets — the subject line is not used';

const plan = (ticketId, ref, steps) => ({ ticketId, ref, ok: true, steps });
const previewData = {
  macro: { id: 31, name: 'Thank and close' },
  tickets: [
    plan(1, 'TP-1', [{ index: 0, type: 'reply', run: true, summary: 'Reply to the requester' }, { index: 1, type: 'status', run: true, summary: 'Set status to Closed' }]),
    plan(2, 'TP-2', [{ index: 0, type: 'reply', run: true, summary: 'Reply to the requester' }, { index: 1, type: 'status', run: false, summary: 'Set status to Closed', reason: SECURITY }]),
    plan(3, '#230003', [{ index: 0, type: 'reply', run: true, summary: 'Reply to the requester', notice: FS_SUBJECT }, { index: 1, type: 'status', run: true, summary: 'Set status to Closed' }]),
  ],
  summary: {
    total: 3, willRun: 3, replies: 3, nothingToDo: [], unavailable: [],
    skips: [{ type: 'status', summary: 'Set status to Closed', reason: SECURITY, refs: ['TP-2'], count: 1 }],
    notices: [{ type: 'reply', notice: FS_SUBJECT, refs: ['#230003'], count: 1 }],
  },
};

const base = {
  selectedCount: 3,
  editableCount: 2,
  skipCount: 1,
  total: 40,
  technicians: [],
  statuses: ['Open', 'Closed'],
  onAction: vi.fn(),
  onClear: vi.fn(),
  onDismissResult: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  ticketsAPI.macros.mockResolvedValue({ success: true, data: [{ id: 31, name: 'Thank and close' }, { id: 32, name: 'Spam / phishing' }] });
  ticketsAPI.previewMacroBulk.mockResolvedValue({ success: true, data: previewData });
  ticketsAPI.applyMacroBulk.mockResolvedValue({ success: true, data: {
    total: 3, applied: 2, failed: 1,
    results: [
      { ticketId: 1, ref: 'TP-1', ok: true },
      { ticketId: 2, ref: 'TP-2', ok: false, error: 'Reply to the requester: mailbox offline' },
      { ticketId: 3, ref: '#230003', ok: true },
    ],
  } });
});
afterEach(cleanup);

async function openMacro(props = {}) {
  const onMacrosApplied = vi.fn();
  const utils = render(<BulkActionBar {...base} macroTicketIds={[1, 2, 3]} onMacrosApplied={onMacrosApplied} {...props} />);
  const button = screen.getByRole('button', { name: 'Bulk macros' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Thank and close' }));
  return { ...utils, onMacrosApplied };
}

describe('BulkActionBar — Macros', () => {
  test('Macros lists the active macros; hidden without ids, for "all matching", and disabled when there are none', async () => {
    const { rerender } = render(<BulkActionBar {...base} macroTicketIds={[1, 2]} onMacrosApplied={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Bulk macros' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(screen.getByRole('menuitem', { name: 'Thank and close' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Spam / phishing' })).toBeInTheDocument();

    rerender(<BulkActionBar {...base} macroTicketIds={null} onMacrosApplied={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Bulk macros' })).not.toBeInTheDocument();
    rerender(<BulkActionBar {...base} macroTicketIds={[1, 2]} onMacrosApplied={vi.fn()} queryScope={{ total: 40, editable: 30, skippedFsBorn: 10 }} />);
    expect(screen.queryByRole('button', { name: 'Bulk macros' })).not.toBeInTheDocument();
    cleanup();

    ticketsAPI.macros.mockResolvedValueOnce({ success: true, data: [] });
    render(<BulkActionBar {...base} macroTicketIds={[1]} onMacrosApplied={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bulk macros' })).toHaveAttribute('title', expect.stringMatching(/No macros yet/)));
    expect(screen.getByRole('button', { name: 'Bulk macros' })).toBeDisabled();
  });

  test('picking a macro previews it inline for the selection and summarises what differs', async () => {
    await openMacro();
    expect(screen.getByText('Apply “Thank and close” to 3 tickets?')).toBeInTheDocument();
    expect(await screen.findByText('Will run on 3 tickets.')).toBeInTheDocument();
    expect(ticketsAPI.previewMacroBulk).toHaveBeenCalledWith(31, [1, 2, 3]);
    expect(screen.getByText(`On 1 (TP-2), “Set status to Closed” is skipped: ${SECURITY}.`)).toBeInTheDocument();
    expect(screen.getByText(`On 1 (#230003): ${FS_SUBJECT}`)).toBeInTheDocument();
    expect(screen.getByText(/Each of the 3 replies goes to its own ticket’s requester/)).toBeInTheDocument();
    expect(ticketsAPI.applyMacroBulk).not.toHaveBeenCalled();
    // Not a browser confirm: the panel is part of the bar.
    expect(screen.getByTestId('bulk-action-bar')).toContainElement(screen.getByTestId('bulk-macro-panel'));
  });

  test('Cancel goes back to the pickers without applying', async () => {
    await openMacro();
    await screen.findByText('Will run on 3 tickets.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('bulk-macro-panel')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bulk macros' })).toBeInTheDocument();
    expect(ticketsAPI.applyMacroBulk).not.toHaveBeenCalled();
  });

  test('Apply runs it and hands the page a result; the bar shows "Applied … to 2 of 3. 1 failed: TP-2 — reason"', async () => {
    const { onMacrosApplied, rerender } = await openMacro();
    await screen.findByText('Will run on 3 tickets.');
    fireEvent.click(screen.getByTestId('bulk-macro-apply'));
    await waitFor(() => expect(onMacrosApplied).toHaveBeenCalled());
    expect(ticketsAPI.applyMacroBulk).toHaveBeenCalledWith(31, [1, 2, 3]);
    const result = onMacrosApplied.mock.calls[0][0];
    expect(result).toEqual(expect.objectContaining({
      kind: 'macro', macroName: 'Thank and close', ok: 2, total: 3, failedIds: [2], leftAlone: 0,
      failed: [{ id: 2, ref: 'TP-2', message: 'Reply to the requester: mailbox offline' }],
    }));

    rerender(<BulkActionBar {...base} selectedCount={1} macroTicketIds={[2]} onMacrosApplied={onMacrosApplied} bulkResult={result} />);
    const line = screen.getByTestId('bulk-macro-result');
    expect(line).toHaveTextContent('Applied “Thank and close” to 2 of 3.');
    expect(line).toHaveTextContent('1 failed: TP-2 — Reply to the requester: mailbox offline');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss result' }));
    expect(base.onDismissResult).toHaveBeenCalled();
  });

  test('tickets with nothing to do are left alone; a big selection applies in small steps', async () => {
    const ids = Array.from({ length: APPLY_CHUNK + 2 }, (_, i) => i + 1);
    ticketsAPI.previewMacroBulk.mockResolvedValueOnce({ success: true, data: {
      macro: { id: 31, name: 'Thank and close' },
      tickets: ids.map((id) => plan(id, `TP-${id}`, [{ index: 0, type: 'note', run: id !== 1, summary: 'Add an internal note', ...(id === 1 ? { reason: 'x' } : {}) }])),
      summary: { total: ids.length, willRun: ids.length - 1, replies: 0, nothingToDo: ['TP-1'], unavailable: [], skips: [], notices: [] },
    } });
    ticketsAPI.applyMacroBulk.mockImplementation(async (_m, part) => ({ success: true, data: { results: part.map((ticketId) => ({ ticketId, ref: `TP-${ticketId}`, ok: true })) } }));
    const { onMacrosApplied } = await openMacro({ macroTicketIds: ids });
    expect(await screen.findByText(/nothing to do on 1 \(TP-1\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('bulk-macro-apply'));
    await waitFor(() => expect(onMacrosApplied).toHaveBeenCalled());
    expect(ticketsAPI.applyMacroBulk.mock.calls.map((c) => c[1])).toEqual([ids.slice(1, APPLY_CHUNK + 1), ids.slice(APPLY_CHUNK + 1)]);
    expect(onMacrosApplied.mock.calls[0][0]).toEqual(expect.objectContaining({ ok: ids.length - 1, total: ids.length - 1, leftAlone: 1, failed: [] }));
  });

  test('a preview that fails says why and offers no Apply', async () => {
    ticketsAPI.previewMacroBulk.mockRejectedValueOnce({ response: { data: { message: 'Native ticketing is not enabled for this workspace' } } });
    await openMacro();
    expect(await screen.findByRole('alert')).toHaveTextContent('Native ticketing is not enabled');
    expect(screen.getByTestId('bulk-macro-apply')).toBeDisabled();
  });
});

describe('bulk macro summary helpers', () => {
  test('chunk summaries merge by step + reason', () => {
    const a = { total: 2, willRun: 2, replies: 1, nothingToDo: [], unavailable: [], skips: [{ type: 'status', summary: 'Set status to Closed', reason: SECURITY, refs: ['TP-1'] }], notices: [] };
    const b = { total: 2, willRun: 1, replies: 0, nothingToDo: ['TP-4'], unavailable: [{ ticketId: 9, error: 'Ticket 9 not found in this workspace' }], skips: [{ type: 'status', summary: 'Set status to Closed', reason: SECURITY, refs: ['TP-3'] }], notices: [] };
    const m = mergeBulkSummaries([a, b]);
    expect(m).toEqual(expect.objectContaining({ total: 4, willRun: 3, replies: 1, nothingToDo: ['TP-4'] }));
    expect(m.skips).toEqual([expect.objectContaining({ count: 2, refs: ['TP-1', 'TP-3'] })]);
    const lines = summaryLines(m).map((l) => l.text);
    expect(lines[0]).toBe('Will run on 3 tickets; nothing to do on 1 (TP-4).');
    expect(lines).toContain(`On 2 (TP-1, TP-3), “Set status to Closed” is skipped: ${SECURITY}.`);
    expect(lines).toContain('1 ticket could not be checked and will be left alone: Ticket 9 not found in this workspace.');
    expect(lines).toContain('The reply goes to that ticket’s own requester.');
  });
});
