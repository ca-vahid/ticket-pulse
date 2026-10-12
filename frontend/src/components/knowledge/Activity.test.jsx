/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { neighboursOf, pageWords, recallList, rememberList } from './activityList';

// Knowledge → Activity (12 Oct 2026): pages and filters in the URL, a run on
// its own page with Previous / Next, and the signature pasted as HTML.
const api = {
  listRuns: vi.fn(), getRun: vi.fn(), listPlaybooks: vi.fn(async () => ({ data: [] })), reviewRun: vi.fn(), sendRunToMe: vi.fn(),
  runsSummary: vi.fn(async () => ({ data: [] })), getSettings: vi.fn(async () => ({ data: {} })),
};
vi.mock('../../services/api', () => ({ get knowledgeAPI() { return api; } }));
vi.mock('../common/FancySelect', () => ({
  default: ({ value, onChange, options, disabled, 'aria-label': label }) => (
    <select aria-label={label} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));
vi.mock('../tickets/RichTextEditor', () => ({ default: () => <div data-testid="rich-editor" /> }));

const { default: ActivityPanel } = await import('./ActivityPanel');
const { default: AutoHelpSignatureSettings } = await import('./AutoHelpSignatureSettings');

const run = (over = {}) => ({
  id: 1, ticketId: 55, ticketRef: '#246501', ticketSubject: 'Software Download', status: 'drafted', trigger: 'categorized', mode: 'shadow',
  createdAt: '2026-10-09T21:06:00Z', requesterName: 'Pat Requester', categoryName: 'Software & Apps', subcategoryName: 'Installation',
  playbookId: 40, playbookName: 'Knowledge answers', confidenceBand: 'medium', confidence: 0.7, sources: [], ...over,
});
const page = (items, total = items.length, extra = {}) => ({ data: { items, total, statusCounts: { drafted: total }, needsReview: 2, ...extra } });

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}{loc.search}</div>;
}
function App({ canReview = true }) {
  return (
    <Routes>
      <Route path="/knowledge/activity/:id" element={<Param canReview={canReview} />} />
      <Route path="*" element={<ActivityPanel canReview={canReview} categories={[{ id: 74, name: 'Software & Apps' }]} />} />
    </Routes>
  );
}
function Param({ canReview }) {
  const id = useLocation().pathname.split('/').pop();
  return <ActivityPanel runId={id} canReview={canReview} />;
}
const at = (path) => render(<MemoryRouter initialEntries={[path]}><App /><Where /></MemoryRouter>);

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('activityList', () => {
  test('words for the page, and where a run sits in the list it was opened from', () => {
    expect(pageWords({ offset: 50, shown: 50, total: 425 })).toBe('51–100 of 425');
    expect(pageWords({ offset: 0, shown: 7, total: 7 })).toBe('7 runs');
    expect(pageWords({ total: 0 })).toBe('No runs');
    rememberList({ ids: [9, 8, 7], search: '?sure=low', offset: 50, total: 425 });
    expect(recallList().ids).toEqual([9, 8, 7]);
    expect(neighboursOf(8)).toEqual({ prev: 9, next: 7, position: 52, total: 425, search: '?sure=low' });
    expect(neighboursOf(9).prev).toBeNull();
    expect(neighboursOf(123)).toMatchObject({ prev: null, next: null, position: null, search: '?sure=low' });
  });
});

describe('the run list', () => {
  test('a page at a time: 50 by default, Next asks for the next 50 and the page lives in the URL', async () => {
    api.listRuns.mockResolvedValue(page([run()], 425));
    at('/knowledge/activity');
    const pager = await screen.findByTestId('runs-pager');
    expect(pager).toHaveTextContent('1–1 of 425');
    expect(pager).toHaveTextContent('Page 1 of 9');
    expect(api.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50, offset: 0 }));
    expect(within(pager).getByRole('button', { name: 'Previous page' })).toBeDisabled();
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(api.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50, offset: 50 })));
    expect(screen.getByTestId('where')).toHaveTextContent('?page=2');
    fireEvent.change(screen.getByLabelText('Runs a page'), { target: { value: '100' } });
    await waitFor(() => expect(api.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100, offset: 0 })));
  });

  test('filters reach the server and go back to page 1; Clear removes them', async () => {
    api.listRuns.mockResolvedValue(page([run()], 120));
    at('/knowledge/activity?page=2');
    await screen.findByTestId('runs-table');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '74' } });
    fireEvent.change(screen.getByLabelText('How sure'), { target: { value: 'low' } });
    fireEvent.change(screen.getByLabelText('Live or test'), { target: { value: 'live' } });
    await waitFor(() => expect(api.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: '74', band: 'low', trigger: 'live', offset: 0 })));
    fireEvent.change(screen.getByLabelText('Search runs by ticket number or subject'), { target: { value: '246501' } });
    await waitFor(() => expect(api.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ q: '246501' })));
    fireEvent.click(screen.getByTestId('clear-filters'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/activity$/));
  });

  test('a row says who asked, the category, how sure and whether it still needs a review; "N to review" filters to those', async () => {
    api.listRuns.mockResolvedValue(page([run(), run({ id: 2, ticketRef: '#246400', reviewVerdict: 'good' })], 2));
    at('/knowledge/activity');
    const table = await screen.findByTestId('runs-table');
    const row = table.querySelector('tr[aria-label="Run on #246501"]');
    expect(row).toHaveTextContent('Pat Requester · Installation · Knowledge answers');
    expect(row).toHaveTextContent('Fairly sure');
    expect(row).toHaveTextContent('To review');
    expect(table.querySelector('tr[aria-label="Run on #246400"]')).toHaveTextContent('reviewed: Good');
    fireEvent.click(screen.getByTestId('to-review'));
    await waitFor(() => expect(api.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ review: 'needs' })));
  });
});

