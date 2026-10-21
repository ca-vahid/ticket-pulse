/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SharesTab from './SharesTab';
import { draftProblems } from '../../utils/assignmentShares';

// QA 10-16 item 4: Assignment Review → Shares. Invented people.
const { getSpy, previewSpy, saveSpy } = vi.hoisted(() => ({ getSpy: vi.fn(), previewSpy: vi.fn(), saveSpy: vi.fn() }));
vi.mock('../../services/api', () => ({
  assignmentSharesAPI: { get: (...a) => getSpy(...a), preview: (...a) => previewSpy(...a), saveSettings: (...a) => saveSpy(...a) },
}));

const PEOPLE = [
  { id: 1, name: 'Alex Doe' }, { id: 2, name: 'Sam Lee' }, { id: 3, name: 'Jo Park' }, { id: 4, name: 'Kit Moss' }, { id: 5, name: 'Ria Chen' },
];
const CATEGORIES = [
  { id: 10, name: 'Project Setup', subcategories: [{ id: 101, name: 'Quebec' }] },
  { id: 11, name: 'Proposal Setup', subcategories: [] },
  { id: 12, name: 'Research & Development', subcategories: [] },
];
const SETTINGS = {
  mode: 'shadow', period: 'week', categoryIds: [10, 11],
  members: [{ techId: 1, pct: 50 }, { techId: 2, pct: 20 }, { techId: 3, pct: 20 }, { techId: 4, pct: 10 }],
  updatedAt: '2026-10-16T16:00:00Z', updatedBy: 'Alex Doe',
  history: [{ at: '2026-10-16T16:00:00Z', by: 'Alex Doe', changes: [{ field: 'mode', from: 'off', to: 'shadow' }] }],
};
const DATA = {
  settings: SETTINGS,
  canManage: true,
  people: PEOPLE,
  categories: CATEGORIES,
  days: 14,
  preview: {
    ready: true,
    period: { kind: 'week', key: 'week of 2026-10-12', start: '2026-10-12T07:00:00Z' },
    picks: ['Alex Doe', 'Sam Lee', 'Jo Park', 'Alex Doe', 'Alex Doe', 'Kit Moss', 'Alex Doe', 'Sam Lee', 'Jo Park', 'Alex Doe'].map((name) => ({ name })),
    out: [{ techId: 5, name: 'Ria Chen', why: 'on leave' }],
    counts: [{ techId: 1, name: 'Alex Doe', pct: 50, count: 3, target: 3.5 }],
  },
  // Deliberately not in count order: the table keeps the server's share order.
  rows: [
    { techId: 1, name: 'Alex Doe', pct: 50, got: 4, gotPct: 40, rulePicked: 5, ruleMatched: 3 },
    { techId: 3, name: 'Jo Park', pct: 20, got: 1, gotPct: 10, rulePicked: 2, ruleMatched: 1 },
    { techId: 2, name: 'Sam Lee', pct: 20, got: 4, gotPct: 40, rulePicked: 2, ruleMatched: 2 },
    { techId: 4, name: 'Kit Moss', pct: 10, got: 1, gotPct: 10, rulePicked: 1, ruleMatched: 0 },
  ],
  totals: { tickets: 12, toMembers: 10, outside: 1, unassigned: 1, runs: 10, compared: 10, agreed: 6, aiCompared: 10, aiAgreed: 7, noPick: 0, selfPicked: 9 },
  events: [
    { runId: 9, at: '2026-10-16T15:02:00Z', mode: 'shadow', ticket: { id: 501, displayRef: 'TP-1900', subject: 'New project setup' }, rulePick: 'Jo Park', aiPick: 'Sam Lee', wentTo: 'Jo Park', agreed: true },
  ],
};

const mount = () => render(<MemoryRouter><SharesTab workspaceTimezone="America/Vancouver" /></MemoryRouter>);
const shareInput = (name) => screen.getByLabelText(`Share for ${name}, percent`);

beforeEach(() => {
  getSpy.mockReset();
  previewSpy.mockReset();
  saveSpy.mockReset();
  getSpy.mockResolvedValue({ success: true, data: DATA });
  previewSpy.mockResolvedValue({ success: true, data: DATA.preview });
});
afterEach(cleanup);

