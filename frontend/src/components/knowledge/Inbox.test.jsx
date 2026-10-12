/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { categoryLine, evidenceWords, impactWords, kindOf, levelWord } from './inboxFormat';

// Knowledge → Inbox, Home, "From rough notes", the save-at-close prompt and
// the contribution settings (plans/KNOWLEDGE_SIMPLIFY_PLAN.md, phase 3).
const api = {
  inbox: vi.fn(), suggestion: vi.fn(), acceptSuggestion: vi.fn(), dismissSuggestion: vi.fn(), snoozeSuggestion: vi.fn(), proposeSuggestion: vi.fn(),
  home: vi.fn(), tidy: vi.fn(), createArticle: vi.fn(), ticketCapture: vi.fn(), captureTicket: vi.fn(),
};
const growth = { getSettings: vi.fn(), updateSettings: vi.fn() };
vi.mock('../../services/api', () => ({ get knowledgeAPI() { return api; }, get knowledgeGrowthAPI() { return growth; } }));
vi.mock('../common/FancySelect', () => ({
  default: ({ value, onChange, options, disabled, 'aria-label': label, 'data-testid': testId }) => (
    <select aria-label={label} data-testid={testId} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

const { default: InboxPanel } = await import('./InboxPanel');
const { default: HomePanel } = await import('./HomePanel');
const { default: NotesToArticle } = await import('./NotesToArticle');
const { default: ContributionSettings } = await import('./ContributionSettings');
const { default: SaveAsKnowledgePrompt } = await import('../tickets/SaveAsKnowledgePrompt');

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}{loc.search}</div>;
}
function InboxRoute(props) {
  const id = useLocation().pathname.split('/')[3] || null;
  return <InboxPanel itemId={id} {...props} />;
}
const renderAt = (path, ui) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="*" element={ui} /></Routes>
    <Where />
  </MemoryRouter>,
);

const ITEMS = [
  { id: 5, kind: 'edit', title: 'Step 2 changed: the app is called Software Center now', impact: 14, mine: true, canDecide: true, createdAt: '2026-10-11T00:00:00Z', source: 'steward', evidence: { ticketIds: [1, 2, 3] } },
  { id: 6, kind: 'flag', title: 'Something is wrong in: Bluebeam licence', impact: 3, mine: false, canDecide: true, createdAt: '2026-10-10T00:00:00Z', source: 'agent_flag', evidence: {} },
];
const DETAIL = {
  5: { ...ITEMS[0], why: 'Three recent replies say Software Center.', assignedTo: ['mid@example.com'], articleId: 7, article: { id: 7, title: 'Installing software', bodyHtml: '<p>Open Company Portal.</p>' }, proposed: { bodyHtml: '<p>Open Software Center.</p><script>x</script>' } },
  6: { ...ITEMS[1], why: 'Step 2 is out of date', assignedTo: [], articleId: 8, article: { id: 8, title: 'Bluebeam licence', bodyHtml: '<p>Ask IT.</p>' }, proposed: null },
};

beforeEach(() => {
  api.inbox.mockResolvedValue({ data: { counts: { mine: 1, categories: 2, all: 5 }, total: 2, items: ITEMS } });
  api.suggestion.mockImplementation(async (id) => ({ data: DETAIL[id] }));
  api.acceptSuggestion.mockResolvedValue({ data: { status: 'accepted' } });
  api.dismissSuggestion.mockResolvedValue({ data: { status: 'dismissed' } });
  api.snoozeSuggestion.mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('inboxFormat', () => {
  test('each kind has its own words; weight and evidence are said with their counts', () => {
    expect(kindOf({ kind: 'merge' })).toMatchObject({ label: 'Two articles to merge', accept: 'Merge them' });
    expect(kindOf({ kind: 'unknown' }).label).toBe('Something is wrong');
    expect(impactWords({ kind: 'edit', impact: 14 })).toBe('about 14 tickets a month');
    expect(impactWords({ kind: 'flag', impact: 1 })).toBe('the article was used in 1 answer');
    expect(impactWords({ kind: 'edit', impact: 0 })).toBe('');
    expect(evidenceWords(ITEMS[0])).toBe('found by the nightly review · 3 tickets behind it');
    expect(levelWord(3)).toBe('Advanced');
    expect(categoryLine({ articles: 6, notChecked: 2, attention: 1, runs30: { total: 40, answered: 9 } })).toBe('6 articles · 2 not checked yet · 1 needs attention · 9 of 40 tickets answered in 30 days');
    expect(categoryLine({ articles: 0 })).toBe('nothing written yet');
  });
});

describe('InboxPanel', () => {
  test('a list sorted by the server, the first item open: what, why, evidence, and the change side by side', async () => {
    renderAt('/knowledge/inbox', <InboxRoute />);
    const list = await screen.findByTestId('inbox-list');
    expect(within(list).getByTestId('inbox-item-5')).toHaveTextContent('A change');
    expect(within(list).getByTestId('inbox-item-5')).toHaveTextContent('for you');
    expect(within(list).getByTestId('inbox-item-5')).toHaveTextContent('about 14 tickets a month');
    const detail = await screen.findByTestId('inbox-detail');
    expect(detail).toHaveTextContent('Three recent replies say Software Center.');
    expect(detail).toHaveTextContent('found by the nightly review · 3 tickets behind it');
    const compare = within(detail).getByTestId('inbox-compare');
    expect(compare).toHaveTextContent('Open Company Portal.');
    expect(compare).toHaveTextContent('Open Software Center.');
    expect(compare.querySelector('script')).toBeNull();
    expect(within(detail).getByRole('link', { name: '#1' })).toHaveAttribute('href', '/tickets/1');
    expect(screen.getByRole('tab', { name: 'For you (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Everything/ })).not.toBeInTheDocument();
  });

  test('accept applies the change, says so, and moves to the next item', async () => {
    renderAt('/knowledge/inbox', <InboxRoute />);
    fireEvent.click(await screen.findByTestId('inbox-accept'));
    await waitFor(() => expect(api.acceptSuggestion).toHaveBeenCalledWith(5, {}));
    expect(await screen.findByRole('status')).toHaveTextContent('Applied.');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/inbox/6'));
  });

  test('dismiss and "Not now"; a flag opens the article in the editor to fix it', async () => {
    renderAt('/knowledge/inbox/6', <InboxRoute />);
    const detail = await screen.findByTestId('inbox-detail');
    expect(within(detail).getByRole('button', { name: 'Dealt with' })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Open in the editor' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/articles/8');
    cleanup();
    renderAt('/knowledge/inbox/6', <InboxRoute />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(api.snoozeSuggestion).toHaveBeenCalledWith(6, { days: 7 }));
    cleanup();
    renderAt('/knowledge/inbox/6', <InboxRoute />);
    fireEvent.click(await screen.findByTestId('inbox-dismiss'));
    await waitFor(() => expect(api.dismissSuggestion).toHaveBeenCalledWith(6, {}));
  });

  test('keyboard: J and K move, A accepts; never while typing', async () => {
    renderAt('/knowledge/inbox', <InboxRoute />);
    await screen.findByTestId('inbox-detail');
    fireEvent.keyDown(window, { key: 'j' });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/inbox/6'));
    fireEvent.keyDown(window, { key: 'k' });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/inbox/5'));
    await screen.findByText('Three recent replies say Software Center.');
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(api.acceptSuggestion).toHaveBeenCalledWith(5, {}));
  });

  test('a question needs an answer before it can be sent; someone without the skill can read but not decide', async () => {
    api.suggestion.mockResolvedValue({ data: { id: 9, kind: 'question', title: 'Is Bluebeam still limited to the CAD team?', canDecide: true, mine: true, assignedTo: [], evidence: {}, createdAt: '2026-10-11T00:00:00Z' } });
    renderAt('/knowledge/inbox/9', <InboxRoute />);
    const send = await screen.findByRole('button', { name: 'Send the answer' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'No, any project lead can ask now.' } });
    fireEvent.click(send);
    await waitFor(() => expect(api.acceptSuggestion).toHaveBeenCalledWith(9, { answer: 'No, any project lead can ask now.' }));
    cleanup();
    api.suggestion.mockResolvedValue({ data: { ...DETAIL[5], canDecide: false, mine: false } });
    renderAt('/knowledge/inbox/5', <InboxRoute />);
    expect(await screen.findByText('Deciding this needs the skill for its category.')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-accept')).not.toBeInTheDocument();
  });

  test('an empty inbox says what will show up; admins get "Everything"', async () => {
    api.inbox.mockResolvedValue({ data: { counts: { mine: 0, categories: 0, all: 0 }, total: 0, items: [] } });
    renderAt('/knowledge/inbox', <InboxRoute isAdmin />);
    expect(await screen.findByText('Nothing is waiting')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Everything' }));
    await waitFor(() => expect(api.inbox).toHaveBeenLastCalledWith({ scope: 'all' }));
  });
});

describe('HomePanel', () => {
  test('what waits for me and how my categories are doing, each with its counts', async () => {
    api.home.mockResolvedValue({ data: {
      rights: { isAdmin: false, canPropose: true, canWriteSomewhere: true },
      inbox: { counts: { mine: 1, categories: 2 }, items: ITEMS },
      categories: [{ id: 10, name: 'Software & Apps', level: 3, articles: 6, notChecked: 2, attention: 1, runs30: { total: 40, answered: 9 }, dayLevel: 'suggest' }],
    } });
    renderAt('/knowledge/home', <HomePanel />);
    const list = await screen.findByTestId('home-inbox-list');
    expect(within(list).getByRole('link', { name: /Step 2 changed/ })).toHaveAttribute('href', '/knowledge/inbox/5');
    expect(screen.getByRole('link', { name: /All 2/ })).toHaveAttribute('href', '/knowledge/inbox');
    const cats = screen.getByTestId('home-categories-list');
    expect(cats).toHaveTextContent('Software & Apps');
    expect(cats).toHaveTextContent('Advanced');
    expect(cats).toHaveTextContent('6 articles · 2 not checked yet · 1 needs attention · 9 of 40 tickets answered in 30 days');
    expect(cats).toHaveTextContent('Suggest to agent');
    expect(screen.getByRole('link', { name: /Add from rough notes/ })).toHaveAttribute('href', '/knowledge/articles/from-notes');
  });

  test('someone with no skill recorded still gets the Library and is told why nothing is listed', async () => {
    api.home.mockResolvedValue({ data: { rights: { isAdmin: false, canPropose: false, canWriteSomewhere: false }, inbox: { counts: {}, items: [] }, categories: [] } });
    renderAt('/knowledge/home', <HomePanel />);
    expect(await screen.findByTestId('home-categories-empty')).toHaveTextContent('Everyone can still read the Library and flag an article');
    expect(screen.getByTestId('home-inbox-empty')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Add from rough notes/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Find an answer/ })).toHaveAttribute('href', '/knowledge/library');
  });
});

describe('NotesToArticle', () => {
  const CATS = [{ id: 10, name: 'Devices & Hardware', subcategories: [{ id: 101, name: 'Docking Stations' }] }];
  const NOTES = 'Dock shows no display after sleep. Unplug the dock for 30 seconds, then plug it back in.';
  const tidied = { title: 'Fix a dock with no display', bodyHtml: '<h2>Steps</h2><ol><li>Unplug the dock.</li></ol>', reviewerNotes: 'The notes do not say which dock models.' };

  test('Tidy shows the article beside the notes with what is still missing; a writer continues in the editor with a draft', async () => {
    api.tidy.mockResolvedValue({ data: tidied });
    api.createArticle.mockResolvedValue({ data: { id: 31 } });
    renderAt('/knowledge/articles/from-notes?c=10&s=101', <NotesToArticle categories={CATS} rights={{ isAdmin: false, categories: { 101: { write: true, propose: true } } }} />);
    expect(screen.getByRole('button', { name: /Tidy/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What you know'), { target: { value: NOTES } });
    fireEvent.click(screen.getByRole('button', { name: /Tidy/ }));
    await waitFor(() => expect(api.tidy).toHaveBeenCalledWith({ text: NOTES, title: '' }));
    expect(await screen.findByTestId('notes-preview')).toHaveTextContent('Unplug the dock.');
    expect(screen.getByTestId('notes-missing')).toHaveTextContent('which dock models');
    expect(screen.getByLabelText('Title')).toHaveValue('Fix a dock with no display');
    fireEvent.click(screen.getByTestId('notes-save'));
    await waitFor(() => expect(api.createArticle).toHaveBeenCalledWith(expect.objectContaining({ title: 'Fix a dock with no display', status: 'draft', categoryId: 10, subcategoryId: 101 })));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/articles/31'));
  });

  test('someone who may only propose sends it to a person with the skill', async () => {
    api.tidy.mockResolvedValue({ data: tidied });
    api.proposeSuggestion.mockResolvedValue({ data: { id: 9 } });
    renderAt('/knowledge/articles/from-notes?c=10', <NotesToArticle categories={CATS} rights={{ isAdmin: false, categories: { 10: { write: false, propose: true } } }} />);
    fireEvent.change(screen.getByLabelText('What you know'), { target: { value: NOTES } });
    fireEvent.click(screen.getByRole('button', { name: /Tidy/ }));
    const save = await screen.findByTestId('notes-save');
    expect(save).toHaveTextContent('Send to someone with the skill');
    fireEvent.click(save);
    await waitFor(() => expect(api.proposeSuggestion).toHaveBeenCalledWith(expect.objectContaining({ kind: 'new_article', categoryId: 10, proposed: expect.objectContaining({ title: 'Fix a dock with no display' }) })));
    expect(await screen.findByTestId('notes-sent')).toBeInTheDocument();
    expect(api.createArticle).not.toHaveBeenCalled();
  });

  test('a failed tidy says so and keeps the notes', async () => {
    api.tidy.mockRejectedValue(new Error('The notes could not be tidied right now.'));
    renderAt('/knowledge/articles/from-notes', <NotesToArticle categories={CATS} rights={{ isAdmin: true }} />);
    fireEvent.change(screen.getByLabelText('What you know'), { target: { value: NOTES } });
    fireEvent.click(screen.getByRole('button', { name: /Tidy/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be tidied');
    expect(screen.getByLabelText('What you know')).toHaveValue(NOTES);
  });
});

describe('SaveAsKnowledgePrompt', () => {
  const mount = (props) => render(<MemoryRouter><SaveAsKnowledgePrompt ticketId={55} {...props} /></MemoryRouter>);

  test('never on opening a ticket that is already resolved; only at the moment it is resolved here', async () => {
    api.ticketCapture.mockResolvedValue({ data: { ask: true, reason: '6 requests like this came in over the last 90 days, and nothing in the Library covers it.' } });
    const { rerender } = mount({ resolved: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.ticketCapture).not.toHaveBeenCalled();
    cleanup();
    const view = mount({ resolved: false });
    expect(api.ticketCapture).not.toHaveBeenCalled();
    view.rerender(<MemoryRouter><SaveAsKnowledgePrompt ticketId={55} resolved /></MemoryRouter>);
    expect(await screen.findByTestId('save-as-knowledge')).toHaveTextContent('6 requests like this');
    expect(api.ticketCapture).toHaveBeenCalledWith(55);
    expect(rerender).toBeTypeOf('function');
  });

  test('"Save it" drafts in one click and points to the inbox; the server saying no shows nothing', async () => {
    api.ticketCapture.mockResolvedValue({ data: { ask: true, reason: 'Worth saving.' } });
    api.captureTicket.mockResolvedValue({ data: { saved: true, article: { id: 31, title: 'Fix a dock with no display' } } });
    const view = mount({ resolved: false });
    view.rerender(<MemoryRouter><SaveAsKnowledgePrompt ticketId={55} resolved /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Save it' }));
    await waitFor(() => expect(api.captureTicket).toHaveBeenCalledWith(55, { decision: 'yes' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Fix a dock with no display');
    expect(screen.getByRole('link', { name: 'Knowledge inbox' })).toHaveAttribute('href', '/knowledge/inbox');
    cleanup();
    api.ticketCapture.mockResolvedValue({ data: { ask: false, why: 'daily_cap' } });
    const quiet = mount({ resolved: false });
    quiet.rerender(<MemoryRouter><SaveAsKnowledgePrompt ticketId={55} resolved /></MemoryRouter>);
    await waitFor(() => expect(api.ticketCapture).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('save-as-knowledge')).not.toBeInTheDocument();
  });

  test('"Not now" is told to the server and the prompt goes away; closing it only hides it', async () => {
    api.ticketCapture.mockResolvedValue({ data: { ask: true, reason: 'Worth saving.' } });
    api.captureTicket.mockResolvedValue({ data: { saved: false } });
    const view = mount({ resolved: false });
    view.rerender(<MemoryRouter><SaveAsKnowledgePrompt ticketId={55} resolved /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(api.captureTicket).toHaveBeenCalledWith(55, { decision: 'not_now' });
    expect(screen.queryByTestId('save-as-knowledge')).not.toBeInTheDocument();
    cleanup();
    vi.clearAllMocks();
    api.ticketCapture.mockResolvedValue({ data: { ask: true, reason: 'Worth saving.' } });
    const again = mount({ resolved: false });
    again.rerender(<MemoryRouter><SaveAsKnowledgePrompt ticketId={55} resolved /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(api.captureTicket).not.toHaveBeenCalled();
    expect(screen.queryByTestId('save-as-knowledge')).not.toBeInTheDocument();
  });
});

describe('ContributionSettings', () => {
  test('the two levels and the ask at close; each change is saved on its own', async () => {
    growth.getSettings.mockResolvedValue({ data: { publishLevel: 'intermediate', checkLevel: 'advanced', askAtClose: false, askDailyCap: 1 } });
    growth.updateSettings.mockImplementation(async (patch) => ({ data: { publishLevel: 'intermediate', checkLevel: 'advanced', askAtClose: false, askDailyCap: 1, ...patch } }));
    render(<ContributionSettings canManage />);
    const box = await screen.findByTestId('contribution-settings');
    expect(within(box).getByTestId('contribution-publish')).toHaveValue('intermediate');
    expect(within(box).getByTestId('contribution-cap')).toBeDisabled();
    fireEvent.change(within(box).getByTestId('contribution-check'), { target: { value: 'expert' } });
    await waitFor(() => expect(growth.updateSettings).toHaveBeenCalledWith({ checkLevel: 'expert' }));
    fireEvent.click(within(box).getByRole('switch', { name: /Ask agents to save their answer/ }));
    await waitFor(() => expect(growth.updateSettings).toHaveBeenCalledWith({ askAtClose: true }));
    await waitFor(() => expect(within(box).getByTestId('contribution-cap')).not.toBeDisabled());
  });

  test('read-only for people who cannot manage; a refused change is shown', async () => {
    growth.getSettings.mockResolvedValue({ data: { publishLevel: 'intermediate', checkLevel: 'advanced', askAtClose: true, askDailyCap: 1 } });
    render(<ContributionSettings canManage={false} />);
    expect(await screen.findByTestId('contribution-publish')).toBeDisabled();
    cleanup();
    growth.updateSettings.mockRejectedValue(new Error('The level that can check articles cannot be lower than the level that can write them'));
    render(<ContributionSettings canManage />);
    fireEvent.change(await screen.findByTestId('contribution-publish'), { target: { value: 'expert' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot be lower');
  });
});
