/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Knowledge v2 — "scope, then let the AI judge" (MEGA 09-28 §1 and §6):
// "Which tickets" with a plain-words "When to help" and words under Advanced,
// no tag-only knowledge scope, the playbook summary line, the effect before
// saving, article Topics (type-ahead) + Source + "Quoted by", and the
// "Not this playbook" result in Activity and in the test panel.

const SETTINGS = {
  enabled: true, canManage: true, canReview: true, approveModeEnabled: false, autoModeAllowed: false,
  alwaysStayQuietWhen: ['Any sign of a security incident'],
  tools: [{ name: 'search_knowledge', label: 'Search knowledge', summary: 'Searches articles.' }],
};
const CATEGORIES = [{ id: 10, name: 'Software & Apps', subcategories: [{ id: 101, name: 'Installation' }, { id: 102, name: 'Licensing' }] }];
const SUMMARY = {
  subcategoryCount: 7, whenToHelp: 'Installs', useWords: false, stayQuietCount: 6, workspaceRuleCount: 6,
  articles: [{ id: 12, title: 'Company Portal installs' }, { id: 13, title: 'Licence errors' }], articleTotalPublished: 12,
};
const PLAYBOOK = {
  id: 3, name: 'Software installs', enabled: true, mode: 'shadow', categoryId: 10, subcategoryIds: [101],
  match: { whenToHelp: 'Someone wants to install an app.', useWords: false, keywords: [], excludeKeywords: [] },
  instructions: 'Use Company Portal.', stayQuietWhen: [], allowedTools: ['search_knowledge'],
  kbScope: { mode: 'all', tags: [], includeVerifiedSolutions: true }, minConfidence: 0.8, followUp: null, priority: 100,
  version: 4, sensitive: false, summary: SUMMARY, runCount: 0, lastRunAt: null,
};
const PREVIEW = {
  days: 30, inScope: 100, draftTakes: 58, savedTakes: 55,
  gained: [{ id: 1, ref: '#241001', subject: 'Leapfrog Viewer' }, { id: 2, ref: '#241002', subject: 'Globbal Mapper Update' }],
  lost: [{ id: 3, ref: '#241003', subject: 'Passkeys?' }],
  aiFitCheckNotRun: true,
};
const ARTICLE = {
  id: 12, title: 'Company Portal installs', bodyHtml: '<p>Open it</p>', status: 'published', tags: ['company-portal'],
  categoryId: 10, subcategoryId: null, sourceLabel: 'Drafted from tickets', quotedBy: [{ playbookId: 3, name: 'Software installs', enabled: true }, { playbookId: 4, name: 'GIS', enabled: false }],
  timesQuoted: 14, reviewEveryDays: 180,
};

const api = {
  getSettings: vi.fn(() => Promise.resolve({ success: true, data: SETTINGS })),
  updateSettings: vi.fn(),
  categories: vi.fn(() => Promise.resolve({ success: true, data: CATEGORIES })),
  listPlaybooks: vi.fn(() => Promise.resolve({ success: true, data: [PLAYBOOK] })),
  getPlaybook: vi.fn(() => Promise.resolve({ success: true, data: PLAYBOOK })),
  updatePlaybook: vi.fn((id, data) => Promise.resolve({ success: true, data: { ...PLAYBOOK, ...data, version: 5 } })),
  createPlaybook: vi.fn((data) => Promise.resolve({ success: true, data: { ...PLAYBOOK, ...data, id: 44, version: 1 } })),
  previewPlaybookMatch: vi.fn(() => Promise.resolve({ success: true, data: PREVIEW })),
  playbookReadiness: vi.fn(() => Promise.resolve({ success: true, data: { met: false, criteria: [] } })),
  playbookPreview: vi.fn(() => Promise.resolve({ success: true, data: { latest: null, sample: null } })),
  testPlaybook: vi.fn(),
  listRuns: vi.fn(() => Promise.resolve({ success: true, data: { items: [], total: 0 } })),
  runsSummary: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  getRun: vi.fn(),
  listArticles: vi.fn(() => Promise.resolve({ success: true, data: { items: [], total: 0 } })),
  getArticle: vi.fn(() => Promise.resolve({ success: true, data: ARTICLE })),
  updateArticle: vi.fn((id, data) => Promise.resolve({ success: true, data: { ...ARTICLE, ...data } })),
  topics: vi.fn(() => Promise.resolve({ success: true, data: [{ topic: 'company-portal', count: 6 }, { topic: 'company-apps', count: 2 }] })),
  waiting: vi.fn(() => Promise.resolve({ success: true, data: [] })),
};
const growthApi = {
  reviewDigest: vi.fn(() => Promise.resolve({ success: true, data: { count: 0, groups: [] } })),
  backtestStatus: vi.fn(() => Promise.resolve({ success: true, data: null })),
  backtestResults: vi.fn(() => Promise.resolve({ success: true, data: { counts: { total: 0 }, runs: [] } })),
};
const ticketsMeta = vi.hoisted(() => vi.fn(async () => ({ data: { technicians: [], groups: [] } })));
vi.mock('../../services/api', () => ({ get knowledgeAPI() { return api; }, get knowledgeGrowthAPI() { return growthApi; }, ticketsAPI: { meta: ticketsMeta } }));
vi.mock('../AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../tickets/RichTextEditor', () => ({
  default: ({ value, onChange, ariaLabel }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange?.({ html: e.target.value, text: e.target.value })} />
  ),
}));

