/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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
}));

const {
  AuditModeBadge,
  WorkflowEnableMockConfirmModal,
  LlmDiagnosticsList,
  LlmContextToolsPanel,
  TicketContextPicker,
  buildConditionRule,
  conditionBuilderFromRule,
  describeCondition,
  routingRuleForSave,
  validateWorkflowDefinitionClient,
} = await import('./NotificationWorkflowsPanel.jsx');

const tickets = {
  items: [
    {
      id: 501,
      freshserviceTicketId: '225001',
      subject: 'VPN access problem',
      requester: { name: 'Requester', email: 'requester@example.com' },
      assignedAgent: { name: 'Alex Agent', email: 'alex@example.com' },
      priorityLabel: 'High',
      status: 'Open',
      createdAt: '2026-05-29T18:30:00.000Z',
    },
  ],
  page: 1,
  total: 1,
  totalPages: 1,
};

function renderPicker(overrides = {}) {
  const props = {
    tickets,
    ticketsLoading: false,
    ticketSearch: '',
    ticketPage: 1,
    ticketPriority: 'all',
    ticketStatus: 'all',
    selectedTicket: null,
    onTicketSearchChange: vi.fn(),
    onTicketPriorityChange: vi.fn(),
    onTicketStatusChange: vi.fn(),
    onTicketPageChange: vi.fn(),
    onSelectTicket: vi.fn(),
    onRun: vi.fn(),
    ...overrides,
  };
  render(<TicketContextPicker {...props} />);
  return props;
}

describe('TicketContextPicker', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders FreshService ticket results and search controls', () => {
    renderPicker({ ticketSearch: '225001' });

    expect(screen.getByPlaceholderText('Search by FreshService #, subject, requester, assignee, or category')).toBeInTheDocument();
    expect(screen.getByText('#225001 VPN access problem')).toBeInTheDocument();
    expect(screen.getByText(/Requester/)).toBeInTheDocument();
    expect(screen.getByText(/Assigned: Alex Agent/)).toBeInTheDocument();
  });

  test('selects a ticket and sends search/filter changes to the parent', () => {
    const props = renderPicker();

    fireEvent.change(screen.getByPlaceholderText('Search by FreshService #, subject, requester, assignee, or category'), {
      target: { value: '225001' },
    });
    expect(props.onTicketSearchChange).toHaveBeenCalledWith('225001');

    fireEvent.click(screen.getByText('#225001 VPN access problem'));
    expect(props.onSelectTicket).toHaveBeenCalledWith(tickets.items[0]);
  });

  test('enables the run button only after a ticket is selected', () => {
    const { rerender } = render(<TicketContextPicker
      tickets={tickets}
      ticketsLoading={false}
      ticketSearch=""
      ticketPage={1}
      ticketPriority="all"
      ticketStatus="all"
      selectedTicket={null}
      onTicketSearchChange={vi.fn()}
      onTicketPriorityChange={vi.fn()}
      onTicketStatusChange={vi.fn()}
      onTicketPageChange={vi.fn()}
      onSelectTicket={vi.fn()}
      onRun={vi.fn()}
    />);

    expect(screen.getByRole('button', { name: /Run with selected ticket/i })).toBeDisabled();

    rerender(<TicketContextPicker
      tickets={tickets}
      ticketsLoading={false}
      ticketSearch=""
      ticketPage={1}
      ticketPriority="all"
      ticketStatus="all"
      selectedTicket={tickets.items[0]}
      onTicketSearchChange={vi.fn()}
      onTicketPriorityChange={vi.fn()}
      onTicketStatusChange={vi.fn()}
      onTicketPageChange={vi.fn()}
      onSelectTicket={vi.fn()}
      onRun={vi.fn()}
    />);

    expect(screen.getByRole('button', { name: /Run with selected ticket/i })).not.toBeDisabled();
  });
});

function renderLlmContextPanel(overrides = {}) {
  const props = {
    policy: { mode: 'context_only', enabledTools: [], toolSettings: {} },
    draft: {
      mode: 'context_only',
      enabledTools: [],
      toolSettings: {
        context: {},
        outageSignals: {},
        safety: {},
      },
      maxTurns: 4,
      maxToolCalls: 6,
      totalTimeoutMs: 20000,
      perToolTimeoutMs: 3000,
      redactionEnabled: true,
      includePrivateNotes: false,
    },
    catalog: [],
    saving: false,
    message: null,
    tickets,
    ticketsLoading: false,
    ticketSearch: '',
    ticketPage: 1,
    ticketPriority: 'all',
    ticketStatus: 'all',
    selectedTicket: null,
    preview: null,
    previewLoading: false,
    testRun: null,
    testLoading: false,
    onChange: vi.fn(),
    onSettingChange: vi.fn(),
    onToggleTool: vi.fn(),
    onSave: vi.fn(),
    onPreview: vi.fn(),
    onTestRun: vi.fn(),
    onTicketSearchChange: vi.fn(),
    onTicketPriorityChange: vi.fn(),
    onTicketStatusChange: vi.fn(),
    onTicketPageChange: vi.fn(),
    onSelectTicket: vi.fn(),
    ...overrides,
  };
  const utils = render(<LlmContextToolsPanel {...props} />);
  return { props, ...utils };
}

