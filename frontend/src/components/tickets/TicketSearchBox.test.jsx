/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Search v2 — the tickets-page search box: recents on focus, results as you
// type after the idle delay, direct refs, keyboard, row actions.

const apiMock = vi.hoisted(() => ({
  searchAPI: { global: vi.fn() },
  uiPreferencesAPI: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../services/api', () => apiMock);

import TicketSearchBox, { SEARCH_IDLE_MS, directRef } from './TicketSearchBox';
import { RECENT_SEARCHES_KEY, RECENT_TICKETS_KEY } from '../../utils/recentSearches';

const sections = {
  tickets: [
    { id: 153877, displayRef: '#153877', subject: 'RE: New Hire: Sabina Sanchez', status: 'Open', requesterName: 'HR', assigneeName: 'Reza' },
    { id: 200168, displayRef: '#200168', subject: 'Corrective Action Over Due', status: 'Closed', requesterName: 'Sabina Greer' },
  ],
  requesters: [{ id: 9, name: 'Sabina Greer', email: 'sgreer@bgc.ca', jobTitle: 'Office Administrator', department: 'Colorado', ticketCount: 12 }],
  agents: [{ id: 3, name: 'Sabina Novak', location: 'Calgary' }],
  departments: [{ name: 'Sabina Dept' }],
  tasks: [{ id: 5, title: 'Call Sabina', ticket: { id: 77, displayRef: 'TP-77' } }],
};

function Harness(props) {
  const [value, setValue] = useState(props.initial || '');
  return <TicketSearchBox value={value} onChange={setValue} {...props} />;
}

describe('TicketSearchBox', () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.searchAPI.global.mockReset();
    apiMock.uiPreferencesAPI.get.mockReset().mockResolvedValue({ data: { value: null } });
    apiMock.uiPreferencesAPI.set.mockReset().mockResolvedValue({});
  });
  afterEach(() => cleanup());

  test('directRef recognises #n, bare numbers and TP-n', () => {
    expect(directRef('#242054')).toEqual({ kind: 'fs', number: 242054, label: '#242054' });
    expect(directRef('242054')).toMatchObject({ kind: 'fs' });
    expect(directRef('tp-1042')).toEqual({ kind: 'tp', number: 1042, label: 'TP-1042' });
    expect(directRef('sabina')).toBeNull();
    expect(directRef('123')).toBeNull();
  });

  test('focused and empty: recent searches (with remove + clear all) and recently viewed tickets', async () => {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(['sabina', '#242054']));
    localStorage.setItem(RECENT_TICKETS_KEY, JSON.stringify([{ id: 242769, displayRef: '#242769', subject: 'Passkey issue', at: Date.now() - 60000 }]));
    const onApply = vi.fn(); const onOpenTicket = vi.fn();
    render(<Harness onApply={onApply} onOpenTicket={onOpenTicket} />);
    const box = screen.getByRole('combobox', { name: 'Search tickets' });
    fireEvent.focus(box);
    const panel = await screen.findByRole('listbox', { name: 'Recent searches' });
    expect(within(panel).getByText('sabina')).toBeInTheDocument();
    expect(within(panel).getByText('Passkey issue')).toBeInTheDocument();
    // remove one
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove #242054 from recent searches' }));
    expect(within(panel).queryByText('#242054')).not.toBeInTheDocument();
    // click a recent → applies as the list filter
    fireEvent.click(within(panel).getByText('sabina'));
    expect(onApply).toHaveBeenCalledWith('sabina');
    // recently viewed → opens the ticket (box emptied first: a query switches the panel to results)
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.focus(box);
    fireEvent.click(await screen.findByText('Passkey issue'));
    expect(onOpenTicket).toHaveBeenCalledWith(242769, { newTab: false });
    // clear all
    fireEvent.focus(box);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY))).toEqual([]);
  });

  test('typing waits for the idle delay, shows a spinner, then grouped results with highlights and the ticket total', async () => {
    apiMock.searchAPI.global.mockResolvedValue({ data: { query: 'sabina', sections, totals: { tickets: 196 } } });
    const onOpenTicket = vi.fn(); const onOpenRequester = vi.fn(); const onApply = vi.fn();
    render(<Harness onOpenTicket={onOpenTicket} onOpenRequester={onOpenRequester} onApply={onApply} />);
    const box = screen.getByRole('combobox', { name: 'Search tickets' });
    fireEvent.change(box, { target: { value: 'sabina' } });
    expect(screen.getByLabelText('Searching')).toBeInTheDocument();
    expect(apiMock.searchAPI.global).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMock.searchAPI.global).toHaveBeenCalledWith('sabina'), { timeout: SEARCH_IDLE_MS + 1500 });
    const panel = await screen.findByRole('listbox', { name: 'Search results' }, { timeout: 2000 });
    expect(within(panel).getByText('Tickets')).toBeInTheDocument();
    expect(within(panel).getByText('196')).toBeInTheDocument();
    expect(within(panel).getByText('View all 196 in the list')).toBeInTheDocument();
    expect(within(panel).getAllByText('Sabina').length).toBeGreaterThan(0); // highlighted fragment
    expect(within(panel).getByText('Requesters')).toBeInTheDocument();
    expect(within(panel).getByText('12 tickets →')).toBeInTheDocument();
    expect(within(panel).getByText('Agents')).toBeInTheDocument();
    expect(within(panel).getByText('Departments')).toBeInTheDocument();
    expect(within(panel).getByText('Tasks')).toBeInTheDocument();
    expect(screen.queryByLabelText('Searching')).not.toBeInTheDocument();

    // ticket row → peek; ctrl-click → full page
    fireEvent.click(within(panel).getAllByTitle('Open in the peek panel · Ctrl-click for the full page')[0]);
    expect(onOpenTicket).toHaveBeenCalledWith(153877, { newTab: false });
    // requester row → requester handler (refocus reopens the panel with the same results)
    fireEvent.focus(box);
    fireEvent.click(await screen.findByText('12 tickets →', {}, { timeout: 2000 }));
    expect(onOpenRequester).toHaveBeenCalledWith(expect.objectContaining({ id: 9, name: 'Sabina Greer' }));
    // the query is remembered as a recent
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY))).toEqual(['sabina']);
  });

  test('a direct ref shows an "Open" row first and Enter opens it; plain Enter applies the filter', async () => {
    apiMock.searchAPI.global.mockResolvedValue({ data: { sections: { tickets: [{ id: 21787, displayRef: '#242054', subject: 'DNS and Microsoft 365 support', status: 'Open' }] }, totals: { tickets: 1 } } });
    const onOpenTicket = vi.fn(); const onApply = vi.fn();
    render(<Harness onOpenTicket={onOpenTicket} onApply={onApply} />);
    const box = screen.getByRole('combobox', { name: 'Search tickets' });
    fireEvent.change(box, { target: { value: '#242054' } });
    await screen.findAllByText(/DNS and Microsoft 365 support/, {}, { timeout: 2000 });
    const panel = screen.getByRole('listbox', { name: 'Search results' });
    expect(within(panel).getAllByRole('option')[0]).toHaveTextContent(/Open #242054 — DNS and Microsoft 365 support/);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpenTicket).toHaveBeenCalledWith(21787, { newTab: false });

    fireEvent.change(box, { target: { value: 'printer' } });
    apiMock.searchAPI.global.mockResolvedValue({ data: { sections: {}, totals: {} } });
    await screen.findByText(/Nothing matches/, {}, { timeout: 2000 });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onApply).toHaveBeenCalledWith('printer');
  });

  test('keyboard: arrows move the highlight across sections, Escape closes, "/" focuses from the page', async () => {
    apiMock.searchAPI.global.mockResolvedValue({ data: { sections, totals: { tickets: 2 } } });
    const onOpenRequester = vi.fn();
    render(<Harness onOpenRequester={onOpenRequester} />);
    const box = screen.getByRole('combobox', { name: 'Search tickets' });
    fireEvent.change(box, { target: { value: 'sabina' } });
    await screen.findByRole('listbox', { name: 'Search results' }, { timeout: 2000 });
    await screen.findByText('12 tickets →');
    // rows: ticket, ticket, view-all, requester …
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getByText('12 tickets →').closest('[role="option"]')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpenRequester).toHaveBeenCalled();
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    box.blur();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(box);
  });

  test('the server copy of recent searches wins on mount', async () => {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(['stale']));
    apiMock.uiPreferencesAPI.get.mockResolvedValue({ data: { value: ['fresh one', 'fresh two'] } });
    render(<Harness />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Search tickets' }));
    const panel = await screen.findByRole('listbox', { name: 'Recent searches' });
    await within(panel).findByText('fresh one');
    expect(within(panel).getByText('fresh one')).toBeInTheDocument();
    expect(within(panel).queryByText('stale')).not.toBeInTheDocument();
  });
});
