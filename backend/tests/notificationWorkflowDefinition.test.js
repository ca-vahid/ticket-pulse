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
  notificationEmailSignature: {
    findUnique: jest.fn(),
  },
  publicTicketStatusSettings: {
    upsert: jest.fn(),
  },
  publicTicketStatusLink: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  ticket: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  ticketThreadEntry: {
    findMany: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: jest.fn(),
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  DEFAULT_LLM_OUTPUT_SCHEMA,
  NOTIFICATION_EVENT_TYPES,
  buildDefaultWorkflowDefinition,
  notificationVariableCatalog,
  validateWorkflowDefinition,
} = await import('../src/services/notificationWorkflowDefinition.js');
const { default: notificationWorkflowEngine } = await import('../src/services/notificationWorkflowEngine.js');
const {
  appendSignatureToEmail,
  sanitizeSignatureHtml,
} = await import('../src/services/notificationWorkflowSignatureService.js');

describe('notification workflow definitions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let stepId = 1000;
    prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({
      id: 900,
      ...data,
    }));
    prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
    prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({
      id: stepId += 1,
      ...data,
    }));
    prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
    prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
    prismaMock.publicTicketStatusSettings.upsert.mockResolvedValue({
      enabled: true,
      expiryDays: 60,
      showRequesterName: false,
      showRequesterEmail: false,
      showAssignedAgent: true,
      showSummary: true,
      showPriority: true,
      showCategory: true,
      showWorkspaceStats: true,
      etaLookbackDays: 180,
      etaMinSampleSize: 8,
      etaPercentile: 75,
    });
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 100, workspaceId: 1 });
    prismaMock.ticket.findMany.mockResolvedValue([]);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue({
      id: 200,
      workspaceId: 1,
      ticketId: 100,
      token: 'public-status-token',
      enabled: true,
      revokedAt: null,
      expiresAt: null,
    });
  });

  test('default definitions validate for every v1 ticket event', () => {
    for (const triggerType of NOTIFICATION_EVENT_TYPES) {
      const definition = buildDefaultWorkflowDefinition(triggerType);
      const result = validateWorkflowDefinition(definition, { triggerType });
      expect(result.success).toBe(true);
    }
  });

  test('validation rejects trigger mismatches', () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const result = validateWorkflowDefinition(definition, { triggerType: 'ticket.assigned' });
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('ticket.assigned');
  });

  test('variable catalog includes ticket category fields and LLM output fields', () => {
    const variables = notificationVariableCatalog(['summary']);
    const paths = variables.map((variable) => variable.path);
    expect(paths).toContain('ticket.category');
    expect(paths).toContain('ticket.subCategory');
    expect(paths).toContain('ticket.ticketCategory');
    expect(paths).toContain('ticket.tpSkill');
    expect(paths).toContain('ticket.ccEmails');
    expect(paths).toContain('ticket.replyCcEmails');
    expect(paths).toContain('ticket.publicStatusUrl');
    expect(paths).toContain('ticket.selfEscalationUrl');
    expect(paths).toContain('publicStatusUrl');
    expect(paths).toContain('selfEscalationUrl');
    expect(paths).toContain('availability.isAfterHours');
    expect(paths).toContain('availability.isHoliday');
    expect(paths).toContain('availability.nextBusinessTimeLocal');
    expect(paths).toContain('afterHoursSupport.emergencySupportUrl');
    expect(paths).toContain('afterHoursSupport.selfEscalationUrl');
    expect(paths).toContain('state.llm.email.subject');
    expect(paths).toContain('state.llm.email.extra.summary');
  });

  test('validation rejects LLM schemas missing stable email fields', () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    definition.nodes.splice(3, 0, {
      id: 'llm-generate',
      type: 'llm_generate',
      position: { x: 650, y: 0 },
      data: {
        outputSchema: {
          ...DEFAULT_LLM_OUTPUT_SCHEMA,
          required: ['subject'],
          properties: {
            subject: { type: 'string' },
          },
        },
      },
    });
    definition.edges = [
      { id: 'trigger-to-condition', source: 'trigger', target: 'skip-noise' },
      { id: 'condition-true-to-recipients', source: 'skip-noise', sourceHandle: 'true', target: 'recipients' },
      { id: 'condition-false-to-stop', source: 'skip-noise', sourceHandle: 'false', target: 'stop-skipped' },
      { id: 'recipients-to-llm', source: 'recipients', target: 'llm-generate' },
      { id: 'llm-to-template', source: 'llm-generate', target: 'template' },
      { id: 'template-to-send', source: 'template', target: 'send' },
    ];
    const result = validateWorkflowDefinition(definition, { triggerType: 'ticket.created' });
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('html');
    expect(result.errors.join(' ')).toContain('text');
  });

  test('signature sanitization preserves data image urls and appends once', () => {
    const html = sanitizeSignatureHtml('<div>IT</div><img src="data:image/png;base64,aGVsbG8="><script>alert(1)</script>');
    expect(html).toContain('data:image/png;base64,aGVsbG8=');
    expect(html).not.toContain('<script>');
    const signed = appendSignatureToEmail(
      { html: '<p>Hello</p>', text: 'Hello' },
      { enabled: true, html, text: 'IT' },
    );
    const signedAgain = appendSignatureToEmail(signed, { enabled: true, html, text: 'IT' });
    expect(signed.html.match(/data:image\/png/g)).toHaveLength(1);
    expect(signedAgain.html.match(/data:image\/png/g)).toHaveLength(1);
  });

  test('preview renders recipients and template without sending', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const result = await notificationWorkflowEngine.executePreview({
      workflow: {
        id: 10,
        workspaceId: 1,
        triggerType: 'ticket.created',
        draftDefinition: definition,
        publishedVersion: 0,
        versions: [],
      },
      definition,
      eventContext: {
        event: { type: 'ticket.created', source: 'test', occurredAt: '2026-05-29T19:00:00.000Z' },
        workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
        ticket: {
          id: 100,
          freshserviceTicketId: 225001,
          subject: 'VPN access problem',
          status: 'Open',
          priorityLabel: 'High',
          isNoise: false,
        },
        requester: { name: 'Requester', email: 'requester@example.com' },
        assignedAgent: null,
        previousAgent: null,
      },
    });

    expect(result.status).toBe('completed');
    expect(result.state.recipients.to).toEqual(['requester@example.com']);
    expect(result.state.email.subject).toContain('#225001');
    expect(result.steps.some((step) => step.nodeType === 'send_email' && step.output.skipped)).toBe(true);
  });

  test('recipient resolver can copy original FreshService CCs', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const recipientsNode = definition.nodes.find((node) => node.id === 'recipients');
    recipientsNode.data.cc = ['original_ccs'];

    const result = await notificationWorkflowEngine.executePreview({
      workflow: {
        id: 13,
        workspaceId: 1,
        triggerType: 'ticket.created',
        draftDefinition: definition,
        publishedVersion: 0,
        versions: [],
      },
      definition,
      eventContext: {
        event: { type: 'ticket.created', source: 'test', occurredAt: '2026-05-29T19:00:00.000Z' },
        workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
        ticket: {
          id: 100,
          freshserviceTicketId: 225001,
          subject: 'VPN access problem',
          status: 'Open',
          priorityLabel: 'High',
          isNoise: false,
          ccEmails: ['manager@example.com', 'requester@example.com'],
          replyCcEmails: ['lead@example.com', 'Manager@example.com'],
        },
        requester: { name: 'Requester', email: 'requester@example.com' },
        assignedAgent: null,
        previousAgent: null,
      },
    });

    const sendStep = result.steps.find((step) => step.nodeType === 'send_email');
    expect(result.status).toBe('completed');
    expect(result.state.recipients.to).toEqual(['requester@example.com']);
    expect(result.state.recipients.cc).toEqual(['manager@example.com', 'lead@example.com']);
    expect(sendStep.output.ccRecipients).toEqual(['manager@example.com', 'lead@example.com']);
  });

  test('template render uses LLM output with template fallback without Liquid if statements', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.assigned');
    const template = definition.nodes.find((node) => node.id === 'template');
    template.data = {
      ...template.data,
      contentSource: 'llm_with_template_fallback',
      subject: 'Fallback #{{ ticket.freshserviceTicketId }}',
      html: '<p>Fallback {{ ticket.subject }}</p>',
      text: 'Fallback {{ ticket.subject }}',
    };
    definition.nodes.splice(3, 0, {
      id: 'llm-generate',
      type: 'llm_generate',
      position: { x: 650, y: 0 },
      data: {
        prompt: 'Skipped in this test',
        outputSchema: DEFAULT_LLM_OUTPUT_SCHEMA,
      },
    });
    definition.edges = [
      { id: 'trigger-to-condition', source: 'trigger', target: 'skip-noise' },
      { id: 'condition-true-to-recipients', source: 'skip-noise', sourceHandle: 'true', target: 'recipients' },
      { id: 'condition-false-to-stop', source: 'skip-noise', sourceHandle: 'false', target: 'stop-skipped' },
      { id: 'recipients-to-llm', source: 'recipients', target: 'llm-generate' },
      { id: 'llm-to-template', source: 'llm-generate', target: 'template' },
      { id: 'template-to-send', source: 'template', target: 'send' },
    ];

    const result = await notificationWorkflowEngine.executePreview({
      workflow: {
        id: 11,
        workspaceId: 1,
        triggerType: 'ticket.assigned',
        draftDefinition: definition,
        publishedVersion: 0,
        versions: [],
      },
      definition,
      eventContext: {
        event: { type: 'ticket.assigned', source: 'test', occurredAt: '2026-05-29T19:00:00.000Z' },
        workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
        ticket: {
          id: 100,
          freshserviceTicketId: 225001,
          subject: 'VPN access problem',
          status: 'Open',
          priorityLabel: 'High',
          isNoise: false,
        },
        requester: { name: 'Requester', email: 'requester@example.com' },
        assignedAgent: { name: 'Agent', email: 'agent@example.com' },
        previousAgent: null,
      },
      executeLlm: false,
    });

    expect(result.status).toBe('completed');
    expect(result.state.email.subject).toBe('Fallback #225001');
    expect(result.state.email.html).toContain('Fallback VPN access problem');
  });

  test('template render can use the public ticket status URL variable', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const template = definition.nodes.find((node) => node.id === 'template');
    template.data = {
      ...template.data,
      subject: 'Ticket #{{ ticket.freshserviceTicketId }} status',
      html: '<p>Status link: <a href="{{ ticket.publicStatusUrl }}">View ticket status</a></p>',
      text: 'Status link: {{ publicStatusUrl }}',
      plainTextMode: 'manual',
    };

    const result = await notificationWorkflowEngine.executePreview({
      workflow: {
        id: 12,
        workspaceId: 1,
        triggerType: 'ticket.created',
        draftDefinition: definition,
        publishedVersion: 0,
        versions: [],
      },
      definition,
      eventContext: {
        event: { type: 'ticket.created', source: 'test', occurredAt: '2026-05-29T19:00:00.000Z' },
        workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
        ticket: {
          id: 100,
          freshserviceTicketId: 225001,
          subject: 'VPN access problem',
          status: 'Open',
          priorityLabel: 'High',
          isNoise: false,
        },
        requester: { name: 'Requester', email: 'requester@example.com' },
        assignedAgent: null,
        previousAgent: null,
      },
    });

    expect(result.status).toBe('completed');
    expect(result.state.email.html).toContain('/ticket-status/public-status-token');
    expect(result.state.email.text).toContain('/ticket-status/public-status-token');
  });
});
