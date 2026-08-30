/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MergeTicketsModal from './MergeTicketsModal';
import { MERGE_FS_BLOCKED_REASON, MERGE_TERMINAL_BLOCKED_REASON } from './mergeRules';

// Mega 08-30 Phase MB2/MB6 (QA 08-27 #7): candidates match the SERVICE's
// source rule (any origin, any status but Deleted/Spam — was Open/Pending
// only), terminal candidates are labeled "folded in as-is", and only a
// TP-born Open/Pending ticket can be the survivor (same copy as the header).

const { related, list, mergeMany } = vi.hoisted(() => ({
  related: vi.fn(),
  list: vi.fn(),
  mergeMany: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  ticketsAPI: { related, list, mergeMany },
}));

const PRIMARY = { id: 20, origin: 'ticketpulse', status: 'Open', subject: 'Printer jams', nativeNumber: 20, displayRef: 'TP-20', createdAt: '2026-08-01T10:00:00Z', requester: { id: 40, name: 'Rita Requester' } };
const RESOLVED_TP = { id: 21, origin: 'ticketpulse', status: 'Resolved', subject: 'Printer jams again', nativeNumber: 21, displayRef: 'TP-21', createdAt: '2026-08-02T10:00:00Z' };
const FS_OPEN = { id: 22, origin: 'freshservice', status: 'Open', subject: 'Printer jam (FS)', freshserviceTicketId: 900, displayRef: '#900', createdAt: '2026-08-03T10:00:00Z' };
const DELETED = { id: 23, origin: 'ticketpulse', status: 'Deleted', subject: 'Deleted twin', nativeNumber: 23, displayRef: 'TP-23', createdAt: '2026-08-04T10:00:00Z' };
const CUSTOM_PENDING = { id: 24, origin: 'ticketpulse', status: 'Waiting on vendor', subject: 'Toner on order', nativeNumber: 24, displayRef: 'TP-24', createdAt: '2026-08-05T10:00:00Z' };
const DEFS = [
  { name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true },
  { name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true },
  { name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true },
  { name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true },
  { name: 'Waiting on vendor', baseStatus: 'Pending', color: 'orange', sortOrder: 4, isSystem: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  related.mockResolvedValue({ data: { nearDuplicates: [RESOLVED_TP, DELETED], similarByContent: [] } });
  list.mockResolvedValue({ data: { items: [FS_OPEN, CUSTOM_PENDING] } });
});
afterEach(cleanup);

describe('MergeTicketsModal candidates (Phase MB2)', () => {
  test('lists a Resolved candidate with the "folded in as-is" note, a custom Pending-base ticket, and never a Deleted one', async () => {
    render(<MergeTicketsModal ticket={PRIMARY} statusDefs={DEFS} onClose={() => {}} onMerged={() => {}} />);
    // Same-subject twins are preselected, so the Resolved one shows in the
    // candidates list AND the survivor group — take the candidates row.
    const resolvedRow = (await screen.findAllByText('Printer jams again'))[0].closest('li');
    expect(within(resolvedRow).getByTestId('merge-terminal-note')).toHaveTextContent('Resolved — will be folded in as-is');
    expect(screen.getByText('Toner on order')).toBeInTheDocument();
    expect(screen.queryByText('Deleted twin')).not.toBeInTheDocument();
    // Open candidates carry no terminal note.
    const fsRow = screen.getByText('Printer jam (FS)').closest('li');
    expect(within(fsRow).queryByTestId('merge-terminal-note')).not.toBeInTheDocument();
  });

  test('requester + search lookups no longer pin status to Open,Pending', async () => {
    render(<MergeTicketsModal ticket={PRIMARY} statusDefs={DEFS} onClose={() => {}} onMerged={() => {}} />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0][0]).toEqual({ requesterId: 40, pageSize: 10 });
    expect(list.mock.calls[0][0].status).toBeUndefined();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tickets to merge' }), { target: { value: 'printer' } });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list.mock.calls[1][0]).toEqual({ q: 'printer', pageSize: 8 });
  });

  test('survivor radios: FS-born and Resolved candidates are disabled with the SAME reasons the header uses', async () => {
    render(<MergeTicketsModal ticket={PRIMARY} statusDefs={DEFS} onClose={() => {}} onMerged={() => {}} />);
    await screen.findAllByText('Printer jams again');
    // TP-21 (same subject) is preselected; add the FS-born one.
    expect(screen.getByRole('checkbox', { name: 'Include TP-21 in the merge' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include #900 in the merge' }));

    const fsRadio = screen.getByRole('radio', { name: 'Keep #900 as the primary' });
    expect(fsRadio).toBeDisabled();
    expect(fsRadio).toHaveAttribute('title', MERGE_FS_BLOCKED_REASON);
    const resolvedRadio = screen.getByRole('radio', { name: 'Keep TP-21 as the primary' });
    expect(resolvedRadio).toBeDisabled();
    expect(resolvedRadio).toHaveAttribute('title', MERGE_TERMINAL_BLOCKED_REASON);
    expect(screen.getByRole('radio', { name: 'Keep TP-20 as the primary' })).toBeEnabled();
    expect(screen.getByText(/already closed — folded in as-is/)).toBeInTheDocument();

    // Merge proceeds with the TP Open primary and BOTH sources (Resolved included).
    mergeMany.mockResolvedValue({ data: { merged: [{ id: 21 }, { id: 22 }], failed: [], primaryId: 20 } });
    fireEvent.click(screen.getByRole('button', { name: 'Merge tickets' }));
    await waitFor(() => expect(mergeMany).toHaveBeenCalledWith(20, [21, 22], false));
  });
});
