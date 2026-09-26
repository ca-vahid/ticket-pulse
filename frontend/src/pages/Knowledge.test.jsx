/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Knowledge (Auto-help P0): the page renders its four URL tabs, the playbook
// editor saves through knowledgeAPI (shadow only), and "Test on a ticket"
// shows the drafted answer with confidence and sources.

const SETTINGS = {
  enabled: false, disclosureEnabled: true, disclosureText: 'This is an automated first answer from the {{workspace}} team. Reply any time to reach a person.',
  canManage: true, canReview: true, modeLocked: true,
  tools: [
    { name: 'search_knowledge', label: 'Search knowledge', summary: 'Searches articles.' },
    { name: 'get_article', label: 'Read an article', summary: 'Reads one article.' },
  ],
};
const CATEGORIES = [{ id: 10, name: 'Software & Apps', subcategories: [{ id: 101, name: 'Installation' }, { id: 102, name: 'Licensing' }] }];
const PLAYBOOK = {
  id: 3, name: 'Software installs', enabled: false, mode: 'shadow', categoryId: 10, subcategoryIds: [101],
  match: { keywords: ['install'], excludeKeywords: [] }, instructions: 'Use Company Portal.', allowedTools: ['search_knowledge'],
  kbScope: { mode: 'all', tags: [], includeVerifiedSolutions: true }, minConfidence: 0.8,
  followUp: { nudgeAfterBusinessDays: 2, closeAfterBusinessDays: 2, nudgeText: 'Hope that sorted it.', onSilence: 'resolve' },
  priority: 100, version: 2, lastRunAt: null, runCount: 0,
};

const RUN_5 = {
  id: 5, status: 'drafted', trigger: 'test', createdAt: '2026-09-25T10:00:00Z', ticketId: 55, ticketRef: 'TP-12', ticketSubject: 'Install Bluebeam',
  createdBy: 'vahid.pelarak@example.com', createdByPerson: { name: 'Vahid Pelarak', email: 'vahid.pelarak@example.com', photoUrl: null },
  draftSubject: 'Installing Bluebeam', draftHtml: '<p>Open Company Portal.</p>',
  sources: [{ sourceId: 'article:12', type: 'article', id: 12, title: 'Company Portal installs', section: 'Install Bluebeam', stale: true, cited: true, url: '/knowledge/articles/12' }],
  transcript: { steps: [] }, gateDecision: 'shadow_recorded',
  checks: { answerability: { sufficient: 'yes', unsupportedSteps: [] } },
  teamOutcome: {
    firstReply: { text: 'Installed it remotely for you.', occurredAt: '2026-09-25T11:00:00Z', author: { name: 'Sam Agent', email: 'sam.agent@example.com', photoUrl: null } },
    ticket: { status: 'Resolved', resolvedAt: '2026-09-25T12:00:00Z', resolutionNote: 'Remote install' },
  },
};

