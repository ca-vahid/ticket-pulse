/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

// Knowledge that grows (Auto-help P1): Gaps tab, drafting from tickets,
// drafted-from banner, FreshService read-only articles + import settings,
// the review digest line, playbook backtests and "Turn into an article".

const growth = {
  gaps: vi.fn(),
  draftFromTickets: vi.fn(),
  draftFromTicket: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  fsFolders: vi.fn(),
  fsImportNow: vi.fn(),
  fsImportStatus: vi.fn(),
  fsImportJob: vi.fn(),
  reviewDigest: vi.fn(),
  backtestEstimate: vi.fn(),
  startBacktest: vi.fn(),
  backtestStatus: vi.fn(),
  cancelBacktest: vi.fn(),
  backtestResults: vi.fn(),
};
const knowledge = {
  getSettings: vi.fn(),
  getArticle: vi.fn(),
  listArticles: vi.fn(),
  search: vi.fn(),
};
vi.mock('../../services/api', () => ({
  get knowledgeGrowthAPI() { return growth; },
  get knowledgeAPI() { return knowledge; },
  ticketsAPI: { meta: vi.fn(async () => ({ data: { technicians: [] } })) },
}));
vi.mock('../tickets/RichTextEditor', () => ({ default: () => <textarea aria-label="Article body" /> }));

import GapsPanel from './GapsPanel';
import DraftFromTicketsDialog from './DraftFromTicketsDialog';
import { DraftedFromBanner, FsSourceNote, ReviewDigestLine } from './ArticleGrowth';
import { KnowledgeSources } from './KnowledgeSourcesSettings';
import PlaybookBacktestBox from './PlaybookBacktestBox';
import TurnIntoArticleButton from './TurnIntoArticleButton';
import ArticlesPanel from './ArticlesPanel';
import {
  estimateLine, importSummary, money, parseTicketRefs, readableNotes, reasonLine,
} from './knowledgeGrowthFormat';

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname}</p>;
}
const renderIn = (ui, path = '/knowledge/gaps') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="*" element={<>{ui}<Where /></>} />
    </Routes>
  </MemoryRouter>,
);

