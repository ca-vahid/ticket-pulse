/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// MEGA 09-01 Phase TU (TU-8): the "Ticket updated (fields)" trigger — picker
// entry under Ticket lifecycle right after "Status changed", condition-field
// mirrors, and the trigger-node options (coalesce / FS changes / notify actor).

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco-editor" /> }));
vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({ children }) => <div data-testid="react-flow">{children}</div>,
}));
vi.mock('@tiptap/react', () => ({ EditorContent: () => null, useEditor: () => null }));
vi.mock('@tiptap/starter-kit', () => ({ default: {} }));
vi.mock('react-resizable-panels', () => ({
  Group: ({ children }) => <div>{children}</div>,
  Panel: ({ children }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}));
vi.mock('../../services/api', () => ({ notificationWorkflowAPI: {} }));

const {
  CONDITION_FIELD_OPTIONS,
  FieldsUpdatedTriggerOptions,
  TRIGGER_PICKER_GROUPS,
} = await import('./NotificationWorkflowsPanel.jsx');

describe('trigger picker (TU-8)', () => {
  test('"Ticket updated (fields)" sits under Ticket lifecycle right after Status changed, with the disambiguating hint', () => {
    const lifecycle = TRIGGER_PICKER_GROUPS.find((g) => g.label === 'Ticket lifecycle');
    const values = lifecycle.triggers.map((t) => t.value);
    expect(values.indexOf('ticket.fields_updated')).toBe(values.indexOf('ticket.status_changed') + 1);
    const entry = lifecycle.triggers.find((t) => t.value === 'ticket.fields_updated');
    expect(entry.hint).toMatch(/Status, assignment and notes have their own triggers/);
  });

  test('condition-field options mirror the backend fields_updated catalog', () => {
    const values = CONDITION_FIELD_OPTIONS.map((o) => o.value);
    for (const key of ['event.changedFields', 'event.actorKind', 'event.source', 'event.changedCount', 'event.reopened']) {
      expect(values).toContain(key);
    }
  });
});

describe('FieldsUpdatedTriggerOptions (TU-8)', () => {
  afterEach(cleanup);

  test('renders the defaults: coalesce 3 minutes, FS changes off, notify actor off', () => {
    render(<FieldsUpdatedTriggerOptions data={{}} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/Group edits made within/i)).toHaveValue(3);
    expect(screen.getByRole('checkbox', { name: /Include changes made in FreshService/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Also notify the person who made the change/i })).not.toBeChecked();
  });

  test('edits write the three trigger-node keys (0 = off, clamped to 0…1440)', () => {
    const onChange = vi.fn();
    render(<FieldsUpdatedTriggerOptions data={{ coalesceMinutes: 10, includeFreshserviceChanges: true, notifyActor: false }} onChange={onChange} />);
    expect(screen.getByLabelText(/Group edits made within/i)).toHaveValue(10);
    expect(screen.getByRole('checkbox', { name: /Include changes made in FreshService/i })).toBeChecked();

    fireEvent.change(screen.getByLabelText(/Group edits made within/i), { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith({ coalesceMinutes: 0 });
    fireEvent.change(screen.getByLabelText(/Group edits made within/i), { target: { value: '99999' } });
    expect(onChange).toHaveBeenLastCalledWith({ coalesceMinutes: 1440 });
    fireEvent.click(screen.getByRole('checkbox', { name: /Include changes made in FreshService/i }));
    expect(onChange).toHaveBeenLastCalledWith({ includeFreshserviceChanges: false });
    fireEvent.click(screen.getByRole('checkbox', { name: /Also notify the person who made the change/i }));
    expect(onChange).toHaveBeenLastCalledWith({ notifyActor: true });
  });
});
