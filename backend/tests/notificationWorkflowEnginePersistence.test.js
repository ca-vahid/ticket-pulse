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
  notificationEmailBlock: {
    findFirst: jest.fn(),
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
        email: 'alex.agent@example.com',
        photoUrl: 'data:image/png;base64,avatar',
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

function llmResponse({ provider = 'openai', model = 'gpt-test', subject, html, text, extra = {} }) {
  return {
    provider,
    model,
    parsed: {
      subject,
      html,
      text,
      ...extra,
    },
    usage: {
      inputTokens: 45,
      outputTokens: 18,
      totalTokens: 63,
    },
    metadata: {
      stopReason: 'complete',
    },
  };
}

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
    prismaMock.notificationEmailBlock.findFirst.mockResolvedValue(null);
    prismaMock.notificationEmailBlock.findMany.mockResolvedValue([]);
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

  test('workflow and delivery dedupe prefer canonical lifecycle fingerprints', async () => {
    const assignedWorkflow = {
      ...workflow,
      triggerType: 'ticket.assigned',
    };
    const assignedContext = {
      ...eventContext,
      event: {
        type: 'ticket.assigned',
        source: 'assignment_pipeline',
        occurredAt: '2026-06-01T16:00:02.000Z',
        dedupeStamp: '2026-06-01T16:00:02.000Z',
        notificationFingerprint: '1:ticket.assigned:501:17:2026-06-01T16:00:00.000Z',
      },
      assignedAgent: { id: 17, name: 'Agent', email: 'agent@example.com' },
    };
    const definition = buildDefaultWorkflowDefinition('ticket.assigned');
    const recipientNode = definition.nodes.find((node) => node.type === 'recipient_resolver');
    recipientNode.data.to = ['requester'];

    await executeDefinition({
      workflow: assignedWorkflow,
      definition,
      eventContext: assignedContext,
      dryRun: true,
      executionMode: 'mock',
      triggerSource: 'freshservice_webhook',
    });

    const runData = prismaMock.notificationWorkflowRun.create.mock.calls[0][0].data;
    expect(runData.dedupeKey).toContain('1:ticket.assigned:501:17:2026-06-01T16:00:00.000Z');
    expect(runData.dedupeKey).not.toContain('2026-06-01T16:00:02.000Z');
    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(deliveryData.dedupeKey).toContain('notification-workflow-delivery:7:1:send:ticket.assigned:501:assignee:17');
    expect(deliveryData.dedupeKey).toContain('1:ticket.assigned:501:17:2026-06-01T16:00:00.000Z');
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

  test('suppresses duplicate requester-facing deliveries through the delivery dedupe key', async () => {
    prismaMock.notificationDelivery.create.mockRejectedValueOnce({ code: 'P2002' });

    const result = await executeDefinition({
      workflow,
      definition: buildDefaultWorkflowDefinition('ticket.created'),
      eventContext: {
        ...eventContext,
        event: {
          ...eventContext.event,
          notificationFingerprint: '1:ticket.created:501:2026-05-29T18:30:00.000Z',
        },
      },
      dryRun: false,
      triggerSource: 'assignment_fast_sync',
    });

    expect(result.status).toBe('completed');
    const sendStep = result.steps.find((step) => step.nodeType === 'send_email');
    expect(sendStep.output).toEqual(expect.objectContaining({
      skipped: true,
      duplicateDelivery: true,
      reason: 'Duplicate workflow delivery',
    }));
    expect(processDeliveryMock).not.toHaveBeenCalled();
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

  test('send email can disable the default footer branding block', async () => {
    prismaMock.notificationEmailSignature.findUnique.mockResolvedValueOnce({
      enabled: true,
      html: '<p>Workspace Signature</p>',
      text: 'Workspace Signature',
    });
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const sendNode = definition.nodes.find((node) => node.type === 'send_email');
    sendNode.data.includeFooter = false;

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: true,
      triggerSource: 'test',
    });

    expect(result.state.email.html).not.toContain('Workspace Signature');
    expect(result.state.email.footerApplied).toBe(false);
    expect(result.state.email.branding.footer.requested).toBe(false);
  });

  test('send email uses a selected alternate footer block', async () => {
    prismaMock.notificationEmailBlock.findFirst.mockImplementation(({ where }) => {
      if (where.id === 44) {
        return Promise.resolve({
          id: 44,
          workspaceId: 1,
          type: 'footer',
          name: 'Escalation footer',
          enabled: true,
          isDefault: false,
          html: '<p>Escalation Footer</p>',
          text: 'Escalation Footer',
        });
      }
      return Promise.resolve(null);
    });
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const sendNode = definition.nodes.find((node) => node.type === 'send_email');
    sendNode.data.footerBlockId = 44;

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: true,
      triggerSource: 'test',
    });

    expect(result.state.email.html).toContain('Escalation Footer');
    expect(result.state.email.footerBlockId).toBe(44);
    expect(result.state.email.footerBlockName).toBe('Escalation footer');
    expect(result.state.email.branding.footer.fallback).toBe(false);
  });

  test('send email applies selected header before the main body', async () => {
    prismaMock.notificationEmailBlock.findFirst.mockImplementation(({ where }) => {
      if (where.id === 33) {
        return Promise.resolve({
          id: 33,
          workspaceId: 1,
          type: 'header',
          name: 'Maintenance header',
          enabled: true,
          isDefault: false,
          html: '<p>Maintenance Header</p>',
          text: 'Maintenance Header',
        });
      }
      return Promise.resolve(null);
    });
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const sendNode = definition.nodes.find((node) => node.type === 'send_email');
    sendNode.data.includeHeader = true;
    sendNode.data.headerBlockId = 33;
    sendNode.data.includeFooter = false;

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: true,
      triggerSource: 'test',
    });

    expect(result.state.email.html.indexOf('Maintenance Header')).toBeLessThan(
      result.state.email.html.indexOf('Ticket'),
    );
    expect(result.state.email.headerBlockId).toBe(33);
    expect(result.state.email.branding.header.applied).toBe(true);
  });

  test('missing selected footer falls back to default and records branding warning', async () => {
    prismaMock.notificationEmailBlock.findFirst.mockImplementation(({ where }) => {
      if (where.id === 999) return Promise.resolve(null);
      if (where.type === 'footer' && where.isDefault === true) {
        return Promise.resolve({
          id: 45,
          workspaceId: 1,
          type: 'footer',
          name: 'Default footer',
          enabled: true,
          isDefault: true,
          html: '<p>Default Footer</p>',
          text: 'Default Footer',
        });
      }
      return Promise.resolve(null);
    });
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const sendNode = definition.nodes.find((node) => node.type === 'send_email');
    sendNode.data.footerBlockId = 999;

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: true,
      triggerSource: 'test',
    });

    expect(result.state.email.html).toContain('Default Footer');
    expect(result.state.email.footerBlockId).toBe(45);
    expect(result.state.email.branding.footer.fallback).toBe(true);
    expect(result.state.email.brandingWarnings[0]).toContain('not found');
  });

  test('live action blocks bundle selected links including after-hours support during business hours', async () => {
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
    expect(result.state.email.actionLinks.afterHoursSupport.applied).toBe(true);
    expect(result.state.email.actionLinks.afterHoursSupport.skipped).toBe(false);
    expect(result.state.email.html).toContain('Helpful ticket links');
    expect(result.state.email.html).toContain('Open status page');
    expect(result.state.email.html).toContain('Raise urgency');
    expect(result.state.email.html).toContain('Request support');
    expect(result.state.email.html).toContain(publicStatusUrl);
    expect(result.state.email.html).toContain(raiseUrgencyUrl);
    expect(result.state.email.html).toContain(immediateSupportUrl);
    expect(result.state.email.html).toContain('+16045551234');
    expect(result.state.email.html).not.toContain('Need immediate after-hours support?');
  });

  test('forced preview keeps selected action blocks in one helpful-links bundle', async () => {
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
    expect(result.state.email.actionLinks.afterHoursSupport.forced).toBe(false);
    expect(result.state.email.actionLinks.afterHoursSupport.actionLinkRenderMode).toBe('force_all_enabled');
    expect(result.state.email.html).toContain('Helpful ticket links');
    expect(result.state.email.html).not.toContain('Need immediate after-hours support?');
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
    expect(result.state.email.html).toContain('Helpful ticket links');
    expect(result.state.email.html).toContain(immediateSupportUrl);
    expect(result.state.email.html).not.toContain('Need immediate after-hours support?');
  });

  test('send step captures final action-block email even when recipient resolution is empty', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const sendNode = definition.nodes.find((node) => node.type === 'send_email');
    sendNode.data.appendPublicStatusLink = true;
    sendNode.data.appendAfterHoursSupportLink = true;

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext: {
        ...eventContext,
        requester: null,
        availability: { isBusinessHours: false, isAfterHours: true, isHoliday: false },
      },
      dryRun: true,
      executionMode: 'mock',
      triggerSource: 'freshservice_poll',
    });

    const sendStep = result.steps.find((step) => step.nodeType === 'send_email');
    expect(sendStep.output).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'No recipient email address resolved',
      htmlBody: expect.stringContaining('Helpful ticket links'),
      actionLinks: expect.objectContaining({
        publicStatus: expect.objectContaining({ applied: true }),
        afterHoursSupport: expect.objectContaining({ applied: true }),
      }),
    }));
    expect(sendStep.output.htmlBody).not.toContain('Need immediate after-hours support?');
    expect(sendStep.output.htmlBody).toContain('Request immediate support');
    expect(sendStep.output.actionLinks.afterHoursSupport).toEqual(expect.objectContaining({
      hasActiveContact: true,
      phoneVerified: true,
      rotationLabel: 'Manual after-hours contact',
    }));
    expect(sendStep.output.actionLinks.afterHoursSupport.activeContact).toBeUndefined();
    expect(result.state.email.html).not.toContain('Need immediate after-hours support?');
    expect(result.state.email.html).toContain('Request immediate support');
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
    expect(processDeliveryMock).not.toHaveBeenCalled();
  });

  test('mocked delivery payload stores compact action-link diagnostics without contact blobs', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const sendNode = definition.nodes.find((node) => node.type === 'send_email');
    sendNode.data.appendAfterHoursSupportLink = true;

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext: {
        ...eventContext,
        availability: { isBusinessHours: false, isAfterHours: true, isHoliday: false },
      },
      dryRun: true,
      executionMode: 'mock',
      triggerSource: 'freshservice_poll',
    });

    const sendStep = result.steps.find((step) => step.nodeType === 'send_email');
    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    const stepDiagnostics = JSON.stringify(sendStep.output.actionLinks);
    const payloadDiagnostics = JSON.stringify(deliveryData.payload.actionLinks);

    expect(sendStep.output.actionLinks.afterHoursSupport).toEqual(expect.objectContaining({
      requested: true,
      applied: true,
      hasActiveContact: true,
      phoneVerified: true,
      rotationLabel: 'Manual after-hours contact',
    }));
    expect(sendStep.output.actionLinks.afterHoursSupport.activeContact).toBeUndefined();
    expect(stepDiagnostics).not.toContain('data:image');
    expect(stepDiagnostics).not.toContain('alex.agent@example.com');
    expect(stepDiagnostics).not.toContain('+16045551234');
    expect(payloadDiagnostics).not.toContain('data:image');
    expect(payloadDiagnostics).not.toContain('alex.agent@example.com');
    expect(payloadDiagnostics).not.toContain('+16045551234');
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

  test('guard-rejected LLM output is visible while template fallback continues', async () => {
    providerSendJsonMock.mockResolvedValueOnce(llmResponse({
      subject: 'Provider leak',
      html: '<p>The Claude model drafted this update.</p>',
      text: 'The Claude model drafted this update.',
    }));

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

    const llmStep = result.steps.find((step) => step.nodeType === 'llm_generate');
    expect(result.status).toBe('completed');
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'guard_rejected',
        templateFallbackUsed: true,
      }),
    ]));
    expect(llmStep.output).toEqual(expect.objectContaining({
      failed: true,
      failureType: 'guard_rejected',
      guardRejected: true,
      templateFallbackUsed: true,
      raw: null,
      guard: expect.objectContaining({ accepted: false }),
      promptPolicy: expect.objectContaining({
        strictness: 'strict_default',
        strictDefaultApplied: true,
        customSystemPromptUsed: false,
      }),
      guardPolicy: expect.objectContaining({
        mode: 'strict_default_repair_copy',
        allowEmoji: false,
        allowPlayfulTone: false,
        hardBlocks: expect.arrayContaining(['provider_model_internals']),
        repairChecks: expect.arrayContaining(['unsupported_timing_claims']),
      }),
    }));
    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(deliveryData.subject).not.toBe('Provider leak');
    expect(deliveryData.htmlBody).not.toContain('Claude model');
    expect(processDeliveryMock).toHaveBeenCalled();
  });

  test('custom system prompt is audited and relaxes tone guard only', async () => {
    providerSendJsonMock.mockResolvedValueOnce(llmResponse({
      subject: 'Warmer VPN update',
      html: '<p>We will get this back on rock solid ground. 🚀</p>',
      text: 'We will get this back on rock solid ground. 🚀',
    }));

    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.push({
      id: 'llm-generate',
      type: 'llm_generate',
      position: { x: 700, y: 120 },
      data: {
        prompt: 'Generate email content for {{ ticket.subject }}',
        systemPrompt: 'Use a warmer requester-facing voice and include emoji when it helps.',
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

    const llmStep = result.steps.find((step) => step.nodeType === 'llm_generate');
    expect(result.status).toBe('completed');
    expect(llmStep.output.llm).toEqual(expect.objectContaining({
      promptPolicy: expect.objectContaining({
        strictness: 'custom_relaxed_tone',
        strictDefaultApplied: false,
        customSystemPromptUsed: true,
        relaxedControls: ['emoji', 'playful_tone'],
      }),
      guardPolicy: expect.objectContaining({
        mode: 'custom_prompt_repair_copy',
        allowEmoji: true,
        allowPlayfulTone: true,
        repairChecks: expect.arrayContaining(['unsupported_timing_claims']),
        hardBlocks: expect.arrayContaining(['provider_model_internals']),
      }),
      guard: expect.objectContaining({ accepted: true }),
    }));
    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(deliveryData.subject).toBe('Warmer VPN update');
    expect(deliveryData.textBody).toContain('rock solid ground');
  });

  test('unsupported timing claims are repaired and audited instead of falling back', async () => {
    providerSendJsonMock.mockResolvedValueOnce(llmResponse({
      subject: 'VPN update within 30 minutes',
      html: '<p>We received your VPN request.</p><p>We should have this resolved within 30 minutes.</p>',
      text: 'We received your VPN request. We should have this resolved within 30 minutes.',
    }));

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

    const llmStep = result.steps.find((step) => step.nodeType === 'llm_generate');
    expect(result.status).toBe('completed');
    expect(result.warnings || []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'guard_rejected' }),
    ]));
    expect(llmStep.output.llm.guard).toEqual(expect.objectContaining({
      accepted: true,
      repairedIssues: expect.arrayContaining([
        expect.objectContaining({
          id: 'unsupported_timing_claims',
          action: 'repaired',
        }),
      ]),
    }));
    expect(llmStep.output.llm.email.subject).not.toMatch(/within 30 minutes/i);
    expect(llmStep.output.llm.email.text).not.toMatch(/within 30 minutes/i);
    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(deliveryData.subject).toBe('VPN update');
    expect(deliveryData.textBody).toContain('We received your VPN request');
    expect(deliveryData.textBody).not.toMatch(/within 30 minutes/i);
  });

  test('workflow can disable timing guardrail for an LLM node', async () => {
    providerSendJsonMock.mockResolvedValueOnce(llmResponse({
      subject: 'VPN update within 30 minutes',
      html: '<p>We received your VPN request.</p><p>We should have this resolved within 30 minutes.</p>',
      text: 'We received your VPN request. We should have this resolved within 30 minutes.',
    }));

    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.push({
      id: 'llm-generate',
      type: 'llm_generate',
      position: { x: 700, y: 120 },
      data: {
        prompt: 'Generate email content for {{ ticket.subject }}',
        requesterGuardrails: {
          timingClaims: false,
        },
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

    const llmStep = result.steps.find((step) => step.nodeType === 'llm_generate');
    expect(llmStep.output.llm.guardPolicy).toEqual(expect.objectContaining({
      disabledGroups: expect.arrayContaining(['timingClaims']),
      disabledChecks: expect.arrayContaining(['unsupported_timing_claims']),
    }));
    expect(llmStep.output.llm.guard.skippedChecks).toEqual(expect.arrayContaining(['unsupported_timing_claims']));
    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(deliveryData.subject).toMatch(/within 30 minutes/i);
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

  test('condition true branch runs the recipient, template, and send path', async () => {
    const result = await executeDefinition({
      workflow,
      definition: buildDefaultWorkflowDefinition('ticket.created'),
      eventContext: {
        ...eventContext,
        ticket: {
          ...eventContext.ticket,
          isNoise: false,
        },
      },
      dryRun: true,
      triggerSource: 'preview',
    });

    const executedNodeIds = result.steps.map((step) => step.nodeId);
    expect(result.status).toBe('completed');
    expect(executedNodeIds).toEqual(expect.arrayContaining(['trigger', 'skip-noise', 'recipients', 'template', 'send']));
    expect(executedNodeIds).not.toContain('stop-skipped');
    expect(result.steps.find((step) => step.nodeId === 'skip-noise').output.passed).toBe(true);
  });

  test('condition false branch runs the stop path and skips email nodes', async () => {
    const result = await executeDefinition({
      workflow,
      definition: buildDefaultWorkflowDefinition('ticket.created'),
      eventContext: {
        ...eventContext,
        ticket: {
          ...eventContext.ticket,
          isNoise: true,
        },
      },
      dryRun: true,
      triggerSource: 'preview',
    });

    const executedNodeIds = result.steps.map((step) => step.nodeId);
    expect(result.status).toBe('completed');
    expect(executedNodeIds).toEqual(expect.arrayContaining(['trigger', 'skip-noise', 'stop-skipped']));
    expect(executedNodeIds).not.toContain('recipients');
    expect(executedNodeIds).not.toContain('template');
    expect(executedNodeIds).not.toContain('send');
    expect(result.steps.find((step) => step.nodeId === 'skip-noise').output.passed).toBe(false);
  });

  test('multiple LLM nodes persist separate output buckets', async () => {
    providerSendJsonMock
      .mockResolvedValueOnce(llmResponse({
        subject: 'Classifier output',
        html: '<p>Classification only.</p>',
        text: 'Classification only.',
        extra: { confidence: 'high' },
      }))
      .mockResolvedValueOnce(llmResponse({
        subject: 'Final LLM email',
        html: '<p>Final generated email.</p>',
        text: 'Final generated email.',
        extra: { confidence: 'medium' },
      }));

    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.push(
      {
        id: 'classify-llm',
        type: 'llm_generate',
        position: { x: 700, y: 120 },
        data: {
          label: 'Classify ticket',
          outputKey: 'classification',
          outputMode: 'classify',
          promoteToEmail: false,
          prompt: 'Classify {{ ticket.subject }}',
        },
      },
      {
        id: 'draft-llm',
        type: 'llm_generate',
        position: { x: 960, y: 120 },
        data: {
          label: 'Draft email',
          outputKey: 'draft',
          outputMode: 'draft_email',
          promoteToEmail: true,
          prompt: 'Draft email using {{ state.outputs.classification.email.extra.confidence }}',
        },
      },
    );
    const templateNode = definition.nodes.find((node) => node.type === 'template_render');
    templateNode.data.contentSource = 'llm_with_template_fallback';
    definition.edges = definition.edges.map((edge) => (
      edge.id === 'recipients-to-template'
        ? { ...edge, id: 'recipients-to-classify', target: 'classify-llm' }
        : edge
    ));
    definition.edges.push(
      { id: 'classify-to-draft', source: 'classify-llm', target: 'draft-llm' },
      { id: 'draft-to-template', source: 'draft-llm', target: 'template' },
    );

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: false,
      executeLlm: true,
      triggerSource: 'test',
    });

    expect(result.status).toBe('completed');
    expect(providerSendJsonMock).toHaveBeenCalledTimes(2);
    expect(result.state.outputs.classification.email.subject).toBe('Classifier output');
    expect(result.state.outputs.classification.llm.outputMode).toBe('classify');
    expect(result.state.outputs.classification.llm.promotedToEmail).toBe(false);
    expect(result.state.outputs.draft.email.subject).toBe('Final LLM email');
    expect(result.state.outputs.draft.llm.promotedToEmail).toBe(true);
    expect(result.state.llmRuns).toEqual(expect.objectContaining({
      classification: expect.objectContaining({ outputMode: 'classify' }),
      draft: expect.objectContaining({ outputMode: 'draft_email' }),
    }));
    const persistedOutputKeys = prismaMock.notificationWorkflowStepRun.update.mock.calls
      .map((call) => call[0].data.output?.outputKey)
      .filter(Boolean);
    expect(persistedOutputKeys).toEqual(expect.arrayContaining(['classification', 'draft']));
  });

  test('template can reference a specific LLM node output', async () => {
    providerSendJsonMock.mockResolvedValueOnce(llmResponse({
      subject: 'Specific LLM subject',
      html: '<p>Specific body.</p>',
      text: 'Specific body.',
    }));

    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.push({
      id: 'evidence-llm',
      type: 'llm_generate',
      position: { x: 700, y: 120 },
      data: {
        outputKey: 'evidence',
        outputMode: 'extract',
        promoteToEmail: false,
        prompt: 'Extract a requester-safe summary for {{ ticket.subject }}',
      },
    });
    const templateNode = definition.nodes.find((node) => node.type === 'template_render');
    templateNode.data.contentSource = 'advanced_liquid';
    templateNode.data.subject = 'Specific: {{ state.outputs.evidence.email.subject }}';
    templateNode.data.html = '<div>{{ state.outputs.evidence.email.html }}</div>';
    templateNode.data.text = 'Specific text: {{ state.outputs.evidence.email.text }}';
    definition.edges = definition.edges.map((edge) => (
      edge.id === 'recipients-to-template'
        ? { ...edge, id: 'recipients-to-evidence', target: 'evidence-llm' }
        : edge
    ));
    definition.edges.push({ id: 'evidence-to-template', source: 'evidence-llm', target: 'template' });

    await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: false,
      executeLlm: true,
      triggerSource: 'test',
    });

    const deliveryData = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(deliveryData.subject).toBe('Specific: Specific LLM subject');
    expect(deliveryData.htmlBody).toContain('Specific body');
    expect(deliveryData.textBody).toContain('Specific body');
  });

  test('multiple send nodes create separate deduped deliveries', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.push({
      id: 'send-secondary',
      type: 'send_email',
      position: { x: 1040, y: 160 },
      data: {
        provider: 'sendgrid',
        notificationType: 'secondary_notice',
      },
    });
    definition.edges.push({
      id: 'template-to-send-secondary',
      source: 'template',
      target: 'send-secondary',
    });

    const result = await executeDefinition({
      workflow,
      definition,
      eventContext,
      dryRun: false,
      triggerSource: 'test',
    });

    expect(result.status).toBe('completed');
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledTimes(2);
    const dedupeKeys = prismaMock.notificationDelivery.create.mock.calls.map((call) => call[0].data.dedupeKey);
    expect(dedupeKeys).toEqual(expect.arrayContaining([
      expect.stringContaining(':send:ticket.created'),
      expect.stringContaining(':send-secondary:secondary_notice'),
    ]));
    expect(new Set(dedupeKeys).size).toBe(2);
    expect(processDeliveryMock).toHaveBeenCalledTimes(2);
  });

  test('mock mode suppresses provider delivery with advanced LLM and multi-send graph', async () => {
    providerSendJsonMock.mockResolvedValueOnce(llmResponse({
      subject: 'Mock advanced subject',
      html: '<p>Advanced mock body.</p>',
      text: 'Advanced mock body.',
    }));

    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.push(
      {
        id: 'draft-llm',
        type: 'llm_generate',
        position: { x: 700, y: 120 },
        data: {
          outputKey: 'draft',
          outputMode: 'draft_email',
          promoteToEmail: true,
          prompt: 'Draft a mock-mode email for {{ ticket.subject }}',
        },
      },
      {
        id: 'send-secondary',
        type: 'send_email',
        position: { x: 1040, y: 160 },
        data: {
          provider: 'sendgrid',
          notificationType: 'secondary_notice',
        },
      },
    );
    const templateNode = definition.nodes.find((node) => node.type === 'template_render');
    templateNode.data.contentSource = 'llm_with_template_fallback';
    definition.edges = definition.edges.map((edge) => (
      edge.id === 'recipients-to-template'
        ? { ...edge, id: 'recipients-to-draft', target: 'draft-llm' }
        : edge
    ));
    definition.edges.push(
      { id: 'draft-to-template', source: 'draft-llm', target: 'template' },
      { id: 'template-to-send-secondary', source: 'template', target: 'send-secondary' },
    );

    const result = await executeWorkflow({
      ...workflow,
      mockModeEnabled: true,
      publishedDefinition: definition,
    }, eventContext, { triggerSource: 'freshservice_poll' });

    expect(result.status).toBe('completed');
    expect(result.executionMode).toBe('mock');
    expect(providerSendJsonMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.notificationDelivery.create.mock.calls.every((call) => call[0].data.status === 'mocked')).toBe(true);
    expect(prismaMock.notificationDelivery.create.mock.calls.every((call) => call[0].data.payload.mockMode === true)).toBe(true);
    expect(processDeliveryMock).not.toHaveBeenCalled();
  });
});