const CLUSTER = {
  key: '1:11', title: 'Install Revit add-in', keywords: ['revit', 'add-in'], count: 3, notPickedUp: 1,
  reasons: { no_sources: 2, not_picked_up: 1 }, lastSeenAt: new Date().toISOString(), resolvedCount: 2,
  ticketIds: [11, 12, 13],
  examples: [
    { id: 11, ref: 'TP-11', subject: 'Install Revit add-in', resolved: true, reason: 'no_sources' },
    { id: 12, ref: 'TP-12', subject: 'Revit add-in missing', resolved: true, reason: 'no_sources' },
    { id: 13, ref: '#241406', subject: 'Need the add-in manager', resolved: false, reason: 'not_picked_up' },
    { id: 14, ref: 'TP-14', subject: 'Fourth example', resolved: false, reason: 'no_sources' },
  ],
  article: null,
};
const GAPS = {
  generatedAt: new Date().toISOString(), days: 90, mode: 'dense', totals: { tickets: 5, clusters: 3 },
  playbooks: [{
    playbookId: 1, playbookName: 'Software installs', enabled: true, tickets: 5,
    clusters: [
      CLUSTER,
      { ...CLUSTER, key: '1:20', title: 'VPN drops', count: 1, resolvedCount: 0, ticketIds: [20], examples: [{ id: 20, ref: 'TP-20', subject: 'VPN drops', resolved: false }] },
      { ...CLUSTER, key: '1:30', title: 'Bluebeam licence', count: 2, ticketIds: [30, 31], article: { id: 70, title: 'Bluebeam licences', status: 'draft' } },
    ],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  growth.gaps.mockResolvedValue({ success: true, data: GAPS });
  growth.draftFromTickets.mockResolvedValue({ success: true, data: { article: { id: 88 }, used: 2 } });
  growth.reviewDigest.mockResolvedValue({ success: true, data: { count: 0, groups: [] } });
  growth.backtestStatus.mockResolvedValue({ success: true, data: null });
  growth.backtestResults.mockResolvedValue({ success: true, data: { counts: { total: 0 }, runs: [] } });
  knowledge.getSettings.mockResolvedValue({ success: true, data: { canManage: true } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('format helpers', () => {
  test('reasons, money, estimate line, ticket refs', () => {
    expect(reasonLine({ no_sources: 2, not_picked_up: 1, uncited_step: 0 })).toBe('2 nothing in Knowledge matched · 1 not picked up by the playbook\'s keywords');
    expect(money(0.004)).toBe('under US$0.01');
    expect(money(1.5)).toBe('US$1.50');
    expect(money(null)).toBe('—');
    expect(estimateLine({ totalUsd: 0.43, perRunUsd: 0.024, basis: 'history', sampleRuns: 42 })).toBe('about US$0.43 (≈ US$0.02 a run, from 42 recent runs)');
    expect(parseTicketRefs('tp-12, #241406 and 55; TP-12 foo')).toEqual(['TP-12', '#241406', '55']);
  });
});

describe('Gaps tab', () => {
  test('repeated questions show title, count, words, reasons and example tickets (subject only, linked)', async () => {
    renderIn(<GapsPanel canManage />);
    const rows = await screen.findAllByTestId('gap-cluster');
    expect(rows).toHaveLength(2); // the one-off is collapsed
    const revit = rows[0];
    expect(within(revit).getByText('Install Revit add-in', { selector: 'p' })).toBeInTheDocument();
    expect(within(revit).getByTestId('gap-count')).toHaveTextContent('3 tickets');
    expect(revit).toHaveTextContent('revit · add-in');
    expect(revit).toHaveTextContent('2 resolved');
    expect(revit).toHaveTextContent('2 nothing in Knowledge matched');
    const link = within(revit).getByRole('link', { name: 'Revit add-in missing' });
    expect(link).toHaveAttribute('href', '/tickets/12');
    expect(within(revit).queryByText('Fourth example')).toBeNull();
    fireEvent.click(within(revit).getByRole('button', { name: /1 more example/ }));
    expect(within(revit).getByText('Fourth example')).toBeInTheDocument();
    expect(growth.gaps).toHaveBeenCalledWith({ days: '90' });
  });

  test('"Draft an article" drafts from the cluster and opens the draft', async () => {
    renderIn(<GapsPanel canManage />);
    const [revit] = await screen.findAllByTestId('gap-cluster');
    fireEvent.click(within(revit).getByTestId('gap-draft'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/articles/88'));
    expect(growth.draftFromTickets).toHaveBeenCalledWith({ ticketIds: [11, 12, 13], playbookId: 1, topic: 'Install Revit add-in', kind: 'gap' });
  });

  test('an existing draft is linked instead; nothing resolved means the button explains why it is off', async () => {
    renderIn(<GapsPanel canManage />);
    const rows = await screen.findAllByTestId('gap-cluster');
    expect(within(rows[1]).getByTestId('gap-open-draft')).toHaveAttribute('href', '/knowledge/articles/70');
    fireEvent.click(screen.getByRole('button', { name: /1 one-off question/ }));
    const oneOff = (await screen.findAllByTestId('gap-cluster')).find((r) => r.textContent.includes('VPN drops'));
    expect(within(oneOff).getByTestId('gap-draft')).toBeDisabled();
    expect(within(oneOff).getByTestId('gap-draft')).toHaveAttribute('title', expect.stringMatching(/nothing to learn from/));
  });

  test('viewers see the gaps but no drafting', async () => {
    renderIn(<GapsPanel canManage={false} />);
    await screen.findAllByTestId('gap-cluster');
    expect(screen.queryByTestId('gap-draft')).toBeNull();
    expect(screen.queryByRole('button', { name: /From tickets/ })).toBeNull();
  });

  test('empty window -> a plain empty state; the window select re-asks', async () => {
    growth.gaps.mockResolvedValue({ success: true, data: { playbooks: [], totals: { tickets: 0 } } });
    renderIn(<GapsPanel canManage />);
    expect(await screen.findByText('No gaps found')).toBeInTheDocument();
  });

  test('a draft failure is shown in words', async () => {
    growth.draftFromTickets.mockRejectedValue(new Error('None of these tickets is resolved'));
    renderIn(<GapsPanel canManage />);
    const [revit] = await screen.findAllByTestId('gap-cluster');
    fireEvent.click(within(revit).getByTestId('gap-draft'));
    expect(await screen.findByRole('alert')).toHaveTextContent('None of these tickets is resolved');
  });
});

describe('Draft from hand-picked tickets', () => {
  test('parses refs, drafts, opens the draft; Escape closes; no browser dialogs', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onClose = vi.fn();
    renderIn(<DraftFromTicketsDialog open onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: /Draft an article from solved tickets/ });
    const field = within(dialog).getByLabelText('Tickets');
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'TP-12 #241406' } });
    expect(dialog).toHaveTextContent('2 tickets: TP-12, #241406');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Draft article' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/articles/88'));
    expect(growth.draftFromTickets).toHaveBeenCalledWith({ ticketRefs: ['TP-12', '#241406'], kind: 'tickets' });
    expect(confirmSpy).not.toHaveBeenCalled();
    cleanup();
    renderIn(<DraftFromTicketsDialog open onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  test('more than 12 is refused before any call', () => {
    renderIn(<DraftFromTicketsDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Tickets'), { target: { value: Array.from({ length: 13 }, (_, i) => `TP-${i + 1}`).join(' ') } });
    expect(screen.getByRole('button', { name: 'Draft article' })).toBeDisabled();
    expect(screen.getByText(/more than 12/)).toBeInTheDocument();
  });
});

describe('Article pieces', () => {
  const drafted = {
    status: 'draft',
    sourceMeta: { draftedFrom: { kind: 'gap', ticketIds: [11, 12], ticketRefs: ['TP-11', 'TP-12'], reviewerNotes: 'Check the Company Portal name.', at: new Date().toISOString() } },
  };

  test('drafted-from banner: the check-every-step warning, linked sources, reviewer notes', () => {
    renderIn(<DraftedFromBanner article={drafted} />);
    const banner = screen.getByTestId('drafted-from-banner');
    expect(banner).toHaveTextContent('Drafted from 2 tickets — check every step before publishing.');
    expect(within(banner).getByRole('link', { name: 'TP-12' })).toHaveAttribute('href', '/tickets/12');
    expect(screen.getByTestId('reviewer-notes')).toHaveTextContent('Check the Company Portal name.');
    cleanup();
    const { container } = renderIn(<DraftedFromBanner article={{ status: 'draft' }} />);
    expect(container.querySelector('[data-testid="drafted-from-banner"]')).toBeNull();
  });

  test('FreshService note links to FreshService', () => {
    renderIn(<FsSourceNote article={{ source: 'fs_solution', sourceMeta: { url: 'https://acme.freshservice.com/a/solutions/articles/9' } }} />);
    expect(screen.getByRole('link', { name: /Edit in FreshService/ })).toHaveAttribute('href', 'https://acme.freshservice.com/a/solutions/articles/9');
  });

  test('a FreshService article opens read-only for managers (no title field, the note shows)', async () => {
    knowledge.getArticle.mockResolvedValue({ success: true, data: {
      id: 9, title: 'VPN from FreshService', bodyHtml: '<p>Connect</p>', status: 'published', source: 'fs_solution', readOnly: true,
      tags: ['freshservice'], sourceMeta: { url: 'https://acme.freshservice.com/a/solutions/articles/9' },
    } });
    renderIn(<ArticlesPanel itemId="9" canManage categories={[]} />, '/knowledge/articles/9');
    expect(await screen.findByRole('heading', { name: 'VPN from FreshService' })).toBeInTheDocument();
    expect(screen.getByTestId('fs-source-note')).toBeInTheDocument();
    expect(screen.queryByLabelText('Title')).toBeNull();
  });

  test('a drafted article opens in the editor with the banner', async () => {
    knowledge.getArticle.mockResolvedValue({ success: true, data: { id: 88, title: 'Revit add-ins', bodyHtml: '<p>x</p>', tags: ['drafted-from-tickets'], ...drafted } });
    renderIn(<ArticlesPanel itemId="88" canManage categories={[]} />, '/knowledge/articles/88');
    expect(await screen.findByLabelText('Title')).toHaveValue('Revit add-ins');
    expect(screen.getByTestId('drafted-from-banner')).toBeInTheDocument();
  });

  test('review digest line: the owner\'s count, expands to the grouped list', async () => {
    growth.reviewDigest.mockResolvedValue({ success: true, data: { count: 2, groups: [{ category: 'Software', articles: [{ id: 1, title: 'VPN', daysOverdue: 12 }, { id: 2, title: 'Printers', daysOverdue: 3 }] }] } });
    renderIn(<ReviewDigestLine />, '/knowledge/articles');
    const btn = await screen.findByRole('button', { name: /2 articles you own are due for review/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(screen.getByRole('link', { name: 'VPN' })).toHaveAttribute('href', '/knowledge/articles/1');
    expect(screen.getByText('12 d overdue')).toBeInTheDocument();
  });

  test('Sources: pick folders, save, import now (dry run explained), weekly e-mail switch', async () => {
    growth.getSettings.mockResolvedValue({ success: true, data: { fsImportEnabled: false, fsFolderIds: [], fsImportState: null, reviewDigestEnabled: false, fsCallsAllowed: false } });
    growth.fsFolders.mockResolvedValue({ success: true, data: { categories: [{ id: '3', name: 'IT how-tos', folders: [{ id: '7', name: 'VPN', description: null }, { id: '8', name: 'Printers', description: null }] }] } });
    growth.updateSettings.mockImplementation(async (patch) => ({ success: true, data: { fsImportEnabled: false, fsFolderIds: [], reviewDigestEnabled: false, fsCallsAllowed: false, ...patch } }));
    growth.fsImportNow.mockResolvedValue({ success: true, data: { dryRun: true, reason: 'not_production' } });
    renderIn(<KnowledgeSources />, '/knowledge/articles');
    const picker = await screen.findByTestId('fs-folder-picker');
    expect(screen.getByRole('switch', { name: /Import FreshService solution articles/ })).toBeDisabled(); // no folders yet
    fireEvent.click(within(picker).getByLabelText('VPN'));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 folder' }));
    await waitFor(() => expect(growth.updateSettings).toHaveBeenCalledWith({ fsFolderIds: ['7'] }));
    fireEvent.click(await screen.findByRole('button', { name: /Import now/ }));
    expect(await screen.findByText(/Dry run only: this environment never calls FreshService/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Weekly review e-mail/ }));
    await waitFor(() => expect(growth.updateSettings).toHaveBeenCalledWith({ reviewDigestEnabled: true }));
    expect(screen.getByTestId('fs-import-state')).toHaveTextContent('Not imported yet');
  });

  test('Sources: a refused folder list is explained with a retry', async () => {
    growth.getSettings.mockResolvedValue({ success: true, data: { fsImportEnabled: false, fsFolderIds: [], reviewDigestEnabled: false, fsCallsAllowed: false } });
    growth.fsFolders.mockRejectedValue(new Error('The FreshService folder list is only fetched in production'));
    renderIn(<KnowledgeSources />, '/knowledge/articles');
    expect(await screen.findByText(/only fetched in production/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('Backtest', () => {
  const EST = {
    playbook: { id: 3, name: 'Software installs' }, requested: 20, count: 18, matching: 22, alreadyBacktested: 4,
    tickets: [{ id: 1, ref: 'TP-1', subject: 'Install Revit' }], perRunUsd: 0.024, totalUsd: 0.43, basis: 'history', sampleRuns: 42,
    budget: null,
  };

  test('estimate -> in-app confirm with the cost -> start -> progress while it runs -> results', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    growth.backtestEstimate.mockResolvedValue({ success: true, data: EST });
    growth.startBacktest.mockResolvedValue({ success: true, data: { playbookId: 3, playbookName: 'Software installs', status: 'running', total: 18, done: 0, counts: { drafted: 0, not_answerable: 0, failed: 0 } } });
    growth.backtestStatus
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValue({ success: true, data: { playbookId: 3, playbookName: 'Software installs', status: 'done', total: 18, done: 18, counts: { drafted: 12, not_answerable: 5, failed: 1 } } });
    growth.backtestResults
      .mockResolvedValueOnce({ success: true, data: { counts: { total: 0 }, runs: [] } })
      .mockResolvedValue({ success: true, data: { counts: { total: 18, drafted: 12, notAnswerable: 5, failed: 1, reviewed: 0, good: 0 }, runs: [{ id: 901, status: 'drafted', confidence: 0.9, ticketRef: 'TP-1', ticketSubject: 'Install Revit' }] } });

    renderIn(<PlaybookBacktestBox playbookId={3} />, '/knowledge/playbooks/3');
    fireEvent.click(await screen.findByRole('button', { name: 'Estimate' }));
    const est = await screen.findByTestId('backtest-estimate');
    expect(est).toHaveTextContent('18 resolved tickets ready · about US$0.43 (≈ US$0.02 a run, from 42 recent runs)');
    expect(est).toHaveTextContent('22 resolved tickets match; 4 already backtested.');
    expect(growth.backtestEstimate).toHaveBeenCalledWith(3, 20);

    fireEvent.click(screen.getByTestId('backtest-run'));
    const dialog = screen.getByRole('alertdialog', { name: /Backtest on 18 resolved tickets/ });
    expect(dialog).toHaveTextContent('about US$0.43');
    expect(dialog).toHaveTextContent('Nothing is sent');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run backtest' }));
    await waitFor(() => expect(growth.startBacktest).toHaveBeenCalledWith(3, 20));
    expect(await screen.findByTestId('backtest-progress')).toHaveTextContent('0 of 18 done');
    await waitFor(() => expect(screen.getByTestId('backtest-progress')).toHaveTextContent('Finished: 18 of 18'), { timeout: 4000 });
    const results = await screen.findByTestId('backtest-results');
    expect(results).toHaveTextContent('18 backtest runs · 12 drafted · 5 not answerable · 1 failed · none reviewed yet');
    expect(within(results).getByRole('link', { name: /TP-1 · Install Revit/ })).toHaveAttribute('href', '/knowledge/activity/901');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test('another playbook\'s backtest running -> said plainly, no second start', async () => {
    growth.backtestStatus.mockResolvedValue({ success: true, data: { playbookId: 9, playbookName: 'Mobile', status: 'running', total: 10, done: 4, counts: {} } });
    renderIn(<PlaybookBacktestBox playbookId={3} />, '/knowledge/playbooks/3');
    expect(await screen.findByText(/A backtest of “Mobile” is running \(4 of 10\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Estimate' })).toBeNull();
  });

  test('an unsaved playbook cannot be backtested', () => {
    renderIn(<PlaybookBacktestBox playbookId={null} />, '/knowledge/playbooks/new');
    expect(screen.getByText(/Save the playbook first/)).toBeInTheDocument();
  });
});

describe('Turn into an article', () => {
  test('managers draft from the ticket and land in the editor', async () => {
    growth.draftFromTicket.mockResolvedValue({ success: true, data: { article: { id: 77 }, reused: false } });
    renderIn(<TurnIntoArticleButton ticketId={55} />, '/tickets/55');
    const btn = await screen.findByTestId('turn-into-article');
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/knowledge/articles/77'));
    expect(growth.draftFromTicket).toHaveBeenCalledWith(55);
  });
});

describe('audit fixes (Part B)', () => {
  test('the Recalculate button (gaps ?refresh=1) is only there for people who may recompute', async () => {
    renderIn(<GapsPanel canManage={false} canRefresh={false} />);
    await screen.findAllByTestId('gap-cluster');
    expect(screen.queryByRole('button', { name: 'Recalculate the gaps' })).toBeNull();
    cleanup();
    renderIn(<GapsPanel canManage={false} canRefresh />);
    await screen.findAllByTestId('gap-cluster');
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate the gaps' }));
    await waitFor(() => expect(growth.gaps).toHaveBeenLastCalledWith({ days: '90', refresh: 1 }));
  });

  test('reviewer notes never show a raw field name like "doesNotApply"', () => {
    expect(readableNotes('doesNotApply is empty; see usedTicketIds.')).toBe('When this doesn’t apply is empty; see the source tickets.');
    renderIn(<DraftedFromBanner article={{ status: 'draft', sourceMeta: { draftedFrom: { ticketIds: [1], ticketRefs: ['TP-1'], reviewerNotes: 'The doesNotApply list is thin.' } } }} />);
    expect(screen.getByTestId('reviewer-notes')).not.toHaveTextContent(/doesNotApply/);
    expect(screen.getByTestId('reviewer-notes')).toHaveTextContent('When this doesn’t apply list is thin.');
  });

  test('import summary: progress while running, partial listings and skipped articles said plainly', () => {
    expect(importSummary({ status: 'running', progress: { foldersTotal: 5, foldersDone: 2, articlesSeen: 140 } })).toBe('Importing… 2 of 5 folders, 140 articles read');
    expect(importSummary({ status: 'queued' })).toBe('Starting the import…');
    expect(importSummary({ status: 'interrupted' })).toMatch(/stopped before it finished/);
    const done = importSummary({ status: 'done', at: null, created: 3, updated: 0, unchanged: 9, failedArticles: [{ id: '4' }], archiveSkipped: 'partial_listing', unknownFolders: ['9'] });
    expect(done).toMatch(/3 new, 0 updated, 9 unchanged, 1 article skipped, 1 folder no longer in FreshService\./);
    expect(done).toMatch(/Nothing was archived/);
  });

  test('"Import now" starts a background job and follows its progress until it is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    growth.getSettings.mockResolvedValue({ success: true, data: { fsImportEnabled: true, fsFolderIds: ['7'], fsImportState: null, reviewDigestEnabled: false, fsCallsAllowed: true } });
    growth.fsFolders.mockResolvedValue({ success: true, data: { categories: [{ id: '3', name: 'IT how-tos', folders: [{ id: '7', name: 'VPN', description: null }] }] } });
    growth.fsImportNow.mockResolvedValue({ success: true, data: { jobId: 'fsi-1-a', status: 'queued' } });
    growth.fsImportJob
      .mockResolvedValueOnce({ success: true, data: { jobId: 'fsi-1-a', status: 'running', progress: { foldersTotal: 1, foldersDone: 0, articlesSeen: 40 } } })
      .mockResolvedValueOnce({ success: true, data: { jobId: 'fsi-1-a', status: 'done', at: new Date().toISOString(), created: 40, updated: 0, unchanged: 0 } });
    renderIn(<KnowledgeSources />, '/knowledge/articles');
    fireEvent.click(await screen.findByRole('button', { name: /Import now/ }));
    expect(await screen.findByRole('button', { name: /Importing/ })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => expect(screen.getByTestId('fs-import-state')).toHaveTextContent('Importing… 0 of 1 folder, 40 articles read'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await waitFor(() => expect(screen.getByTestId('fs-import-state')).toHaveTextContent(/40 new/));
    expect(screen.getByRole('button', { name: /Import now/ })).not.toBeDisabled();
    expect(growth.fsImportJob).toHaveBeenCalledWith('fsi-1-a');
  });

  test('an import already running when the panel opens is followed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    growth.getSettings.mockResolvedValue({ success: true, data: { fsImportEnabled: true, fsFolderIds: ['7'], fsImportState: { jobId: 'fsi-1-b', status: 'running', progress: { foldersTotal: 2, foldersDone: 1, articlesSeen: 3 } }, reviewDigestEnabled: false, fsCallsAllowed: true } });
    growth.fsFolders.mockResolvedValue({ success: true, data: { categories: [] } });
    growth.fsImportJob.mockResolvedValue({ success: true, data: { jobId: 'fsi-1-b', status: 'done', created: 1, updated: 0, unchanged: 2 } });
    renderIn(<KnowledgeSources />, '/knowledge/articles');
    expect(await screen.findByTestId('fs-import-state')).toHaveTextContent('Importing… 1 of 2 folders');
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => expect(screen.getByTestId('fs-import-state')).toHaveTextContent(/1 new/));
    expect(growth.fsImportJob).toHaveBeenCalledWith('fsi-1-b');
  });
});
