/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  countWords, healthOf, listRequests, mergeArticles, scopeTitle, sectionAnchor, usageWords,
} from './libraryFormat';

// Knowledge → Library, the article page and the ticket's Knowledge card
// (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 12).
const api = {
  library: vi.fn(), listArticles: vi.fn(), search: vi.fn(), getArticle: vi.fn(), verifyArticle: vi.fn(), flagArticle: vi.fn(),
  articleVersions: vi.fn(), restoreArticleVersion: vi.fn(), ticketKnowledge: vi.fn(), reviewRun: vi.fn(),
};
vi.mock('../../services/api', () => ({ get knowledgeAPI() { return api; } }));
vi.mock('../common/FancySelect', () => ({
  default: ({ value, onChange, options, 'aria-label': label, 'data-testid': testId }) => (
    <select aria-label={label} data-testid={testId} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

const { default: LibraryPanel } = await import('./LibraryPanel');
const { default: ArticleReader } = await import('./ArticleReader');
const { default: TicketKnowledgeCard } = await import('../tickets/TicketKnowledgeCard');

const bucket = (articles = 0, drafts = 0, attention = 0, notChecked = 0) => ({ articles, drafts, attention, notChecked });
const TREE = {
  totals: bucket(8, 1, 2, 3), mine: bucket(2, 1), uncategorised: bucket(1),
  categories: [
    { id: 10, name: 'Software & Apps', ...bucket(6, 1, 2, 2), subcategories: [{ id: 101, name: 'OpenGround', ...bucket(2, 0, 1) }, { id: 102, name: 'Installs', ...bucket(0) }] },
    { id: 20, name: 'Devices & Hardware', ...bucket(0), subcategories: [] },
  ],
};
const ARTICLES = [
  { id: 7, title: 'OpenGround: install and access', snippet: 'Use Company Portal.', health: 'checked', categoryId: 10, subcategoryId: 101, timesQuoted: 14, updatedAt: '2026-10-10T00:00:00Z', ownerEmail: 'vhaeri@example.com' },
  { id: 8, title: 'Bluebeam licence', snippet: 'Ask with a project number.', health: 'needs_look', categoryId: 10, subcategoryId: null, timesQuoted: 0, updatedAt: '2026-10-01T00:00:00Z', ownerEmail: null },
];
const CATEGORIES = [{ id: 10, name: 'Software & Apps', subcategories: [{ id: 101, name: 'OpenGround' }] }];
const ARTICLE = {
  id: 7, title: 'OpenGround: install and access', status: 'published', health: 'checked', confidence: 'checked', checkedBy: 'andrew.fong@example.com', checkedAt: '2026-10-09T00:00:00Z',
  bodyHtml: '<h2>Install</h2><ol><li>Open Company Portal.</li></ol><h2>Project access</h2><p>Ask for the project by name.</p><script>alert(1)</script>',
  categoryId: 10, subcategoryId: 101, tags: ['openground'], version: 3, timesQuoted: 14, updatedAt: '2026-10-10T00:00:00Z',
  use: { good: 9, partial: 2, wrong: 0, flagged: 1, lastGoodAt: '2026-10-10T00:00:00Z', lastGoodBy: 'mehdi@example.com', flags: [{ note: 'Step 2 changed', actor: 'gaby@example.com', at: '2026-10-08T00:00:00Z' }] },
  my: { write: true, check: true, level: 3 },
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}{loc.search}</div>;
}
const renderAt = (path, ui) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/knowledge/library" element={ui} />
      <Route path="*" element={ui} />
    </Routes>
    <Where />
  </MemoryRouter>,
);

beforeEach(() => {
  api.library.mockResolvedValue({ data: TREE });
  api.listArticles.mockResolvedValue({ data: { items: ARTICLES, total: 2 } });
  api.search.mockResolvedValue({ data: [] });
  api.getArticle.mockResolvedValue({ data: ARTICLE });
  api.verifyArticle.mockResolvedValue({ data: {} });
  api.flagArticle.mockResolvedValue({ data: { recorded: true, demoted: false } });
  api.articleVersions.mockResolvedValue({ data: { current: 3, items: [
    { id: 3, version: 3, title: 'T', status: 'published', changedBy: 'andrew.fong@example.com', changeNote: 'Fixed step 2', createdAt: '2026-10-10T00:00:00Z' },
    { id: 2, version: 2, title: 'T', status: 'published', changedBy: 'vhaeri@example.com', changeNote: null, createdAt: '2026-10-01T00:00:00Z' },
  ] } });
  api.restoreArticleVersion.mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('libraryFormat', () => {
  test('one word per article; an unknown state reads as not checked', () => {
    expect(healthOf({ health: 'needs_look' }).label).toBe('Needs a look');
    expect(healthOf({ health: 'out_of_date' }).label).toBe('Out of date');
    expect(healthOf({}).label).toBe('Not checked yet');
  });

  test('what the list asks the server for, per place and filter', () => {
    expect(listRequests({ scope: { categoryId: 10, subcategoryId: 101 } })).toEqual([{ limit: 50, offset: 0, sort: 'title', categoryId: 10, subcategoryId: 101 }]);
    expect(listRequests({ scope: { view: 'mine' } })[0]).toMatchObject({ owner: 'me' });
    expect(listRequests({ scope: { view: 'none' } })[0]).toMatchObject({ uncategorised: true });
    expect(listRequests({ scope: {}, health: 'draft' })[0]).toMatchObject({ status: 'draft' });
    expect(listRequests({ scope: {}, health: 'out_of_date' })[0]).toMatchObject({ status: 'published', review: 'due' });
    expect(listRequests({ scope: {}, health: 'not_checked' })[0]).toMatchObject({ status: 'published', confidence: 'not_checked' });
    // "Needs attention" is two lists: doubtful, and past review.
    expect(listRequests({ scope: { view: 'attention' } })).toMatchObject([{ confidence: 'needs_look' }, { review: 'due' }]);
  });

  test('merging, counts, titles, anchors and "how it did in use" always with the counts', () => {
    expect(mergeArticles([[{ id: 2, title: 'B' }], [{ id: 1, title: 'A' }, { id: 2, title: 'B' }]]).map((a) => a.id)).toEqual([1, 2]);
    expect([0, 1, 12].map((n) => countWords(n))).toEqual(['Nothing yet', '1 article', '12 articles']);
    expect(scopeTitle({ categoryId: 10, subcategoryId: 101 }, TREE)).toBe('Software & Apps › OpenGround');
    expect(scopeTitle({ view: 'attention' }, TREE)).toBe('Needs attention');
    expect(scopeTitle({}, TREE)).toBe('All articles');
    expect(sectionAnchor('Project access!', 2)).toBe('s2-project-access');
    expect(usageWords(ARTICLE)).toBe('Used in 14 answers · 9 of 11 judged good · flagged 1 time');
    expect(usageWords({ timesQuoted: 0 })).toBe('Not used in an answer yet');
  });
});

describe('LibraryPanel', () => {
  test('a category tree with counts, and the articles of the chosen place with one health word each', async () => {
    renderAt('/knowledge/library', <LibraryPanel canWrite />);
    const tree = await screen.findByTestId('library-tree');
    expect(within(tree).getByTestId('library-all')).toHaveTextContent('All articles9');
    expect(within(tree).getByTestId('library-attention')).toHaveTextContent('Needs attention2');
    expect(within(tree).getByTestId('library-cat-10')).toHaveTextContent('Software & Apps7');
    expect(within(tree).getByTestId('library-cat-20')).toHaveTextContent('Devices & Hardware0');
    expect(within(tree).getByTestId('library-none')).toBeInTheDocument();
    const row = await screen.findByTestId('library-article-7');
    expect(row).toHaveAttribute('href', '/knowledge/library/7');
    expect(row).toHaveTextContent('Checked');
    expect(row).toHaveTextContent('Software & Apps › OpenGround');
    expect(row).toHaveTextContent('used in 14 answers');
    expect(screen.getByTestId('library-article-8')).toHaveTextContent('Needs a look');
    expect(screen.getByTestId('library-article-8')).toHaveTextContent('not used yet');
  });

  test('picking a category opens its subcategories and asks for that place; the place lives in the URL', async () => {
    renderAt('/knowledge/library', <LibraryPanel canWrite />);
    fireEvent.click(await screen.findByTestId('library-cat-10'));
    await waitFor(() => expect(api.listArticles).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: 10 })));
    expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/library?c=10');
    expect(screen.getByTestId('library-title')).toHaveTextContent('Software & Apps');
    fireEvent.click(screen.getByTestId('library-sub-101'));
    await waitFor(() => expect(api.listArticles).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: 10, subcategoryId: 101 })));
    expect(screen.getByTestId('library-title')).toHaveTextContent('Software & Apps › OpenGround');
  });

  test('a link lands where you were; the health filter narrows the list', async () => {
    renderAt('/knowledge/library?c=10&s=101&health=not_checked', <LibraryPanel />);
    await waitFor(() => expect(api.listArticles).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: 10, subcategoryId: 101, status: 'published', confidence: 'not_checked' })));
    expect(await screen.findByTestId('library-sub-101')).toHaveAttribute('aria-current', 'true');
    fireEvent.change(screen.getByTestId('library-health'), { target: { value: 'draft' } });
    await waitFor(() => expect(api.listArticles).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'draft' })));
  });

  test('an empty category says so and offers to write the first article, filed there', async () => {
    api.listArticles.mockResolvedValue({ data: { items: [], total: 0 } });
    renderAt('/knowledge/library?c=20', <LibraryPanel canWrite />);
    expect(await screen.findByText('Nothing written here yet')).toBeInTheDocument();
    expect(screen.getByText('Tickets in this category have nothing to be answered from yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Write the first one/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/articles/new?c=20');
  });

  test('searching uses the hybrid search and shows the matching section; nothing found is said plainly', async () => {
    api.search.mockResolvedValue({ data: [{ id: 7, title: 'OpenGround: install and access', snippet: 'Ask for the project by name.', section: { heading: 'Project access' } }] });
    renderAt('/knowledge/library?q=openground%20access', <LibraryPanel canWrite />);
    const hit = await screen.findByTestId('library-hit-7');
    expect(api.search).toHaveBeenCalledWith('openground access', { limit: 20 });
    expect(hit).toHaveTextContent('Project access');
    cleanup();
    api.search.mockResolvedValue({ data: [] });
    renderAt('/knowledge/library?q=docking%20station', <LibraryPanel canWrite />);
    expect(await screen.findByText('Nothing in the Library answers that')).toBeInTheDocument();
    expect(screen.getByText(/If you know the answer, write it down/)).toBeInTheDocument();
  });

  test('someone who cannot write sees no "New article" and no housekeeping link', async () => {
    renderAt('/knowledge/library', <LibraryPanel canWrite={false} />);
    await screen.findByTestId('library-article-7');
    expect(screen.queryByRole('link', { name: 'Manage as a list' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New article/ })).not.toBeInTheDocument();
  });
});

