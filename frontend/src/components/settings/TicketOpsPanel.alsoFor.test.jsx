/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdditionalRequestersSection } from './TicketOpsPanel';
import { ticketsAPI } from '../../services/api';

// Phase MR6 (QA 08-26 #3) — Settings → Ticket Ops → Additional requesters:
// the per-workspace "Also notify additional requesters" switch (default off).

vi.mock('../../services/api', () => ({
  settingsAPI: {},
  ticketsAPI: {
    getAlsoForSettings: vi.fn(() => Promise.resolve({ data: { data: { notifyAdditionalRequesters: false } } })),
    updateAlsoForSettings: vi.fn((v) => Promise.resolve({ data: { data: { notifyAdditionalRequesters: v } } })),
  },
  workspaceAPI: {},
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: [], activeTypes: [], defaultType: null, refresh: vi.fn() }),
  invalidateTicketTypesCache: vi.fn(),
}));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderLoaded({ enabled = false } = {}) {
  ticketsAPI.getAlsoForSettings.mockResolvedValueOnce({ data: { data: { notifyAdditionalRequesters: enabled } } });
  render(<AdditionalRequestersSection />);
  await waitFor(() => expect(screen.getByRole('switch', { name: /Also notify additional requesters/ })).toBeEnabled());
}

describe('AdditionalRequestersSection — "Also notify additional requesters" toggle', () => {
  test('renders off by default with the explanation (replies always, lifecycle mails only when on, CSAT never)', async () => {
    await renderLoaded();
    expect(screen.getByText('Additional requesters')).toBeInTheDocument();
    expect(screen.getByText(/always receive every reply/)).toBeInTheDocument();
    expect(screen.getByText(/Satisfaction surveys stay requester-only/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Also notify additional requesters off/ })).toHaveAttribute('aria-checked', 'false');
  });

  test('flipping the switch PUTs the workspace flag and reflects the response', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('switch', { name: /Also notify additional requesters/ }));
    await waitFor(() => expect(ticketsAPI.updateAlsoForSettings).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByRole('switch', { name: /Also notify additional requesters on/ })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/now carry the additional requesters in Cc/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: /Also notify additional requesters/ }));
    await waitFor(() => expect(ticketsAPI.updateAlsoForSettings).toHaveBeenLastCalledWith(false));
  });

  test('a rejected save (non-admin) shows the server message and keeps the previous state', async () => {
    await renderLoaded({ enabled: false });
    ticketsAPI.updateAlsoForSettings.mockRejectedValueOnce({ response: { data: { message: 'Changing requester notification settings requires admin access.' } } });
    fireEvent.click(screen.getByRole('switch', { name: /Also notify additional requesters/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/requires admin access/);
    expect(screen.getByRole('switch', { name: /Also notify additional requesters off/ })).toHaveAttribute('aria-checked', 'false');
  });
});
