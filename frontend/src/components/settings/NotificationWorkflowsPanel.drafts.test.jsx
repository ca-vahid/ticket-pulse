/** @vitest-environment jsdom */
// QA 11-05b #1 — a place to see unpublished workflow drafts: the list marks
// saved drafts nobody published and this browser's unsaved copies (Drafts
// tab), Open restores a local copy into the editor, and the editor says when
// the saved draft is not what is live.
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

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

const definition = (body, triggerType = 'ticket.created') => ({
  version: 1,
  nodes: [
    { id: 'trigger', type: 'trigger', data: { triggerType } },
    { id: 'add-note', type: 'add_note', data: { mode: 'text', body } },
    { id: 'stop', type: 'stop', data: {} },
  ],
  edges: [
    { id: 'trigger-to-add-note', source: 'trigger', target: 'add-note' },
    { id: 'add-note-to-stop', source: 'add-note', target: 'stop' },
  ],
  metadata: {},
});

const SAVED_AT = '2026-11-05T23:12:00.000Z'; // Thu 5 Nov, 3:12 PM Pacific

function live() {
  return {
    id: 12, key: 'intake', name: 'Intake acknowledgement', description: null, triggerType: 'ticket.created',
    isDefaultVariant: true, isEnabled: true, mockModeEnabled: false, publishedVersion: 4,
    draftDefinition: definition('<p>Live body</p>'), publishedDefinition: definition('<p>Live body</p>'),
    routingMode: 'exclusive', routingPriority: 1, routingRule: null, lastChangedBy: 'sam.ortiz@example.com',
    hasUnpublishedChanges: false, draftState: null,
  };
}
function changed() {
  return {
    ...live(), id: 13, key: 'reassigned', name: 'Reassignment notice', triggerType: 'ticket.reassigned', isEnabled: false,
    draftDefinition: definition('<p>New wording</p>', 'ticket.reassigned'), publishedDefinition: definition('<p>Old wording</p>', 'ticket.reassigned'),
    lastChangedBy: 'alex.rivera@example.com',
    hasUnpublishedChanges: true, draftState: 'unpublished', draftSavedAt: SAVED_AT, draftSavedBy: 'alex.rivera@example.com', draftSavedByName: 'Alex Rivera',
  };
}
function neverPublished() {
  return {
    ...live(), id: 14, key: 'custom_unassigned', name: 'Unassigned nudge', triggerType: 'ticket.assigned', isDefaultVariant: false,
    isEnabled: false, publishedVersion: 0, publishedDefinition: null, draftDefinition: definition('<p>Draft</p>', 'ticket.assigned'),
    lastChangedBy: 'alex.rivera@example.com',
    hasUnpublishedChanges: true, draftState: 'never_published', draftSavedAt: SAVED_AT, draftSavedBy: 'alex.rivera@example.com', draftSavedByName: 'Alex Rivera',
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
const { workflowDraftStorageKey } = await import('./workflowEditorGuard.jsx');

function seedLocal(workflowId, body = '<p>Typed on this computer</p>', triggerType = 'ticket.created') {
  window.localStorage.setItem(workflowDraftStorageKey(5, workflowId), JSON.stringify({
    workflowId, definition: definition(body, triggerType), savedAt: '2026-11-05T22:40:00.000Z', baseHash: null, basePublishedVersion: 4,
  }));
}

function renderPanel() {
  return render(
    <BrowserRouter>
      <Routes>
        <Route path="/workflows" element={<NotificationWorkflowsPanel workspaceId={5} hideTabBar />} />
      </Routes>
    </BrowserRouter>,
  );
}

const rows = () => [live(), changed(), neverPublished()];

beforeEach(() => {
  for (const key of Object.keys(api.overrides)) delete api.overrides[key];
  api.overrides.list = vi.fn(async () => ({ data: rows() }));
  api.overrides.get = vi.fn(async (id) => ({ data: rows().find((w) => String(w.id) === String(id)) }));
  api.overrides.saveDraft = vi.fn(async (id, body) => ({ data: { ...rows().find((w) => String(w.id) === String(id)), draftDefinition: body.definition } }));
  api.overrides.publish = vi.fn(async (id) => ({
    data: { workflow: { ...rows().find((w) => String(w.id) === String(id)), publishedVersion: 5, publishedDefinition: changed().draftDefinition, hasUnpublishedChanges: false, draftState: null }, version: { version: 5 } },
  }));
  window.localStorage.clear();
  window.history.replaceState(null, '', '/workflows');
});

afterEach(() => cleanup());

const rowFor = (name) => screen.getAllByTestId('workflow-list-row').find((li) => li.textContent.includes(name));

describe('Mail Workflows list: drafts (QA 11-05b #1)', () => {
  test('(a) marks a saved draft nobody published, and one never published, in words with an icon', async () => {
    renderPanel();
    await screen.findByTestId('workflow-list-page');
    const marker = within(rowFor('Reassignment notice')).getByTestId('workflow-draft-marker');
    expect(marker).toHaveTextContent('Unpublished changes · saved Thu 5 Nov, 3:12 PM by Alex Rivera');
    expect(marker.querySelector('svg')).toBeTruthy();
    expect(marker.className).not.toMatch(/rounded-full|border/); // no pill
    expect(within(rowFor('Unassigned nudge')).getByTestId('workflow-draft-marker')).toHaveTextContent('Never published · saved Thu 5 Nov, 3:12 PM by Alex Rivera');
    expect(within(rowFor('Intake acknowledgement')).queryByTestId('workflow-draft-marker')).not.toBeInTheDocument();
  });

  test('(b) the Drafts tab counts and shows only those workflows', async () => {
    renderPanel();
    await screen.findByTestId('workflow-list-page');
    const tab = screen.getByRole('button', { name: /^Drafts/ });
    expect(tab).toHaveTextContent('Drafts2');
    fireEvent.click(tab);
    expect(tab).toHaveAttribute('aria-pressed', 'true');
    const names = screen.getAllByTestId('workflow-list-row').map((li) => li.textContent);
    expect(names).toHaveLength(2);
    expect(names.join(' ')).not.toContain('Intake acknowledgement');
  });

  test('(c) lists this browser’s unsaved copy with Open and Discard; it counts in Drafts', async () => {
    seedLocal(12);
    renderPanel();
    await screen.findByTestId('workflow-list-page');
    const line = within(rowFor('Intake acknowledgement')).getByTestId('workflow-local-draft');
    expect(line).toHaveTextContent('Unsaved on this computer · Thu 5 Nov, 2:40 PM');
    expect(screen.getByRole('button', { name: /^Drafts/ })).toHaveTextContent('Drafts3');
    fireEvent.click(within(line).getByRole('button', { name: 'Discard the unsaved copy of Intake acknowledgement' }));
    await waitFor(() => expect(screen.queryByTestId('workflow-local-draft')).not.toBeInTheDocument());
    expect(window.localStorage.getItem(workflowDraftStorageKey(5, 12))).toBeNull();
    expect(screen.getByRole('button', { name: /^Drafts/ })).toHaveTextContent('Drafts2');
  });

  test('(c) a stored copy equal to what is saved is not listed', async () => {
    seedLocal(12, '<p>Live body</p>');
    renderPanel();
    await screen.findByTestId('workflow-list-page');
    expect(screen.queryByTestId('workflow-local-draft')).not.toBeInTheDocument();
  });

  test('(c) Open restores the unsaved copy in the editor', async () => {
    seedLocal(13, '<p>Typed on this computer</p>', 'ticket.reassigned');
    renderPanel();
    await screen.findByTestId('workflow-list-page');
    fireEvent.click(within(rowFor('Reassignment notice')).getByRole('button', { name: 'Open the unsaved copy of Reassignment notice' }));
    await screen.findByTestId('workflow-back-to-list');
    expect(window.location.search).toBe('?wf=13');
    // Restored, not merely offered: it says so, the offer line is gone and leaving asks first.
    expect(await screen.findByText('Restored your unsaved changes. Save & publish when ready.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('workflow-draft-restore')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId('workflow-back-to-list'));
    expect(await screen.findByRole('alertdialog', { name: 'Leave without saving?' })).toBeInTheDocument();
  });
});

describe('Mail Workflows editor: the unpublished line (QA 11-05b #1d)', () => {
  test('a workflow whose saved draft is not live says so, with Publish and no Compare', async () => {
    window.history.replaceState(null, '', '/workflows?wf=13');
    renderPanel();
    const line = await screen.findByTestId('workflow-unpublished-line');
    expect(line).toHaveTextContent('This workflow has unpublished changes (saved Thu 5 Nov, 3:12 PM by Alex Rivera).');
    expect(within(line).queryByText(/Compare/)).not.toBeInTheDocument();
    fireEvent.click(within(line).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.overrides.publish).toHaveBeenCalledTimes(1));
    expect(api.overrides.publish.mock.calls[0][0]).toBe(13);
    await waitFor(() => expect(screen.queryByTestId('workflow-unpublished-line')).not.toBeInTheDocument());
  });

  test('a never-published draft says so', async () => {
    window.history.replaceState(null, '', '/workflows?wf=14');
    renderPanel();
    expect(await screen.findByTestId('workflow-unpublished-line')).toHaveTextContent('This workflow has never been published (saved Thu 5 Nov, 3:12 PM by Alex Rivera).');
  });

  test('a workflow whose draft is what is live shows no line', async () => {
    window.history.replaceState(null, '', '/workflows?wf=12');
    renderPanel();
    await screen.findByTestId('workflow-back-to-list');
    expect(screen.queryByTestId('workflow-unpublished-line')).not.toBeInTheDocument();
  });
});