describe('ArticleReader', () => {
  test('a reading page: trust in words with who and when, use with counts, the text made safe, and "On this page"', async () => {
    renderAt('/knowledge/library/7', <ArticleReader articleId="7" categories={CATEGORIES} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'OpenGround: install and access' })).toBeInTheDocument();
    const health = screen.getByTestId('article-health');
    expect(health).toHaveTextContent('Checked');
    expect(health).toHaveTextContent('Andrew Fong');
    expect(screen.getByTestId('article-use')).toHaveTextContent('Used in 14 answers · 9 of 11 judged good · flagged 1 time');
    expect(screen.getByTestId('article-use')).toHaveTextContent('version 3');
    const body = screen.getByTestId('article-body');
    expect(body.querySelector('script')).toBeNull();
    expect(within(body).getByRole('heading', { name: 'Install' })).toHaveAttribute('id', 's0-install');
    const nav = await screen.findByRole('navigation', { name: 'On this page' });
    expect(within(nav).getByRole('link', { name: 'Project access' })).toHaveAttribute('href', '#s1-project-access');
    expect(screen.getByTestId('article-flags')).toHaveTextContent('Step 2 changed');
    expect(screen.getByRole('link', { name: 'OpenGround' })).toHaveAttribute('href', '/knowledge/library?c=10&s=101');
  });

  test('flag it or fix it: anyone can flag with a sentence; Edit and "I checked this" only for people with the skill', async () => {
    api.getArticle.mockResolvedValue({ data: { ...ARTICLE, health: 'not_checked', confidence: 'not_checked', checkedBy: null, my: { write: false, check: false, level: 0 } } });
    renderAt('/knowledge/library/7', <ArticleReader articleId="7" categories={CATEGORIES} />);
    await screen.findByTestId('article-reader');
    expect(screen.getByTestId('article-health')).toHaveTextContent('Not checked yet');
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /I checked this/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Something is wrong/ }));
    const form = screen.getByTestId('article-flag-form');
    expect(within(form).getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('What is wrong or unclear?'), { target: { value: 'Step 2 is out of date' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.flagArticle).toHaveBeenCalledWith(7, { note: 'Step 2 is out of date' }));
    expect(await screen.findByRole('status')).toHaveTextContent('People with the skill for this topic will see it');
  });

  test('someone with the skill confirms a not-checked article in one click', async () => {
    api.getArticle.mockResolvedValue({ data: { ...ARTICLE, health: 'needs_look', confidence: 'needs_look' } });
    renderAt('/knowledge/library/7', <ArticleReader articleId="7" categories={CATEGORIES} />);
    fireEvent.click(await screen.findByRole('button', { name: /I checked this, it is right/ }));
    await waitFor(() => expect(api.verifyArticle).toHaveBeenCalledWith(7));
    expect(await screen.findByRole('status')).toHaveTextContent('Marked as checked');
  });

  test('history: every version with who and why; putting one back asks first and makes a new version', async () => {
    renderAt('/knowledge/library/7', <ArticleReader articleId="7" categories={CATEGORIES} />);
    fireEvent.click(await screen.findByRole('button', { name: /History/ }));
    const history = await screen.findByTestId('article-history');
    expect(history).toHaveTextContent('Version 3');
    expect(history).toHaveTextContent('Fixed step 2');
    expect(within(history).getAllByRole('button', { name: /Put back/ })).toHaveLength(1);
    fireEvent.click(within(history).getByRole('button', { name: /Put back/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Nothing is lost');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Put it back' }));
    await waitFor(() => expect(api.restoreArticleVersion).toHaveBeenCalledWith(7, 2));
  });
});

