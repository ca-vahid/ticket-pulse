/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LevelMatchTab from './LevelMatchTab';

// 26 Oct 2026: Assignment Review → Level match.
const { getSpy, saveSpy, tzGetSpy } = vi.hoisted(() => ({ getSpy: vi.fn(), saveSpy: vi.fn(), tzGetSpy: vi.fn() }));
vi.mock('../../services/api', () => ({
  assignmentLevelMatchAPI: { get: (...a) => getSpy(...a), saveSettings: (...a) => saveSpy(...a) },
  // QA 11-17 item 1: the Time zone fit switch sits in this tab (its own test covers it).
  assignmentTimezoneFitAPI: { get: (...a) => tzGetSpy(...a), saveSettings: vi.fn() },
}));

const RUNS = [
  {
    runId: 2, ticketId: 62380, ref: 'TP-10643', subject: 'Design tool seat', at: '2026-10-26T16:43:00Z',
    outcome: 'moved', applied: false, requiredLevel: 'basic', requiredLevelReason: 'Add a seat to an existing plan',
    from: { techId: 4, techName: 'Eli Park' }, to: { techId: 56, techName: 'Sam Okafor' }, sentence: 'Needs basic: Sam…',
  },
  {
    runId: 1, ticketId: 62390, ref: 'TP-10692', subject: 'Slide template please', at: '2026-10-26T22:22:00Z',
    outcome: 'kept', applied: false, requiredLevel: 'advanced', from: { techId: 4, techName: 'Eli Park' }, to: null,
  },
];
const DATA = {
  settings: { mode: 'shadow', updatedAt: null, updatedBy: null, history: [] },
  canManage: true,
  tally: { total: 2, kept: 1, moved: 1, noLevel: 0, noSkill: 0, byLevel: { basic: 1, advanced: 1 } },
  runs: RUNS,
};

const mount = () => render(<MemoryRouter><LevelMatchTab workspaceTimezone="America/Vancouver" /></MemoryRouter>);
const levelSwitch = () => screen.getByRole('group', { name: 'Level match mode' });

beforeEach(() => {
  getSpy.mockResolvedValue({ data: DATA });
  saveSpy.mockResolvedValue({ data: { settings: { ...DATA.settings, mode: 'live', updatedBy: 'Dana Fox', updatedAt: '2026-10-27T17:00:00Z' } } });
  tzGetSpy.mockRejectedValue(new Error('not here'));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('LevelMatchTab', () => {
  test('shows the mode, the tallies and only the tickets whose person would change', async () => {
    mount();
    expect(await screen.findByTestId('level-match-tab')).toBeInTheDocument();
    expect(within(levelSwitch()).getByRole('button', { name: 'Shadow' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1 basic, 1 advanced')).toBeInTheDocument();
    expect(screen.getByText('Would have moved')).toBeInTheDocument();
    expect(screen.getByText('TP-10643')).toBeInTheDocument();
    expect(screen.getByText('Sam Okafor')).toBeInTheDocument();
    expect(screen.getByText('(shadow)')).toBeInTheDocument();
    expect(screen.queryByText('TP-10692')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Only tickets that would have moved'));
    expect(screen.getByText('TP-10692')).toBeInTheDocument();
    expect(screen.getAllByText('Kept').length).toBe(2); // the tally and the row
  });

  test('QA 11-23: the sentence is plain muted text in the row; a kept run shows its skip reason', async () => {
    getSpy.mockResolvedValue({
      data: {
        ...DATA,
        runs: [
          RUNS[0],
          { ...RUNS[1], sentence: null, skipReason: 'kept: Priya Nair has 9 more open tickets and only 1 fewer today' },
        ],
      },
    });
    mount();
    const sentence = await screen.findByTestId('level-match-sentence');
    expect(sentence).toHaveTextContent('Needs basic: Sam…');
    expect(sentence).toHaveClass('text-muted-foreground', 'whitespace-normal');
    expect(sentence.closest('tr')).not.toHaveAttribute('title');
    fireEvent.click(screen.getByLabelText('Only tickets that would have moved'));
    expect(screen.getByTestId('level-match-skip-reason')).toHaveTextContent('Kept: Priya Nair has 9 more open tickets and only 1 fewer today');
  });

  test('the status is one muted line under the switch, plain text', async () => {
    mount();
    const status = await screen.findByTestId('level-match-status');
    expect(status).toHaveTextContent('Shadow: judges the level and writes who it would choose on each run; nobody’s tickets change.');
    expect(status).toHaveClass('text-muted-foreground');
  });

  test('an admin switches the mode', async () => {
    mount();
    await screen.findByTestId('level-match-tab');
    fireEvent.click(within(levelSwitch()).getByRole('button', { name: 'Live' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith({ mode: 'live' }));
    await waitFor(() => expect(within(levelSwitch()).getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByTestId('level-match-status')).toHaveTextContent(/^Live: automatic assignments go to the qualified person/);
    expect(screen.getByText(/by Dana Fox/)).toBeInTheDocument();
  });

  test('a reviewer sees the switch but cannot change it', async () => {
    getSpy.mockResolvedValue({ data: { ...DATA, canManage: false } });
    mount();
    expect(await screen.findByText('Only an admin can change this.')).toBeInTheDocument();
    expect(within(levelSwitch()).getByRole('button', { name: 'Live' })).toBeDisabled();
  });

  test('both switches look the same: the shared Off / Shadow / Live control, the same status line and (shadow) marker', async () => {
    tzGetSpy.mockResolvedValue({
      data: {
        settings: { mode: 'shadow', updatedAt: null, updatedBy: null, history: [] },
        canManage: true,
        days: 14,
        tally: { total: 5, moved: 1 },
        recentMoves: [{ runId: 7, ticketId: 70, ref: 'TP-200', mode: 'shadow', applied: false, sentence: 'Priya Nair is closer.' }],
      },
    });
    mount();
    const tz = await screen.findByTestId('timezone-fit-setting');
    const lmGroup = levelSwitch();
    const tzGroup = within(tz).getByRole('group', { name: 'Time zone fit mode' });
    expect(tzGroup.className).toBe(lmGroup.className);
    expect(within(tzGroup).getAllByRole('button').map((b) => b.textContent)).toEqual(['Off', 'Shadow', 'Live']);
    expect(within(tzGroup).getByRole('button', { name: 'Shadow' }).className)
      .toBe(within(lmGroup).getByRole('button', { name: 'Shadow' }).className);
    expect(screen.getByTestId('timezone-fit-status').className).toBe(screen.getByTestId('level-match-status').className);
    expect(screen.getByTestId('timezone-fit-status')).toHaveTextContent(/^Shadow: /);
    const marks = screen.getAllByText('(shadow)');
    expect(marks).toHaveLength(2);
    expect(marks[0].className).toBe(marks[1].className);
  });
});