describe('LlmContextToolsPanel ticket picker', () => {
  afterEach(() => {
    cleanup();
  });

  test('previews context from a manually entered FreshService ticket number', () => {
    const { props } = renderLlmContextPanel({ ticketSearch: '225001' });

    fireEvent.click(screen.getByRole('button', { name: /Preview context/i }));
    expect(props.onPreview).toHaveBeenCalled();
    expect(screen.getByText(/Preview will resolve FreshService ticket #225001 directly/)).toBeInTheDocument();
  });

  test('selects a ticket and enables the full tool test', () => {
    const { props, rerender } = renderLlmContextPanel({
      draft: {
        mode: 'tools_enabled',
        enabledTools: [],
        toolSettings: { context: {}, outageSignals: {}, safety: {} },
      },
    });

    expect(screen.getByRole('button', { name: /Run tool test/i })).toBeDisabled();
    fireEvent.click(screen.getByText('#225001 VPN access problem'));
    expect(props.onSelectTicket).toHaveBeenCalledWith(tickets.items[0]);

    rerender(<LlmContextToolsPanel
      {...props}
      selectedTicket={tickets.items[0]}
      draft={{
        mode: 'tools_enabled',
        enabledTools: [],
        toolSettings: { context: {}, outageSignals: {}, safety: {} },
      }}
    />);

    fireEvent.click(screen.getByRole('button', { name: /Run tool test/i }));
    expect(props.onTestRun).toHaveBeenCalled();
  });
});

describe('condition rule helpers', () => {
  test('builds JSONLogic for visual condition fields', () => {
    expect(buildConditionRule({ field: 'ticket.status', operator: 'equals', value: 'Open' })).toEqual({
      '==': [{ var: 'ticket.status' }, 'Open'],
    });
    expect(buildConditionRule({ field: 'availability.isAfterHours', operator: 'is_true', value: '' })).toEqual({
      '==': [{ var: 'availability.isAfterHours' }, true],
    });
  });

  test('round-trips a simple JSONLogic condition to visual copy', () => {
    const builder = conditionBuilderFromRule({ '!=': [{ var: 'requester.department' }, 'Finance'] });

    expect(builder).toEqual({
      field: 'requester.department',
      operator: 'not_equals',
      value: 'Finance',
    });
    expect(describeCondition(builder)).toBe('Requester FS department/location does not equal "Finance"');
  });
});

describe('workflow graph helpers', () => {
  afterEach(() => {
    cleanup();
  });

  test('blocks unsafe condition graphs before publish', () => {
    const definition = {
      version: 1,
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'condition', type: 'condition', data: { rule: true } },
        { id: 'recipients', type: 'recipient_resolver', data: {} },
        { id: 'template', type: 'template_render', data: {} },
        { id: 'send', type: 'send_email', data: {} },
      ],
      edges: [
        { id: 'trigger-to-condition', source: 'trigger', target: 'condition' },
        { id: 'condition-true-to-recipients', source: 'condition', sourceHandle: 'true', target: 'recipients' },
        { id: 'recipients-to-template', source: 'recipients', target: 'template' },
        { id: 'template-to-send', source: 'template', target: 'send' },
      ],
      metadata: {},
    };

    expect(validateWorkflowDefinitionClient(definition, 'ticket.created')).toEqual(expect.arrayContaining([
      'Condition node condition must define a false branch',
    ]));
  });

  test('renders diagnostics for multiple LLM nodes', () => {
    render(<LlmDiagnosticsList diagnostics={[
      {
        nodeId: 'classify-llm',
        outputKey: 'classification',
        status: 'completed',
        llm: {
          provider: 'openai',
          model: 'gpt-test',
          outputMode: 'classify',
          promotedToEmail: false,
          email: { subject: 'Classified', html: '<p>Classified</p>', text: 'Classified' },
        },
      },
      {
        nodeId: 'draft-llm',
        outputKey: 'draft',
        status: 'completed',
        llm: {
          provider: 'anthropic',
          model: 'claude-test',
          outputMode: 'draft_email',
          promotedToEmail: true,
          guard: { accepted: true, issues: [] },
          email: { subject: 'Drafted', html: '<p>Drafted</p>', text: 'Drafted' },
        },
      },
    ]}
    />);

    expect(screen.getByText('classify-llm')).toBeInTheDocument();
    expect(screen.getByText('draft-llm')).toBeInTheDocument();
    expect(screen.getByText('classify')).toBeInTheDocument();
    expect(screen.getByText('draft_email')).toBeInTheDocument();
    expect(screen.getByText(/Guardrail passed/i)).toBeInTheDocument();
  });
});

