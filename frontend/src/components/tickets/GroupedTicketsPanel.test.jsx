/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The Grouped view of Tickets: what waits for a person, what was grouped on its
// own (with Undo), and the senders Ticket Pulse has learned.
const api = vi.hoisted(() => ({ get: vi.fn(), undo: vi.fn(), accept: vi.fn(), dismiss: vi.fn(), saveSettings: vi.fn(), updateSender: vi.fn() }));
vi.mock('../../services/api', () => ({ ticketGroupingAPI: api }));

const { default: GroupedTicketsPanel } = await import('./GroupedTicketsPanel');

const t = (id, ref, subject, over = {}) => ({ id, ref, subject, status: 'Open', createdAt: '2026-10-11T20:00:00Z', requester: 'Rapidrecovery', assignee: null, occurrenceCount: 0, ...over });
const PAGE = {
  settings: { mode: 'on', peopleAuto: true }, days: 14, canManage: true,
  waiting: [{ id: 3, kind: 'duplicate', state: 'suggested', reason: 'Same outage.', via: 'similar', retraction: false, createdAt: '2026-10-11T20:00:00Z', ticket: t(80, '#300', 'VPN is down'), target: t(79, '#299', 'Cannot connect to VPN', { assignee: 'Mo' }) }],
  combined: [{ id: 4, kind: 'update', state: 'applied', reason: 'Says the laptop was found.', via: 'requester', retraction: true, createdAt: '2026-10-11T20:00:00Z', ticket: t(70, '#244800', 'Laptop found'), target: t(60, '#244717', 'Disable or locate computer') }],
  repeats: [{ target: t(10, '#246525', 'BGC-EDM-HV02 - Error: Transfer has failed for BGC-EDM-FILE3', { occurrenceCount: 54 }), count: 53, latestAt: '2026-10-12T03:00:00Z', events: [{ id: 9, ticket: t(11, '#246530', 'x'), createdAt: '2026-10-10T00:00:00Z' }] }],
  reversed: [],
  senders: [{ id: 7, sender: 'rapidrecovery@bgcengineering.ca', template: 'x', kind: 'repeating', enabled: true, decidedBy: 'ai', reason: 'A backup system.', sampleSubject: 'BGC-EDM-HV02 - Error', repeatCount: 53 }],
};
const show = () => render(<MemoryRouter initialEntries={['/tickets?view=grouped']}><GroupedTicketsPanel /></MemoryRouter>);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: PAGE });
  for (const k of ['undo', 'accept', 'dismiss', 'saveSettings', 'updateSender']) api[k].mockResolvedValue({ data: {} });
});

describe('Grouped tickets', () => {
  test('says what is on, and lists what waits, what repeated and what was combined', async () => {
    show();
    expect(await screen.findByText('Grouping is on')).toBeInTheDocument();
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByText('VPN is down')).toBeInTheDocument();
    expect(within(waiting).getByText(/Same outage\./)).toBeInTheDocument();
    const repeats = screen.getByRole('region', { name: 'Repeating alerts' });
    expect(within(repeats).getByText('53 repeats closed')).toBeInTheDocument();
    expect(within(repeats).getByText(/seen 54 times in all/)).toBeInTheDocument();
    const combined = screen.getByRole('region', { name: 'Combined on its own' });
    expect(within(combined).getByText('The requester says it is no longer needed.')).toBeInTheDocument();
    expect(within(combined).getByRole('link', { name: '#244717' })).toHaveAttribute('href', '/tickets/60');
  });

  test('Combine and Not related answer a suggestion and the page reloads', async () => {
    show();
    const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
    fireEvent.click(within(waiting).getByRole('button', { name: 'Combine' }));
    await waitFor(() => expect(api.accept).toHaveBeenCalledWith(3));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    fireEvent.click(within(screen.getByRole('region', { name: 'Waiting for you' })).getByRole('button', { name: 'Not related' }));
    await waitFor(() => expect(api.dismiss).toHaveBeenCalledWith(3));
  });

  test('a repeat opens to its copies, each with Undo; a combined pair has Undo too', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Show the repeats of #246525' }));
    const group = screen.getByTestId('grouping-repeats-10');
    fireEvent.click(within(group).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith(9));
    fireEvent.click(within(screen.getByTestId('grouping-event-4')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith(4));
  });

  test('an admin can turn it off, switch people to suggest-only, and correct a sender', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ mode: 'off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Only suggest for people' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ peopleAuto: false }));
    const sender = screen.getByTestId('grouping-sender-7');
    fireEvent.change(within(sender).getByRole('combobox'), { target: { value: 'distinct' } });
    await waitFor(() => expect(api.updateSender).toHaveBeenCalledWith(7, { kind: 'distinct' }));
    fireEvent.click(within(screen.getByTestId('grouping-sender-7')).getByRole('button', { name: 'Stop grouping' }));
    await waitFor(() => expect(api.updateSender).toHaveBeenCalledWith(7, { enabled: false }));
  });

  test('a coordinator sees everything but no switches; an agent gets a plain sentence', async () => {
    api.get.mockResolvedValue({ data: { ...PAGE, canManage: false } });
    const { unmount } = show();
    expect(await screen.findByText('Grouping is on')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
    expect(within(screen.getByTestId('grouping-sender-7')).getByRole('combobox')).toBeDisabled();
    unmount();
    api.get.mockRejectedValue({ response: { status: 403 } });
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Only coordinators and admins can review grouped tickets.');
  });
});
