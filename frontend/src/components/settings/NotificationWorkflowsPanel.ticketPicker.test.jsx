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
  LlmDiagnosticsList,
  LlmContextToolsPanel,
  TicketContextPicker,
  buildConditionRule,
  conditionBuilderFromRule,
  describeCondition,
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
