/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Knowledge redesign (26 Sep 2026, the outside artist's mockup): the playbook
// builder (header card, numbered sections, token chips, Save split button,
// sticky Test / Preview / Backtest panel), "Stay quiet when" at both levels,
// and the stayed-quiet runs in Activity.

const SETTINGS = {
  enabled: true, disclosureEnabled: true, disclosureText: 'Automated answer from {{workspace}}.', canManage: true, canReview: true,
  approveModeEnabled: false, autoModeAllowed: false,
  alwaysStayQuietWhen: ['Any sign of a security incident', 'HR, legal, or personal matters'],
  defaults: { alwaysStayQuietWhen: ['Any sign of a security incident', 'The requester is complaining about IT', 'HR, legal, or personal matters'] },
  tools: [
    { name: 'search_knowledge', label: 'Search knowledge', summary: 'Searches articles.' },
    { name: 'get_requester_profile', label: 'Requester profile', summary: 'Office and country.' },
  ],
};
const CATEGORIES = [{ id: 10, name: 'Software & Apps', subcategories: [{ id: 101, name: 'Installation' }, { id: 102, name: 'Licensing' }] }];
const PLAYBOOK = {
  id: 3, name: 'Software installs', enabled: true, mode: 'shadow', categoryId: 10, subcategoryIds: [101],
  match: { keywords: ['install'], excludeKeywords: ['licence'] },
  instructions: 'Use Company Portal.\n\nSay it is not answerable when:\n- The app is not in Company Portal.\n- They ask for admin rights.\n\nKeep it short.',
  stayQuietWhen: ['It needs a purchase'], allowedTools: ['search_knowledge'],
  kbScope: { mode: 'all', tags: [], includeVerifiedSolutions: true }, minConfidence: 0.8, followUp: null, priority: 100,
  version: 4, sensitive: false, updatedAt: new Date(Date.now() - 2 * 86400e3).toISOString(), updatedBy: 'kim.lee@example.com',
};

const api = {
  getSettings: vi.fn(() => Promise.resolve({ success: true, data: SETTINGS })),
  updateSettings: vi.fn((patch) => Promise.resolve({ success: true, data: { ...SETTINGS, ...patch } })),
  categories: vi.fn(() => Promise.resolve({ success: true, data: CATEGORIES })),
  listPlaybooks: vi.fn(() => Promise.resolve({ success: true, data: [PLAYBOOK] })),
  getPlaybook: vi.fn(() => Promise.resolve({ success: true, data: PLAYBOOK })),
  updatePlaybook: vi.fn((id, data) => Promise.resolve({ success: true, data: { ...PLAYBOOK, ...data, version: 5 } })),
  createPlaybook: vi.fn((data) => Promise.resolve({ success: true, data: { ...PLAYBOOK, ...data, id: 44, version: 1 } })),
  playbookReadiness: vi.fn(() => Promise.resolve({ success: true, data: { met: false, autoModeAllowed: false, criteria: [] } })),
  playbookPreview: vi.fn(() => Promise.resolve({ success: true, data: { latest: null, sample: null } })),
  testPlaybook: vi.fn(() => Promise.resolve({ success: true, data: { id: 9, status: 'drafted', confidence: 0.9, ticketRef: 'TP-12', ticketSubject: 'Install Bluebeam', draftSubject: 'Installing Bluebeam', draftHtml: '<p>Open Company Portal.</p>', sources: [] } })),
  listRuns: vi.fn(() => Promise.resolve({ success: true, data: { items: [], total: 0 } })),
  runsSummary: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  getRun: vi.fn(),
  listArticles: vi.fn(() => Promise.resolve({ success: true, data: { items: [], total: 0 } })),
  waiting: vi.fn(() => Promise.resolve({ success: true, data: [] })),
};
const growthApi = {
  reviewDigest: vi.fn(() => Promise.resolve({ success: true, data: { count: 0, groups: [] } })),
  backtestStatus: vi.fn(() => Promise.resolve({ success: true, data: null })),
  backtestResults: vi.fn(() => Promise.resolve({ success: true, data: { counts: { total: 0 }, runs: [] } })),
  getSettings: vi.fn(() => Promise.resolve({ success: true, data: { fsImportEnabled: false, fsFolderIds: [], reviewDigestEnabled: false, fsCallsAllowed: false } })),
  fsFolders: vi.fn(() => Promise.resolve({ success: true, data: { categories: [] } })),
};
const ticketsMeta = vi.hoisted(() => vi.fn(async () => ({ data: { technicians: [], groups: [] } })));
vi.mock('../../services/api', () => ({ get knowledgeAPI() { return api; }, get knowledgeGrowthAPI() { return growthApi; }, ticketsAPI: { meta: ticketsMeta } }));
vi.mock('../AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../nav/MobileTabBar', () => ({ default: () => null }));

import Knowledge from '../../pages/Knowledge';
import { TokenInput } from './builderUi';
import { findStayQuietBlock, mergeConditions } from './stayQuietFormat';

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/knowledge/:tab/:itemId?" element={<Knowledge />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('stayQuietFormat', () => {
  test('finds the "not answerable" block under its heading and returns the instructions without it', () => {
    const out = findStayQuietBlock(PLAYBOOK.instructions);
    expect(out.items).toEqual(['The app is not in Company Portal.', 'They ask for admin rights.']);
    expect(out.rest).toBe('Use Company Portal.\n\nKeep it short.');
    expect(findStayQuietBlock('Stay quiet when:\n1. HR matters')).toEqual({ items: ['HR matters'], rest: '' });
    expect(findStayQuietBlock('No block here')).toBeNull();
    expect(findStayQuietBlock('Stay quiet when:\n\nnothing listed')).toBeNull();
  });
  test('mergeConditions skips case-insensitive duplicates', () => {
    expect(mergeConditions(['HR matters'], ['hr matters', ' New  one '])).toEqual(['HR matters', 'New one']);
  });
});

