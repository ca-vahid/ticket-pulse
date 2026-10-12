/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { calibrationWords, coverageNote, coverageSort, gapOf, reviewWords } from './coverageFormat';

// The coverage map, the nightly review's switch, the review's inbox items and
// calibration on the dial (plans/KNOWLEDGE_SIMPLIFY_PLAN.md, phases 4 and 5).
const api = {
  coverage: vi.fn(), steward: vi.fn(), runSteward: vi.fn(), suggestion: vi.fn(), inbox: vi.fn(), acceptSuggestion: vi.fn(),
  answering: vi.fn(), listPlaybooks: vi.fn(async () => ({ data: [] })), updateAnswering: vi.fn(), updateSettings: vi.fn(),
};
const growth = { getSettings: vi.fn(), updateSettings: vi.fn(), draftFromTickets: vi.fn() };
vi.mock('../../services/api', () => ({ get knowledgeAPI() { return api; }, get knowledgeGrowthAPI() { return growth; } }));
vi.mock('../common/FancySelect', () => ({
  default: ({ value, onChange, options, disabled, 'aria-label': label, 'data-testid': testId }) => (
    <select aria-label={label} data-testid={testId} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  ),
}));

const { default: CoverageTable } = await import('./CoverageTable');
const { default: ContributionSettings } = await import('./ContributionSettings');
const { default: InboxPanel } = await import('./InboxPanel');
const { default: AnsweringPanel } = await import('./AnsweringPanel');

const row = (over = {}) => ({ id: 1, name: 'X', tickets30: 0, answered: 0, needsPerson: 0, notAnswered: 0, articles: 0, notChecked: 0, attention: 0, searchMisses: 0, openGaps: 0, openItems: 0, couldWrite: 0, ...over });
const ROWS = [
  row({ id: 10, name: 'Software & Apps', tickets30: 210, answered: 31, needsPerson: 120, notAnswered: 4, articles: 5, notChecked: 2, couldWrite: 10 }),
  row({ id: 30, name: 'Devices & Hardware', tickets30: 114, needsPerson: 60, notAnswered: 9, searchMisses: 3, openGaps: 2, couldWrite: 10 }),
  row({ id: 40, name: 'Cloud & Servers', tickets30: 59, needsPerson: 55, couldWrite: 0 }),
  row({ id: 50, name: 'Quiet', tickets30: 0 }),
];
function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}
const wrap = (ui, path = '/') => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="*" element={ui} /></Routes><Where /></MemoryRouter>);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('coverageFormat', () => {
  test('the gap is what nothing answered plus searches that found nothing; the biggest gap comes first', () => {
    expect(gapOf(ROWS[1])).toBe(12);
    expect(coverageSort(ROWS).map((c) => c.id)).toEqual([30, 10, 40, 50]);
  });

  test('one sentence per row for the thing worth acting on, always with its count', () => {
    expect(coverageNote(ROWS[1])).toBe('114 tickets and nothing written yet');
    expect(coverageNote(ROWS[2])).toBe('59 tickets, nothing written, and nobody has the skill recorded to write it');
    expect(coverageNote(ROWS[0])).toBe('4 could not be answered');
    expect(coverageNote(row({ articles: 3, notAnswered: 5, openGaps: 1 }))).toBe('5 could not be answered; 1 in the inbox as gap');
    expect(coverageNote(row({ articles: 3, attention: 2 }))).toBe('2 articles need attention');
    expect(coverageNote(row({ articles: 3 }))).toBe('');
  });

  test('calibration and the last review, in words', () => {
    expect(calibrationWords({ high: { judged: 11, right: 9 } })).toBe('sure answers were right 9 of 11 times');
    expect(calibrationWords({ high: { judged: 0, right: 0 } })).toBe('');
    expect(reviewWords(null)).toBe('It has not run yet.');
    expect(reviewWords({ at: '2026-10-12T09:00:00Z', scanned: 7, counts: { overlap: 1, gaps: 2, edits: 1 } })).toBe('Read 7 articles; raised 1 to merge, 2 not written down, 1 change.');
    expect(reviewWords({ at: '2026-10-12T09:00:00Z', scanned: 1, counts: {} })).toBe('Read 1 article; raised nothing new.');
  });
});