import Knowledge from '../../pages/Knowledge';
import { playbookSummaryParts, previewMatchLine } from './knowledgeFormat';

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/knowledge/:tab/:itemId?" element={<Knowledge />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('format helpers', () => {
  test('summary parts and the preview line', () => {
    expect(playbookSummaryParts(SUMMARY).map((p) => p.text)).toEqual([
      'Answers tickets in 7 subcategories',
      'Stays quiet on 6 playbook rules + 6 workspace rules',
      'Can quote 2 articles in its category (12 published)',
    ]);
    expect(playbookSummaryParts({ subcategoryCount: 0, articles: [], articleTotalPublished: 4, useWords: true }).map((p) => p.text)).toEqual([
      'Answers tickets anywhere in its category', 'only when the words match', 'No article in its category yet — search still reaches all 4 published',
    ]);
    expect(previewMatchLine(PREVIEW)).toBe('Last 30 days: this version would take 58 tickets (saved version: 55).');
    expect(previewMatchLine({ ...PREVIEW, draftTakes: 1, savedTakes: null }, { isNew: true })).toBe('Last 30 days: this version would take 1 ticket (new playbook).');
  });
});

describe('builder: Which tickets', () => {
  test('"When to help" is saved; words stay under a closed Advanced section with the switch off', async () => {
    api.previewPlaybookMatch.mockRejectedValueOnce(new Error('offline'));
    renderAt('/knowledge/playbooks/3');
    const when = await screen.findByLabelText('When to help');
    expect(when).toHaveValue('Someone wants to install an app.');
    expect(when).toHaveAttribute('placeholder', 'Someone wants to install or update an app on their own BGC laptop.');
    expect(screen.getByText(/decides whether the playbook fits — typos and other wording are fine/)).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Advanced: also require words/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Words that bring a ticket in')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    const sw = screen.getByRole('switch', { name: 'Also require words' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(screen.getByLabelText('Words that bring a ticket in')).toBeInTheDocument();
    expect(screen.getByLabelText('Words that keep it out')).toBeInTheDocument();
    expect(screen.getByTestId('variants-note')).toHaveTextContent('Spelling variants (licence/license, set up/setup), plurals and small typos are matched automatically.');
    fireEvent.change(when, { target: { value: 'Installing or updating an app.' } });
    // The preview failed: saving is never blocked.
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(api.updatePlaybook).toHaveBeenCalled());
    expect(api.updatePlaybook.mock.calls[0][1].match).toEqual({ whenToHelp: 'Installing or updating an app.', useWords: true, keywords: [], excludeKeywords: [] });
  });

  test('a legacy playbook with words on opens Advanced by itself', async () => {
    api.getPlaybook.mockResolvedValueOnce({ success: true, data: { ...PLAYBOOK, match: { whenToHelp: '', useWords: true, keywords: ['install'], excludeKeywords: ['licence'] } } });
    renderAt('/knowledge/playbooks/3');
    const toggle = await screen.findByRole('button', { name: /Advanced: also require words/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('switch', { name: 'Also require words' })).toHaveAttribute('aria-checked', 'true');
    expect(within(screen.getByTestId('tokens-include')).getByText('install')).toBeInTheDocument();
  });

  test('knowledge step: no tag-only option; a legacy tag scope offers "Use all articles"', async () => {
    api.getPlaybook.mockResolvedValueOnce({ success: true, data: { ...PLAYBOOK, kbScope: { mode: 'tags', tags: ['software'], includeVerifiedSolutions: true } } });
    api.previewPlaybookMatch.mockResolvedValueOnce({ success: true, data: { ...PREVIEW, gained: [], lost: [], draftTakes: 55, savedTakes: 55 } });
    renderAt('/knowledge/playbooks/3');
    const note = await screen.findByTestId('legacy-tag-scope');
    expect(screen.queryByText('Only articles with these tags')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Include verified solutions/)).toBeChecked();
    fireEvent.click(within(note).getByRole('button', { name: 'Use all articles' }));
    expect(screen.queryByTestId('legacy-tag-scope')).not.toBeInTheDocument();
    // Scope unchanged -> no dialog, saved straight away.
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(api.updatePlaybook).toHaveBeenCalled());
    expect(screen.queryByTestId('preview-match-dialog')).not.toBeInTheDocument();
    expect(api.updatePlaybook.mock.calls[0][1].kbScope.mode).toBe('all');
  });

  test('a new playbook is saved with words off and previewed on the unsaved endpoint', async () => {
    api.previewPlaybookMatch.mockResolvedValueOnce({ success: true, data: { ...PREVIEW, savedTakes: null, lost: [] } });
    renderAt('/knowledge/playbooks/new');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'AI tools' } });
    fireEvent.click(screen.getByRole('button', { name: /Create playbook/ }));
    const dialog = await screen.findByTestId('preview-match-dialog');
    expect(api.previewPlaybookMatch).toHaveBeenCalledWith(null, expect.objectContaining({ name: 'AI tools' }));
    expect(dialog).toHaveTextContent('this version would take 58 tickets (new playbook)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.createPlaybook).toHaveBeenCalled());
    expect(api.createPlaybook.mock.calls[0][0].match).toMatchObject({ useWords: false, whenToHelp: '' });
  });
});