describe('SharesTab', () => {
  test('shows the setup, the preview and the Shadow report', async () => {
    mount();
    expect(await screen.findByTestId('shares-tab')).toBeInTheDocument();
    expect(getSpy).toHaveBeenCalledWith(14);
    expect(screen.getByText(/Shadow: recording who the rule would pick/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Shadow' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Week' })).toBeChecked();
    expect(shareInput('Alex Doe')).toHaveValue(50);
    expect(screen.getByTestId('shares-total')).toHaveTextContent('Total 100%');
    expect(screen.getByTestId('shares-preview')).toHaveTextContent('The next 10 tickets would go to: Alex Doe, Sam Lee, Jo Park, Alex Doe, Alex Doe, Kit Moss');
    expect(screen.getByText(/Out now: Ria Chen \(on leave\)/)).toBeInTheDocument();
    expect(screen.getByTestId('shares-agreement')).toHaveTextContent('The rule’s pick matched who really got the ticket on 6 of 10 tickets (60%). The AI’s first suggestion matched on 7 of 10.');
    // QA 10-20 #4: who really decided the tickets.
    expect(screen.getByTestId('shares-self-picked')).toHaveTextContent('9 of 11 assigned tickets were taken by the person themselves, from the queue.');
    expect(screen.getByTestId('shares-self-picked')).toHaveTextContent('The rule is in Shadow: it writes down its pick and changes nothing.');
  });

  test('the report is ordered by share, never by count', async () => {
    mount();
    await screen.findByTestId('shares-tab');
    const table = screen.getByRole('columnheader', { name: 'Share' }).closest('table');
    const names = within(table).getAllByRole('row').slice(1).map((row) => row.cells[0].textContent);
    expect(names).toEqual(['Alex Doe', 'Jo Park', 'Sam Lee', 'Kit Moss']);
  });

  test('cannot save unless the total is 100', async () => {
    mount();
    await screen.findByTestId('shares-tab');
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.change(shareInput('Alex Doe'), { target: { value: '40' } });
    expect(screen.getByTestId('shares-total')).toHaveTextContent('Total 90% — add 10% to save');
    expect(save).toBeDisabled();
    fireEvent.change(shareInput('Kit Moss'), { target: { value: '20' } });
    expect(screen.getByTestId('shares-total')).toHaveTextContent('Total 100%');
    expect(save).toBeEnabled();
    saveSpy.mockResolvedValue({ success: true, data: { settings: { ...SETTINGS, members: [{ techId: 1, pct: 40 }, { techId: 2, pct: 20 }, { techId: 3, pct: 20 }, { techId: 4, pct: 20 }] } } });
    fireEvent.click(save);
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'shadow', period: 'week', categoryIds: [10, 11],
      members: [{ techId: 1, pct: 40 }, { techId: 2, pct: 20 }, { techId: 3, pct: 20 }, { techId: 4, pct: 20 }],
    })));
  });

  test('the categories pick-list: a top category covers its subcategories', async () => {
    mount();
    await screen.findByTestId('shares-tab');
    const list = screen.getByRole('list', { name: 'Categories it applies to' });
    expect(within(list).getByRole('checkbox', { name: /^Project Setup(?! ›)/ })).toBeChecked();
    const sub = within(list).getByRole('checkbox', { name: 'Project Setup › Quebec' });
    expect(sub).toBeChecked();
    expect(sub).toBeDisabled();
    fireEvent.click(within(list).getByRole('checkbox', { name: /Research & Development/ }));
    fireEvent.click(within(list).getByRole('checkbox', { name: /^Project Setup(?! ›)/ }));
    expect(sub).not.toBeChecked();
    expect(sub).toBeEnabled();
    fireEvent.click(sub);
    saveSpy.mockResolvedValue({ success: true, data: { settings: SETTINGS } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ categoryIds: [11, 12, 101] })));
  });

  test('add a person, split evenly, and the draft preview is asked for', async () => {
    mount();
    await screen.findByTestId('shares-tab');
    fireEvent.change(screen.getByLabelText('Add person'), { target: { value: '5' } });
    expect(shareInput('Ria Chen')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Split evenly' }));
    expect(['Alex Doe', 'Sam Lee', 'Jo Park', 'Kit Moss', 'Ria Chen'].map((n) => Number(shareInput(n).value))).toEqual([20, 20, 20, 20, 20]);
    expect(screen.getByText('Preview (not saved yet)')).toBeInTheDocument();
    await waitFor(() => expect(previewSpy).toHaveBeenCalledWith(expect.objectContaining({ members: expect.arrayContaining([{ techId: 5, pct: 20 }]) })), { timeout: 2000 });
  });

  test('switching on with nobody on the list says why it cannot save', () => {
    expect(draftProblems({ mode: 'shadow', period: 'week', categoryIds: [], members: [] })).toEqual([
      'Add the people who share the tickets before switching it on.',
      'Pick at least one category before switching it on.',
    ]);
    expect(draftProblems({ mode: 'off', period: 'week', categoryIds: [], members: [] })).toEqual([]);
  });

  test('a reviewer who is not an admin sees it read-only', async () => {
    getSpy.mockResolvedValue({ success: true, data: { ...DATA, canManage: false } });
    mount();
    await screen.findByTestId('shares-tab');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText('Only an admin can change these.')).toBeInTheDocument();
    expect(shareInput('Alex Doe')).toBeDisabled();
  });
});