describe('CoverageTable', () => {
  test('one row per category with demand, what happened to it and what is written; quiet categories are left out', async () => {
    api.coverage.mockResolvedValue({ data: { days: 30, categories: ROWS } });
    wrap(<CoverageTable />);
    const table = await screen.findByTestId('coverage-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('th').textContent)).toEqual(['Devices & Hardware', 'Software & Apps', 'Cloud & Servers']);
    const hardware = within(table).getByTestId('coverage-row-30');
    expect(hardware).toHaveTextContent('114');
    expect(hardware).toHaveTextContent('12');
    expect(hardware).toHaveTextContent('114 tickets and nothing written yet');
    expect(within(hardware).getByRole('link', { name: 'Devices & Hardware' })).toHaveAttribute('href', '/knowledge/library?c=30');
    expect(within(table).getByRole('columnheader', { name: 'Could write' })).toBeInTheDocument();
  });

  test('no data, or a failed read: nothing is shown', async () => {
    api.coverage.mockRejectedValue(new Error('403'));
    wrap(<CoverageTable />);
    await waitFor(() => expect(api.coverage).toHaveBeenCalled());
    expect(screen.queryByTestId('coverage-table')).not.toBeInTheDocument();
  });
});

describe('the nightly review in Settings', () => {
  beforeEach(() => {
    growth.getSettings.mockResolvedValue({ data: { publishLevel: 'intermediate', checkLevel: 'advanced', askAtClose: false, askDailyCap: 1, stewardEnabled: false } });
    growth.updateSettings.mockImplementation(async (patch) => ({ data: { publishLevel: 'intermediate', checkLevel: 'advanced', askAtClose: false, askDailyCap: 1, stewardEnabled: false, ...patch } }));
    api.steward.mockResolvedValue({ data: { enabled: false, last: null } });
  });

  test('a switch that says what it does and that it never changes an article; "Review now" shows what it raised', async () => {
    api.runSteward.mockResolvedValue({ data: { at: new Date().toISOString(), scanned: 7, counts: { overlap: 1, gaps: 2 } } });
    render(<ContributionSettings canManage />);
    const sw = await screen.findByRole('switch', { name: 'Review the Library every night' });
    expect(screen.getByText(/It never changes an article by itself/)).toBeInTheDocument();
    expect(screen.getByTestId('review-last')).toHaveTextContent('It has not run yet.');
    fireEvent.click(sw);
    await waitFor(() => expect(growth.updateSettings).toHaveBeenCalledWith({ stewardEnabled: true }));
    fireEvent.click(screen.getByTestId('review-now'));
    await waitFor(() => expect(screen.getByTestId('review-last')).toHaveTextContent('Read 7 articles; raised 1 to merge, 2 not written down.'));
  });

  test('someone who cannot manage sees the switch read-only and no "Review now"', async () => {
    render(<ContributionSettings canManage={false} />);
    expect(await screen.findByRole('switch', { name: 'Review the Library every night' })).toBeDisabled();
    expect(screen.queryByTestId('review-now')).not.toBeInTheDocument();
  });
});

describe('the review\'s items in the Inbox', () => {
  const list = (item) => api.inbox.mockResolvedValue({ data: { counts: { mine: 0, categories: 1, all: 1 }, total: 1, items: [item] } });

  test('a merge with no merged text: open the kept article, or say it already covers the other; nothing is archived on a guess', async () => {
    const item = { id: 5, kind: 'merge', title: 'Two articles say the same thing', impact: 11, mine: false, canDecide: true, createdAt: '2026-10-12T00:00:00Z', source: 'steward', evidence: {} };
    list(item);
    api.suggestion.mockResolvedValue({ data: { ...item, why: '84 % alike.', assignedTo: [], articleId: 16, article: { id: 16, title: 'Installing software', bodyHtml: '<p>a</p>' }, otherArticle: { id: 18, title: 'Paid software', bodyHtml: '<p>b</p>' }, proposed: null } });
    api.acceptSuggestion.mockResolvedValue({ data: {} });
    wrap(<InboxPanel />, '/knowledge/inbox');
    const detail = await screen.findByTestId('inbox-detail');
    expect(within(detail).getByText('Kept')).toBeInTheDocument();
    expect(within(detail).getByText('Folded in, then archived')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Open the kept article in the editor' })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Archive the other one' }));
    await waitFor(() => expect(api.acceptSuggestion).toHaveBeenCalledWith(5, { keepAsIs: true }));
  });

  test('"not written down": one click drafts from the tickets behind it and opens the draft', async () => {
    const item = { id: 6, kind: 'gap', title: 'Not written down: Docking station shows no display', impact: 6, mine: true, canDecide: true, createdAt: '2026-10-12T00:00:00Z', source: 'steward', evidence: { ticketIds: [55, 56] } };
    list(item);
    api.suggestion.mockResolvedValue({ data: { ...item, why: 'Asked 6 times in 30 days.', assignedTo: [], proposed: null } });
    api.acceptSuggestion.mockResolvedValue({ data: {} });
    growth.draftFromTickets.mockResolvedValue({ data: { article: { id: 31 } } });
    wrap(<InboxPanel />, '/knowledge/inbox');
    fireEvent.click(await screen.findByTestId('inbox-draft'));
    await waitFor(() => expect(growth.draftFromTickets).toHaveBeenCalledWith({ ticketIds: [55, 56], topic: 'Docking station shows no display', kind: 'gap' }));
    await waitFor(() => expect(api.acceptSuggestion).toHaveBeenCalledWith(6, {}));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/articles/31'));
  });
});

describe('calibration on the dial', () => {
  test('how often "sure" was right is said with its counts; a category where it stopped being reliable says it is paused', async () => {
    const resolved = { dayLevel: 'suggest', nightLevel: 'draft', bar: 0.85, alwaysChecked: false, notes: [], stayQuietWhen: [] };
    const cat = (id, name, calibration, highReliable) => ({ id, name, own: null, resolved, readiness: { met: false, criteria: [] }, articles: 3, runs30: { total: 0, answered: 0 }, subcategories: [], calibration, highReliable });
    api.answering.mockResolvedValue({ data: {
      knowledgeFirst: true, enabled: true, canManage: true, afterHoursNow: false, readinessBar: { minReviewed: 30, minGoodPct: 85 }, default: { own: null, resolved },
      categories: [cat(10, 'Software & Apps', { high: { judged: 11, right: 10 } }, true), cat(20, 'Procurement', { high: { judged: 10, right: 6 } }, false), cat(30, 'Devices', null, true)],
    } });
    wrap(<AnsweringPanel canManage />);
    expect(await screen.findByTestId('answering-calibration-10')).toHaveTextContent('sure answers were right 10 of 11 times');
    expect(screen.getByTestId('answering-calibration-20')).toHaveTextContent('Paused one level down: sure answers were right 6 of 10 times');
    expect(screen.queryByTestId('answering-calibration-30')).not.toBeInTheDocument();
  });
});