const api = {
  getSettings: vi.fn(() => Promise.resolve({ success: true, data: SETTINGS })),
  categories: vi.fn(() => Promise.resolve({ success: true, data: CATEGORIES })),
  listArticles: vi.fn(() => Promise.resolve({ success: true, data: { items: [], total: 0 } })),
  listPlaybooks: vi.fn(() => Promise.resolve({ success: true, data: [PLAYBOOK] })),
  getPlaybook: vi.fn(() => Promise.resolve({ success: true, data: PLAYBOOK })),
  updatePlaybook: vi.fn((id, data) => Promise.resolve({ success: true, data: { ...PLAYBOOK, ...data, version: 3 } })),
  testPlaybook: vi.fn(() => Promise.resolve({
    success: true,
    data: {
      id: 901, status: 'drafted', confidence: 0.91, minConfidence: 0.8, durationMs: 4200,
      ticketRef: 'TP-12', ticketSubject: 'Install Bluebeam', matchCheck: { matches: true, reason: 'Matches' }, warnings: [],
      draftSubject: 'Installing Bluebeam',
      draftHtml: '<p>This is an automated first answer from the IT team.</p><p>Open Company Portal and install Bluebeam.</p><p>Did this sort it out?</p>',
      sources: [{ sourceId: 'article:12', type: 'article', id: 12, title: 'Company Portal installs', cited: true, url: '/knowledge/articles/12' }],
    },
  })),
  listRuns: vi.fn(() => Promise.resolve({ success: true, data: { items: [], total: 0 } })),
  getRun: vi.fn(() => Promise.resolve({ success: true, data: RUN_5 })),
  search: vi.fn(() => Promise.resolve({ success: true, data: [{ id: 12, title: 'Company Portal installs', snippet: 'Open it', score: 0.8, tags: [] }] })),
  getArticle: vi.fn(() => Promise.resolve({ success: true, data: { id: 7, title: 'VPN setup', bodyHtml: '<p>Connect</p>', status: 'draft', tags: [], categoryId: null, subcategoryId: null } })),
  updateArticle: vi.fn((id, data) => Promise.resolve({ success: true, data: { id: 7, ...data } })),
  deleteArticle: vi.fn(() => Promise.resolve({ success: true, data: { id: 7, archived: true } })),
  verifyArticle: vi.fn(() => Promise.resolve({ success: true, data: { id: 7, lastVerifiedAt: new Date().toISOString(), needsReview: false } })),
  reviewRun: vi.fn((id, data) => Promise.resolve({ success: true, data: { ...RUN_5, reviewVerdict: data.verdict, reviewNote: data.note, reviewedAt: new Date().toISOString(), reviewedBy: 'rev@example.com', reviewedByPerson: { name: 'Rae Viewer' } } })),
  runsSummary: vi.fn(() => Promise.resolve({ success: true, data: [
    { playbookId: 3, playbookName: 'Software installs', runs: 40, drafted: 30, draftedPct: 75, reviewed: 12, good: 11, goodPct: 92, wrong: 1, readyForApprove: false, bar: { minReviewed: 30, minGoodPct: 85 } },
  ] })),
  waiting: vi.fn(() => Promise.resolve({ success: true, data: [] })),
};
// Getter: vi.mock is hoisted above `api`, so resolve it lazily.
// The article Owner picker lists the workspace team (avatar + name).
const ticketsMeta = vi.hoisted(() => vi.fn(async () => ({ data: { technicians: [
  { id: 1, name: 'Kim Lee', email: 'kim@example.com', photoUrl: null },
  { id: 2, name: 'Sam Agent', email: 'sam@example.com', photoUrl: null },
] } })));
vi.mock('../services/api', () => ({ get knowledgeAPI() { return api; }, ticketsAPI: { meta: ticketsMeta } }));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/RichTextEditor', () => ({
  default: ({ value, onChange, ariaLabel }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange?.({ html: e.target.value, text: e.target.value })} />
  ),
}));

