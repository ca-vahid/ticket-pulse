/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueueCardsSection } from './TicketOpsPanel';
import { ticketsAPI } from '../../services/api';
import { DEFAULT_QUEUE_CARDS } from '../tickets/queueCards';

// Mega 08-23 Phase FC (FC4) — Settings → Ticket Ops → Quick filter cards:
// six slot dropdowns over the registry (no duplicate offerings), live mini
// preview, immediate PUT on change, Restore defaults.

vi.mock('../../services/api', () => ({
  settingsAPI: {},
  workspaceAPI: {},
  ticketsAPI: {
    meta: vi.fn(),
    updateQueueCards: vi.fn(),
  },
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: [], activeTypes: [], defaultType: null, refresh: vi.fn() }),
  invalidateTicketTypesCache: vi.fn(),
}));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

beforeEach(() => {
  vi.clearAllMocks();
  ticketsAPI.meta.mockResolvedValue({ data: { queueCards: DEFAULT_QUEUE_CARDS } });
  ticketsAPI.updateQueueCards.mockImplementation((cards) => Promise.resolve({ data: { cards } }));
});

afterEach(cleanup);

async function renderLoaded() {
  render(<QueueCardsSection />);
  await waitFor(() => expect(screen.getByLabelText('Card slot 1')).toBeInTheDocument());
}

describe('QueueCardsSection (Phase FC admin UI)', () => {
  test('renders six slots seeded from meta.queueCards plus a live preview', async () => {
    await renderLoaded();
    for (let i = 1; i <= 6; i += 1) expect(screen.getByLabelText(`Card slot ${i}`)).toBeInTheDocument();
    expect(screen.getByLabelText('Card slot 4')).toHaveValue('due_today');
    const preview = screen.getByLabelText('Card row preview');
    expect(within(preview).getByText('Due today')).toBeInTheDocument();
    expect(within(preview).getByText('All tickets')).toBeInTheDocument();
  });

  test('slot dropdowns never offer a card already used by another slot', async () => {
    await renderLoaded();
    const slot4 = screen.getByLabelText('Card slot 4');
    const offered = [...slot4.querySelectorAll('option')].map((o) => o.value);
    expect(offered).toContain('due_today'); // its own current value
    expect(offered).toContain('created_month'); // unused → offered
    expect(offered).not.toContain('all'); // used by slot 1
    expect(offered).not.toContain('resolved'); // used by slot 6
  });

  test('changing a slot to "Tickets this month" PUTs the new six and updates the preview', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Card slot 4'), { target: { value: 'created_month' } });
    await waitFor(() => expect(ticketsAPI.updateQueueCards).toHaveBeenCalledWith(
      ['all', 'open', 'awaiting', 'created_month', 'overdue', 'resolved'],
    ));
    expect(within(screen.getByLabelText('Card row preview')).getByText('Tickets this month')).toBeInTheDocument();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  test('Restore defaults PUTs the classic six (disabled while already default)', async () => {
    ticketsAPI.meta.mockResolvedValue({ data: { queueCards: ['all', 'open', 'awaiting', 'created_month', 'overdue', 'resolved'] } });
    await renderLoaded();
    const restore = screen.getByRole('button', { name: /Restore defaults/ });
    expect(restore).toBeEnabled();
    fireEvent.click(restore);
    await waitFor(() => expect(ticketsAPI.updateQueueCards).toHaveBeenCalledWith(DEFAULT_QUEUE_CARDS));
    await waitFor(() => expect(screen.getByRole('button', { name: /Restore defaults/ })).toBeDisabled());
  });

  test('a rejected PUT surfaces the server message', async () => {
    ticketsAPI.updateQueueCards.mockRejectedValue({ response: { data: { message: 'cards must not contain duplicates' } } });
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Card slot 4'), { target: { value: 'noise' } });
    expect(await screen.findByText('cards must not contain duplicates')).toBeInTheDocument();
  });
});
