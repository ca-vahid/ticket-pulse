/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// FreshService switch (25 Nov 2026): merging while FreshService is off never
// offers, ticks or describes anything done in FreshService.

const api = vi.hoisted(() => ({ mergeInto: vi.fn(), related: vi.fn(), list: vi.fn(), mergeMany: vi.fn() }));
vi.mock('../../services/api', () => ({ ticketsAPI: api }));

const { default: RelatedMergeButton } = await import('./RelatedMergeButton');
const { default: MergeTicketsModal } = await import('./MergeTicketsModal');

const TARGET = { id: 63857, displayRef: 'TP-10179', subject: 'anyone working today?' };
const FS_SOURCE = { id: 63901, displayRef: '#900011', subject: 'Re: anyone working today?', origin: 'freshservice', status: 'Open' };
const PRIMARY = { id: 20, origin: 'ticketpulse', status: 'Open', subject: 'Printer jams', nativeNumber: 20, displayRef: 'TP-20', createdAt: '2026-08-01T10:00:00Z' };
const FS_OPEN = { id: 22, origin: 'freshservice', status: 'Open', subject: 'Printer jam (FS)', freshserviceTicketId: 900012, displayRef: '#900012', createdAt: '2026-08-03T10:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  api.mergeInto.mockResolvedValue({ data: { data: { fsDelete: null } } });
  api.related.mockResolvedValue({ data: { nearDuplicates: [], similarByContent: [] } });
  api.list.mockResolvedValue({ data: { items: [] } });
});
afterEach(cleanup);

describe('Related merge while Off', () => {
  test('no "Also delete in FreshService" checkbox, and the merge never asks FreshService to delete', async () => {
    render(<RelatedMergeButton source={FS_SOURCE} target={TARGET} canDeleteFs fsEnabled={false} onMerged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Merge #900011/ }));
    expect(screen.queryByTestId('related-merge-delete-fs')).toBeNull();
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/delete .* in FreshService/i);
    expect(screen.getByTestId('related-merge-confirm')).toHaveTextContent(/^Merge$/);
    fireEvent.click(screen.getByTestId('related-merge-confirm'));
    await waitFor(() => expect(api.mergeInto).toHaveBeenCalledWith(63901, 63857, { deleteFsSource: false }));
  });

  test('connected is unchanged: the box is there and ticked for reviewers', () => {
    render(<RelatedMergeButton source={FS_SOURCE} target={TARGET} canDeleteFs onMerged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Merge #900011/ }));
    expect(screen.getByTestId('related-merge-delete-fs')).toBeChecked();
  });
});

describe('Merge dialog copy while Off', () => {
  test('a FreshService-born ticket "will be closed with a pointer note", never "in FreshService"', async () => {
    render(<MergeTicketsModal ticket={PRIMARY} initialTickets={[FS_OPEN]} fsEnabled={false} onClose={() => {}} onMerged={() => {}} />);
    await screen.findAllByText('Printer jam (FS)');
    expect(screen.queryByText(/closed in FreshService/)).toBeNull();
    expect(screen.getAllByText(/will be closed with a pointer note/).length).toBeGreaterThan(0);
  });

  test('connected keeps "will be closed in FreshService with a pointer note"', async () => {
    render(<MergeTicketsModal ticket={PRIMARY} initialTickets={[FS_OPEN]} onClose={() => {}} onMerged={() => {}} />);
    await screen.findAllByText('Printer jam (FS)');
    expect(screen.getAllByText(/will be closed in FreshService with a pointer note/).length).toBeGreaterThan(0);
  });
});
