/** @vitest-environment jsdom */
// QA 11-05 #3 — the Mail Workflows editor holds every exit while it has
// unsaved changes, and offers a local draft back on reopen.
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco-editor" /> }));
vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BaseEdge: () => null,
  Controls: () => null,
  EdgeLabelRenderer: ({ children }) => <>{children}</>,
  Handle: () => null,
  MiniMap: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  ReactFlow: ({ children }) => <div data-testid="react-flow">{children}</div>,
  getSmoothStepPath: () => ['', 0, 0],
}));
vi.mock('@tiptap/react', () => ({ EditorContent: () => null, useEditor: () => null }));
vi.mock('@tiptap/starter-kit', () => ({ default: {} }));
vi.mock('react-resizable-panels', () => ({
  Group: ({ children }) => <div>{children}</div>,
  Panel: ({ children }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

const DEFINITION = {
  version: 1,
  nodes: [
    { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
    { id: 'add-note', type: 'add_note', data: { mode: 'text', body: '<p>Saved body</p>' } },
    { id: 'stop', type: 'stop', data: {} },
  ],
  edges: [
    { id: 'trigger-to-add-note', source: 'trigger', target: 'add-note' },
    { id: 'add-note-to-stop', source: 'add-note', target: 'stop' },
  ],
  metadata: {},
};
const EDITED = JSON.parse(JSON.stringify(DEFINITION));
EDITED.nodes[1].data.body = '<p>Edited body, not saved</p>';

function workflowRow() {
  return {
    id: 12,
    key: 'intake',
    name: 'Intake acknowledgement',
    description: null,
    triggerType: 'ticket.created',
    isDefaultVariant: true,
    isEnabled: false,
    mockModeEnabled: false,
    publishedVersion: 1,
    draftDefinition: JSON.parse(JSON.stringify(DEFINITION)),
    publishedDefinition: JSON.parse(JSON.stringify(DEFINITION)),
    routingMode: 'exclusive',
    routingPriority: 1,
    routingRule: null,
  };
}

const api = vi.hoisted(() => ({ overrides: {} }));
vi.mock('../../services/api', () => {
  const handler = {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (!api.overrides[prop]) api.overrides[prop] = vi.fn(async () => ({ data: null }));
      return api.overrides[prop];
    },
  };
  return { notificationWorkflowAPI: new Proxy({}, handler), ticketsAPI: new Proxy({}, handler) };
});

const { default: NotificationWorkflowsPanel } = await import('./NotificationWorkflowsPanel.jsx');
const { workflowDraftStorageKey, hashFingerprint } = await import('./workflowEditorGuard.jsx');

const DRAFT_KEY = workflowDraftStorageKey(5, 12);

function seedLocalDraft({ baseHash } = {}) {
  window.localStorage.setItem(DRAFT_KEY, JSON.stringify({
    workflowId: 12,
    definition: EDITED,
    savedAt: '2026-11-05T23:12:00.000Z', // Thu 5 Nov, 3:12 PM Pacific
    baseHash: baseHash ?? null,
    basePublishedVersion: 1,
  }));
}

function DashboardStub() {
  return <div data-testid="dashboard-page">Dashboard</div>;
}

function RailButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/dashboard')}>Rail: Dashboard</button>;
}

function renderPanel() {
  return render(
    <BrowserRouter>
      <RailButton />
      <Routes>
        <Route path="/workflows" element={<NotificationWorkflowsPanel workspaceId={5} hideTabBar />} />
        <Route path="/dashboard" element={<DashboardStub />} />
      </Routes>
    </BrowserRouter>,
  );
}

async function openEditedEditor() {
  seedLocalDraft();
  renderPanel();
  await screen.findByTestId('workflow-draft-restore');
  fireEvent.click(screen.getByTestId('workflow-draft-restore-button'));
  await waitFor(() => expect(screen.queryByTestId('workflow-draft-restore')).not.toBeInTheDocument());
}

beforeEach(() => {
  for (const key of Object.keys(api.overrides)) delete api.overrides[key];
  api.overrides.list = vi.fn(async () => ({ data: [workflowRow()] }));
  api.overrides.get = vi.fn(async () => ({ data: workflowRow() }));
  api.overrides.saveDraft = vi.fn(async (_id, body) => ({ data: { ...workflowRow(), draftDefinition: body.definition } }));
  window.localStorage.clear();
  window.history.replaceState(null, '', '/workflows?wf=12');
});

afterEach(() => cleanup());

describe('Mail Workflows editor leave guard (QA 11-05 #3)', () => {
  test('offers a newer local draft inline, with its Pacific time, and restores it', async () => {
    seedLocalDraft();
    renderPanel();
    const line = await screen.findByTestId('workflow-draft-restore');
    expect(line).toHaveTextContent('Unsaved changes from Thu 5 Nov, 3:12 PM');
    expect(screen.queryByTestId('workflow-draft-stale')).not.toBeInTheDocument();
    // Never restored on its own: Save & publish still says Saved.
    expect(screen.getByRole('button', { name: /Saved/ })).toBeDisabled();
    fireEvent.click(screen.getByTestId('workflow-draft-restore-button'));
    expect(await screen.findByRole('button', { name: /Save & publish/ })).toBeEnabled();
  });

  test('says so when the workflow was saved after the draft was started', async () => {
    seedLocalDraft({ baseHash: hashFingerprint('an older saved version') });
    renderPanel();
    expect(await screen.findByTestId('workflow-draft-stale')).toHaveTextContent('This workflow was saved since');
  });

  test('a stored draft equal to the saved version is not offered and is cleared', async () => {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ workflowId: 12, definition: DEFINITION, savedAt: '2026-11-05T23:12:00.000Z' }));
    renderPanel();
    await screen.findByTestId('workflow-back-to-list');
    expect(screen.queryByTestId('workflow-draft-restore')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('Discard on the restore line forgets the local draft', async () => {
    seedLocalDraft();
    renderPanel();
    fireEvent.click(await screen.findByTestId('workflow-draft-discard-button'));
    expect(screen.queryByTestId('workflow-draft-restore')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('clean editor: All workflows leaves without asking', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('workflow-back-to-list'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  test('dirty: All workflows asks; Keep editing is focused, primary, and stays', async () => {
    await openEditedEditor();
    fireEvent.click(screen.getByTestId('workflow-back-to-list'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    const keep = screen.getByTestId('workflow-leave-keep');
    expect(keep).toHaveFocus();
    expect(keep.className).toContain('bg-primary');
    expect(dialog).toHaveTextContent('Save draft and leave');
    fireEvent.click(keep);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-back-to-list')).toBeInTheDocument();
    expect(window.location.search).toBe('?wf=12');
  });

  test('dirty: Discard leaves and drops the changes and the local copy', async () => {
    await openEditedEditor();
    fireEvent.click(screen.getByTestId('workflow-back-to-list'));
    fireEvent.click(await screen.findByTestId('workflow-leave-discard'));
    await waitFor(() => expect(screen.queryByTestId('workflow-back-to-list')).not.toBeInTheDocument());
    expect(window.location.search).toBe('');
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(api.overrides.saveDraft).not.toHaveBeenCalled();
  });

  test('dirty: Save draft and leave saves without publishing and clears the local copy', async () => {
    await openEditedEditor();
    fireEvent.click(screen.getByTestId('workflow-back-to-list'));
    fireEvent.click(await screen.findByTestId('workflow-leave-save'));
    await waitFor(() => expect(api.overrides.saveDraft).toHaveBeenCalledTimes(1));
    expect(api.overrides.saveDraft.mock.calls[0][1].definition.nodes[1].data.body).toBe('<p>Edited body, not saved</p>');
    expect(api.overrides.publish).toBeUndefined();
    await waitFor(() => expect(screen.queryByTestId('workflow-back-to-list')).not.toBeInTheDocument());
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('dirty: a side-rail navigate() is held until Discard, then goes', async () => {
    await openEditedEditor();
    fireEvent.click(screen.getByText('Rail: Dashboard'));
    await screen.findByRole('alertdialog');
    expect(screen.queryByTestId('dashboard-page')).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/workflows');
    fireEvent.click(screen.getByTestId('workflow-leave-discard'));
    expect(await screen.findByTestId('dashboard-page')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/dashboard');
  });

  test('dirty: browser Back stays on the editor and asks', async () => {
    await openEditedEditor();
    // The guard put a same-address entry on top.
    await waitFor(() => expect(window.history.state?.tpWfLeaveGuard).toBe(true));
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => { window.addEventListener('popstate', resolve, { once: true }); });
    });
    await screen.findByRole('alertdialog');
    expect(screen.getByTestId('workflow-back-to-list')).toBeInTheDocument();
    expect(window.location.search).toBe('?wf=12');
    // Guard is back in place for the next Back.
    expect(window.history.state?.tpWfLeaveGuard).toBe(true);
  });

  test('dirty: reload / tab close gets the browser prompt (beforeunload)', async () => {
    await openEditedEditor();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test('autosaves the working copy locally every few seconds while dirty', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openEditedEditor();
      window.localStorage.removeItem(DRAFT_KEY);
      await act(async () => { vi.advanceTimersByTime(3500); });
      const stored = JSON.parse(window.localStorage.getItem(DRAFT_KEY));
      expect(stored.workflowId).toBe(12);
      expect(stored.definition.nodes[1].data.body).toBe('<p>Edited body, not saved</p>');
      expect(stored.baseHash).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
