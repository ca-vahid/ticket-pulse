/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LevelMatchTab from './LevelMatchTab';

// 26 Oct 2026: Assignment Review → Level match.
const { getSpy, saveSpy } = vi.hoisted(() => ({ getSpy: vi.fn(), saveSpy: vi.fn() }));
vi.mock('../../services/api', () => ({
  assignmentLevelMatchAPI: { get: (...a) => getSpy(...a), saveSettings: (...a) => saveSpy(...a) },
}));

const RUNS = [
  {
    runId: 2, ticketId: 62380, ref: 'TP-10643', subject: 'Claude Enterprise Account', at: '2026-10-26T16:43:00Z',
    outcome: 'moved', applied: false, requiredLevel: 'basic', requiredLevelReason: 'Add a seat to an existing plan',
    from: { techId: 4, techName: 'Alexey Lavrenyuk' }, to: { techId: 56, techName: 'Soheil Nasiri' }, sentence: 'Needs basic: Soheil…',
  },
  {
    runId: 1, ticketId: 62390, ref: 'TP-10692', subject: 'Slide 2.0 Required Please', at: '2026-10-26T22:22:00Z',
    outcome: 'kept', applied: false, requiredLevel: 'advanced', from: { techId: 4, techName: 'Alexey Lavrenyuk' }, to: null,
  },
];
const DATA = {
  settings: { mode: 'shadow', updatedAt: null, updatedBy: null, history: [] },
  canManage: true,
  tally: { total: 2, kept: 1, moved: 1, noLevel: 0, noSkill: 0, byLevel: { basic: 1, advanced: 1 } },
  runs: RUNS,
};

const mount = () => render(<MemoryRouter><LevelMatchTab workspaceTimezone="America/Vancouver" /></MemoryRouter>);

beforeEach(() => {
  getSpy.mockResolvedValue({ data: DATA });
  saveSpy.mockResolvedValue({ data: { settings: { ...DATA.settings, mode: 'live', updatedBy: 'Vahid Haeri', updatedAt: '2026-10-27T17:00:00Z' } } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('LevelMatchTab', () => {
  test('shows the mode, the tallies and only the tickets whose person would change', async () => {
    mount();
    expect(await screen.findByTestId('level-match-tab')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Shadow/ })).toBeChecked();
    expect(screen.getByText('1 basic, 1 advanced')).toBeInTheDocument();
    expect(screen.getByText('TP-10643')).toBeInTheDocument();
    expect(screen.getByText('Soheil Nasiri')).toBeInTheDocument();
    expect(screen.getByText('(shadow)')).toBeInTheDocument();
    expect(screen.queryByText('TP-10692')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Only where the person changes'));
    expect(screen.getByText('TP-10692')).toBeInTheDocument();
    expect(screen.getAllByText('Kept').length).toBe(2); // the tally and the row
  });

  test('an admin switches the mode', async () => {
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Live/ }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith({ mode: 'live' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Live/ })).toBeChecked());
  });

  test('a reviewer sees the switch but cannot change it', async () => {
    getSpy.mockResolvedValue({ data: { ...DATA, canManage: false } });
    mount();
    expect(await screen.findByText('Only an admin can change this.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Live/ })).toBeDisabled();
  });
});
