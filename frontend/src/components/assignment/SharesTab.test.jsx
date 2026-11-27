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
  { id: 6, name: 'Avery Stone' }, { id: 7, name: 'Blake Ruiz' },
];
const CATEGORIES = [
  { id: 10, name: 'Project Setup', subcategories: [{ id: 101, name: 'Quebec' }] },
  { id: 11, name: 'Proposal Setup', subcategories: [] },
  { id: 12, name: 'Research & Development', subcategories: [] },
  { id: 20, name: 'Vendor Invoices', subcategories: [] },
];
const GROUPS = [{ id: 70, name: 'Juniors', memberIds: [6, 7] }, { id: 71, name: 'Night shift', memberIds: [] }];
// QA 11-26: settings are a list of rules. The first is what a v1 object reads as.
const RULE = {
  id: 'r1', name: '', mode: 'shadow', period: 'week', categoryIds: [10, 11],
  members: [{ techId: 1, pct: 50 }, { techId: 2, pct: 20 }, { techId: 3, pct: 20 }, { techId: 4, pct: 10 }],
  groups: [], rest: { evenly: false, techIds: [] },
  updatedAt: '2026-10-16T16:00:00Z', updatedBy: 'Alex Doe',
};
const SETTINGS = {
  v: 2, seq: 1, rules: [RULE],
  updatedAt: '2026-10-16T16:00:00Z', updatedBy: 'Alex Doe',
  history: [{ at: '2026-10-16T16:00:00Z', by: 'Alex Doe', changes: [{ field: 'mode', from: 'off', to: 'shadow' }] }],
};
const DATA = {
  settings: SETTINGS,
  ruleId: 'r1',
  canManage: true,
  people: PEOPLE,
  categories: CATEGORIES,
  groups: GROUPS,
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
    expect(getSpy).toHaveBeenCalledWith(14, undefined);
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
    const members = [{ techId: 1, pct: 40 }, { techId: 2, pct: 20 }, { techId: 3, pct: 20 }, { techId: 4, pct: 20 }];
    saveSpy.mockResolvedValue({ success: true, data: { settings: { ...SETTINGS, rules: [{ ...RULE, members }] }, ruleId: 'r1' } });
    fireEvent.click(save);
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith({
      rule: expect.objectContaining({ id: 'r1', mode: 'shadow', period: 'week', categoryIds: [10, 11], members }),
    }));
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
    saveSpy.mockResolvedValue({ success: true, data: { settings: SETTINGS, ruleId: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith({ rule: expect.objectContaining({ categoryIds: [11, 12, 101] }) }));
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

  // QA 11-06 #4: days away per person, in the window and coming up.
  const AWAY = {
    availability: {
      today: '2026-11-09', unit: 'working days', calendar: 'business hours',
      past: { days: 14, from: '2026-10-27', to: '2026-11-09', workingDays: 10 },
      ahead: { days: 14, from: '2026-11-10', to: '2026-11-23', workingDays: 9 },
      belowShareWithAway: 1, awaySoon: 1,
    },
    rows: DATA.rows.map((r) => ({
      ...r,
      away: r.techId === 3
        ? {
          past: { days: 3, heavy: true, dates: [{ date: '2026-11-02', half: false }, { date: '2026-11-03', half: false }, { date: '2026-11-04', half: false }] },
          ahead: { days: 2, heavy: false, from: '2026-11-18', dates: [{ date: '2026-11-18', half: false }, { date: '2026-11-19', half: true }] },
        }
        : { past: { days: 0, heavy: false, dates: [] }, ahead: { days: 0, heavy: false, from: null, dates: [] } },
    })),
  };

  test('the report shows days away per person, flags a long absence and says what it explains', async () => {
    getSpy.mockResolvedValue({ success: true, data: { ...DATA, ...AWAY } });
    mount();
    await screen.findByTestId('shares-tab');
    expect(screen.getByRole('columnheader', { name: 'Away' })).toBeInTheDocument();
    const jo = screen.getByTestId('shares-away-3');
    expect(jo).toHaveTextContent('3 days away (last 14)');
    expect(jo).toHaveTextContent('2 coming up (from 18 Nov)');
    expect(jo).toHaveTextContent('away for a large part of the time');
    expect(jo.querySelector('[title]').getAttribute('title')).toMatch(/Away in the last 14 days: Mon 2 Nov, Tue 3 Nov, Wed 4 Nov\. Coming up in the next 14 days: Wed 18 Nov, Thu 19 Nov \(half\)\./);
    expect(within(jo).getByText('3 days away (last 14)')).toHaveClass('text-amber-700');
    expect(screen.getByTestId('shares-away-1')).toHaveTextContent('no days away');
    expect(screen.getByTestId('shares-away-note')).toHaveTextContent('Away days explain part of the gap for 1 person: the rule counts a share only on days someone is in.');
    expect(screen.getByTestId('shares-away-note')).toHaveTextContent('1 person is away in the next 14 days.');
    // Still in share order.
    const table = screen.getByRole('columnheader', { name: 'Share' }).closest('table');
    expect(within(table).getAllByRole('row').slice(1).map((row) => row.cells[0].textContent)).toEqual(['Alex Doe', 'Jo Park', 'Sam Lee', 'Kit Moss']);
  });

  test('no availability data: no Away column and no sentence', async () => {
    mount();
    await screen.findByTestId('shares-tab');
    expect(screen.queryByRole('columnheader', { name: 'Away' })).toBeNull();
    expect(screen.queryByTestId('shares-away-note')).toBeNull();
  });

  // ---- QA 11-26: rules per category, internal groups, the rest split evenly ----
  const R2 = {
    id: 'r2', name: 'Vendor Invoices', mode: 'live', period: 'week', categoryIds: [20],
    members: [], groups: [{ groupId: 70, pct: 50 }], rest: { evenly: true, techIds: [4, 5] },
    updatedAt: '2026-11-20T16:00:00Z', updatedBy: 'Alex Doe',
  };
  const TWO = { ...SETTINGS, seq: 2, rules: [RULE, R2] };
  const R2_DATA = {
    ...DATA,
    settings: TWO,
    ruleId: 'r2',
    preview: { ...DATA.preview, picks: [{ name: 'Avery Stone' }], sections: [] },
    rows: [
      { techId: 6, name: 'Avery Stone', pct: 25, slotKey: 'g70', got: 2, gotPct: 33, rulePicked: 2, ruleMatched: 2 },
      { techId: 7, name: 'Blake Ruiz', pct: 25, slotKey: 'g70', got: 1, gotPct: 17, rulePicked: 1, ruleMatched: 1 },
      { techId: 4, name: 'Kit Moss', pct: 25, slotKey: 'rest', got: 2, gotPct: 33, rulePicked: 1, ruleMatched: 1 },
      { techId: 5, name: 'Ria Chen', pct: 25, slotKey: 'rest', got: 1, gotPct: 17, rulePicked: 1, ruleMatched: 0 },
    ],
    totals: { tickets: 6, toMembers: 6, outside: 0, unassigned: 0, runs: 6, compared: 5, agreed: 4, aiCompared: 5, aiAgreed: 3, noPick: 0 },
    events: [],
  };
  R2_DATA.sections = [
    { kind: 'group', id: 70, name: 'Juniors', pct: 50, got: 3, gotPct: 50, rulePicked: 3, ruleMatched: 3, rows: R2_DATA.rows.slice(0, 2) },
    { kind: 'rest', name: 'The rest, split evenly', pct: 50, got: 3, gotPct: 50, rulePicked: 2, ruleMatched: 1, rows: R2_DATA.rows.slice(2) },
  ];
  const twoRules = () => getSpy.mockImplementation(async (days, ruleId) => ({ success: true, data: ruleId === 'r2' ? R2_DATA : { ...DATA, settings: TWO } }));

  test('the rules list: one plain row per rule with its summary and mode', async () => {
    twoRules();
    mount();
    await screen.findByTestId('shares-tab');
    const list = screen.getByRole('list', { name: 'Rules' });
    const rows = within(list).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual([
      'Project Setup, Proposal Setup4 people 100%Shadow',
      'Vendor InvoicesJuniors 50% · rest split evenly across 2 peopleLive',
    ]);
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText(/2 rules: 1 Live, 1 in Shadow\./)).toBeInTheDocument();
  });

  test('picking a rule loads its report; a group row lists its members; other rules’ categories are greyed out', async () => {
    twoRules();
    mount();
    await screen.findByTestId('shares-tab');
    fireEvent.click(screen.getByRole('button', { name: /^Vendor Invoices/ }));
    await waitFor(() => expect(getSpy).toHaveBeenLastCalledWith(14, 'r2'));
    const group = await screen.findByTestId('shares-group-row-70');
    expect(group).toHaveTextContent('Juniors');
    expect(group).toHaveTextContent('Avery Stone, Blake Ruiz — about 25% each');
    expect(screen.getByLabelText('Share for Juniors, percent')).toHaveValue(50);
    expect(screen.getByTestId('shares-rest-row')).toHaveTextContent('The rest, split evenly50%');
    expect(screen.getByTestId('shares-total')).toHaveTextContent('Total 100% — the rest gets 50%, 25% each');
    const cats = screen.getByRole('list', { name: 'Categories it applies to' });
    expect(within(cats).getByRole('checkbox', { name: /^Project Setup(?! ›)/ })).toBeDisabled();
    expect(within(cats).getAllByText('in “Project Setup, Proposal Setup”')).toHaveLength(2);
    // The report: the Juniors subtotal, each junior underneath, then the rest.
    const table = screen.getByRole('columnheader', { name: 'Share' }).closest('table');
    const names = within(table).getAllByRole('row').slice(1).map((row) => row.cells[0].textContent);
    expect(names).toEqual(['Juniorsgroup', 'Avery Stone', 'Blake Ruiz', 'The rest, split evenly', 'Kit Moss', 'Ria Chen']);
    const subtotal = screen.getByTestId('shares-group-70');
    expect([subtotal.cells[1].textContent, subtotal.cells[2].textContent]).toEqual(['50%', '3']);
  });

  test('the running total must leave something for the rest', async () => {
    twoRules();
    mount();
    await screen.findByTestId('shares-tab');
    fireEvent.click(screen.getByRole('button', { name: /^Vendor Invoices/ }));
    const input = await screen.findByLabelText('Share for Juniors, percent');
    fireEvent.change(input, { target: { value: '100' } });
    expect(screen.getByTestId('shares-total')).toHaveTextContent('Named shares make 100% — nothing is left for the rest');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/nothing is left to split evenly/)).toBeInTheDocument();
  });

  test('add a rule: a group with its members, a category, Shadow, saved as a new rule', async () => {
    mount();
    await screen.findByTestId('shares-tab');
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    await waitFor(() => expect(getSpy).toHaveBeenLastCalledWith(14, 'new'));
    expect(screen.getByText('not saved yet')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Add group'), { target: { value: '70' } });
    expect(screen.getByTestId('shares-group-row-70')).toHaveTextContent('Avery Stone, Blake Ruiz — about 50% each');
    expect(screen.getByTestId('shares-total')).toHaveTextContent('Total 100%');
    // The juniors are placed: they are no longer offered as people.
    expect(within(screen.getByLabelText('Add person')).queryByRole('option', { name: 'Avery Stone' })).toBeNull();
    // Categories the first rule holds cannot be ticked.
    const cats = screen.getByRole('list', { name: 'Categories it applies to' });
    expect(within(cats).getByRole('checkbox', { name: /^Proposal Setup/ })).toBeDisabled();
    fireEvent.click(within(cats).getByRole('checkbox', { name: /Research & Development/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Shadow' }));
    saveSpy.mockResolvedValue({ success: true, data: { settings: { ...SETTINGS, rules: [RULE, { ...R2, id: 'r2' }] }, ruleId: 'r2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith({
      rule: expect.objectContaining({ id: undefined, mode: 'shadow', categoryIds: [12], groups: [{ groupId: 70, pct: 100 }], members: [] }),
    }));
  });

  test('a group with nobody in it says so', async () => {
    mount();
    await screen.findByTestId('shares-tab');
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    fireEvent.change(await screen.findByLabelText('Add group'), { target: { value: '71' } });
    expect(screen.getByTestId('shares-group-row-71')).toHaveTextContent('Nobody in this group yet. Its share goes to the others until someone joins.');
  });

  test('split the rest evenly among people: the rest takes what the named shares leave', async () => {
    mount();
    await screen.findByTestId('shares-tab');
    fireEvent.change(shareInput('Alex Doe'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split the rest evenly among…' }));
    expect(screen.getByText('Pick the people who split the rest.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Add person to the rest'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Add person to the rest'), { target: { value: '6' } });
    expect(screen.getByTestId('shares-total')).toHaveTextContent('Total 100% — the rest gets 30%, 15% each');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  test('delete a rule asks first, in the page', async () => {
    mount();
    await screen.findByTestId('shares-tab');
    fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }));
    expect(screen.getByTestId('shares-delete-confirm')).toHaveTextContent('Delete “Project Setup, Proposal Setup”? Tickets in its categories go back to the AI’s pick.');
    saveSpy.mockResolvedValue({ success: true, data: { settings: { ...SETTINGS, rules: [] } } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith({ removeRuleId: 'r1' }));
  });

  test('switching rules with changes not saved asks first', async () => {
    twoRules();
    mount();
    await screen.findByTestId('shares-tab');
    fireEvent.change(shareInput('Alex Doe'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /^Vendor Invoices/ }));
    expect(screen.getByText(/has changes that are not saved/)).toBeInTheDocument();
    expect(shareInput('Alex Doe')).toHaveValue(40);
    fireEvent.click(screen.getByRole('button', { name: 'Discard them' }));
    expect(await screen.findByLabelText('Share for Juniors, percent')).toHaveValue(50);
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