describe('a run on its own page', () => {
  const FULL = run({
    id: 8, draftSubject: 'Re: Software Download', draftHtml: '<p>Open Company Portal.</p>',
    evidence: { misses: [{ key: 'partial', label: 'The knowledge covers only part of the request' }], action: { level: 'draft', ceiling: 'suggest', reason: 'one_step_down' } },
    request: { text: 'Please install DT Logger Host.', requester: { name: 'Pat Requester', jobTitle: 'Engineer' }, createdAt: '2026-10-09T21:00:00Z', priority: 2, assigneeName: 'Sam Agent' },
    teamOutcome: { firstReply: { text: 'Installed it for you.', occurredAt: '2026-10-09T22:00:00Z', author: { name: 'Sam Agent' } }, ticket: { status: 'Closed' } },
    sources: [{ sourceId: 'article:5', type: 'article', title: 'Company Portal', cited: true, url: '/knowledge/library/5' }],
  });

  test('opening a row lands on the page: the request, the answer, the team reply, why it was rated, and the place in the list', async () => {
    api.listRuns.mockResolvedValue(page([run({ id: 9 }), run({ id: 8 }), run({ id: 7 })], 3));
    api.getRun.mockResolvedValue({ data: FULL });
    at('/knowledge/activity?sure=medium');
    fireEvent.click((await screen.findByTestId('runs-table')).querySelectorAll('tbody tr')[1]);
    const detail = await screen.findByTestId('run-detail');
    expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/activity/8');
    expect(within(detail).getByTestId('run-request')).toHaveTextContent('Please install DT Logger Host.');
    expect(within(detail).getByTestId('run-answer')).toHaveTextContent('Open Company Portal.');
    expect(within(detail).getByTestId('run-team')).toHaveTextContent('Installed it for you.');
    expect(within(detail).getByTestId('run-sure')).toHaveTextContent('Fairly sure');
    expect(within(detail).getByTestId('run-sure')).toHaveTextContent('The knowledge covers only part of the request');
    expect(within(detail).getByTestId('run-sources')).toHaveTextContent('Company Portal');
    expect(within(detail).getByTestId('run-position')).toHaveTextContent('2 of 3');
    // Back keeps the list's filters.
    expect(within(detail).getByRole('link', { name: /Activity/ })).toHaveAttribute('href', '/knowledge/activity?sure=medium');
  });

  test('Previous / Next and J / K walk the list; "Save and next" judges and moves on', async () => {
    rememberList({ ids: [9, 8, 7], search: '', offset: 0, total: 3 });
    api.getRun.mockImplementation(async (id) => ({ data: { ...FULL, id: Number(id) } }));
    api.reviewRun.mockResolvedValue({ data: { reviewVerdict: 'good' } });
    at('/knowledge/activity/8');
    await screen.findByTestId('run-detail');
    fireEvent.keyDown(window, { key: 'k' });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/activity/9'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Previous run' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Next run' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/activity/8'));
    fireEvent.click(await screen.findByRole('button', { name: 'Good' }));
    fireEvent.click(screen.getByTestId('review-save-next'));
    await waitFor(() => expect(api.reviewRun).toHaveBeenCalledWith(8, { verdict: 'good', note: null }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/activity/7'));
  });

  test('a run opened from a link has no neighbours and still reads', async () => {
    api.getRun.mockResolvedValue({ data: FULL });
    at('/knowledge/activity/8');
    await screen.findByTestId('run-detail');
    expect(screen.queryByTestId('run-position')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next run' })).toBeDisabled();
  });
});

describe('the signature as HTML', () => {
  const TABLE = '<p style="margin-top:25px">Regards,</p><table><tbody><tr><td><img alt="Logo" src="data:image/png;base64,AAAA"></td><td><p style="margin-top:0pt">IT Helpdesk</p></td></tr></tbody></table>';

  test('a table signature is edited as HTML and "As pasted" keeps its own spacing in the preview and the save', async () => {
    const save = vi.fn();
    render(<AutoHelpSignatureSettings settings={{ signatureEnabled: true, signatureHtml: TABLE, signatureSpacing: 'tight', signatureWith: 'replace' }} canManage busy={false} save={save} />);
    expect(screen.getByTestId('signature-source')).toHaveValue(TABLE);
    expect(screen.queryByTestId('rich-editor')).not.toBeInTheDocument();
    const preview = screen.getByTestId('auto-help-signature-preview');
    const regards = () => [...preview.querySelectorAll('p')].find((el) => el.textContent.includes('Regards'));
    expect(regards().getAttribute('style')).not.toContain('25px');
    fireEvent.click(screen.getByRole('radio', { name: 'As pasted' }));
    expect(regards().getAttribute('style')).toContain('25px');
    expect(preview.querySelector('table')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save signature' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ signatureHtml: TABLE, signatureSpacing: 'exact' }));
  });

  test('a plain signature keeps the rich editor; "Edit the HTML" switches', () => {
    render(<AutoHelpSignatureSettings settings={{ signatureEnabled: true, signatureHtml: '<p>IT Department</p>', signatureSpacing: 'tight', signatureWith: 'replace' }} canManage busy={false} save={vi.fn()} />);
    expect(screen.getByTestId('rich-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('signature-source-toggle'));
    fireEvent.change(screen.getByTestId('signature-source'), { target: { value: '<p>IT Helpdesk</p><p>BGC</p>' } });
    expect(screen.getByTestId('auto-help-signature-preview')).toHaveTextContent('IT Helpdesk');
  });
});