describe('effect before saving', () => {
  test('shows the 30-day delta with gained and lost examples; Keep editing does not save, Save does', async () => {
    renderAt('/knowledge/playbooks/3');
    fireEvent.change(await screen.findByLabelText('When to help'), { target: { value: 'Any app install or update.' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Save this version?' });
    expect(api.previewPlaybookMatch).toHaveBeenCalledWith('3', expect.objectContaining({ match: expect.objectContaining({ whenToHelp: 'Any app install or update.' }) }));
    expect(within(dialog).getByTestId('preview-match-line')).toHaveTextContent('Last 30 days: this version would take 58 tickets (saved version: 55).');
    expect(within(dialog).getByTestId('preview-gained')).toHaveTextContent('#241001 Leapfrog Viewer');
    expect(within(dialog).getByTestId('preview-lost')).toHaveTextContent('#241003 Passkeys?');
    expect(dialog).toHaveTextContent('Before the AI’s fit check — the AI still decides each ticket.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(api.updatePlaybook).not.toHaveBeenCalled();
    expect(screen.getByLabelText('When to help')).toHaveValue('Any app install or update.');
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updatePlaybook).toHaveBeenCalledTimes(1));
  });
});

describe('playbook summary line', () => {
  test('on the list card and in the builder header, with article titles as links', async () => {
    renderAt('/knowledge/playbooks');
    const line = await screen.findByTestId('playbook-summary-3');
    expect(line).toHaveTextContent('Answers tickets in 7 subcategories · Stays quiet on 6 playbook rules + 6 workspace rules · Can quote 2 articles in its category (12 published): Company Portal installs, Licence errors');
    expect(within(line).getByRole('link', { name: 'Company Portal installs' })).toHaveAttribute('href', '/knowledge/articles/12');
    cleanup();
    renderAt('/knowledge/playbooks/3');
    const header = await screen.findByTestId('playbook-header');
    expect(await within(header).findByTestId('playbook-summary')).toHaveTextContent('Answers tickets in 7 subcategories');
  });

  test('an article link in the header goes through the unsaved-changes guard', async () => {
    renderAt('/knowledge/playbooks/3');
    const header = await screen.findByTestId('playbook-header');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited' } });
    fireEvent.click(within(header).getByRole('link', { name: 'Licence errors' }));
    expect(await screen.findByRole('alertdialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    expect(api.getArticle).not.toHaveBeenCalled();
  });
});

describe('articles: Topics, Source, Quoted by', () => {
  test('editor: Topics with type-ahead counts, Source on its own line, Quoted by with an "off" playbook and the quote count', async () => {
    renderAt('/knowledge/articles/12');
    expect(await screen.findByText('Topics')).toBeInTheDocument();
    expect(screen.queryByText('Tags')).not.toBeInTheDocument();
    expect(screen.queryByText(/A playbook limited to tags/)).not.toBeInTheDocument();
    expect(screen.getByTestId('article-source')).toHaveTextContent('Drafted from tickets');
    expect(within(screen.getByTestId('article-tags')).queryByText('Drafted from tickets')).not.toBeInTheDocument();
    const reach = screen.getByTestId('article-quoted-by');
    expect(within(reach).getByRole('link', { name: 'Software installs' })).toHaveAttribute('href', '/knowledge/playbooks/3');
    expect(reach).toHaveTextContent('GIS');
    expect(reach).toHaveTextContent('off');
    expect(within(reach).getByTestId('times-quoted')).toHaveTextContent('Quoted in 14 Auto-help answers');

    const input = screen.getByLabelText('Topics');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'comp' } });
    const list = await screen.findByRole('listbox', { name: 'Topics suggestions' });
    await waitFor(() => expect(api.topics).toHaveBeenLastCalledWith('comp'));
    // Already on the article -> not suggested again.
    expect(within(list).queryByRole('option', { name: /company-portal/ })).not.toBeInTheDocument();
    expect(within(list).getByRole('option', { name: 'company-apps · 2' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(within(screen.getByTestId('article-tags')).getByText('company-apps')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(api.updateArticle).toHaveBeenCalled());
    expect(api.updateArticle.mock.calls[0][1].tags).toEqual(['company-portal', 'company-apps']);
  });

  test('no playbook reaches it: a warning in the editor and a marker on the list row', async () => {
    api.getArticle.mockResolvedValueOnce({ success: true, data: { ...ARTICLE, quotedBy: [], timesQuoted: 0 } });
    renderAt('/knowledge/articles/12');
    expect(await screen.findByTestId('no-playbook-note')).toHaveTextContent('No playbook reaches this article’s category yet — Auto-help can still find it by search, but no playbook is aimed at it.');
    expect(screen.getByTestId('times-quoted')).toHaveTextContent('Quoted in 0 Auto-help answers');
    cleanup();
    api.listArticles.mockResolvedValueOnce({ success: true, data: { items: [
      { id: 12, title: 'Reached', status: 'published', snippet: 'x', tags: ['vpn'], quotedBy: [{ playbookId: 3, name: 'A', enabled: true }], sourceLabel: 'Drafted from tickets' },
      { id: 13, title: 'Orphan', status: 'published', snippet: 'y', tags: [], quotedBy: [] },
    ], total: 2 } });
    renderAt('/knowledge/articles');
    const list = await screen.findByTestId('articles-list');
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0]).queryByTestId('no-playbook-reaches')).not.toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Drafted from tickets');
    expect(within(rows[1]).getByTestId('no-playbook-reaches')).toHaveTextContent('No playbook reaches it');
  });

  test('filter bar: the search is capped and the category select is wider (QA 09-28 item 1)', async () => {
    renderAt('/knowledge/articles');
    const bar = await screen.findByTestId('articles-filters');
    expect(within(bar).getByLabelText('Search articles').closest('label').className).toMatch(/lg:max-w-md/);
    expect(within(bar).getByRole('combobox', { name: 'Article category' }).parentElement.className).toMatch(/lg:w-72/);
  });
});

describe('Not this playbook', () => {
  const RUN = {
    id: 31, status: 'no_match', gateDecision: 'not_this_playbook', reason: 'Asks for a new laptop, not an app install.',
    trigger: 'categorized', createdAt: new Date().toISOString(), mode: 'shadow', ticketId: 5, ticketRef: 'TP-40',
    ticketSubject: 'New laptop', playbookId: 3, playbookName: 'Software installs', confidence: null, sources: [],
  };
  test('Activity row and drawer say "Not this playbook" with the AI reason', async () => {
    api.listRuns.mockResolvedValue({ success: true, data: { items: [RUN], total: 1 } });
    api.getRun.mockResolvedValue({ success: true, data: RUN });
    renderAt('/knowledge/activity/31');
    const table = await screen.findByTestId('runs-table');
    // The open drawer hides the page from the accessibility tree, so find the row by its cell.
    const row = within(table).getByTestId('row-not-this-playbook').closest('tr');
    expect(within(row).getByText('Not this playbook')).toHaveAttribute('title', 'Why: Asks for a new laptop, not an app install.');
    expect(within(row).getByTestId('row-not-this-playbook')).toHaveTextContent('Asks for a new laptop, not an app install.');
    const drawer = await screen.findByTestId('run-not-this-playbook');
    expect(drawer).toHaveTextContent('Asks for a new laptop, not an app install.');
    expect(screen.getByTestId('run-detail')).toHaveTextContent('decided it doesn’t fit');
    api.listRuns.mockResolvedValue({ success: true, data: { items: [], total: 0 } });
  });

  test('a test that the fit check turns away shows the reason clearly', async () => {
    api.testPlaybook.mockResolvedValueOnce({ success: true, data: { id: 32, status: 'no_match', ticketRef: 'TP-40', ticketSubject: 'New laptop', reason: 'Asks for a new laptop, not an app install.', sources: [] } });
    renderAt('/knowledge/playbooks/3');
    const box = await screen.findByTestId('playbook-test');
    fireEvent.change(within(box).getByLabelText('Ticket to test on'), { target: { value: 'TP-40' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Run test' }));
    const result = await screen.findByTestId('test-not-this-playbook');
    expect(result).toHaveTextContent('Not this playbook');
    expect(result).toHaveTextContent('Asks for a new laptop, not an app install.');
    expect(screen.getByTestId('playbook-test-result')).not.toHaveTextContent('No match');
  });
});
