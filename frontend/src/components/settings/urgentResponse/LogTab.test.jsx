/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ok } from './urgentResponse.fixtures';

// Log tab: the 30-day counts (live and shadow apart), the filters, the rows
// with the server's sentence, Undo behind an in-app confirm, and Load more.

const api = vi.hoisted(() => ({}));
vi.mock('../../../services/api', () => ({ get urgentResponseAPI() { return api; } }));

const { default: LogTab } = await import('./LogTab');

const zero = { redirected: 0, held: 0, moved: 0, raiseMoved: 0, clockMoved: 0, toldOwnerAway: 0, teamTold: 0, coordinator: 0, onCallAssigned: 0, undone: 0 };
const STATS = { days: 30, live: { ...zero, moved: 4, raiseMoved: 3, clockMoved: 1, teamTold: 6, undone: 1 }, shadow: { ...zero, redirected: 12, moved: 3, raiseMoved: 1, clockMoved: 2 } };

const DAVID = { id: 1, name: 'David Zapata' };
const ANDREW = { id: 2, name: 'Andrew Fong' };
const ROWS = [
  {
    id: 90, createdAt: '2026-10-09T14:10:00Z', layer: 'raise', action: 'moved', shadow: false, priority: 4,
    ticket: { id: 555, displayRef: 'TP-1234', subject: 'VPN down' }, from: DAVID, to: ANDREW,
    sentence: 'Moved from David Zapata to Andrew Fong by the Urgent rule. Became Urgent at 07:10; David starts at 09:00.', details: {}, undoable: true, undoneAt: null, undoneBy: null,
  },
  {
    id: 89, createdAt: '2026-10-09T13:00:00Z', layer: 'assign', action: 'redirected', shadow: true, priority: 3,
    ticket: { id: 556, displayRef: '#240100', subject: 'Printer' }, from: DAVID, to: ANDREW,
    sentence: 'Shadow: would have assigned to Andrew Fong instead of David Zapata.', details: {}, undoable: false, undoneAt: null, undoneBy: null,
  },
  {
    id: 88, createdAt: '2026-10-08T20:00:00Z', layer: 'clock', action: 'moved', shadow: false, priority: 4,
    ticket: { id: 557, displayRef: 'TP-1200', subject: 'Server' }, from: ANDREW, to: DAVID,
    sentence: 'Urgent and untouched for 30 minutes. Moved from Andrew Fong to David Zapata: at work, fewest open tickets.', details: {}, undoable: false,
    undoneAt: '2026-10-08T21:30:00Z', undoneBy: 'Vahid Haeri',
  },
];
const OLDER = { ...ROWS[0], id: 40, ticket: { id: 500, displayRef: 'TP-1100', subject: 'Old' }, undoable: false };

const setup = () => render(<MemoryRouter><LogTab timezone="America/Vancouver" /></MemoryRouter>);
const rows = () => screen.getAllByTestId('urgent-log-row');

beforeEach(() => {
  Object.assign(api, {
    getStats: vi.fn(async () => ok(STATS)),
    getActions: vi.fn(async (params) => ok(params.before ? { items: [OLDER], nextBefore: null } : { items: ROWS, nextBefore: 88 })),
    undoAction: vi.fn(async () => ok({ action: { id: 91 } })),
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Urgent response: Log', () => {
  test('30-day counts keep live and shadow apart', async () => {
    setup();
    const table = await screen.findByTestId('urgent-stats');
    expect(api.getStats).toHaveBeenCalledWith(30);
    const cells = (layer, label) => within(within(within(table).getByTestId(`urgent-stats-${layer}`)).getByRole('row', { name: new RegExp(`^${label}`) })).getAllByRole('cell').map((c) => c.textContent);
    // Moves are counted under the step that made them, never as one total.
    expect(cells('raise', 'Moved to someone at work')).toEqual(['3', '1']);
    expect(cells('clock', 'Moved to someone at work')).toEqual(['1', '2']);
    expect(cells('assign', 'Given to someone at work instead')).toEqual(['0', '12']);
    expect(cells('clock', 'People told')).toEqual(['6', '0']);
    expect(within(table).getByTestId('urgent-stats-clock')).toHaveTextContent('If nobody touches it');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['What', 'Live', 'Shadow']);
  });

  test('rows: time in the workspace zone, ticket link, the sentence, Shadow as a dot and a word', async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(api.getActions).toHaveBeenCalledWith({ limit: 50 });
    const [moved, shadow, undone] = rows();
    expect(moved).toHaveTextContent('Oct 9, 7:10 AM');
    expect(within(moved).getByRole('link', { name: 'TP-1234' })).toHaveAttribute('href', '/tickets/555');
    expect(moved).toHaveTextContent('Moved from David Zapata to Andrew Fong by the Urgent rule.');
    expect(within(moved).getByRole('button', { name: 'Undo: TP-1234' })).toBeInTheDocument();
    expect(within(moved).queryByText('Shadow')).not.toBeInTheDocument();

    expect(within(shadow).getByText('Shadow').className).not.toMatch(/rounded-full|bg-/);
    expect(within(shadow).queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument();

    expect(undone).toHaveTextContent('Undone by Vahid Haeri at Oct 8, 2:30 PM');
    expect(within(undone).queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument();
  });

  test('filters by step and by live / shadow', async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by step' }));
    fireEvent.click(screen.getByRole('option', { name: 'If nobody touches it' }));
    await waitFor(() => expect(api.getActions).toHaveBeenLastCalledWith({ limit: 50, layer: 'clock' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Filter by live or shadow' }));
    fireEvent.click(screen.getByRole('option', { name: 'Shadow only' }));
    await waitFor(() => expect(api.getActions).toHaveBeenLastCalledWith({ limit: 50, layer: 'clock', shadow: 'true' }));
  });

  test('Undo says what will happen, then calls the server and reloads', async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Undo: TP-1234' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Move TP-1234 back to David Zapata?' });
    expect(api.undoAction).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo: TP-1234' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Move back to David' }));
    await waitFor(() => expect(api.undoAction).toHaveBeenCalledWith(90));
    expect(await screen.findByText('TP-1234 is back with David Zapata.')).toBeInTheDocument();
    await waitFor(() => expect(api.getActions).toHaveBeenCalledTimes(2));
    expect(api.getStats).toHaveBeenCalledTimes(2);
  });

  test('an undo the server refuses shows its reason', async () => {
    api.undoAction.mockRejectedValueOnce(Object.assign(new Error('The ticket has moved on: it is now with Maria Lee.'), { status: 409 }));
    setup();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Undo: TP-1234' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Move back to David' }));
    expect(await screen.findByText('The ticket has moved on: it is now with Maria Lee.')).toBeInTheDocument();
  });

  test('Load more asks for the rows before the last one and adds them', async () => {
    setup();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(api.getActions).toHaveBeenLastCalledWith({ limit: 50, before: 88 });
    expect(rows()[3]).toHaveTextContent('TP-1100');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});
