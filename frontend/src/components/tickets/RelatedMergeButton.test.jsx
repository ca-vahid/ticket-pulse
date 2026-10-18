/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Related card merge (17 Oct 2026): the icon opens a confirmation that says
// what happens; a FreshService-born ticket can be deleted there in the same
// call (ticked by default for reviewers/admins).
const api = vi.hoisted(() => ({ mergeInto: vi.fn() }));
vi.mock('../../services/api', () => ({ ticketsAPI: api }));

const { default: RelatedMergeButton } = await import('./RelatedMergeButton');

const TARGET = { id: 63857, displayRef: 'TP-10179', subject: 'anyone working today?' };
const FS_SOURCE = { id: 63901, displayRef: '#247711', subject: 'Re: anyone working today?', origin: 'freshservice', status: 'Open' };
const TP_SOURCE = { id: 63902, displayRef: 'TP-10201', subject: 'follow-up', origin: 'ticketpulse', status: 'Open' };

beforeEach(() => {
  vi.clearAllMocks();
  api.mergeInto.mockResolvedValue({ data: { data: { fsDelete: { deleted: true } } } });
});
afterEach(cleanup);

describe('RelatedMergeButton', () => {
  test('FS-born: confirm merges into the open ticket and deletes it in FreshService', async () => {
    const onMerged = vi.fn();
    render(<RelatedMergeButton source={FS_SOURCE} target={TARGET} canDeleteFs onMerged={onMerged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Merge #247711 into TP-10179' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Merge #247711 into TP-10179?');
    expect(screen.getByTestId('related-merge-delete-fs')).toBeChecked();
    fireEvent.click(screen.getByTestId('related-merge-confirm'));
    await waitFor(() => expect(api.mergeInto).toHaveBeenCalledWith(63901, 63857, { deleteFsSource: true }));
    await waitFor(() => expect(onMerged).toHaveBeenCalledWith({ source: FS_SOURCE, fsDelete: { deleted: true } }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('FS-born, delete unticked: merge only', async () => {
    render(<RelatedMergeButton source={FS_SOURCE} target={TARGET} canDeleteFs onMerged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Merge #247711/ }));
    fireEvent.click(screen.getByTestId('related-merge-delete-fs'));
    expect(screen.getByTestId('related-merge-confirm')).toHaveTextContent('Merge');
    fireEvent.click(screen.getByTestId('related-merge-confirm'));
    await waitFor(() => expect(api.mergeInto).toHaveBeenCalledWith(63901, 63857, { deleteFsSource: false }));
  });

  test('TP-born: no FreshService choice; it is closed with a note', () => {
    render(<RelatedMergeButton source={TP_SOURCE} target={TARGET} canDeleteFs onMerged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Merge TP-10201/ }));
    expect(screen.queryByTestId('related-merge-delete-fs')).toBeNull();
    expect(screen.getByRole('dialog')).toHaveTextContent('TP-10201 is closed with a note pointing to TP-10179.');
  });

  test('a refusal stays in the dialog with its reason', async () => {
    api.mergeInto.mockRejectedValue({ response: { data: { message: 'The ticket you merge into must be Open or Pending' } } });
    const onMerged = vi.fn();
    render(<RelatedMergeButton source={TP_SOURCE} target={TARGET} canDeleteFs onMerged={onMerged} />);
    fireEvent.click(screen.getByRole('button', { name: /Merge TP-10201/ }));
    fireEvent.click(screen.getByTestId('related-merge-confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent('must be Open or Pending');
    expect(onMerged).not.toHaveBeenCalled();
  });

  test('without delete rights the FreshService box is off and disabled', () => {
    render(<RelatedMergeButton source={FS_SOURCE} target={TARGET} canDeleteFs={false} onMerged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Merge #247711/ }));
    expect(screen.getByTestId('related-merge-delete-fs')).not.toBeChecked();
    expect(screen.getByTestId('related-merge-delete-fs')).toBeDisabled();
  });
});