import Knowledge from './Knowledge';

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/knowledge" element={<Knowledge />} />
      <Route path="/knowledge/:tab/:itemId?" element={<Knowledge />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('Knowledge page', () => {
  test('renders the five tabs with no page header; /knowledge lands on Articles; settings live on their own tab', async () => {
    renderAt('/knowledge');
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent.trim())).toEqual(['Articles', 'Playbooks', 'Waiting', 'Activity', 'Settings']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('No articles yet')).toBeInTheDocument();
    // 26 Sep 2026 (Vahid): no "Knowledge — Answers we can stand behind…" header, no settings above the tabs.
    expect(screen.queryByText(/Answers we can stand behind/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-settings')).not.toBeInTheDocument();
  });

  test('the Settings tab holds the Auto-help switch and the automated-answer line with a live preview', async () => {
    renderAt('/knowledge/settings');
    expect(await screen.findByTestId('knowledge-settings')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Auto-help on for this workspace/)).toBeInTheDocument();
    const wording = screen.getByLabelText('Automated-answer wording');
    fireEvent.change(wording, { target: { value: 'Automated reply from {{workspace}}.' } });
    expect(screen.getByTestId('disclosure-preview')).toHaveTextContent(/Automated reply from/);
    expect(screen.getByRole('button', { name: /Save wording/ })).toBeEnabled();
  });

  test('Waiting explains it fills once sending is on', async () => {
    renderAt('/knowledge/waiting');
    expect(await screen.findByTestId('waiting-empty')).toHaveTextContent(/once sending is switched on/);
  });

  test('people who cannot manage see read-only playbooks and read-only settings', async () => {
    api.getSettings.mockResolvedValue({ success: true, data: { ...SETTINGS, canManage: false } });
    renderAt('/knowledge/playbooks');
    expect(await screen.findByText('Software installs')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New playbook/ })).not.toBeInTheDocument();
    cleanup();
    renderAt('/knowledge/settings');
    expect(await screen.findByTestId('knowledge-settings-readonly')).toHaveTextContent(/off for this workspace/);
    expect(screen.getByRole('switch', { name: /Auto-help on for this workspace/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save wording/ })).not.toBeInTheDocument();
    api.getSettings.mockResolvedValue({ success: true, data: SETTINGS });
  });

  test('the playbook editor saves (mode stays shadow, keywords split)', async () => {
    renderAt('/knowledge/playbooks/3');
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Software installs v2' } });
    fireEvent.change(screen.getByLabelText('Only when it mentions any of'), { target: { value: 'install, download' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updatePlaybook).toHaveBeenCalled());
    const [id, payload] = api.updatePlaybook.mock.calls[0];
    expect(id).toBe('3');
    expect(payload).toMatchObject({ name: 'Software installs v2', categoryId: 10, subcategoryIds: [101], match: { keywords: ['install', 'download'] } });
    expect(payload.mode).toBeUndefined();
    expect(screen.getByText(/Mode:/)).toHaveTextContent('Shadow');
  });

  test('test on a ticket shows the draft, confidence and cited sources', async () => {
    renderAt('/knowledge/playbooks/3');
    const box = await screen.findByTestId('playbook-test');
    fireEvent.change(within(box).getByLabelText('Ticket to test on'), { target: { value: 'TP-12' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Run test' }));
    const result = await screen.findByTestId('playbook-test-result');
    expect(api.testPlaybook).toHaveBeenCalledWith(3, 'TP-12');
    expect(result).toHaveTextContent('Drafted');
    expect(result).toHaveTextContent('91%');
    expect(result).toHaveTextContent('Installing Bluebeam');
    expect(result).toHaveTextContent('automated first answer');
    expect(result).toHaveTextContent('Company Portal installs');
    expect(result).toHaveTextContent('cited');
  });

  test('a not-answerable test run explains itself instead of showing a draft', async () => {
    api.testPlaybook.mockResolvedValueOnce({
      success: true,
      data: { id: 902, status: 'not_answerable', confidence: null, ticketRef: 'TP-13', ticketSubject: 'x', warnings: ['Ticket is marked noise'], transcript: { reason: 'Needs a licence first' }, sources: [] },
    });
    renderAt('/knowledge/playbooks/3');
    const box = await screen.findByTestId('playbook-test');
    fireEvent.change(within(box).getByLabelText('Ticket to test on'), { target: { value: 'TP-13' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Run test' }));
    const result = await screen.findByTestId('playbook-test-result');
    expect(result).toHaveTextContent('Not answerable');
    expect(result).toHaveTextContent('Needs a licence first');
    expect(result).toHaveTextContent('Ticket is marked noise');
  });

  test('no page header; the shared gradient tab bar is a keyboard tablist with aria-controls', async () => {
    renderAt('/knowledge/articles');
    const tabs = await screen.findAllByRole('tab');
    expect(screen.queryByRole('heading', { level: 1, name: 'Knowledge' })).not.toBeInTheDocument();
    expect(tabs[0]).toHaveAttribute('aria-controls', 'knowledge-panel-articles');
    // Same look as the Assignment page's bar: selected tab lifted on the blue→purple gradient.
    expect(tabs[0].className).toMatch(/bg-white\/25/);
    expect(tabs[0].closest('.bg-gradient-to-r')).not.toBeNull();
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    const panel = await screen.findByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'knowledge-panel-articles');
    expect(panel).toHaveAttribute('aria-labelledby', 'knowledge-tab-articles');

    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /Playbooks/ })).toHaveAttribute('aria-selected', 'true'));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Playbooks/ }));
    fireEvent.keyDown(screen.getByRole('tab', { name: /Playbooks/ }), { key: 'End' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /Settings/ })).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(screen.getByRole('tab', { name: /Settings/ }), { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /Articles/ })).toHaveAttribute('aria-selected', 'true'));
  });

  test('run detail shows who ran it as avatar + name, never the bare e-mail, and the draft in the white e-mail well', async () => {
    renderAt('/knowledge/activity/5');
    const detail = await screen.findByTestId('run-detail');
    expect(within(detail).getAllByTestId('person-line')[0]).toHaveTextContent('Vahid Pelarak');
    expect(detail).not.toHaveTextContent('vahid.pelarak@example.com');
    expect(within(detail).getByTestId('email-well')).toHaveClass('tp-light', 'bg-card');
  });

  test('without a person record the e-mail local part is prettified', async () => {
    api.getRun.mockResolvedValueOnce({
      success: true,
      data: { id: 6, status: 'not_answerable', trigger: 'test', createdAt: '2026-09-25T10:00:00Z', ticketId: 55, ticketRef: 'TP-12', ticketSubject: 'x', createdBy: 'jane.roe@example.com', createdByPerson: null, sources: [], transcript: { reason: 'n/a' } },
    });
    renderAt('/knowledge/activity/6');
    const detail = await screen.findByTestId('run-detail');
    expect(within(detail).getAllByTestId('person-line')[0]).toHaveTextContent('Jane Roe');
    expect(detail).not.toHaveTextContent('jane.roe@example.com');
  });

  test('unsaved article edits: switching tabs asks in-app first; Keep editing stays, Discard leaves', async () => {
    renderAt('/knowledge/articles/7');
    const title = await screen.findByLabelText('Title');
    fireEvent.change(title, { target: { value: 'VPN setup (new)' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Playbooks/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Leave without saving?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Articles/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Title')).toHaveValue('VPN setup (new)');

    fireEvent.click(screen.getByRole('tab', { name: /Playbooks/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Playbooks/ })).toHaveAttribute('aria-selected', 'true'));
  });

  test('a clean editor leaves without asking; archive asks in-app (no window.confirm)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderAt('/knowledge/articles/7');
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(api.deleteArticle).toHaveBeenCalledWith('7'));
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('Show archived lists the archive; typing a query uses the hybrid search', async () => {
    renderAt('/knowledge/articles');
    await screen.findByText('No articles yet');
    fireEvent.click(screen.getByLabelText('Show archived'));
    await waitFor(() => expect(api.listArticles).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'archived' })));
    expect(await screen.findByText('Nothing archived')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show archived'));

    fireEvent.change(screen.getByLabelText('Search articles'), { target: { value: 'bluebeam install' } });
    await waitFor(() => expect(api.search).toHaveBeenCalledWith('bluebeam install', { limit: 20 }));
    expect(await screen.findByText('Company Portal installs')).toBeInTheDocument();
  });

  test('playbook editor: explicit opt-in for quoting instructions; default check-in wording shown, not empty', async () => {
    api.getPlaybook.mockResolvedValueOnce({ success: true, data: { ...PLAYBOOK, followUp: { nudgeAfterBusinessDays: 2, closeAfterBusinessDays: 3, onSilence: 'resolve' } } });
    renderAt('/knowledge/playbooks/3');
    const optIn = await screen.findByLabelText(/Let the answer quote these instructions/);
    expect(optIn).not.toBeChecked();
    const nudge = screen.getByLabelText('Check-in message');
    expect(nudge.value).toMatch(/close this ticket in \{\{days\}\}/);
    expect(screen.getByText(/close this ticket in 3 business days/)).toBeInTheDocument();
    fireEvent.click(optIn);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updatePlaybook).toHaveBeenCalled());
    expect(api.updatePlaybook.mock.calls[0][1].instructionsAreSource).toBe(true);
  });

  test('R1: list shows "Verified … · Review due" in plain words, and the Needs review filter asks the API', async () => {
    api.listArticles.mockResolvedValueOnce({ success: true, data: { items: [
      { id: 1, title: 'Company Portal installs', status: 'published', lastVerifiedAt: new Date(Date.now() - 95 * 86400e3).toISOString(), needsReview: true, tags: [], updatedAt: new Date().toISOString() },
    ], total: 1 } });
    renderAt('/knowledge/articles');
    expect(await screen.findByTestId('governance-line')).toHaveTextContent('Verified 3 months ago · Review due');
    fireEvent.click(screen.getByLabelText('Needs review'));
    await waitFor(() => expect(api.listArticles).toHaveBeenLastCalledWith(expect.objectContaining({ review: 'due' })));
  });

  test('R1: editor has the writing guide, Mark as verified, owner/review fields, and a non-blocking duplicate-title warning', async () => {
    api.getArticle.mockResolvedValueOnce({ success: true, data: { id: 7, title: 'Install software from Company Portal', bodyHtml: '<p>x</p>', status: 'published', tags: [], lastVerifiedAt: null, needsReview: true, ownerEmail: 'kim@example.com', reviewEveryDays: 180, sectionHeadings: ['Install', 'Uninstall'] } });
    api.updateArticle.mockResolvedValueOnce({ success: true, data: { id: 7, title: 'Install software from Company Portal', bodyHtml: '<p>x</p>', status: 'published', tags: [], warnings: { similarTitles: [{ id: 4, title: 'Install software via the Company Portal', overlap: 0.83 }] } } });
    renderAt('/knowledge/articles/7');
    const guide = await screen.findByTestId('writing-guide');
    expect(guide).not.toHaveTextContent('can’t follow links');
    fireEvent.click(within(guide).getByRole('button', { name: /Writing for Auto-help/ }));
    expect(guide).toHaveTextContent(/can.t follow links/);
    // K2: the owner is a person (avatar + name), stored as their e-mail.
    const owner = screen.getByTestId('owner-picker');
    await waitFor(() => expect(owner).toHaveTextContent('Kim Lee'));
    expect(owner).toHaveAttribute('data-value', 'kim@example.com');
    fireEvent.click(owner);
    fireEvent.click(await screen.findByRole('option', { name: 'Sam Agent' }));
    expect(owner).toHaveAttribute('data-value', 'sam@example.com');
    expect(screen.getByTestId('verify-row')).toHaveTextContent('Never verified · Review due');
    expect(screen.getByTestId('section-headings')).toHaveTextContent('Install · Uninstall');
    fireEvent.click(screen.getByRole('button', { name: /Mark as verified/ }));
    await waitFor(() => expect(api.verifyArticle).toHaveBeenCalledWith('7'));
    await waitFor(() => expect(screen.getByTestId('verify-row')).toHaveTextContent('Verified today'));

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Install software from Company Portal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const warn = await screen.findByTestId('similar-titles');
    expect(warn).toHaveTextContent('Install software via the Company Portal');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  test('R6: the run drawer shows what the team did next to the draft, sources with their section, and saves a verdict', async () => {
    renderAt('/knowledge/activity/5');
    const detail = await screen.findByTestId('run-detail');
    const team = within(detail).getByTestId('team-outcome');
    expect(team).toHaveTextContent('Installed it remotely for you.');
    expect(within(team).getByTestId('person-line')).toHaveTextContent('Sam Agent');
    expect(team).not.toHaveTextContent('sam.agent@example.com');
    expect(team).toHaveTextContent('Resolved');
    expect(detail).toHaveTextContent('Company Portal installs › Install Bluebeam');
    expect(detail).toHaveTextContent('review due');
    expect(within(detail).getByTestId('answerability')).toHaveTextContent('Context check: enough');

    const box = within(detail).getByTestId('review-box');
    const partly = within(box).getByRole('button', { name: 'Partly right' });
    fireEvent.click(partly);
    expect(partly).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(within(box).getByLabelText('Review note'), { target: { value: 'Step 2 names the wrong app' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(api.reviewRun).toHaveBeenCalledWith(5, { verdict: 'partial', note: 'Step 2 names the wrong app' }));
    expect(await within(detail).findByText(/Last: Partly right/)).toBeInTheDocument();
  });

  test('R6: people who cannot review see no verdict buttons', async () => {
    api.getSettings.mockResolvedValueOnce({ success: true, data: { ...SETTINGS, canManage: false, canReview: false } });
    renderAt('/knowledge/activity/5');
    const detail = await screen.findByTestId('run-detail');
    expect(within(detail).queryByTestId('review-box')).not.toBeInTheDocument();
  });

  test('R6: per-playbook summary with N and the rollout bar in plain text', async () => {
    renderAt('/knowledge/activity');
    const strip = await screen.findByTestId('runs-summary');
    expect(strip).toHaveTextContent('Software installs');
    expect(strip).toHaveTextContent('drafted 75% (N=40)');
    expect(strip).toHaveTextContent('good 92% (N=12)');
    expect(strip).toHaveTextContent('wrong 1');
    expect(strip).toHaveTextContent('Ready for approve mode when ≥30 reviewed and ≥85 % good — not met yet');
  });
});