// QA 08-06 #6 — the workflow routing trap: what the Routing tab sends on save.
describe('routingRuleForSave (QA 08-06 #6)', () => {
  const EMPTY_BUILDER = { field: 'requester.regionKey', operator: 'equals', value: '' };

  test('rule-less workflow + untouched builder saves NULL (no demo rule attached)', () => {
    const workflow = { id: 42, isDefaultVariant: false, routingRule: null };
    expect(routingRuleForSave({ workflow, builder: EMPTY_BUILDER, dirty: false })).toBeNull();
  });

  test('rule-less workflow + touched builder saves the built rule', () => {
    const workflow = { id: 42, isDefaultVariant: false, routingRule: null };
    const builder = { field: 'requester.regionKey', operator: 'equals', value: 'AU-BRISBANE' };
    expect(routingRuleForSave({ workflow, builder, dirty: true }))
      .toEqual({ '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] });
  });

  test('a stored rule round-trips unchanged through the builder', () => {
    const stored = { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] };
    const workflow = { id: 42, isDefaultVariant: false, routingRule: stored };
    const builder = conditionBuilderFromRule(stored);
    expect(routingRuleForSave({ workflow, builder, dirty: false })).toEqual(stored);
  });

  test('default variants never carry a rule', () => {
    const workflow = { id: 7, isDefaultVariant: true, routingRule: null };
    const builder = { field: 'requester.regionKey', operator: 'equals', value: 'AU-BRISBANE' };
    expect(routingRuleForSave({ workflow, builder, dirty: true })).toBeNull();
  });
});

// QA 08-06 (Susan, ws5) — enabling a workflow whose mock mode is on must ask
// whether to also turn mock off, since observe-only means NO real actions.
describe('WorkflowEnableMockConfirmModal (QA 08-06 mock-mode visibility)', () => {
  const mockWorkflow = { id: 11393, name: 'Intake field card', triggerType: 'ticket.created', mockModeEnabled: true };

  function renderModal(overrides = {}) {
    const props = {
      workflow: mockWorkflow,
      saving: false,
      onCancel: vi.fn(),
      onEnableLive: vi.fn(),
      onKeepObserveOnly: vi.fn(),
      ...overrides,
    };
    render(<WorkflowEnableMockConfirmModal {...props} />);
    return props;
  }

  afterEach(() => cleanup());

  test('explains observe-only mode and offers both choices', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Observe-only (mock) mode is on')).toBeInTheDocument();
    expect(screen.getByText(/no real actions/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enable \+ turn off mock/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Keep observe-only/ })).toBeInTheDocument();
  });

  test('"Enable + turn off mock" fires onEnableLive only', () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Enable \+ turn off mock/ }));
    expect(props.onEnableLive).toHaveBeenCalledTimes(1);
    expect(props.onKeepObserveOnly).not.toHaveBeenCalled();
  });

  test('"Keep observe-only" fires onKeepObserveOnly only', () => {
    const props = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Keep observe-only/ }));
    expect(props.onKeepObserveOnly).toHaveBeenCalledTimes(1);
    expect(props.onEnableLive).not.toHaveBeenCalled();
  });

  test('Cancel closes without enabling anything; hidden without a workflow', () => {
    const props = renderModal();
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[1]);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onEnableLive).not.toHaveBeenCalled();
    expect(props.onKeepObserveOnly).not.toHaveBeenCalled();
    cleanup();
    render(<WorkflowEnableMockConfirmModal workflow={null} saving={false} onCancel={vi.fn()} onEnableLive={vi.fn()} onKeepObserveOnly={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// Run-log rows label mock runs — pin the badge so it cannot silently regress.
describe('AuditModeBadge (mock runs are visibly labeled)', () => {
  afterEach(() => cleanup());

  test('mock execution mode renders the sky "Mock" badge', () => {
    render(<AuditModeBadge mode="mock" compact />);
    const badge = screen.getByText('Mock');
    expect(badge.closest('span')).toHaveClass('bg-sky-50');
  });

  test('live execution mode renders "Live"', () => {
    render(<AuditModeBadge mode="live" compact />);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });
});
