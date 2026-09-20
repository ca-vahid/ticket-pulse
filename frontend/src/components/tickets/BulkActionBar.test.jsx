/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import BulkActionBar from './BulkActionBar';
import BulkSelectionPanel from './BulkSelectionPanel';

// QA 09-18 #3 — the queue's bulk bar: pickers instead of native selects,
// Merge with a spoken reason when it cannot run, tags and category for a
// page selection, and the Details panel.

const base = {
  selectedCount: 2,
  editableCount: 1,
  skipCount: 1,
  total: 40,
  technicians: [{ id: 7, name: 'Terry Tech' }, { id: 8, name: 'Uma Unix' }],
  statuses: ['Open', 'Pending', 'Resolved', 'Closed'],
  tags: [{ id: 1, name: 'vip' }, { id: 2, name: 'hardware' }],
  categories: [{ id: 10, name: 'Account & Access' }],
  onAction: vi.fn(),
  onMerge: vi.fn(),
  onOpenDetails: vi.fn(),
  onClear: vi.fn(),
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
  onDismissResult: vi.fn(),
  onSelectAllMatching: vi.fn(),
  onBackToPage: vi.fn(),
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('BulkActionBar', () => {
  test('assign, status, tags and category are menus that hand the page a typed action', () => {
    render(<BulkActionBar {...base} />);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByText('1 FS-born read-only')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Bulk assign' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Terry Tech/ }));
    expect(base.onAction).toHaveBeenLastCalledWith({ type: 'assign', value: 7, label: 'Terry Tech' });

    fireEvent.click(screen.getByRole('button', { name: 'Bulk status' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pending' }));
    expect(base.onAction).toHaveBeenLastCalledWith({ type: 'status', value: 'Pending', label: 'Pending' });

    fireEvent.click(screen.getByRole('button', { name: 'Bulk tag' }));
    const tagItems = screen.getAllByRole('menuitem', { name: 'hardware' });
    fireEvent.click(tagItems[1]); // second group = Remove tag
    expect(base.onAction).toHaveBeenLastCalledWith({ type: 'remove_tags', value: [2], label: 'tag − hardware' });

    fireEvent.click(screen.getByRole('button', { name: 'Bulk category' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Uncategorized' }));
    expect(base.onAction).toHaveBeenLastCalledWith({ type: 'set_category', value: null, label: 'category → Uncategorized' });
  });

  test('Merge is disabled with the reason as its tooltip, and calls back when allowed', () => {
    const { rerender } = render(<BulkActionBar {...base} mergeBlockedReason="Select at least two tickets to merge" />);
    const merge = screen.getByRole('button', { name: 'Merge selected tickets' });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAttribute('title', 'Select at least two tickets to merge');
    rerender(<BulkActionBar {...base} mergeBlockedReason={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected tickets' }));
    expect(base.onMerge).toHaveBeenCalled();
  });

  test('agents get assign/status only — no tags, category or merge', () => {
    render(<BulkActionBar {...base} canEdit={false} />);
    expect(screen.queryByRole('button', { name: 'Bulk tag' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bulk category' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge selected tickets' })).not.toBeInTheDocument();
  });

  test('confirm state names the action and count; result state reports and dismisses', () => {
    const { rerender } = render(<BulkActionBar {...base} bulkAction={{ type: 'assign', value: 7, label: 'Terry Tech' }} />);
    expect(screen.getByText(/Assign/)).toBeInTheDocument();
    expect(screen.getByText('1 ticket')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(base.onConfirm).toHaveBeenCalled();
    rerender(<BulkActionBar {...base} bulkResult={{ ok: 1, failed: [], skipped: 1, label: 'Terry Tech' }} />);
    expect(screen.getByText('1 updated (Terry Tech)')).toBeInTheDocument();
    expect(screen.getByText('1 FS-born skipped (read-only)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss result' }));
    expect(base.onDismissResult).toHaveBeenCalled();
  });

  test('a fully selected page offers "Select all N matching"; query scope offers the way back', () => {
    const { rerender } = render(<BulkActionBar {...base} skipCount={0} pageFullySelected total={40} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all 40 matching' }));
    expect(base.onSelectAllMatching).toHaveBeenCalled();
    rerender(<BulkActionBar {...base} queryScope={{ total: 40, editable: 30, skippedFsBorn: 10 }} />);
    expect(screen.getByText('All 40 matching')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge selected tickets' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to page selection' }));
    expect(base.onBackToPage).toHaveBeenCalled();
  });
});

describe('BulkSelectionPanel', () => {
  const tickets = [
    { id: 1, displayRef: 'TP-1', subject: 'Printer', status: 'Open', origin: 'ticketpulse', requester: { name: 'Rita' }, createdAt: '2026-09-01T10:00:00Z' },
    { id: 2, displayRef: '#243080', subject: 'QA TEST - Merge 2', status: 'Closed', origin: 'freshservice', requester: { name: 'Susan' }, createdAt: '2026-09-18T10:00:00Z' },
  ];
  test('lists the selection, drops a ticket, and explains why a merge is blocked', () => {
    const onRemove = vi.fn();
    render(<BulkSelectionPanel tickets={tickets} onRemove={onRemove} onClose={() => {}} onMerge={() => {}} mergeBlockedReason="None of these can receive a merge" />);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByText(/1 FreshService-born/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove #243080 from the selection' }));
    expect(onRemove).toHaveBeenCalledWith(2);
    expect(screen.getByRole('button', { name: /Merge these into one ticket/ })).toBeDisabled();
    expect(screen.getByText('None of these can receive a merge')).toBeInTheDocument();
  });
});
