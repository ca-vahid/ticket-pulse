import { jest } from '@jest/globals';

const runToolTurnMock = jest.fn();
const executeNotificationWorkflowToolMock = jest.fn();

jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({
  default: {
    runToolTurn: runToolTurnMock,
  },
}));

jest.unstable_mockModule('../src/services/notificationWorkflowTools.js', () => ({
  SUBMIT_NOTIFICATION_EMAIL_TOOL: {
    name: 'submit_notification_email',
    input_schema: {
      type: 'object',
      required: ['subject', 'html', 'text'],
      properties: {
        subject: { type: 'string' },
        html: { type: 'string' },
        text: { type: 'string' },
        citedSignals: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  notificationWorkflowToolSchemasForPolicy: (policy) => [
    ...(policy.enabledTools || []).map((name) => ({ name, input_schema: { type: 'object', properties: {}, required: [] } })),
    { name: 'submit_notification_email', input_schema: { type: 'object', properties: {}, required: ['subject', 'html', 'text'] } },
  ],
  executeNotificationWorkflowTool: executeNotificationWorkflowToolMock,
}));

const { runNotificationWorkflowLlmPipeline } = await import('../src/services/notificationWorkflowLlmPipelineService.js');

const workflow = { id: 7, workspaceId: 1 };
const node = { id: 'llm-generate', type: 'llm_generate', data: {} };
const basePolicy = {
  mode: 'tools_enabled',
  enabledTools: ['get_notification_context'],
  toolSettings: { safety: { maxToolOutputBytes: 12000 } },
  maxTurns: 4,
  maxToolCalls: 6,
  totalTimeoutMs: 20000,
  perToolTimeoutMs: 3000,
};
const contextBundle = {
  outageSignals: {
    allowedPublicPhrases: [],
  },
  threadSummary: { entries: [] },
  recentSimilarTickets: { windows: [] },
};

function toolTurn(content, stopReason = 'tool_use') {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    message: {
      stop_reason: stopReason,
      content,
    },
  };
}

describe('notification workflow LLM pipeline service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runToolTurnMock.mockReset();
    executeNotificationWorkflowToolMock.mockReset();
    executeNotificationWorkflowToolMock.mockResolvedValue({ evidenceId: 'notification_context', ok: true });
  });

  test('runs an approved read-only tool then accepts submit_notification_email', async () => {
    runToolTurnMock
      .mockResolvedValueOnce(toolTurn([
        { type: 'tool_use', id: 'toolu_ctx', name: 'get_notification_context', input: {} },
      ]))
      .mockResolvedValueOnce(toolTurn([
        {
          type: 'tool_use',
          id: 'toolu_submit',
          name: 'submit_notification_email',
          input: {
            subject: 'Ticket update',
            html: '<p>We are reviewing your request.</p>',
            text: 'We are reviewing your request.',
            citedSignals: ['notification_context'],
          },
        },
      ]));

    const result = await runNotificationWorkflowLlmPipeline({
      workflow,
      node,
      eventContext: { event: { type: 'ticket.created' } },
      state: {},
      policy: basePolicy,
      contextBundle,
      systemPrompt: 'Write an email.',
      userMessage: 'Generate.',
      maxTokens: 1000,
    });

    expect(result.email.subject).toBe('Ticket update');
    expect(result.llm.toolMode).toBe(true);
    expect(result.llm.turns).toBe(2);
    expect(result.llm.toolCalls).toBe(2);
    expect(executeNotificationWorkflowToolMock).toHaveBeenCalledWith(
      'get_notification_context',
      {},
      expect.objectContaining({ workspaceId: 1, policy: basePolicy }),
    );
  });

  test('disabled tools are not executed even if the model asks for them', async () => {
    runToolTurnMock
      .mockResolvedValueOnce(toolTurn([
        { type: 'tool_use', id: 'toolu_search', name: 'search_recent_tickets', input: { query: 'vpn' } },
      ]))
      .mockResolvedValueOnce(toolTurn([
        {
          type: 'tool_use',
          id: 'toolu_submit',
          name: 'submit_notification_email',
          input: {
            subject: 'Ticket update',
            html: '<p>We are checking.</p>',
            text: 'We are checking.',
          },
        },
      ]));

    const result = await runNotificationWorkflowLlmPipeline({
      workflow,
      node,
      eventContext: { event: { type: 'ticket.created' } },
      state: {},
      policy: basePolicy,
      contextBundle,
      systemPrompt: 'Write an email.',
      userMessage: 'Generate.',
      maxTokens: 1000,
    });

    expect(result.email.subject).toBe('Ticket update');
    expect(executeNotificationWorkflowToolMock).not.toHaveBeenCalled();
    const secondTurnMessages = runToolTurnMock.mock.calls[1][0].messages;
    expect(JSON.stringify(secondTurnMessages)).toContain('disabled or unavailable');
  });

  test('enforces max tool call budget', async () => {
    runToolTurnMock.mockResolvedValueOnce(toolTurn([
      { type: 'tool_use', id: 'toolu_1', name: 'get_notification_context', input: {} },
      { type: 'tool_use', id: 'toolu_2', name: 'get_notification_context', input: {} },
    ]));

    await expect(runNotificationWorkflowLlmPipeline({
      workflow,
      node,
      eventContext: { event: { type: 'ticket.created' } },
      state: {},
      policy: { ...basePolicy, maxToolCalls: 1 },
      contextBundle,
      systemPrompt: 'Write an email.',
      userMessage: 'Generate.',
      maxTokens: 1000,
    })).rejects.toThrow('exceeded max tool calls');
  });

  test('rejects unsupported outage claims in final email tool output', async () => {
    runToolTurnMock.mockResolvedValueOnce(toolTurn([
      {
        type: 'tool_use',
        id: 'toolu_submit',
        name: 'submit_notification_email',
        input: {
          subject: 'Confirmed global outage',
          html: '<p>There is a global outage.</p>',
          text: 'There is a global outage.',
        },
      },
    ]));

    await expect(runNotificationWorkflowLlmPipeline({
      workflow,
      node,
      eventContext: { event: { type: 'ticket.created' } },
      state: {},
      policy: basePolicy,
      contextBundle,
      systemPrompt: 'Write an email.',
      userMessage: 'Generate.',
      maxTokens: 1000,
    })).rejects.toThrow('global/company-wide/confirmed outage');
  });
});
