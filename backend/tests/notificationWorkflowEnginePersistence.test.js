import { jest } from '@jest/globals';

const prismaMock = {
  notificationWorkflowRun: {
    create: jest.fn(),
    update: jest.fn(),
  },
  notificationWorkflowStepRun: {
    create: jest.fn(),
    update: jest.fn(),
  },
  notificationDelivery: {
    create: jest.fn(),
  },
  notificationLlmToolPolicy: {
    findUnique: jest.fn(),
  },
  ticket: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  ticketThreadEntry: {
    findMany: jest.fn(),
  },
  notificationEmailSignature: {
    findUnique: jest.fn(),
  },
};

const processDeliveryMock = jest.fn();
const providerSendJsonMock = jest.fn();
const providerRunToolTurnMock = jest.fn();
const publicStatusUrl = 'https://ticketpulse.example/ticket-status/sample-token';
const raiseUrgencyUrl = 'https://ticketpulse.example/ticket-urgency/sample-token';
const immediateSupportUrl = 'https://ticketpulse.example/ticket-escalation/sample-token';

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: processDeliveryMock,
}));

jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({
  default: {
    sendJson: providerSendJsonMock,
    runToolTurn: providerRunToolTurnMock,
  },
}));

jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => ({
  enrichEventContextWithPublicStatusUrl: jest.fn(async (context) => ({
    ...context,
    publicStatusUrl,
    raiseUrgencyUrl,
    selfEscalationUrl: immediateSupportUrl,
    afterHoursEscalationUrl: immediateSupportUrl,
    ticket: {
      ...(context.ticket || {}),
      publicStatusUrl,
      raiseUrgencyUrl,
      urgencyRaiseUrl: raiseUrgencyUrl,
      selfEscalationUrl: immediateSupportUrl,
      afterHoursEscalationUrl: immediateSupportUrl,
    },
    afterHoursSupport: {
      ...(context.afterHoursSupport || {}),
      selfEscalationUrl: immediateSupportUrl,
      immediateSupportUrl,
      activeContact: {
        name: 'Alex Agent',
        phone: '+16045551234',
        rotationLabel: 'Manual after-hours contact',
        source: 'manual',
      },
    },
  })),
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { executeDefinition, executeWorkflow } = await import('../src/services/notificationWorkflowEngine.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');

const workflow = {
  id: 7,
  workspaceId: 1,
  triggerType: 'ticket.created',
  publishedVersion: 1,
  versions: [{ id: 70, version: 1 }],
};

const eventContext = {
  event: {
    type: 'ticket.created',
    source: 'test',
    occurredAt: '2026-05-29T19:00:00.000Z',
    dedupeStamp: '2026-05-29T19:00:00.000Z',
  },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: {
    id: 501,
    freshserviceTicketId: 225001,
    subject: 'VPN access problem',
    status: 'Open',
    priorityLabel: 'High',
    isNoise: false,
  },
  requester: { name: 'Requester', email: 'requester@example.com' },
  assignedAgent: null,
  previousAgent: null,
};

describe('notification workflow engine persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    providerSendJsonMock.mockReset();
    providerRunToolTurnMock.mockReset();
    prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({
      id: 900,
      ...data,
    }));
    prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
    prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({
      id: Math.floor(Math.random() * 10000) + 1,
      ...data,
    }));
    prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
    prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({
      id: 1234,
      ...data,
    }));
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
    prismaMock.ticket.findFirst.mockResolvedValue({
      id: 501,
      workspaceId: 1,
      freshserviceTicketId: BigInt(225001),
      subject: 'VPN access problem',
      descriptionText: 'User cannot connect to VPN from home.',
      status: 'Open',
      priority: 3,
      assessedPriority: 'High',
      toEmails: ['helpdesk@example.com'],
      ccEmails: ['manager@example.com'],
      replyCcEmails: [],
      fwdEmails: [],
      category: 'Access',
      subCategory: 'VPN',
      ticketCategory: 'IT',
      tpSkill: 'Network',
      tpSubskill: 'VPN',
      isNoise: false,
      createdAt: new Date('2026-05-29T18:30:00.000Z'),
      assignedAt: null,
      resolvedAt: null,
      closedAt: null,
      freshserviceUpdatedAt: new Date('2026-05-29T19:00:00.000Z'),
      workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' },
      requester: { id: 40, name: 'Requester', email: 'requester@example.com', department: 'Operations', jobTitle: 'Lead' },
      assignedTech: null,
      internalCategory: { id: 5, name: 'Network' },
      internalSubcategory: { id: 6, name: 'VPN' },
    });
    prismaMock.ticket.findMany.mockResolvedValue([]);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
    processDeliveryMock.mockResolvedValue({ success: true, result: { provider: 'sendgrid' } });
  });

  test('creates a workflow run, step audit rows, and an email delivery', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: false,
      triggerSource: 'test',
    });

    expect(result.status).toBe('completed');
    expect(prismaMock.notificationWorkflowRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workflowId: 7,
        workflowVersionId: 70,
        ticketId: 501,
        eventType: 'ticket.created',
        dryRun: false,
        executionMode: 'live',
      }),
    }));
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: 1,
        ticketId: 501,
        workflowRunId: 900,
        channel: 'email',
        toRecipients: ['requester@example.com'],
        eventType: 'ticket.created',
      }),
    }));
    expect(processDeliveryMock).toHaveBeenCalled();
  });

  test('preview execution records preview run state without creating delivery rows', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: true,
      triggerSource: 'preview',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'completed',
      executionMode: 'preview',
    }));
    expect(prismaMock.notificationWorkflowRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        dryRun: true,
        executionMode: 'preview',
      }),
    }));
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
    expect(processDeliveryMock).not.toHaveBeenCalled();
  });

  test('mock execution creates a mocked delivery and does not process provider delivery', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: true,
      executionMode: 'mock',
      triggerSource: 'freshservice_poll',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'completed',
      executionMode: 'mock',
    }));
    const runData = prismaMock.notificationWorkflowRun.create.mock.calls[0][0].data;
    expect(runData).toEqual(expect.objectContaining({
      dryRun: true,
      executionMode: 'mock',
      dedupeKey: 'notification-workflow-mock:7:1:ticket.created:501:2026-05-29T19:00:00.000Z',
    }));
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'mocked',
        toRecipients: ['requester@example.com'],
        payload: expect.objectContaining({
          mockMode: true,
          wouldSend: true,
          workflowId: 7,
          workflowVersion: 1,
        }),
      }),
    }));
    expect(processDeliveryMock).not.toHaveBeenCalled();
    const sendStep = result.steps.find((step) => step.nodeType === 'send_email');
    expect(sendStep.output).toEqual(expect.objectContaining({
      mocked: true,
      skipped: true,
      reason: 'Mock mode - email not sent',
    }));
  });

  test('mock workflow execution runs the configured LLM but suppresses email send', async () => {
    providerSendJsonMock.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-test',
      parsed: {
        subject: 'Mock LLM ticket update',
        html: '<p>Mock-generated body.</p>',
        text: 'Mock-generated body.',
      },
      usage: {
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
      },
      metadata: {
        stopReason: 'complete',
      },
    });

    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.push({
      id: 'llm-generate',
      type: 'llm_generate',
      position: { x: 700, y: 120 },
      data: {
        prompt: 'Generate email content for {{ ticket.subject }}',
      },
    });
    const templateNode = definition.nodes.find((node) => node.type === 'template_render');
    templateNode.data.contentSource = 'llm_with_template_fallback';
    definition.edges = definition.edges.map((edge) => (
      edge.id === 'recipients-to-template'
        ? { ...edge, id: 'recipients-to-llm', target: 'llm-generate' }
        : edge
    ));
    definition.edges.push({ id: 'llm-to-template', source: 'llm-generate', target: 'template' });

    const result = await executeWorkflow({
      ...workflow,
      mockModeEnabled: true,
      publishedDefinition: definition,
    }, eventContext, { triggerSource: 'freshservice_poll' });

    expect(result.executionMode).toBe('mock');
    expect(providerSendJsonMock).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'notification_workflow_generation',
      runLinks: { notificationWorkflowRunId: 900 },
    }));
    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(deliveryData.status).toBe('mocked');
    expect(deliveryData.subject).toBe('Mock LLM ticket update');
    expect(deliveryData.htmlBody).toContain('Mock-generated body');
    expect(processDeliveryMock).not.toHaveBeenCalled();
  });

  test('skips duplicate workflow events through the run dedupe key', async () => {
    prismaMock.notificationWorkflowRun.create.mockRejectedValueOnce({ code: 'P2002' });
    const result = await executeDefinition({
      workflow,
      definition: buildDefaultWorkflowDefinition('ticket.created'),
      eventContext,
      dryRun: false,
      triggerSource: 'test',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'skipped',
      reason: 'Duplicate workflow event',
    }));
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
  });

  test('appends the public status link before the workspace signature', async () => {
    prismaMock.notificationEmailSignature.findUnique.mockResolvedValueOnce({
      enabled: true,
      html: '<p>Workspace Signature</p>',
      text: 'Workspace Signature',
      updatedAt: new Date('2026-05-29T20:00:00.000Z'),
      updatedBy: 'admin@example.com',
    });
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const sendNode = definition.nodes.find((node) => node.type === 'send_email');
    sendNode.data.appendPublicStatusLink = true;

    await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: false,
      triggerSource: 'test',
    });

    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(deliveryData.htmlBody).toContain(publicStatusUrl);
    expect(deliveryData.textBody).toContain(publicStatusUrl);
    expect(deliveryData.htmlBody.indexOf('View ticket status and estimate')).toBeLessThan(
      deliveryData.htmlBody.indexOf('Workspace Signature'),
    );
    expect(deliveryData.textBody.indexOf('Check the latest ticket status')).toBeLessThan(
      deliveryData.textBody.indexOf('Workspace Signature'),
    );
  });

  test('live action blocks render only timing-appropriate links', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const sendNode = definition.nodes.find((node) => node.type === 'send_email');
    sendNode.data.appendPublicStatusLink = true;
    sendNode.data.appendRaiseUrgencyLink = true;
    sendNode.data.appendAfterHoursSupportLink = true;

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext: {
        ...eventContext,
        availability: { isBusinessHours: true, isAfterHours: false, isHoliday: false },
      },
      dryRun: true,
      triggerSource: 'test',
    });

    expect(result.state.email.actionLinks.publicStatus.applied).toBe(true);
    expect(result.state.email.actionLinks.raiseUrgency.applied).toBe(true);
    expect(result.state.email.actionLinks.afterHoursSupport.skipped).toBe(true);
    expect(result.state.email.actionLinks.afterHoursSupport.reason).toContain('hidden during business hours');
    expect(result.state.email.html).toContain('Helpful ticket links');
    expect(result.state.email.html).toContain('Open status page');
    expect(result.state.email.html).toContain('Raise urgency');
    expect(result.state.email.html).toContain(publicStatusUrl);
    expect(result.state.email.html).toContain(raiseUrgencyUrl);
    expect(result.state.email.html).not.toContain(immediateSupportUrl);
  });

  test('forced preview renders checked timing-gated action blocks with diagnostics', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const sendNode = definition.nodes.find((node) => node.type === 'send_email');
    sendNode.data.appendPublicStatusLink = true;
    sendNode.data.appendRaiseUrgencyLink = true;
    sendNode.data.appendAfterHoursSupportLink = true;

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext: {
        ...eventContext,
        availability: { isBusinessHours: true, isAfterHours: false, isHoliday: false },
      },
      dryRun: true,
      triggerSource: 'test',
      forceActionLinks: true,
    });

    expect(result.state.email.actionLinks.afterHoursSupport.applied).toBe(true);
    expect(result.state.email.actionLinks.afterHoursSupport.forced).toBe(true);
    expect(result.state.email.html).toContain('Helpful ticket links');
    expect(result.state.email.html).toContain('Need immediate after-hours support?');
    expect(result.state.email.html).toContain(immediateSupportUrl);
    expect(result.state.email.html).toContain('+16045551234');
  });

  test('after-hours live action blocks prefer immediate support and skip business urgency', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const sendNode = definition.nodes.find((node) => node.type === 'send_email');
    sendNode.data.appendPublicStatusLink = true;
    sendNode.data.appendRaiseUrgencyLink = true;
    sendNode.data.appendAfterHoursSupportLink = true;

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext: {
        ...eventContext,
        availability: { isBusinessHours: false, isAfterHours: true, isHoliday: false },
      },
      dryRun: true,
      triggerSource: 'test',
    });

    expect(result.state.email.actionLinks.publicStatus.applied).toBe(true);
    expect(result.state.email.actionLinks.raiseUrgency.skipped).toBe(true);
    expect(result.state.email.actionLinks.raiseUrgency.reason).toContain('outside business hours');
    expect(result.state.email.actionLinks.afterHoursSupport.applied).toBe(true);
    expect(result.state.email.html).toContain(immediateSupportUrl);
  });

  test('uses LLM text as HTML when the provider returns blank HTML', async () => {
    providerSendJsonMock.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-sonnet-test',
      parsed: {
        subject: 'LLM ticket update',
        html: '   ',
        text: 'LLM wrote this body.\n\nIt should be the visible email content.',
      },
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      metadata: {
        stopReason: 'tool_use',
      },
    });

    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.push({
      id: 'llm-generate',
      type: 'llm_generate',
      position: { x: 700, y: 120 },
      data: {
        prompt: 'Generate email content for {{ ticket.subject }}',
      },
    });
    const templateNode = definition.nodes.find((node) => node.type === 'template_render');
    templateNode.data.contentSource = 'llm_with_template_fallback';
    definition.edges = definition.edges.map((edge) => (
      edge.id === 'recipients-to-template'
        ? { ...edge, id: 'recipients-to-llm', target: 'llm-generate' }
        : edge
    ));
    definition.edges.push({ id: 'llm-to-template', source: 'llm-generate', target: 'template' });

    await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: false,
      executeLlm: true,
      triggerSource: 'test',
    });

    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(deliveryData.subject).toBe('LLM ticket update');
    expect(deliveryData.htmlBody).toContain('<p>LLM wrote this body.</p>');
    expect(deliveryData.htmlBody).toContain('<p>It should be the visible email content.</p>');
    expect(deliveryData.htmlBody).not.toContain('We received your ticket');
    expect(deliveryData.textBody).toContain('LLM wrote this body.');
  });

  test('tool-enabled LLM mode requires final email tool and persists tool audit rows', async () => {
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue({
      id: 5,
      workspaceId: 1,
      mode: 'tools_enabled',
      enabledTools: ['get_notification_context'],
      toolSettings: {
        context: {
          includeThreadHistory: true,
          includeSimilarTickets: true,
          includeOutageSignals: true,
          maxThreadEntries: 6,
          maxSimilarTickets: 5,
          lookbackHours: [1, 4, 24],
        },
        outageSignals: {
          watchThreshold: 3,
          possibleBroaderIssueThreshold: 5,
          distinctRequesterThreshold: 3,
          distinctDepartmentThreshold: 2,
        },
        safety: {
          maxContextBytes: 40000,
          maxToolOutputBytes: 12000,
        },
      },
      maxTurns: 4,
      maxToolCalls: 6,
      totalTimeoutMs: 20000,
      perToolTimeoutMs: 3000,
      includePrivateNotes: false,
      redactionEnabled: true,
      policyVersion: 1,
      updatedBy: null,
    });
    providerRunToolTurnMock
      .mockResolvedValueOnce({
        provider: 'anthropic',
        model: 'claude-sonnet-test',
        usage: { inputTokens: 120, outputTokens: 25, totalTokens: 145 },
        message: {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'toolu_context', name: 'get_notification_context', input: {} },
          ],
        },
      })
      .mockResolvedValueOnce({
        provider: 'anthropic',
        model: 'claude-sonnet-test',
        usage: { inputTokens: 140, outputTokens: 50, totalTokens: 190 },
        message: {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_submit',
              name: 'submit_notification_email',
              input: {
                subject: 'Tool final ticket update',
                html: '<p>We are reviewing your VPN request.</p>',
                text: 'We are reviewing your VPN request.',
                confidence: 'high',
                citedSignals: ['notification_context'],
              },
            },
          ],
        },
      });

    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.push({
      id: 'llm-generate',
      type: 'llm_generate',
      position: { x: 700, y: 120 },
      data: {
        prompt: 'Generate email content for {{ ticket.subject }}',
      },
    });
    const templateNode = definition.nodes.find((node) => node.type === 'template_render');
    templateNode.data.contentSource = 'llm_with_template_fallback';
    definition.edges = definition.edges.map((edge) => (
      edge.id === 'recipients-to-template'
        ? { ...edge, id: 'recipients-to-llm', target: 'llm-generate' }
        : edge
    ));
    definition.edges.push({ id: 'llm-to-template', source: 'llm-generate', target: 'template' });

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: false,
      executeLlm: true,
      triggerSource: 'test',
    });

    expect(result.status).toBe('completed');
    expect(result.state.llm).toEqual(expect.objectContaining({ toolMode: true }));
    expect(providerSendJsonMock).not.toHaveBeenCalled();
    expect(providerRunToolTurnMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.notificationWorkflowStepRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        nodeId: 'llm-generate:get_notification_context:1',
        nodeType: 'llm_tool',
      }),
    }));
    expect(prismaMock.notificationWorkflowStepRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        nodeId: 'llm-generate:submit_notification_email:2',
        nodeType: 'llm_tool',
      }),
    }));
    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(deliveryData.subject).toBe('Tool final ticket update');
    expect(deliveryData.htmlBody).toContain('We are reviewing your VPN request');
    expect(processDeliveryMock).toHaveBeenCalled();
  });

  test('tool-enabled LLM mode does not create a delivery when final email is missing and no template body exists', async () => {
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue({
      id: 6,
      workspaceId: 1,
      mode: 'tools_enabled',
      enabledTools: ['get_notification_context'],
      toolSettings: {
        context: {
          includeThreadHistory: true,
          includeSimilarTickets: true,
          includeOutageSignals: true,
          maxThreadEntries: 6,
          maxSimilarTickets: 5,
          lookbackHours: [1, 4, 24],
        },
        outageSignals: {
          watchThreshold: 3,
          possibleBroaderIssueThreshold: 5,
          distinctRequesterThreshold: 3,
          distinctDepartmentThreshold: 2,
        },
        safety: {
          maxContextBytes: 40000,
          maxToolOutputBytes: 12000,
        },
      },
      maxTurns: 1,
      maxToolCalls: 2,
      totalTimeoutMs: 20000,
      perToolTimeoutMs: 3000,
      includePrivateNotes: false,
      redactionEnabled: true,
      policyVersion: 1,
      updatedBy: null,
    });
    providerRunToolTurnMock.mockResolvedValueOnce({
      provider: 'anthropic',
      model: 'claude-sonnet-test',
      usage: { inputTokens: 120, outputTokens: 25, totalTokens: 145 },
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'I forgot to call the final tool.' }],
      },
    });

    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.push({
      id: 'llm-generate',
      type: 'llm_generate',
      position: { x: 700, y: 120 },
      data: {
        prompt: 'Generate email content for {{ ticket.subject }}',
      },
    });
    const templateNode = definition.nodes.find((node) => node.type === 'template_render');
    templateNode.data.contentSource = 'llm_with_template_fallback';
    templateNode.data.subject = '';
    templateNode.data.html = '';
    templateNode.data.text = '';
    definition.edges = definition.edges.map((edge) => (
      edge.id === 'recipients-to-template'
        ? { ...edge, id: 'recipients-to-llm', target: 'llm-generate' }
        : edge
    ));
    definition.edges.push({ id: 'llm-to-template', source: 'llm-generate', target: 'template' });

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: false,
      executeLlm: true,
      triggerSource: 'test',
    });

    expect(result.state.llm.failed).toBe(true);
    expect(providerRunToolTurnMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
    expect(processDeliveryMock).not.toHaveBeenCalled();
  });
});
