/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TimezoneFitSetting from './TimezoneFitSetting';

// QA 11-17 item 1: the Time zone fit switch beside Level match.
const { getSpy, saveSpy } = vi.hoisted(() => ({ getSpy: vi.fn(), saveSpy: vi.fn() }));
vi.mock('../../services/api', () => ({
  assignmentTimezoneFitAPI: { get: (...a) => getSpy(...a), saveSettings: (...a) => saveSpy(...a) },
}));

const SENTENCE = 'Time zone: the requester is in Santiago (UTC−3); Dana Fox in Toronto is 2 h away, Eli Park in Vancouver 5 h, so Dana would be put first.';
const DATA = {
  settings: { mode: 'off', updatedAt: null, updatedBy: null, history: [] },
  canManage: true,
  days: 14,
  tally: { total: 0, moved: 0 },
  recentMoves: [],
};
const mount = () => render(<MemoryRouter><TimezoneFitSetting workspaceTimezone="America/Vancouver" /></MemoryRouter>);

beforeEach(() => {
  getSpy.mockResolvedValue({ data: DATA });
  saveSpy.mockResolvedValue({ data: { settings: { ...DATA.settings, mode: 'shadow', updatedBy: 'Dana Fox', updatedAt: '2026-11-17T17:00:00Z' } } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('TimezoneFitSetting', () => {
  test('starts off, with one sentence of help', async () => {
    mount();
    expect(await screen.findByTestId('timezone-fit-setting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/For remote work, when the AI’s pick is 3 hours or more from the requester/)).toBeInTheDocument();
    expect(screen.queryByTestId('timezone-fit-tally')).not.toBeInTheDocument();
  });

  test('an admin switches to Shadow', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Shadow' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith({ mode: 'shadow' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Shadow' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByText(/by Dana Fox/)).toBeInTheDocument();
  });

  test('Shadow shows the count and what it would have done', async () => {
    getSpy.mockResolvedValue({
      data: {
        ...DATA,
        settings: { ...DATA.settings, mode: 'shadow' },
        tally: { total: 12, moved: 1 },
        recentMoves: [{ runId: 1, ticketId: 9, ref: 'TP-100', subject: 'Blue screen', at: '2026-11-17T13:14:00Z', mode: 'shadow', applied: false, sentence: SENTENCE }],
      },
    });
    mount();
    expect(await screen.findByTestId('timezone-fit-tally')).toHaveTextContent('1 of 12 tickets would have moved.');
    expect(screen.getByRole('heading', { name: 'Last 14 days' })).toBeInTheDocument();
    expect(screen.getByTestId('timezone-fit-status')).toHaveTextContent('Shadow: writes who would go first on each run; nobody’s tickets change.');
    expect(screen.getByText('TP-100')).toBeInTheDocument();
    expect(screen.getByText(/so Dana would be put first/)).toBeInTheDocument();
    expect(screen.getByText('(shadow)')).toBeInTheDocument();
  });

  test('Live counts only the moves it made, and says why a move was not applied', async () => {
    getSpy.mockResolvedValue({
      data: {
        ...DATA,
        settings: { ...DATA.settings, mode: 'live' },
        tally: { total: 12, moved: 3, applied: 1 },
        recentMoves: [
          { runId: 2, ticketId: 10, ref: 'TP-101', at: '2026-11-17T14:00:00Z', mode: 'live', applied: true, sentence: 'Moved one.' },
          { runId: 3, ticketId: 11, ref: 'TP-102', at: '2026-11-17T15:00:00Z', mode: 'live', applied: false, notAppliedReason: 'an earlier rule chose the person', sentence: 'Locked one.' },
          { runId: 4, ticketId: 12, ref: 'TP-103', at: '2026-11-16T15:00:00Z', mode: 'shadow', applied: false, sentence: 'Shadow day.' },
        ],
      },
    });
    mount();
    expect(await screen.findByTestId('timezone-fit-tally')).toHaveTextContent('1 of 12 tickets moved.');
    expect(screen.getByText('(not applied: an earlier rule chose the person)')).toBeInTheDocument();
    expect(screen.getAllByText('(shadow)')).toHaveLength(1);
  });

  test('a reviewer sees the switch but cannot change it', async () => {
    getSpy.mockResolvedValue({ data: { ...DATA, canManage: false } });
    mount();
    expect(await screen.findByText('Only an admin can change this.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Live' })).toBeDisabled();
  });

  test('renders nothing when the server does not have it', async () => {
    getSpy.mockRejectedValue(new Error('404'));
    const { container } = mount();
    await waitFor(() => expect(getSpy).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