describe('TicketKnowledgeCard', () => {
  const RUN = { id: 900, status: 'drafted', reviewVerdict: null };
  const FIT = [{ id: 7, title: 'OpenGround: install and access', section: 'Install', confidence: 'checked', stale: false }, { id: 8, title: 'Bluebeam licence', section: null, confidence: 'not_checked', stale: false }];
  const mount = () => render(<MemoryRouter><TicketKnowledgeCard ticketId={55} /></MemoryRouter>);

  test('one click judges the draft, and the verdict is shown in words', async () => {
    api.ticketKnowledge.mockResolvedValue({ data: { run: RUN, articles: FIT, canReview: true } });
    api.reviewRun.mockResolvedValue({ data: { id: 900, reviewVerdict: 'good' } });
    mount();
    const card = await screen.findByTestId('ticket-knowledge-card');
    expect(within(card).getByText('How was the Auto-help draft?')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Good' }));
    await waitFor(() => expect(api.reviewRun).toHaveBeenCalledWith(900, { verdict: 'good' }));
    expect(await within(card).findByText('good')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Wrong' })).not.toBeInTheDocument();
  });

  test('the articles that fit, each with how far it can be trusted, opening in the Library', async () => {
    api.ticketKnowledge.mockResolvedValue({ data: { run: null, articles: FIT, canReview: false } });
    mount();
    const list = await screen.findByTestId('ticket-knowledge-articles');
    expect(within(list).getByRole('link', { name: /OpenGround: install and access/ })).toHaveAttribute('href', '/knowledge/library/7');
    expect(list).toHaveTextContent('Checked');
    expect(list).toHaveTextContent('Not checked yet');
    expect(screen.queryByTestId('ticket-knowledge-verdict')).not.toBeInTheDocument();
  });

  test('someone who may not judge sees no buttons; nothing to show renders nothing; a failed read renders nothing', async () => {
    api.ticketKnowledge.mockResolvedValue({ data: { run: RUN, articles: [], canReview: false } });
    mount();
    await screen.findByTestId('ticket-knowledge-card');
    expect(screen.queryByRole('button', { name: 'Good' })).not.toBeInTheDocument();
    cleanup();
    api.ticketKnowledge.mockResolvedValue({ data: { run: { id: 1, status: 'no_match' }, articles: [], canReview: true } });
    mount();
    await waitFor(() => expect(api.ticketKnowledge).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('ticket-knowledge-card')).not.toBeInTheDocument();
    cleanup();
    api.ticketKnowledge.mockRejectedValue(new Error('403'));
    mount();
    await waitFor(() => expect(api.ticketKnowledge).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId('ticket-knowledge-card')).not.toBeInTheDocument();
  });
});
