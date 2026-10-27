/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// QA 10-26 #3: a device's alert burst is one block with its alert kinds, the
// failure first, and one-click "add all" / "discard all" — in the Tickets
// popup and on Settings → Ticket Mailboxes.
const api = vi.hoisted(() => ({
  listHeldGroups: vi.fn(),
  listHeldMessages: vi.fn(),
  getHeldMessage: vi.fn(),
  attachHeldMessage: vi.fn(),
  createTicketFromHeld: vi.fn(),
  discardHeldMessage: vi.fn(),
  bulkHeldMessages: vi.fn(),
  setBurstGrouping: vi.fn(),
}));
vi.mock('../../services/api', () => ({ ticketsAPI: api, searchAPI: { global: vi.fn(() => Promise.resolve({ data: { sections: { tickets: [] } } })) } }));

const { default: HeldDeviceGroup } = await import('./HeldDeviceGroup');
const { default: HeldRepliesDialog } = await import('./HeldRepliesDialog');
const { default: HeldRepliesPanel } = await import('./HeldRepliesPanel');

const TICKET = { id: 64845, displayRef: 'TP-10558', subject: '[NAS-ONE] Drive 3 …', status: 'Closed' };
const group = () => ({
  sender: 'nas-one@x.io', device: 'NAS-ONE', count: 4, firstAt: '2026-10-23T15:53:37Z', lastAt: '2026-10-23T16:52:32Z',
  ids: [1, 2, 3, 4], attention: true, newKinds: 1, suggestedTicket: TICKET, reasons: ['sender_burst'],
  kinds: [
    { key: 'crash', label: 'Storage Pool 1 on NAS-ONE has crashed', count: 1, attention: true, newKind: true, ticket: null, ids: [4], newestAt: '2026-10-23T16:52:32Z', shadowFolds: 0 },
    { key: 'drive', label: 'Drive # on RS1 is not on the Products Compatibility List', count: 3, attention: false, newKind: false, ticket: TICKET, ids: [1, 2, 3], newestAt: '2026-10-23T16:50:00Z', shadowFolds: 3 },
  ],
});
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('HeldDeviceGroup', () => {
  const mount = (props = {}) => render(<MemoryRouter><HeldDeviceGroup group={group()} mode="shadow" onBulk={vi.fn()} {...props} /></MemoryRouter>);

  test('the device, its count and kinds; the crash is first and marked; the new kind says it has no ticket', () => {
    mount();
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('NAS-ONE · 4 alerts · 2 kinds');
    expect(screen.getByTestId('held-group-attention')).toBeInTheDocument();
    const kinds = screen.getAllByTestId('held-group-kind');
    expect(kinds[0]).toHaveTextContent('1×Storage Pool 1 on NAS-ONE has crashed');
    expect(kinds[0]).toHaveTextContent('New kind, no ticket yet');
    expect(kinds[1]).toHaveTextContent('3×Drive # on RS1');
    expect(within(kinds[1]).getByRole('link', { name: 'TP-10558' })).toHaveAttribute('href', '/tickets/64845');
    expect(screen.getByTestId('held-kind-shadow')).toHaveTextContent('Shadow: 3 would have been counted on TP-10558');
  });

  test('add all goes to the suggested ticket; one kind can be added or discarded on its own', () => {
    const onBulk = vi.fn();
    mount({ onBulk });
    fireEvent.click(screen.getByTestId('held-group-attach-all'));
    expect(onBulk).toHaveBeenCalledWith([1, 2, 3, 4], 'attach', TICKET);
    const drive = screen.getAllByTestId('held-group-kind')[1];
    fireEvent.click(within(drive).getByRole('button', { name: 'Add to TP-10558' }));
    expect(onBulk).toHaveBeenLastCalledWith([1, 2, 3], 'attach', TICKET);
    fireEvent.click(within(drive).getByRole('button', { name: /^Discard 3 / }));
    expect(onBulk).toHaveBeenLastCalledWith([1, 2, 3], 'discard', null);
  });

  test('discard all asks first', () => {
    const onBulk = vi.fn();
    mount({ onBulk });
    fireEvent.click(screen.getByTestId('held-group-discard-all'));
    expect(onBulk).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByTestId('held-group-confirm-discard')).getByRole('button', { name: 'Discard' }));
    expect(onBulk).toHaveBeenCalledWith([1, 2, 3, 4], 'discard', null);
  });
});

describe('grouped queue in the popup and on Settings', () => {
  let queue;
  beforeEach(() => {
    queue = { groups: [group()], singles: [{ id: 31, reason: 'unknown_reference', subject: 'Re: printer', fromEmail: 'rita@x.io', receivedAt: '2026-10-24T18:00:00Z', toEmails: [], ccEmails: [], candidates: [] }], total: 5, mode: 'shadow' };
    api.listHeldGroups.mockImplementation(() => Promise.resolve({ data: queue }));
    api.getHeldMessage.mockResolvedValue({ data: { data: null } });
    api.bulkHeldMessages.mockImplementation(() => { queue = { ...queue, groups: [], total: 1 }; return Promise.resolve({ data: { count: 4 } }); });
  });

  test('the popup lists the device first, opens it, and one click files the whole burst', async () => {
    const onCountChange = vi.fn();
    render(<MemoryRouter><HeldRepliesDialog open onClose={vi.fn()} onCountChange={onCountChange} /></MemoryRouter>);
    expect(await screen.findByText('Unmatched replies · 5 waiting')).toBeInTheDocument();
    expect(onCountChange).toHaveBeenCalledWith(5);
    const entry = screen.getByTestId('held-dialog-group');
    expect(entry).toHaveTextContent('Alert burst · 4');
    expect(entry).toHaveTextContent('Reads like a failure');
    expect(screen.getByTestId('held-dialog-group-detail')).toHaveTextContent('NAS-ONE');
    fireEvent.click(screen.getByTestId('held-group-attach-all'));
    await waitFor(() => expect(api.bulkHeldMessages).toHaveBeenCalledWith([1, 2, 3, 4], 'attach', 64845));
    expect(await screen.findByRole('status')).toHaveTextContent('Added 4 emails from NAS-ONE to TP-10558.');
    // The burst is gone; the remaining email opens.
    await waitFor(() => expect(screen.queryByTestId('held-dialog-group')).not.toBeInTheDocument());
    expect(api.getHeldMessage).toHaveBeenCalledWith(31);
  });

  test('Settings shows the burst switch and the grouped device above the other emails', async () => {
    api.setBurstGrouping.mockResolvedValue({ data: { mode: 'on' } });
    render(<MemoryRouter><HeldRepliesPanel showGuidance={false} /></MemoryRouter>);
    expect(await screen.findByTestId('held-groups')).toHaveTextContent('NAS-ONE');
    expect(screen.getByTestId('held-row-31')).toBeInTheDocument();
    const select = screen.getByLabelText('Repeat alerts in a burst');
    expect(select).toHaveValue('shadow');
    fireEvent.change(select, { target: { value: 'on' } });
    await waitFor(() => expect(api.setBurstGrouping).toHaveBeenCalledWith('on'));
  });
});
