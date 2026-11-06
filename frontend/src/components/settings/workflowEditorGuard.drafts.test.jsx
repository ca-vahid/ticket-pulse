/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UnpublishedChangesLine, listStoredWorkflowDrafts, workflowDraftStorageKey } from './workflowEditorGuard';

// QA 11-05b #1c/#1d — the local drafts the list shows, and the editor's quiet
// "unpublished changes" line.

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const def = { version: 1, nodes: [], edges: [], metadata: {} };
const put = (ws, id, savedAt) => window.localStorage.setItem(workflowDraftStorageKey(ws, id), JSON.stringify({ workflowId: id, definition: def, savedAt }));

describe('listStoredWorkflowDrafts', () => {
  test('lists this workspace’s drafts only, newest first, and skips broken records', () => {
    put(5, 12, '2026-11-05T22:00:00.000Z');
    put(5, 13, '2026-11-05T23:00:00.000Z');
    put(4, 99, '2026-11-05T23:30:00.000Z');
    window.localStorage.setItem(`${workflowDraftStorageKey(5, 14)}`, '{not json');
    window.localStorage.setItem('tp_queue_view_ws5', 'x');
    expect(listStoredWorkflowDrafts(5).map((d) => [d.workflowId, d.savedAt])).toEqual([
      ['13', '2026-11-05T23:00:00.000Z'],
      ['12', '2026-11-05T22:00:00.000Z'],
    ]);
  });

  test('blocked storage gives an empty list', () => {
    const spy = vi.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw new Error('blocked'); });
    put(5, 12, '2026-11-05T22:00:00.000Z');
    expect(listStoredWorkflowDrafts(5)).toEqual([]);
    spy.mockRestore();
  });
});

describe('UnpublishedChangesLine', () => {
  test('says when and by whom, in Pacific time, with Publish', () => {
    const onPublish = vi.fn();
    render(<UnpublishedChangesLine savedAt="2026-11-05T23:12:00.000Z" savedBy="Alex Rivera" onPublish={onPublish} />);
    const line = screen.getByTestId('workflow-unpublished-line');
    expect(line).toHaveTextContent('This workflow has unpublished changes (saved Thu 5 Nov, 3:12 PM by Alex Rivera).');
    expect(line).toHaveAttribute('role', 'status');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  test('never published; no time known; Publish hidden while the editor has unsaved edits', () => {
    render(<UnpublishedChangesLine neverPublished savedBy="Alex Rivera" onPublish={null} />);
    expect(screen.getByTestId('workflow-unpublished-line')).toHaveTextContent('This workflow has never been published (saved by Alex Rivera).');
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  test('Publish is turned off, with the reason, when the graph has blocking errors', () => {
    render(<UnpublishedChangesLine savedAt="2026-11-05T23:12:00.000Z" onPublish={() => {}} publishDisabledReason="Connect the stop step" />);
    const button = screen.getByRole('button', { name: 'Publish' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Connect the stop step');
  });
});
