/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco-editor" />,
}));

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({ children }) => <div data-testid="react-flow">{children}</div>,
}));

vi.mock('@tiptap/react', () => ({
  EditorContent: () => null,
  useEditor: () => null,
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: {},
}));

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }) => <div>{children}</div>,
  Panel: ({ children }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
  }),
}));

vi.mock('../../services/api', () => ({
  notificationWorkflowAPI: {},
  ticketsAPI: {},
}));

const { AddNoteNodeEditor, validateWorkflowDefinitionClient } = await import('./NotificationWorkflowsPanel.jsx');

const DEFS = [
  { key: 'client_name', label: 'Client name', type: 'text', options: [] },
  { key: 'expedite', label: 'Expedite', type: 'boolean', options: [] },
  { key: 'record_link', label: 'Record link', type: 'text', options: [] },
];

const BASE_DATA = {
  label: 'Add note',
  mode: 'field_card',
  title: 'Ticket details',
  intro: '',
  body: '',
  fields: [],
  accent: 'violet',
  placement: 'note',
};

function renderEditor(overrides = {}) {
  const props = {
    data: { ...BASE_DATA, ...(overrides.data || {}) },
    defs: overrides.defs ?? DEFS,
    variables: overrides.variables ?? [],
    workflowName: 'API intake router',
    onChange: vi.fn(),
  };
  render(<AddNoteNodeEditor {...props} />);
  return props;
}

describe('AddNoteNodeEditor', () => {
  afterEach(() => cleanup());

  test('mode toggle switches between rich text and field card', () => {
    const props = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Rich text' }));
    expect(props.onChange).toHaveBeenCalledWith({ mode: 'text' });
  });

  test('rich text mode shows the Liquid body editor with a hint', () => {
    renderEditor({ data: { mode: 'text', body: '<p>{{ ticket.subject }}</p>' } });
    expect(screen.getByLabelText(/Note body \(Liquid HTML\)/)).toHaveValue('<p>{{ ticket.subject }}</p>');
    expect(screen.getByText(/sanitized server-side/)).toBeInTheDocument();
    // Field-card-only controls are hidden in text mode.
    expect(screen.queryByText('Fields on the card', { exact: false })).not.toBeInTheDocument();
  });

  test('field multi-select is fed by the custom-field defs and toggles keys', () => {
    const props = renderEditor();
    fireEvent.click(screen.getByRole('checkbox', { name: /Client name/ }));
    expect(props.onChange).toHaveBeenCalledWith({ fields: ['client_name'] });
  });

  test('deselecting a chosen field removes only that key', () => {
    const props = renderEditor({ data: { fields: ['client_name', 'expedite'] } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Client name/ }));
    expect(props.onChange).toHaveBeenCalledWith({ fields: ['expedite'] });
  });

  test('placement select offers note / pinned / both', () => {
    const props = renderEditor();
    fireEvent.change(screen.getByLabelText(/Placement/), { target: { value: 'pinned' } });
    expect(props.onChange).toHaveBeenCalledWith({ placement: 'pinned' });
    expect(screen.getByRole('option', { name: 'Note in conversation' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Both' })).toBeInTheDocument();
  });

  test('pinning is field_card-only: Rich text disables pinned/both with a hint', () => {
    renderEditor({ data: { mode: 'text' } });
    expect(screen.getByRole('option', { name: 'Pinned card above the conversation' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Both' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Note in conversation' })).not.toBeDisabled();
    expect(screen.getByText('Pinned cards require Field card mode.')).toBeInTheDocument();
  });

  test('switching to Rich text coerces a pinned placement back to note', () => {
    const props = renderEditor({ data: { placement: 'pinned' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rich text' }));
    expect(props.onChange).toHaveBeenCalledWith({ mode: 'text', placement: 'note' });
  });

  test('accent picker exposes the five tp tones', () => {
    const props = renderEditor();
    const group = screen.getByRole('group', { name: 'Card accent' });
    expect(within(group).getAllByRole('button')).toHaveLength(5);
    fireEvent.click(within(group).getByRole('button', { name: 'emerald accent' }));
    expect(props.onChange).toHaveBeenCalledWith({ accent: 'emerald' });
  });

  test('live preview renders the real FieldCardNote with sample values', () => {
    renderEditor({ data: { fields: ['client_name', 'expedite'], title: 'Intake details' } });
    const preview = screen.getByTestId('field-card-note');
    expect(within(preview).getByText('Intake details')).toBeInTheDocument();
    expect(within(preview).getByText('via API intake router · Auto')).toBeInTheDocument();
    expect(within(preview).getByText('Client name')).toBeInTheDocument();
    expect(within(preview).getByText('Sample value')).toBeInTheDocument();
    expect(within(preview).getByText('Yes')).toBeInTheDocument();
  });

  test('empty defs point the admin at Settings → Ticket Ops', () => {
    renderEditor({ defs: [] });
    expect(screen.getByText(/No custom fields defined yet/)).toBeInTheDocument();
  });
});

describe('workflow validation with add_note', () => {
  test('add_note qualifies as an action node', () => {
    const definition = {
      version: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'add-note', type: 'add_note', data: { mode: 'field_card', fields: ['client_name'] } },
        { id: 'stop', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'trigger-to-add-note', source: 'trigger', target: 'add-note' },
        { id: 'add-note-to-stop', source: 'add-note', target: 'stop' },
      ],
      metadata: {},
    };
    expect(validateWorkflowDefinitionClient(definition, 'ticket.created')).toEqual([]);
  });

  test('a workflow with no action node still fails', () => {
    const definition = {
      version: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'stop', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'trigger-to-stop', source: 'trigger', target: 'stop' },
      ],
      metadata: {},
    };
    expect(validateWorkflowDefinitionClient(definition, 'ticket.created')).toEqual(expect.arrayContaining([
      expect.stringContaining('must include at least one action node'),
    ]));
  });
});

describe('unknown node types (frontend/backend version skew)', () => {
  const definition = {
    version: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
      { id: 'mystery', type: 'quantum_note', data: {} },
      { id: 'stop', type: 'stop', data: {} },
    ],
    edges: [
      { id: 'trigger-to-mystery', source: 'trigger', target: 'mystery' },
      { id: 'mystery-to-stop', source: 'mystery', target: 'stop' },
    ],
    metadata: {},
  };

  test('publish stays blocked, but the message guides a hard refresh instead of a bare error', () => {
    const errors = validateWorkflowDefinitionClient(definition, 'ticket.created');
    expect(errors.length).toBeGreaterThan(0); // still blocking
    const message = errors.find((error) => error.includes("('quantum_note')"));
    expect(message).toBeDefined();
    expect(message).toContain("this app version doesn't recognize");
    expect(message).toContain('hard-refresh (Ctrl+Shift+R)');
    expect(message).toContain('contact support');
    // The old unhelpful wording must be gone.
    expect(errors.some((error) => error.startsWith('Unsupported node type'))).toBe(false);
  });
});
