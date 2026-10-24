/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// QA 10-23 #4: Knowledge -> Settings -> Confluence.
const api = {
  get: vi.fn(),
  runs: vi.fn(),
  saveConnection: vi.fn(),
  clearConnection: vi.fn(),
  test: vi.fn(),
  spaces: vi.fn(),
  analyze: vi.fn(),
  saveSelection: vi.fn(),
  setNightly: vi.fn(),
  importNow: vi.fn(),
  importStatus: vi.fn(),
};
vi.mock('../../services/api', () => ({ get knowledgeConfluenceAPI() { return api; } }));

const { ConfluenceSettings } = await import('./ConfluenceSettings');
const { toggleNode, parentMap, isPicked, countPicked, runCounts, normalizeSelection } = await import('./confluenceFormat');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const VIEW = {
  enabled: false, configured: true, siteUrl: 'https://example.atlassian.net', email: 'svc@example.com', tokenSet: true,
  selection: { spaces: [{ id: '9', key: 'IT', name: 'IT Help' }], include: [], exclude: [], wholeSpaces: [], includeRestricted: false },
  importState: null, importedAt: '2026-10-20T00:00:00Z', lastNightly: null, labels: {}, syncedAt: null, waiting: 4, callsAllowed: true,
};
const TREE = {
  spaces: [{
    id: '9', key: 'IT', name: 'IT Help', complete: true, pages: 5, words: 900, lastUpdated: '2026-10-01T00:00:00Z', sectionIds: ['2', '5'],
    tree: [{
      id: '1', title: 'Home', pages: 5, words: 10, subtreeWords: 900, lastUpdated: '2026-10-01T00:00:00Z',
      children: [
        { id: '2', title: 'How-tos', pages: 3, words: 100, subtreeWords: 700, lastUpdated: '2026-10-01T00:00:00Z', label: { label: 'technical_solutions', reason: 'Fixes.', suggestion: 'include', by: 'model' }, children: [
          { id: '3', title: 'Reset VPN', pages: 1, words: 300, subtreeWords: 300, children: [] },
          { id: '4', title: 'Old printers', pages: 1, words: 300, subtreeWords: 300, children: [] },
        ] },
        { id: '5', title: 'Meeting notes', pages: 1, words: 190, subtreeWords: 190, label: { label: 'meeting_notes', reason: 'Minutes.', suggestion: 'skip', by: 'model' }, children: [] },
      ],
    }],
  }],
  labels: {},
};
const RUNS = [
  { id: 2, kind: 'nightly', status: 'done', startedAt: '2026-10-22T06:00:00Z', triggeredBy: 'nightly', counts: { changed: 2, newPages: 1, retired: 0, editedInTp: 1, noSkilledOwner: 1 }, model: 'claude-sonnet-5-5', costUsd: 0.04 },
  { id: 1, kind: 'import', status: 'failed', startedAt: '2026-10-20T00:00:00Z', triggeredBy: 'lead@example.com', counts: { created: 3 }, error: 'Confluence answered 500.' },
];

describe('selection rules (pure)', () => {
  test('ticking a section picks its pages; unticking a child leaves it out; ticking it again clears the mark', () => {
    const parents = parentMap(TREE.spaces);
    const home = TREE.spaces[0].tree[0];
    const howTos = home.children[0];
    let sel = normalizeSelection({ spaces: [{ id: '9' }] });
    sel = toggleNode(sel, howTos, parents, '9');
    expect(sel.include).toEqual(['2']);
    expect(isPicked('3', parents, sel, '9')).toBe(true);
    sel = toggleNode(sel, howTos.children[1], parents, '9');
    expect(sel.exclude).toEqual(['4']);
    expect(countPicked(TREE.spaces, sel)).toBe(2);
    sel = toggleNode(sel, howTos.children[1], parents, '9');
    expect(sel.exclude).toEqual([]);
    sel = toggleNode(sel, howTos, parents, '9');
    expect(sel.include).toEqual([]);
    expect(countPicked(TREE.spaces, sel)).toBe(0);
  });

  test('run counts read as words', () => {
    expect(runCounts(RUNS[0])).toBe('2 changed, 1 new, 0 gone, 1 also edited here. 1 page went to a category where nobody has Intermediate.');
    expect(runCounts({ kind: 'nightly', status: 'skipped', counts: { reason: 'import_first' } })).toBe('Skipped: the one-time import has not run yet.');
  });
});

