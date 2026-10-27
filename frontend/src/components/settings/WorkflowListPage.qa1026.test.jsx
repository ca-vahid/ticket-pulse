/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// QA 10-26 #1: the row "⋯" only shows where its menu holds something real.
// The seeded "Reopen on requester reply" default had a menu with only
// "New variant", and a variant of it has nothing to add (Ticket Ops → When a
// requester replies owns what a reply does).
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

import WorkflowListPage from './WorkflowListPage';
import { canAddVariant, rowMenuItems, rowMenuPosition } from './WorkflowIndex';

afterEach(cleanup);

const REOPEN = { id: 11, name: 'Reopen on requester reply', triggerType: 'ticket.reply_received', isDefaultVariant: true, isEnabled: true, publishedVersion: 2, runs: [] };
const CLOSED = { id: 12, name: 'Ticket resolved or closed', triggerType: 'ticket.resolved_closed', isDefaultVariant: true, isEnabled: true, publishedVersion: 3, runs: [] };
const ROUTED = { id: 13, name: 'Closed for the lab', triggerType: 'ticket.resolved_closed', routingRule: { field: 'x' }, isEnabled: false, publishedVersion: 1, runs: [] };
const ARCHIVED = { id: 14, name: 'Old variant', triggerType: 'ticket.resolved_closed', archivedAt: new Date().toISOString(), isEnabled: false, publishedVersion: 1, runs: [] };
const LABELS = { 'ticket.reply_received': 'Requester replied', 'ticket.resolved_closed': 'Resolved or closed' };

const keys = (wf) => rowMenuItems(wf).map((i) => i.key);
const rowFor = (name) => screen.getAllByTestId('workflow-list-row').find((row) => within(row).getByRole('link').textContent.startsWith(name));

describe('workflow row menu (QA 10-26 #1)', () => {
  test('New variant is offered only where a variant can apply', () => {
    expect(canAddVariant(REOPEN)).toBe(false);
    expect(canAddVariant(CLOSED)).toBe(true);
    expect(canAddVariant(ROUTED)).toBe(true);
    expect(canAddVariant(ARCHIVED)).toBe(false);
    // A non-default workflow on the reply trigger is someone's own automation: it can still be copied.
    expect(canAddVariant({ ...ROUTED, triggerType: 'ticket.reply_received' })).toBe(true);
    expect(keys(REOPEN)).toEqual([]);
    expect(keys(CLOSED)).toEqual(['variant']);
    expect(keys(ROUTED)).toEqual(['variant', 'archive']);
    expect(keys(ARCHIVED)).toEqual(['restore', 'delete']);
    // An archived default (retired by Ticket Ops) can still be restored.
    expect(keys({ ...REOPEN, archivedAt: new Date().toISOString() })).toEqual(['restore']);
  });

  test('the reopen default has no ⋯ button; other rows keep theirs', () => {
    const onRowAction = vi.fn();
    render(<WorkflowListPage workflows={[REOPEN, CLOSED, ROUTED]} onOpen={vi.fn()} onRowAction={onRowAction} eventLabels={LABELS} getVisuals={() => ({})} />);
    expect(within(rowFor('Reopen on requester reply')).queryByRole('button', { name: /More actions/ })).toBeNull();
    fireEvent.click(within(rowFor('Ticket resolved or closed')).getByRole('button', { name: 'More actions for Ticket resolved or closed' }));
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['New variant…']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'New variant…' }));
    expect(onRowAction).toHaveBeenCalledWith(CLOSED, 'variant');
  });
});

describe('workflow row menu is never clipped (QA 10-27 #3)', () => {
  test('the menu renders outside the trigger card, at fixed coordinates', () => {
    render(<WorkflowListPage workflows={[CLOSED, ROUTED]} onOpen={vi.fn()} onRowAction={vi.fn()} eventLabels={LABELS} getVisuals={() => ({})} />);
    const row = rowFor('Closed for the lab');
    fireEvent.click(within(row).getByRole('button', { name: 'More actions for Closed for the lab' }));
    const menu = screen.getByRole('menu', { name: 'Actions for Closed for the lab' });
    // Portalled: not inside the card (whose overflow-hidden used to cut it off).
    expect(screen.getAllByTestId('workflow-list-group').some((card) => card.contains(menu))).toBe(false);
    expect(menu.className).toContain('fixed');
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['New variant…', 'Archive']);
  });

  test('the ⋯ toggles the menu closed again; Escape closes it', () => {
    render(<WorkflowListPage workflows={[ROUTED]} onOpen={vi.fn()} onRowAction={vi.fn()} eventLabels={LABELS} getVisuals={() => ({})} />);
    const button = screen.getByRole('button', { name: 'More actions for Closed for the lab' });
    fireEvent.mouseDown(button); fireEvent.click(button);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(button); fireEvent.click(button);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('position flips above the button near the bottom and stays inside the right edge', () => {
    const viewport = { width: 1000, height: 800 };
    expect(rowMenuPosition({ top: 100, bottom: 120, right: 600 }, 2, viewport)).toEqual({ left: 424, top: 122 });
    expect(rowMenuPosition({ top: 760, bottom: 780, right: 600 }, 2, viewport)).toEqual({ left: 424, bottom: 42 });
    expect(rowMenuPosition({ top: 100, bottom: 120, right: 1200 }, 2, viewport).left).toBe(1000 - 176 - 8);
    expect(rowMenuPosition({ top: 100, bottom: 120, right: 50 }, 2, viewport).left).toBe(8);
  });
});