function Chips({ initial = [] }) {
  const [values, setValues] = useState(initial);
  return (
    <>
      <TokenInput id="t" label="Terms" values={values} onChange={setValues} />
      <label htmlFor="t">Terms</label>
      <output data-testid="value">{values.join('|')}</output>
    </>
  );
}

describe('token chips', () => {
  test('Enter and a comma add, × and Backspace remove, a pasted list splits, duplicates are ignored', () => {
    render(<Chips initial={['install']} />);
    const input = screen.getByLabelText('Terms');
    fireEvent.change(input, { target: { value: 'download' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('value')).toHaveTextContent('install|download');
    fireEvent.change(input, { target: { value: 'setup,' } });
    expect(screen.getByTestId('value')).toHaveTextContent('install|download|setup');
    fireEvent.paste(input, { clipboardData: { getData: () => 'company portal, INSTALL, esim' } });
    expect(screen.getByTestId('value')).toHaveTextContent('install|download|setup|company portal|esim');
    fireEvent.click(screen.getByRole('button', { name: 'Remove download' }));
    expect(screen.getByTestId('value')).toHaveTextContent('install|setup|company portal|esim');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.getByTestId('value')).toHaveTextContent('install|setup|company portal');
    // A half-typed term is kept when the box loses focus.
    fireEvent.change(input, { target: { value: 'roaming' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('value')).toHaveTextContent('install|setup|company portal|roaming');
  });
});

describe('playbook builder', () => {
  test('header card: overline, status badge, mode line, version, last update by a person; six numbered sections', async () => {
    renderAt('/knowledge/playbooks/3');
    const header = await screen.findByTestId('playbook-header');
    expect(header).toHaveTextContent('AI automatic response playbook');
    expect(within(header).getByTestId('playbook-status')).toHaveTextContent('Active');
    expect(header).toHaveTextContent('Mode: Shadow');
    expect(header).toHaveTextContent('Answers are drafted and recorded, never sent');
    expect(header).toHaveTextContent('Version 4');
    expect(header).toHaveTextContent('Last updated 2d ago');
    expect(within(header).getByTestId('person-line')).toHaveTextContent('Kim Lee');
    expect(header).not.toHaveTextContent('kim.lee@example.com');
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual(expect.arrayContaining([
      'Step 1: Which tickets', 'Step 2: Answer behaviour & instructions', 'Step 3: Tools the AI may use',
      'Step 4: Knowledge', 'Step 5: Decision thresholds', 'Step 6: Follow-up & closure',
    ]));
    expect(screen.getByTestId('instructions-count')).toHaveTextContent(`${PLAYBOOK.instructions.length}/8000`);
    // Tool cards: the ticked one is emphasised, the other is not.
    expect(within(screen.getByTestId('tool-search_knowledge')).getByRole('checkbox')).toBeChecked();
    expect(within(screen.getByTestId('tool-get_requester_profile')).getByRole('checkbox')).not.toBeChecked();
  });

  test('page actions live in the tab row; ⋮ Disable saves the switch on its own', async () => {
    renderAt('/knowledge/playbooks/3');
    const actions = await screen.findByTestId('knowledge-tab-actions');
    await within(actions).findByRole('link', { name: 'All playbooks' });
    expect(within(actions).getByTestId('save-split')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Playbook actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Disable/ }));
    await waitFor(() => expect(api.updatePlaybook).toHaveBeenCalledWith('3', { enabled: false }));
    await waitFor(() => expect(screen.getByTestId('playbook-status')).toHaveTextContent('Off'));
  });

  test('Save & test saves, then runs the test on the ticket typed in the panel', async () => {
    renderAt('/knowledge/playbooks/3');
    const box = await screen.findByTestId('playbook-test');
    expect(screen.getByTestId('test-empty')).toHaveTextContent('Does not send a reply to the requester');
    fireEvent.change(within(box).getByLabelText('Ticket to test on'), { target: { value: 'TP-12' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Software installs v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'More ways to save' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Save & test/ }));
    await waitFor(() => expect(api.updatePlaybook).toHaveBeenCalled());
    await waitFor(() => expect(api.testPlaybook).toHaveBeenCalledWith(3, 'TP-12'));
    expect(await screen.findByTestId('playbook-test-result')).toHaveTextContent('Installing Bluebeam');
  });

  test('Save as copy creates a switched-off shadow playbook with the edits and opens it', async () => {
    renderAt('/knowledge/playbooks/3');
    await screen.findByTestId('playbook-header');
    fireEvent.click(screen.getByRole('button', { name: 'More ways to save' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Save as copy/ }));
    await waitFor(() => expect(api.createPlaybook).toHaveBeenCalled());
    expect(api.createPlaybook.mock.calls[0][0]).toMatchObject({ name: 'Software installs (copy)', enabled: false, mode: 'shadow', stayQuietWhen: ['It needs a purchase'] });
    expect(api.updatePlaybook).not.toHaveBeenCalled();
  });

  test('stay quiet: the playbook list is edited in place, the workspace list is shown, and old lines can be moved out of the instructions', async () => {
    renderAt('/knowledge/playbooks/3');
    const panel = await screen.findByTestId('stay-quiet-panel');
    await waitFor(() => expect(within(panel).getByTestId('stay-quiet-workspace')).toHaveTextContent('HR, legal, or personal matters'));
    const add = within(panel).getByLabelText('Add to Stay quiet when (this playbook)');
    fireEvent.change(add, { target: { value: 'They need a licence' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove “It needs a purchase”' }));
    // The offer: move the two "not answerable" lines into the list.
    const offer = screen.getByTestId('stay-quiet-offer');
    expect(offer).toHaveTextContent('list 2 “stay quiet” lines');
    fireEvent.click(within(offer).getByRole('button', { name: 'Move them' }));
    expect(screen.queryByTestId('stay-quiet-offer')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Instructions')).toHaveValue('Use Company Portal.\n\nKeep it short.');
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(api.updatePlaybook).toHaveBeenCalled());
    expect(api.updatePlaybook.mock.calls[0][1].stayQuietWhen).toEqual(['They need a licence', 'The app is not in Company Portal.', 'They ask for admin rights.']);
  });

  test('"Not now" leaves the instructions alone', async () => {
    renderAt('/knowledge/playbooks/3');
    const offer = await screen.findByTestId('stay-quiet-offer');
    fireEvent.click(within(offer).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('stay-quiet-offer')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Instructions').value).toContain('Say it is not answerable when:');
  });

  test('the side panel is a keyboard tablist: Test, Preview answer, Backtest', async () => {
    renderAt('/knowledge/playbooks/3');
    const tablist = await screen.findByRole('tablist', { name: 'Test and preview' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Test on a ticket', 'Preview answer', 'Backtest']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    await waitFor(() => expect(tabs[1]).toHaveAttribute('aria-selected', 'true'));
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1], { key: 'End' });
    await waitFor(() => expect(tabs[2]).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByTestId('playbook-backtest')).toBeVisible();
  });

  test('Preview answer: the latest test as the requester reads it, flagged when the playbook changed since', async () => {
    api.playbookPreview.mockResolvedValueOnce({ success: true, data: { latest: {
      id: 77, ticketRef: 'TP-12', ticketSubject: 'Install Bluebeam', createdAt: new Date().toISOString(), playbookVersion: 3, outdated: true,
      draftSubject: 'Installing Bluebeam', draftHtml: '<p>Automated answer from IT.</p><p>Open Company Portal.</p><p>Did this sort it out?</p>',
      sources: [{ sourceId: 'article:12', type: 'article', id: 12, title: 'Company Portal installs', cited: true, url: '/knowledge/articles/12' }],
    }, sample: null } });
    renderAt('/knowledge/playbooks/3');
    fireEvent.click(await screen.findByRole('tab', { name: /Preview answer/ }));
    const preview = await screen.findByTestId('preview-answer');
    expect(within(preview).getByTestId('preview-latest')).toHaveTextContent('Last test');
    expect(within(preview).getByTestId('preview-outdated')).toHaveTextContent('Tested on version 3');
    expect(within(preview).getByTestId('email-well')).toHaveTextContent('Automated answer from IT.');
    expect(preview).toHaveTextContent('Company Portal installs');
  });

  test('Preview answer: a labelled sample from the best article when nothing was tested; a plain empty state when there is no article', async () => {
    api.playbookPreview.mockResolvedValueOnce({ success: true, data: { latest: null, sample: {
      subject: 'Re: Company Portal installs', html: '<p>Automated answer from IT.</p><p>Install an app</p>',
      article: { id: 12, title: 'Company Portal installs', section: 'Install an app', url: '/knowledge/articles/12' }, sources: [],
    } } });
    renderAt('/knowledge/playbooks/3');
    fireEvent.click(await screen.findByRole('tab', { name: /Preview answer/ }));
    const sample = await screen.findByTestId('preview-sample');
    expect(sample).toHaveTextContent('Sample');
    expect(sample).toHaveTextContent('Not a real answer');
    expect(within(sample).getByRole('link', { name: 'Company Portal installs' })).toHaveAttribute('href', '/knowledge/articles/12');
    cleanup();
    renderAt('/knowledge/playbooks/3');
    fireEvent.click(await screen.findByRole('tab', { name: /Preview answer/ }));
    expect(await screen.findByText('Nothing to preview yet')).toBeInTheDocument();
  });

  test('a stayed-quiet test says which rule applied, not "not answerable"', async () => {
    api.testPlaybook.mockResolvedValueOnce({ success: true, data: {
      id: 10, status: 'not_answerable', gateDecision: 'stayed_quiet', ticketRef: 'TP-13', ticketSubject: 'x', sources: [],
      checks: { stayQuiet: { matched: true, condition: 'Any sign of a security incident', reason: 'Mentions a phishing mail', scope: 'workspace' } },
    } });
    renderAt('/knowledge/playbooks/3');
    const box = await screen.findByTestId('playbook-test');
    fireEvent.change(within(box).getByLabelText('Ticket to test on'), { target: { value: 'TP-13' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Run test' }));
    const quiet = await screen.findByTestId('test-stayed-quiet');
    expect(quiet).toHaveTextContent('Stayed quiet: Any sign of a security incident');
    expect(quiet).toHaveTextContent('Mentions a phishing mail');
  });
});

describe('workspace "Always stay quiet when" (Settings)', () => {
  test('lists the rules, edits them, saves the list and can restore the defaults', async () => {
    renderAt('/knowledge/settings');
    const section = await screen.findByTestId('settings-stay-quiet');
    const list = within(section).getByTestId('workspace-stay-quiet');
    expect(list).toHaveTextContent('Any sign of a security incident');
    fireEvent.click(within(list).getByRole('button', { name: 'Remove “HR, legal, or personal matters”' }));
    const add = within(section).getByLabelText('Add to Always stay quiet when (workspace)');
    fireEvent.change(add, { target: { value: 'Purchases and quotes' } });
    fireEvent.click(within(section).getByRole('button', { name: /Add/ }));
    fireEvent.click(within(section).getByRole('button', { name: 'Save list' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ alwaysStayQuietWhen: ['Any sign of a security incident', 'Purchases and quotes'] }));
    fireEvent.click(await within(section).findByRole('button', { name: /Restore the defaults/ }));
    expect(list).toHaveTextContent('The requester is complaining about IT');
    fireEvent.click(within(section).getByRole('button', { name: 'Save list' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ alwaysStayQuietWhen: SETTINGS.defaults.alwaysStayQuietWhen }));
  });

  test('read-only for people who cannot manage', async () => {
    api.getSettings.mockResolvedValueOnce({ success: true, data: { ...SETTINGS, canManage: false } });
    renderAt('/knowledge/settings');
    const section = await screen.findByTestId('settings-stay-quiet');
    expect(within(section).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(section).queryByLabelText(/Add to/)).not.toBeInTheDocument();
  });
});

describe('Activity: stayed-quiet runs', () => {
  const RUN = {
    id: 21, status: 'not_answerable', gateDecision: 'stayed_quiet', trigger: 'categorized', createdAt: new Date().toISOString(), mode: 'shadow',
    ticketId: 5, ticketRef: 'TP-30', ticketSubject: 'Suspicious sign-in', playbookId: 3, playbookName: 'Software installs', confidence: null,
    checks: { stayQuiet: { matched: true, via: 'check', condition: 'Any sign of a security incident', reason: 'Unknown sign-in from abroad', scope: 'workspace' } },
    sources: [], transcript: { reason: 'Stayed quiet: Any sign of a security incident' },
  };
  test('the row, the drawer and the per-playbook metrics say it stayed quiet and why', async () => {
    api.listRuns.mockResolvedValue({ success: true, data: { items: [RUN], total: 1 } });
    api.getRun.mockResolvedValue({ success: true, data: RUN });
    api.runsSummary.mockResolvedValue({ success: true, data: [{ playbookId: 3, playbookName: 'Software installs', mode: 'shadow', runs: 5, drafted: 1, draftedPct: 20, reviewed: 0, wrong: 0, stayedQuiet: 2, bar: {}, approve: {}, outcomes: {}, readiness: { criteria: [] } }] });
    renderAt('/knowledge/activity/21');
    expect(await screen.findByTestId('row-stayed-quiet')).toHaveTextContent('Stayed quiet: Any sign of a security incident');
    const drawer = await screen.findByTestId('run-stayed-quiet');
    expect(drawer).toHaveTextContent('Unknown sign-in from abroad');
    expect(drawer).toHaveTextContent('A workspace-wide rule, caught by the answer check.');
    // Per-playbook numbers moved to their own view (29 Sep 2026).
    cleanup();
    renderAt('/knowledge/activity?view=playbooks');
    expect(await screen.findByTestId('stat-stayed-quiet')).toHaveTextContent('2 of 5');
    api.listRuns.mockResolvedValue({ success: true, data: { items: [], total: 0 } });
    api.runsSummary.mockResolvedValue({ success: true, data: [] });
  });

  test('?playbook= (the builder\'s "Runs in Activity") filters the list', async () => {
    renderAt('/knowledge/activity?playbook=3');
    await waitFor(() => expect(api.listRuns).toHaveBeenCalledWith(expect.objectContaining({ playbookId: '3' })));
  });
});

describe('audit fixes (26 Sep 2026): the unsaved guard covers every way out of the builder', () => {
  const openPageMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));

  test('"Runs in Activity" with unsaved edits asks first; Keep editing stays, Discard changes goes', async () => {
    renderAt('/knowledge/playbooks/3');
    await screen.findByTestId('playbook-header');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Software installs v2' } });
    openPageMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Runs in Activity/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByTestId('playbook-builder')).toBeInTheDocument();
    expect(api.listRuns).not.toHaveBeenCalled();
    openPageMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Runs in Activity/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(api.listRuns).toHaveBeenCalledWith(expect.objectContaining({ playbookId: '3' })));
  });

  test('"Knowledge settings" with unsaved edits asks first', async () => {
    renderAt('/knowledge/playbooks/3');
    await screen.findByTestId('playbook-header');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed' } });
    openPageMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Knowledge settings/ }));
    expect(await screen.findByRole('alertdialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    expect(screen.getByTestId('playbook-builder')).toBeInTheDocument();
  });

  test('without edits, "Knowledge settings" goes straight there', async () => {
    renderAt('/knowledge/playbooks/3');
    await screen.findByTestId('playbook-header');
    openPageMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Knowledge settings/ }));
    await waitFor(() => expect(screen.queryByTestId('playbook-builder')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('Duplicate with unsaved edits asks (in-app) before copying the saved version', async () => {
    renderAt('/knowledge/playbooks/3');
    await screen.findByTestId('playbook-header');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Playbook actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Duplicate/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Duplicate without your edits?' });
    expect(api.createPlaybook).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(api.createPlaybook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Playbook actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Duplicate/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Duplicate saved version' }));
    await waitFor(() => expect(api.createPlaybook).toHaveBeenCalledTimes(1));
    // The SAVED version is copied, not the unsaved edit.
    expect(api.createPlaybook.mock.calls[0][0]).toMatchObject({ name: 'Software installs (copy)', enabled: false });
  });

  test('Duplicate without edits copies at once (no dialog)', async () => {
    renderAt('/knowledge/playbooks/3');
    await screen.findByTestId('playbook-header');
    fireEvent.click(screen.getByRole('button', { name: 'Playbook actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Duplicate/ }));
    await waitFor(() => expect(api.createPlaybook).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('article list: system tags read as words (audit, 26 Sep 2026)', () => {
  test('"drafted-from-tickets" shows as "Drafted from tickets"', async () => {
    api.listArticles.mockResolvedValueOnce({ success: true, data: { items: [{ id: 88, title: 'Revit add-ins', status: 'draft', snippet: 'x', tags: ['drafted-from-tickets', 'revit'] }], total: 1 } });
    renderAt('/knowledge/articles');
    const list = await screen.findByTestId('articles-list');
    // MEGA 09-28: the source is its own part of the line, never mixed into the topics.
    expect(list).toHaveTextContent('Drafted from tickets');
    expect(list).toHaveTextContent('revit');
    expect(list).not.toHaveTextContent('Drafted from tickets, revit');
    expect(list).not.toHaveTextContent('drafted-from-tickets');
  });
});

// 29 Sep 2026: Activity reorganised — outcome line, the judged draft with its
// unsupported steps marked, and partial drafts that say what they left out.
describe('Activity: runs view and the run panel', () => {
  const base = { trigger: 'categorized', createdAt: new Date().toISOString(), mode: 'shadow', ticketId: 5, ticketRef: '#244642', ticketSubject: 'Bluebeam', playbookId: 3, playbookName: 'Software installs', sources: [] };

  test('the outcome line counts every result and filters the list', async () => {
    api.listRuns.mockResolvedValue({ success: true, data: { items: [], total: 0, statusCounts: { no_match: 59, not_answerable: 27, drafted: 4 } } });
    renderAt('/knowledge/activity');
    const line = await screen.findByTestId('outcome-line');
    expect(line).toHaveTextContent('90 All runs');
    expect(line).toHaveTextContent('4 Drafted');
    expect(line).toHaveTextContent('59 No match');
    fireEvent.click(within(line).getByRole('button', { name: /27 Not answerable/ }));
    await waitFor(() => expect(api.listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'not_answerable' })));
    api.listRuns.mockResolvedValue({ success: true, data: { items: [], total: 0 } });
  });

  test('not answerable: the panel shows the draft the check judged, with the unsupported step marked', async () => {
    const RUN = {
      ...base, id: 100, status: 'not_answerable', gateDecision: 'insufficient_context',
      checks: {
        answerability: { sufficient: 'no', unsupportedSteps: [], reason: 'Nothing on project numbers.' },
        draftSteps: [
          { n: 1, text: 'Request Bluebeam in the Software Request form.', supported: true },
          { n: 2, text: 'Add the project number.', supported: false },
        ],
      },
    };
    api.listRuns.mockResolvedValue({ success: true, data: { items: [RUN], total: 1 } });
    api.getRun.mockResolvedValue({ success: true, data: RUN });
    renderAt('/knowledge/activity/100');
    const steps = await screen.findByTestId('draft-steps');
    expect(steps).toHaveTextContent('1.Request Bluebeam in the Software Request form.');
    expect(steps).toHaveTextContent('2.Add the project number.Not in the knowledge — left out');
    expect(screen.getByTestId('run-detail')).toHaveTextContent('Nothing on project numbers.');
    api.listRuns.mockResolvedValue({ success: true, data: { items: [], total: 0 } });
  });

  test('a partial draft says which steps it left out', async () => {
    const RUN = {
      ...base, id: 101, status: 'drafted', gateDecision: 'partial_context', draftSubject: 'Re: Bluebeam', draftHtml: '<ol><li>Request it.</li></ol>',
      checks: { droppedSteps: [2], draftSteps: [{ n: 1, text: 'Request it.', supported: true }, { n: 2, text: 'Use PDF-XChange instead.', supported: false }] },
    };
    api.listRuns.mockResolvedValue({ success: true, data: { items: [RUN], total: 1 } });
    api.getRun.mockResolvedValue({ success: true, data: RUN });
    renderAt('/knowledge/activity/101');
    expect(await screen.findByTestId('dropped-steps')).toHaveTextContent('Use PDF-XChange instead.');
    // The open panel hides the page from the accessibility tree: find the row by its label.
    const row = screen.getByTestId('runs-table').querySelector('tr[aria-label="Run on #244642"]');
    expect(row).toHaveTextContent('Drafted without step 2 (not in the knowledge)');
    api.listRuns.mockResolvedValue({ success: true, data: { items: [], total: 0 } });
  });

  test('older runs that named a step without keeping the draft say so', async () => {
    const RUN = { ...base, id: 91, status: 'not_answerable', gateDecision: 'insufficient_context', checks: { answerability: { sufficient: 'yes', unsupportedSteps: [6], reason: 'Step 6 is not in the context.' } } };
    api.listRuns.mockResolvedValue({ success: true, data: { items: [RUN], total: 1 } });
    api.getRun.mockResolvedValue({ success: true, data: RUN });
    renderAt('/knowledge/activity/91');
    expect(await screen.findByText(/Runs before 29 Sep did not keep the draft/)).toBeInTheDocument();
    api.listRuns.mockResolvedValue({ success: true, data: { items: [], total: 0 } });
  });
});

// 30 Sep 2026: "Send to me" e-mails yourself what the requester would get.
describe('Activity: Send to me', () => {
  test('a drafted run can be e-mailed to yourself; the result is shown', async () => {
    const RUN = {
      id: 108, status: 'drafted', gateDecision: 'partial_context', trigger: 'test', createdAt: new Date().toISOString(), mode: 'shadow',
      ticketId: 5, ticketRef: '#244642', ticketSubject: 'Bluebeam', playbookId: 1, playbookName: 'Software', draftSubject: 'Getting Bluebeam',
      draftHtml: '<p>Steps</p>', sources: [], checks: {},
    };
    api.listRuns.mockResolvedValue({ success: true, data: { items: [RUN], total: 1 } });
    api.getRun.mockResolvedValue({ success: true, data: RUN });
    api.sendRunToMe = vi.fn().mockResolvedValue({ success: true, data: { sent: true, to: 'me@x.io' } });
    renderAt('/knowledge/activity/108');
    const box = await screen.findByTestId('send-to-me');
    fireEvent.click(within(box).getByRole('button', { name: 'Send to me' }));
    expect(await within(box).findByRole('status')).toHaveTextContent('Sent to me@x.io');
    expect(api.sendRunToMe).toHaveBeenCalledWith(108);
    api.listRuns.mockResolvedValue({ success: true, data: { items: [], total: 0 } });
  });
});
