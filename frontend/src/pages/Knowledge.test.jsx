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
  createPlaybook: vi.fn((data) => Promise.resolve({ success: true, data: { ...PLAYBOOK, ...data, id: 44, version: 1 } })),
  deletePlaybook: vi.fn(() => Promise.resolve({ success: true, data: { id: 3, deleted: true } })),
  playbookPreview: vi.fn(() => Promise.resolve({ success: true, data: { latest: null, sample: null } })),
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
    {
      playbookId: 3, playbookName: 'Software installs', mode: 'approve', sensitive: false, runs: 40, drafted: 30, draftedPct: 75, reviewed: 12, good: 11, goodPct: 92, wrong: 1, readyForApprove: false, bar: { minReviewed: 30, minGoodPct: 85 },
      // P1 metrics
      staged: 14, sent: 10, waiting: 2,
      outcomes: {
        resolved_silence: { n: 4, pct: 40 }, resolved_confirmed: { n: 2, pct: 20 }, help_requested: { n: 1, pct: 10 },
        reopened: { n: 1, pct: 10 }, agent_took_over: { n: 0, pct: 0 }, no_reply_left_open: { n: 0, pct: 0 },
      },
      approve: { decided: 12, unchanged: { n: 7, pct: 58.3 }, edited: { n: 3, pct: 25, medianEditDistance: 0.12 }, dismissed: { n: 2, pct: 16.7, reasons: { wrong_answer: 1, not_needed: 1, other: 0 } } },
      csat: { n: 3, avg: 3.7, outOf: 4 },
      cost: { runsWithCost: 40, totalUsd: 0.8, perRunUsd: 0.02, monthUsd: 0.3, monthRuns: 15, inputTokens: 1, outputTokens: 1 },
      readiness: {
        met: false,
        criteria: [
          { key: 'reviewed', label: 'At least 30 reviewed shadow drafts', value: 12, target: 30, n: 12, met: false },
          { key: 'good', label: 'At least 85 % of them good', value: 91.7, target: 85, n: 12, met: true },
          { key: 'not_sensitive', label: 'Not a sensitive playbook (password, MFA, access, security)', value: 'not sensitive', target: 'not sensitive', n: null, met: true },
        ],
      },
    },
  ] })),
  playbookReadiness: vi.fn(() => Promise.resolve({ success: true, data: { met: false, autoModeAllowed: false, criteria: [{ key: 'reviewed', label: 'At least 30 reviewed shadow drafts', value: 12, target: 30, n: 12, met: false }] } })),
  waiting: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  approvals: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  updateSettings: vi.fn((patch) => Promise.resolve({ success: true, data: patch })),
};
// Getter: vi.mock is hoisted above `api`, so resolve it lazily.
// The article Owner picker lists the workspace team (avatar + name).
const ticketsMeta = vi.hoisted(() => vi.fn(async () => ({ data: { technicians: [
  { id: 1, name: 'Kim Lee', email: 'kim@example.com', photoUrl: null },
  { id: 2, name: 'Sam Agent', email: 'sam@example.com', photoUrl: null },
] } })));
// Knowledge that grows (P1): quiet defaults so the P0 tests stay about P0.
const growthApi = {
  reviewDigest: vi.fn(() => Promise.resolve({ success: true, data: { count: 0, groups: [] } })),
  gaps: vi.fn(() => Promise.resolve({ success: true, data: { playbooks: [], totals: { tickets: 0, clusters: 0 } } })),
  backtestStatus: vi.fn(() => Promise.resolve({ success: true, data: null })),
  backtestResults: vi.fn(() => Promise.resolve({ success: true, data: { counts: { total: 0 }, runs: [] } })),
  getSettings: vi.fn(() => Promise.resolve({ success: true, data: { fsImportEnabled: false, fsFolderIds: ['7'], fsImportState: null, reviewDigestEnabled: true, fsCallsAllowed: false } })),
  updateSettings: vi.fn((patch) => Promise.resolve({ success: true, data: { fsImportEnabled: false, fsFolderIds: ['7'], reviewDigestEnabled: true, fsCallsAllowed: false, ...patch } })),
  fsFolders: vi.fn(() => Promise.resolve({ success: true, data: { categories: [{ id: '3', name: 'IT how-tos', folders: [{ id: '7', name: 'VPN', description: null }] }] } })),
};
vi.mock('../services/api', () => ({ get knowledgeAPI() { return api; }, get knowledgeGrowthAPI() { return growthApi; }, ticketsAPI: { meta: ticketsMeta } }));
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
  test('renders the six tabs with no page header; /knowledge lands on Articles; settings live on their own tab', async () => {
    renderAt('/knowledge');
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent.trim())).toEqual(['Articles', 'Gaps', 'Playbooks', 'Waiting', 'Activity', 'Settings']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('No articles yet')).toBeInTheDocument();
    // 26 Sep 2026 (Vahid): no "Knowledge — Answers we can stand behind…" header, no settings above the tabs.
    expect(screen.queryByText(/Answers we can stand behind/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-settings')).not.toBeInTheDocument();
  });

  test('reviewers and admins get an Approvals tab (30 Sep 2026); it lists answers waiting to be sent', async () => {
    api.getSettings.mockResolvedValueOnce({ success: true, data: { ...SETTINGS, canApprove: true } });
    renderAt('/knowledge/approvals');
    const tabs = await screen.findAllByRole('tab');
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent.trim())).toContain('Approvals'));
    expect(tabs.length).toBeGreaterThan(0);
    expect(await screen.findByText('Nothing waiting')).toBeInTheDocument();
    expect(api.approvals).toHaveBeenCalled();
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

  test('P1 settings moved to the Settings tab: approve mode, thank-you, cost cap with spend, auto lock, sources, reviews', async () => {
    api.getSettings.mockResolvedValue({ success: true, data: { ...SETTINGS, enabled: true, approveModeEnabled: false, thankOnConfirm: false, monthlyCostCapUsd: 50, autoModeAllowed: false, autoModeLockedMessage: 'Auto sending is switched off in this build', budget: { capUsd: 50, spentUsd: 1.25, exhausted: false } } });
    renderAt('/knowledge/settings');
    const panel = await screen.findByTestId('knowledge-settings');
    expect(within(panel).getByRole('heading', { name: 'Auto-help' })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Automated-answer line' })).toBeInTheDocument();
    expect(await within(panel).findByRole('heading', { name: 'Knowledge sources' })).toBeInTheDocument();
    expect(await within(panel).findByRole('heading', { name: 'Reviews' })).toBeInTheDocument();
    expect(screen.getByTestId('autohelp-state')).toHaveTextContent('On · shadow');
    expect(screen.getByTestId('cost-spent')).toHaveTextContent(/1\.25 spent this month/);
    expect(screen.getByTestId('auto-locked')).toHaveTextContent('Auto sending is switched off in this build');
    fireEvent.click(screen.getByRole('switch', { name: /Approve mode/ }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ approveModeEnabled: true }));
    fireEvent.click(screen.getByRole('switch', { name: /Thank the requester/ }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ thankOnConfirm: true }));
    // First response: editable even while auto mode is locked, and says it only matters for auto mode.
    expect(screen.getByTestId('first-response-setting')).toHaveTextContent('Only matters for answers sent by themselves after hours');
    fireEvent.click(screen.getByRole('switch', { name: /Count an automated answer as the first response/ }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ countsAsFirstResponse: true }));
    const cap = screen.getByLabelText('Monthly cost cap');
    fireEvent.change(cap, { target: { value: '80' } });
    fireEvent.blur(cap);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ monthlyCostCapUsd: 80 }));
    // The FS import folder picker and the review e-mail switch are here too (managers).
    expect(await screen.findByTestId('fs-folder-picker')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Weekly review e-mail/ })).toBeChecked();
    expect(screen.getByRole('button', { name: /Import now/ })).toBeInTheDocument();
    api.getSettings.mockImplementation(() => Promise.resolve({ success: true, data: SETTINGS }));
  });

  test('approve by day, auto by night (30 Sep 2026): needs approve mode; says which playbooks qualify; summary recipients', async () => {
    const afterHours = { afterHoursNow: true, playbooks: [
      { id: 1, name: 'Software, apps & licences', mode: 'approve', sensitive: false, readinessMet: false },
      { id: 2, name: 'Phones & mobile', mode: 'approve', sensitive: false, readinessMet: true },
    ] };
    api.getSettings.mockResolvedValue({ success: true, data: { ...SETTINGS, enabled: true, approveModeEnabled: false, afterHours } });
    const first = renderAt('/knowledge/settings');
    await screen.findByTestId('knowledge-settings');
    expect(screen.getByRole('switch', { name: 'Auto after hours and on holidays' })).toBeDisabled();
    expect(screen.getByTestId('after-hours-setting')).toHaveTextContent('Needs approve mode on.');
    first.unmount();

    api.getSettings.mockResolvedValue({ success: true, data: { ...SETTINGS, enabled: true, approveModeEnabled: true, autoAfterHours: false, afterHours } });
    renderAt('/knowledge/settings');
    await screen.findByTestId('knowledge-settings');
    const status = screen.getByTestId('after-hours-status');
    expect(status).toHaveTextContent('Would send by itself: Phones & mobile.');
    expect(status).toHaveTextContent('It is after hours now.');
    expect(screen.queryByLabelText('Morning summary to')).not.toBeInTheDocument();
    api.updateSettings.mockResolvedValueOnce({ success: true, data: { ...SETTINGS, enabled: true, approveModeEnabled: true, autoAfterHours: true, afterHoursSummaryTo: [], afterHours } });
    fireEvent.click(screen.getByRole('switch', { name: 'Auto after hours and on holidays' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ autoAfterHours: true }));
    expect(await screen.findByTestId('after-hours-status')).toHaveTextContent('so these are sending by themselves.');
    const to = await screen.findByLabelText('Morning summary to');
    expect(to).toHaveAttribute('placeholder', 'the workspace admins');
    fireEvent.change(to, { target: { value: 'lead@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ afterHoursSummaryTo: ['lead@example.com'] }));
    api.getSettings.mockImplementation(() => Promise.resolve({ success: true, data: SETTINGS }));
  });

  test('after hours: nothing qualifies yet says why', async () => {
    api.getSettings.mockResolvedValue({ success: true, data: { ...SETTINGS, enabled: true, approveModeEnabled: true, afterHours: { afterHoursNow: false, playbooks: [{ id: 1, name: 'Software', mode: 'approve', sensitive: false, readinessMet: false }] } } });
    renderAt('/knowledge/settings');
    const status = await screen.findByTestId('after-hours-status');
    expect(status).toHaveTextContent('No playbook qualifies yet — Software still need their readiness checklist. It is business hours now.');
    api.getSettings.mockImplementation(() => Promise.resolve({ success: true, data: SETTINGS }));
  });

  test('the workspace switch tells screen readers the real mode, not a stale "(shadow)"', async () => {
    renderAt('/knowledge/settings');
    await screen.findByTestId('knowledge-settings');
    expect(document.getElementById('kh-enabled')).toHaveAttribute('aria-label', expect.stringMatching(/shadow — answers are drafted, never sent/));
    cleanup();
    api.getSettings.mockResolvedValue({ success: true, data: { ...SETTINGS, approveModeEnabled: true } });
    renderAt('/knowledge/settings');
    await screen.findByTestId('knowledge-settings');
    await waitFor(() => expect(document.getElementById('kh-enabled').getAttribute('aria-label')).toMatch(/approve mode allowed/));
    expect(document.getElementById('kh-enabled').getAttribute('aria-label')).not.toMatch(/shadow/);
    api.getSettings.mockImplementation(() => Promise.resolve({ success: true, data: SETTINGS }));
  });

  test('Waiting explains what waits there', async () => {
    renderAt('/knowledge/waiting');
    expect(await screen.findByTestId('waiting-empty')).toHaveTextContent(/answer was sent wait here for the requester/);
  });

  test('P1 Waiting: next step and when, with the requester as a person', async () => {
    api.waiting.mockResolvedValueOnce({ success: true, data: [
      { parkId: 1, ticketId: 55, ticketRef: 'TP-12', subject: 'Install Bluebeam', requesterName: 'Pat Requester', requesterEmail: 'pat@example.com', until: '2026-10-14T17:00:00Z', playbookName: 'Software installs', sentAt: '2026-10-09T17:00:00Z', nudgedAt: null, nextStep: 'nudge' },
    ] });
    renderAt('/knowledge/waiting');
    expect(await screen.findByTestId('waiting-next')).toHaveTextContent(/^Checks in/);
    expect(screen.getByText('Pat Requester')).toBeInTheDocument();
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
    expect(screen.getByRole('switch', { name: /Approve mode/ })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /Thank the requester/ })).toBeDisabled();
    expect(screen.getByLabelText('Monthly cost cap')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save wording/ })).not.toBeInTheDocument();
    // Sources + reviews read-only: no folder list call, no Import now.
    expect(await screen.findByTestId('fs-import-readonly')).toHaveTextContent('1 folder picked.');
    expect(screen.getByRole('switch', { name: /Weekly review e-mail/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Import now/ })).not.toBeInTheDocument();
    expect(growthApi.fsFolders).not.toHaveBeenCalled();
    api.getSettings.mockResolvedValue({ success: true, data: SETTINGS });
  });

  test('the playbook editor saves (mode stays shadow, keywords as chips)', async () => {
    renderAt('/knowledge/playbooks/3');
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Software installs v2' } });
    // A legacy playbook with words (no useWords flag) opens "Advanced: also require words".
    const kw = screen.getByLabelText('Words that bring a ticket in');
    fireEvent.change(kw, { target: { value: 'download' } });
    fireEvent.keyDown(kw, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(api.updatePlaybook).toHaveBeenCalled());
    const [id, payload] = api.updatePlaybook.mock.calls[0];
    expect(id).toBe('3');
    expect(payload).toMatchObject({ name: 'Software installs v2', categoryId: 10, subcategoryIds: [101], match: { useWords: true, keywords: ['install', 'download'] } });
    expect(payload).toMatchObject({ mode: 'shadow', sensitive: false, onHelp: 'assign_normally' });
  });

  test('P1 mode control: approve needs the workspace switch; auto is locked "not in this build"; sensitive is a tick', async () => {
    renderAt('/knowledge/playbooks/3');
    fireEvent.click(await screen.findByTestId('mode-control'));
    const menu = await screen.findByRole('menu', { name: /Mode: Shadow/ });
    const item = (name) => within(menu).getByRole('menuitemradio', { name: new RegExp(`^${name}`) });
    expect(item('Shadow')).toHaveAttribute('aria-checked', 'true');
    expect(item('Approve')).toHaveAttribute('aria-disabled', 'true');
    expect(item('Auto')).toHaveAttribute('aria-disabled', 'true');
    expect(menu).toHaveTextContent('Switch approve mode on for the workspace first');
    expect(item('Auto')).toHaveTextContent('Locked — not in this build');
    expect(screen.getByTestId('mode-line')).toHaveTextContent('Answers are drafted and recorded, never sent');

    cleanup();
    api.getSettings.mockResolvedValue({ success: true, data: { ...SETTINGS, approveModeEnabled: true, autoModeAllowed: false, autoModeLockedMessage: 'Auto sending is switched off in this build' } });
    renderAt('/knowledge/playbooks/3');
    await screen.findByTestId('mode-control');
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('mode-control'));
    const menu2 = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu2).getByRole('menuitemradio', { name: /^Approve/ })).not.toHaveAttribute('aria-disabled'));
    expect(within(menu2).getByRole('menuitemradio', { name: /^Auto/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(within(menu2).getByRole('menuitemradio', { name: /^Approve/ }));
    expect(screen.getByTestId('mode-control')).toHaveTextContent('Mode: Approve');
    fireEvent.click(screen.getByRole('checkbox', { name: /Sensitive topic/ }));
    expect(screen.getByTestId('playbook-header')).toHaveTextContent('Sensitive · approve only');
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(api.updatePlaybook).toHaveBeenCalled());
    expect(api.updatePlaybook.mock.calls.at(-1)[1]).toMatchObject({ mode: 'approve', sensitive: true });
    // The readiness gate lives on the panel's Backtest tab.
    fireEvent.click(screen.getByRole('tab', { name: /Backtest/ }));
    expect(await screen.findByTestId('playbook-readiness')).toHaveTextContent('At least 30 reviewed shadow drafts');
    api.getSettings.mockImplementation(() => Promise.resolve({ success: true, data: SETTINGS }));
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

  test('no page header; the light tab bar is a keyboard tablist with aria-controls and page actions on the right', async () => {
    renderAt('/knowledge/articles');
    const tabs = await screen.findAllByRole('tab');
    expect(screen.queryByRole('heading', { level: 1, name: 'Knowledge' })).not.toBeInTheDocument();
    expect(tabs[0]).toHaveAttribute('aria-controls', 'knowledge-panel-articles');
    // 26 Sep 2026 redesign: light tabs (soft blue fill + underline), not the Assignment gradient.
    expect(tabs[0].className).toMatch(/border-primary/);
    expect(tabs[0].className).toMatch(/bg-primary/);
    expect(tabs[0].closest('[data-testid="light-tab-bar"]')).not.toBeNull();
    expect(tabs[0].closest('.bg-gradient-to-r')).toBeNull();
    // The open tab's actions sit in the tab row.
    expect(within(screen.getByTestId('knowledge-tab-actions')).getByRole('button', { name: /New article/ })).toBeInTheDocument();
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    const panel = await screen.findByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'knowledge-panel-articles');
    expect(panel).toHaveAttribute('aria-labelledby', 'knowledge-tab-articles');

    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /Gaps/ })).toHaveAttribute('aria-selected', 'true'));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Gaps/ }));
    fireEvent.keyDown(screen.getByRole('tab', { name: /Gaps/ }), { key: 'End' });
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
    // A run that did not draft explains itself; it is not "what the requester would get".
    expect(detail).toHaveTextContent('Why Auto-help didn’t answer');
    expect(detail).not.toHaveTextContent('What the requester would get');
  });

  test('unsaved article edits: switching tabs asks in-app first; Keep editing stays, Discard leaves', async () => {
    renderAt('/knowledge/articles/7');
    const title = await screen.findByLabelText('Title');
    fireEvent.change(title, { target: { value: 'VPN setup (new)' } });
    expect(screen.getAllByText('Unsaved changes').length).toBeGreaterThan(0);

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
    fireEvent.click(screen.getByRole('button', { name: 'Article actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Archive/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
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
    // "How Auto-help reads it" (the editor's right panel) lists the sections.
    fireEvent.click(screen.getByRole('tab', { name: /How Auto-help reads it/ }));
    const sections = screen.getByTestId('section-headings');
    expect(sections).toHaveTextContent('Install');
    expect(sections).toHaveTextContent('Uninstall');
    expect(sections).toHaveAttribute('aria-label', 'Auto-help reads it in sections: Install · Uninstall');
    fireEvent.click(screen.getByRole('button', { name: /Mark as verified/ }));
    await waitFor(() => expect(api.verifyArticle).toHaveBeenCalledWith('7'));
    await waitFor(() => expect(screen.getByTestId('verify-row')).toHaveTextContent('Verified today'));

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Install software from Company Portal' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
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
    expect(within(detail).getByTestId('answerability')).toHaveTextContent('Answer check: enough');

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

  // 29 Sep 2026: per-playbook numbers are one compact row each, under Activity → By playbook.
  test('R6: per-playbook summary with N and the rollout bar in plain text', async () => {
    renderAt('/knowledge/activity?view=playbooks');
    const row = await screen.findByTestId('playbook-metrics');
    expect(row).toHaveTextContent('Software installs');
    expect(row).toHaveTextContent('30 of 40');
    expect(row).toHaveTextContent('12 · 92 % good');
    expect(row).toHaveTextContent('12 of 30 reviews');
    fireEvent.click(within(row).getByRole('button', { name: /Show details for Software installs/ }));
    const bar = await screen.findByTestId('stat-review');
    expect(bar).toHaveTextContent('≥30 reviewed and ≥85 % good — not met yet (12 reviewed, 92 % good)');
    expect(bar).toHaveTextContent('wrong 1');
  });

  test('P1 metrics: outcomes and decisions with N, CSAT with N, cost, and the readiness gate line by line', async () => {
    renderAt('/knowledge/activity?view=playbooks');
    const row = await screen.findByTestId('playbook-metrics');
    expect(within(row).getByTestId('stat-cost')).toHaveTextContent('US$0.0200 (N=40)');
    const toggle = within(row).getByRole('button', { name: /Show details for Software installs/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(await screen.findByTestId('stat-outcomes')).toHaveTextContent('Sent answers (N=10)');
    expect(screen.getByTestId('stat-outcomes')).toHaveTextContent('Closed after no reply 4 (40 %)');
    expect(screen.getByTestId('stat-outcomes')).toHaveTextContent('Reopened within 7 days 1 (10 %)');
    expect(screen.getByTestId('stat-outcomes')).toHaveTextContent('still waiting 2');
    expect(screen.getByTestId('stat-decisions')).toHaveTextContent('Unchanged 7 (58 %) · edited 3 (25 %) (median change 12 %) · dismissed 2 (17 %) (N=12)');
    expect(screen.getByTestId('stat-csat')).toHaveTextContent('Average 3.7 out of 4 across 3 survey answers (N = 3)');
    expect(screen.getByTestId('stat-cost-detail')).toHaveTextContent('US$0.0200 per run (N=40) · US$0.30 this month');
    const list = await screen.findByTestId('readiness-list');
    expect(list).toHaveTextContent('At least 30 reviewed shadow drafts');
    expect(list).toHaveTextContent('not met: 12');
    expect(list).toHaveTextContent('Auto sending is switched off in this build');
  });
});
