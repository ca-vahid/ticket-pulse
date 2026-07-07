/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TicketTagEditor from './TicketTagEditor';

const setTags = vi.fn().mockResolvedValue({});
const createTicketTag = vi.fn().mockResolvedValue({ data: { data: { id: 9, name: 'urgent-vendor', color: 'slate' } } });
vi.mock('../../services/api', () => ({
  ticketsAPI: { setTags: (...a) => setTags(...a) },
  settingsAPI: { createTicketTag: (...a) => createTicketTag(...a) },
}));

const TAGS = [
  { id: 1, name: 'vip', color: 'red' },
  { id: 2, name: 'hardware', color: 'sky' },
];

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('TicketTagEditor', () => {
  test('adds a tag from the palette', async () => {
    const onChanged = vi.fn();
    render(<TicketTagEditor ticketId={5} tags={[TAGS[0]]} allTags={TAGS} canEdit onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /add tag/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'hardware' }));
    await waitFor(() => expect(setTags).toHaveBeenCalledWith(5, [1, 2]));
    expect(onChanged).toHaveBeenCalled();
  });

  test('removes a tag via its chip', async () => {
    render(<TicketTagEditor ticketId={5} tags={TAGS} allTags={TAGS} canEdit onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /remove tag vip/i }));
    await waitFor(() => expect(setTags).toHaveBeenCalledWith(5, [2]));
  });

  test('read-only render shows chips without remove buttons', () => {
    render(<TicketTagEditor ticketId={5} tags={TAGS} allTags={TAGS} canEdit={false} />);
    expect(screen.getByText('vip')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove tag/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add tag/i })).not.toBeInTheDocument();
  });

  test('admin can create a missing tag inline', async () => {
    const onChanged = vi.fn();
    render(<TicketTagEditor ticketId={5} tags={[]} allTags={TAGS} canEdit isAdmin onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /add tag/i }));
    fireEvent.change(screen.getByLabelText(/search tags/i), { target: { value: 'urgent-vendor' } });
    fireEvent.click(await screen.findByRole('button', { name: /create “urgent-vendor”/i }));
    await waitFor(() => expect(createTicketTag).toHaveBeenCalledWith({ name: 'urgent-vendor' }));
    await waitFor(() => expect(setTags).toHaveBeenCalledWith(5, [9]));
    expect(onChanged).toHaveBeenCalled();
  });
});