describe('Confluence settings card', () => {
  test('managers: never shows the token, lists the run history, looks at the pages and saves a tree selection', async () => {
    api.get.mockResolvedValue({ data: VIEW });
    api.runs.mockResolvedValue({ data: RUNS });
    api.analyze.mockResolvedValue({ data: TREE });
    api.saveSelection.mockImplementation(async (sel) => ({ data: { ...VIEW, selection: sel } }));
    render(<ConfluenceSettings canManage />);
    const card = await screen.findByTestId('knowledge-confluence');
    expect(within(card).getByTestId('confluence-connection')).toHaveTextContent('Connected to https://example.atlassian.net as svc@example.com');
    expect(within(card).getByLabelText('API token')).toHaveValue('');
    expect(within(card).getByLabelText('API token')).toHaveAttribute('placeholder', 'Saved. Leave blank to keep it');

    const history = await within(card).findByTestId('confluence-runs');
    expect(history).toHaveTextContent('Nightly check');
    expect(history).toHaveTextContent('2 changed, 1 new');
    expect(history).toHaveTextContent('Confluence answered 500.');
    expect(history).toHaveTextContent('US$0.04');
    expect(within(card).getByTestId('confluence-nightly-state')).toHaveTextContent('4 from Confluence waiting in the Inbox');

    fireEvent.click(within(card).getByRole('button', { name: /Look at the pages/ }));
    await waitFor(() => expect(api.analyze).toHaveBeenCalledWith({ spaceIds: ['9'], withModel: true }));
    const tree = await within(card).findByTestId('confluence-tree-9');
    expect(tree).toHaveTextContent('AI: Technical solutions, bring in. Fixes.');
    expect(tree).toHaveTextContent('Meeting notes, skip');
    fireEvent.click(within(tree).getByRole('checkbox', { name: /How-tos/ }));
    fireEvent.click(within(tree).getByRole('button', { name: 'Show pages under How-tos' }));
    fireEvent.click(within(tree).getByRole('checkbox', { name: /Old printers/ }));
    expect(within(card).getByTestId('confluence-picked')).toHaveTextContent('2 pages picked');
    expect(within(card).getByRole('button', { name: /Run import now/ })).toBeDisabled();
    fireEvent.click(within(card).getByRole('button', { name: 'Save picked pages' }));
    await waitFor(() => expect(api.saveSelection).toHaveBeenCalled());
    expect(api.saveSelection.mock.calls[0][0]).toMatchObject({ include: ['2'], exclude: ['4'], includeRestricted: false });
    await waitFor(() => expect(within(card).getByRole('button', { name: /Run import now/ })).toBeEnabled());
  });

  test('the nightly switch saves through the API; the import starts and its progress shows', async () => {
    api.get.mockResolvedValue({ data: { ...VIEW, selection: { ...VIEW.selection, include: ['2'] } } });
    api.runs.mockResolvedValue({ data: [] });
    api.setNightly.mockResolvedValue({ data: { ...VIEW, enabled: true, selection: { ...VIEW.selection, include: ['2'] } } });
    api.importNow.mockResolvedValue({ data: { jobId: 'cfi-1', status: 'queued' } });
    api.importStatus.mockResolvedValue({ data: { status: 'done', at: '2026-10-23T00:00:00Z', counts: { created: 4, restricted: 1 } } });
    render(<ConfluenceSettings canManage />);
    const card = await screen.findByTestId('knowledge-confluence');
    fireEvent.click(within(card).getByRole('switch', { name: 'Check Confluence every night' }));
    await waitFor(() => expect(api.setNightly).toHaveBeenCalledWith(true));
    await waitFor(() => expect(within(card).getByRole('switch', { name: 'Check Confluence every night' })).toBeChecked());
    fireEvent.click(within(card).getByRole('button', { name: /Run import now/ }));
    await waitFor(() => expect(api.importNow).toHaveBeenCalled());
    await waitFor(() => expect(within(card).getByTestId('confluence-import-state')).toHaveTextContent('4 new, 1 skipped (view limits)'), { timeout: 3000 });
  });

  test('read-only for people who cannot manage Knowledge: no form, no Confluence calls, switch locked', async () => {
    api.get.mockResolvedValue({ data: { ...VIEW, email: null, selection: { ...VIEW.selection, include: ['2', '3'] } } });
    api.runs.mockResolvedValue({ data: RUNS });
    render(<ConfluenceSettings canManage={false} />);
    const card = await screen.findByTestId('knowledge-confluence');
    expect(within(card).getByTestId('confluence-connection')).toHaveTextContent('Connected to https://example.atlassian.net.');
    expect(within(card).queryByLabelText('API token')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Look at the pages/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Run import now/ })).not.toBeInTheDocument();
    expect(within(card).getByTestId('confluence-selection-readonly')).toHaveTextContent('1 space, 2 sections picked.');
    expect(within(card).getByRole('switch', { name: 'Check Confluence every night' })).toBeDisabled();
    expect(await within(card).findByTestId('confluence-runs')).toHaveTextContent('One-time import');
    expect(api.spaces).not.toHaveBeenCalled();
    expect(api.importStatus).not.toHaveBeenCalled();
  });
});
