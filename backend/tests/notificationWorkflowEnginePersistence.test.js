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
  notificationEmailSignature: {
    findUnique: jest.fn(),
  },
};

const processDeliveryMock = jest.fn();
const providerSendJsonMock = jest.fn();
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

const { executeDefinition } = await import('../src/services/notificationWorkflowEngine.js');
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
    prismaMock.notificationWorkflowRun.create.mockResolvedValue({
      id: 900,
      workspaceId: 1,
      workflowId: 7,
      dedupeKey: 'notification-workflow:7:1:ticket.created:501:2026-05-29T19:00:00.000Z',
    });
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
});
