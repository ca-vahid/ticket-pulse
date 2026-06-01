import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const prismaMock = {
  ticket: {
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  notificationWorkflowRun: {
    findFirst: jest.fn(),
  },
  notificationDelivery: {
    create: jest.fn(),
  },
};

const repositoryMock = {
  getWorkflow: jest.fn(),
};

const buildNotificationLlmContextMock = jest.fn();
const summarizeNotificationLlmContextMock = jest.fn();
const getNotificationLlmToolPolicyMock = jest.fn();
const processDeliveryMock = jest.fn();
const finalizeWorkflowSendEmailMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAdmin: (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../src/services/notificationWorkflowRepository.js', () => ({
  default: repositoryMock,
}));

jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({
  default: {},
  finalizeWorkflowSendEmail: finalizeWorkflowSendEmailMock,
}));

jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: processDeliveryMock,
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/notificationWorkflowSignatureService.js', () => ({
  getWorkspaceSignature: jest.fn(),
  upsertWorkspaceSignature: jest.fn(),
}));

jest.unstable_mockModule('../src/services/notificationWorkflowPolicyService.js', () => ({
  enrichEventContextWithNotificationPolicy: jest.fn((context) => context),
  getNotificationWorkflowSchedulePreview: jest.fn(),
  getNotificationWorkflowPolicy: jest.fn(),
  isOffHoursWorkflow: jest.fn(),
  updateNotificationWorkflowPolicy: jest.fn(),
}));

jest.unstable_mockModule('../src/services/notificationContextEnrichmentService.js', () => ({
  buildNotificationLlmContext: buildNotificationLlmContextMock,
  summarizeNotificationLlmContext: summarizeNotificationLlmContextMock,
}));

jest.unstable_mockModule('../src/services/notificationLlmToolPolicyService.js', () => ({
  getNotificationLlmToolPolicy: getNotificationLlmToolPolicyMock,
  notificationLlmToolCatalog: jest.fn(),
  normalizeNotificationLlmToolPolicy: jest.fn((policy) => policy),
  updateNotificationLlmToolPolicy: jest.fn(),
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { default: notificationWorkflowRoutes } = await import('../src/routes/notificationWorkflow.routes.js');

const sampleTicket = {
  id: 501,
  workspaceId: 1,
  freshserviceTicketId: BigInt(225001),
  subject: 'VPN access problem',
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
  requester: {
    id: 40,
    name: 'Requester',
    email: 'requester@example.com',
    department: 'Operations',
    jobTitle: 'Lead',
  },
  assignedTech: {
    id: 12,
    name: 'Agent',
    email: 'agent@example.com',
    location: 'Vancouver',
    timezone: 'America/Vancouver',
  },
  internalCategory: { id: 5, name: 'Network' },
  internalSubcategory: { id: 6, name: 'VPN' },
};

function buildApp(workspaceId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspaceId = workspaceId;
    req.session = { user: { role: 'admin', email: 'admin@example.com' } };
    next();
  });
  app.use('/api/notification-workflows', notificationWorkflowRoutes);
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
      details: error.details || null,
    });
  });
  return app;
}

describe('notification workflow routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.count.mockResolvedValue(1);
    prismaMock.ticket.findMany.mockResolvedValue([sampleTicket]);
    prismaMock.ticket.findFirst.mockResolvedValue(sampleTicket);
    prismaMock.notificationWorkflowRun.findFirst.mockResolvedValue(null);
    prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
    processDeliveryMock.mockResolvedValue({ success: true, providerMessageId: 'sg-test' });
    finalizeWorkflowSendEmailMock.mockImplementation(async ({ email }) => email);
    repositoryMock.getWorkflow.mockResolvedValue({
      id: 7,
      workspaceId: 1,
      key: 'ticket_created',
      name: 'Ticket arrived',
      triggerType: 'ticket.created',
      publishedVersion: 1,
    });
    getNotificationLlmToolPolicyMock.mockResolvedValue({
      mode: 'context_only',
      enabledTools: [],
      toolSettings: {},
    });
    buildNotificationLlmContextMock.mockResolvedValue({
      bundleVersion: 1,
      generatedAt: '2026-05-31T00:00:00.000Z',
      ticket: { freshserviceTicketId: '225001' },
    });
    summarizeNotificationLlmContextMock.mockReturnValue({
      enabled: true,
      mode: 'context_only',
    });
  });

  test('preview-tickets searches numeric input as a FreshService ticket number', async () => {
    const response = await request(buildApp())
      .get('/api/notification-workflows/preview-tickets')
      .query({ search: '225001' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.items[0]).toEqual(expect.objectContaining({
      id: 501,
      freshserviceTicketId: '225001',
      subject: 'VPN access problem',
    }));
    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: 1,
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              { freshserviceTicketId: BigInt(225001) },
            ]),
          }),
        ]),
      }),
    }));
  });

  test('context-preview accepts an internal Ticket Pulse ticket ID', async () => {
    const response = await request(buildApp())
      .post('/api/notification-workflows/llm-tools/context-preview')
      .send({ ticketId: 501, workflowId: 7 })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 501,
        workspaceId: 1,
      },
    }));
    expect(buildNotificationLlmContextMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 1,
      workflow: expect.objectContaining({ id: 7 }),
      policyOverride: expect.objectContaining({ mode: 'context_only' }),
    }));
  });

  test('context-preview accepts a FreshService ticket number', async () => {
    const response = await request(buildApp())
      .post('/api/notification-workflows/llm-tools/context-preview')
      .send({ freshserviceTicketId: '225001', workflowId: 7 })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        freshserviceTicketId: BigInt(225001),
        workspaceId: 1,
      },
    }));
  });

  test('context-preview rejects tickets outside the selected workspace', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(null);

    const response = await request(buildApp(2))
      .post('/api/notification-workflows/llm-tools/context-preview')
      .send({ freshserviceTicketId: '225001', workflowId: 7 })
      .expect(404);

    expect(response.body.message).toBe('Context preview ticket not found in this workspace');
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        freshserviceTicketId: BigInt(225001),
        workspaceId: 2,
      },
    }));
  });

  test('sends a test email from a mock audit run even when no delivery row was created', async () => {
    finalizeWorkflowSendEmailMock.mockResolvedValueOnce({
      subject: 'Ticket #225001 received',
      html: '<p>We received it.</p><div>Helpful ticket links</div><div>Need immediate after-hours support?</div>',
      text: 'We received it.\n\nHelpful ticket links\n\nNeed immediate after-hours support?',
      actionLinks: {
        publicStatus: { applied: true },
        afterHoursSupport: { applied: true },
      },
    });
    prismaMock.notificationWorkflowRun.findFirst.mockResolvedValueOnce({
      id: 77,
      workspaceId: 1,
      workflowId: 7,
      eventType: 'ticket.created',
      eventContext: {
        event: { type: 'ticket.created' },
        availability: { isBusinessHours: false, isAfterHours: true },
        publicStatusUrl: 'https://ticketpulse.example/status',
        afterHoursSupport: { immediateSupportUrl: 'https://ticketpulse.example/escalate' },
      },
      workflow: {
        id: 7,
        workspaceId: 1,
        name: 'Ticket arrived after-hours / holiday',
        key: 'ticket_created_after_hours',
        triggerType: 'ticket.created',
        publishedVersion: 1,
        publishedDefinition: {
          metadata: { scheduleMode: 'after_hours' },
          nodes: [
            {
              id: 'send',
              type: 'send_email',
              data: {
                appendPublicStatusLink: true,
                appendAfterHoursSupportLink: true,
              },
            },
          ],
        },
      },
      ticket: {
        id: 501,
        assessedPriority: 'High',
        priority: 3,
      },
      steps: [
        {
          id: 701,
          nodeType: 'recipient_resolver',
          output: { recipients: { to: [], cc: [], bcc: [] } },
        },
        {
          id: 702,
          nodeType: 'template_render',
          output: {
            email: {
              subject: 'Ticket #225001 received',
              html: '<p>We received it.</p>',
              text: 'We received it.',
            },
          },
        },
        {
          id: 703,
          nodeId: 'send',
          nodeType: 'send_email',
          output: { skipped: true, reason: 'No recipient email address resolved' },
        },
      ],
      deliveries: [],
    });

    const response = await request(buildApp())
      .post('/api/notification-workflows/audits/TP-NWF-77/send-test-email')
      .send({})
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.sentTo).toBe('admin@example.com');
    expect(finalizeWorkflowSendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      eventContext: expect.objectContaining({
        publicStatusUrl: 'https://ticketpulse.example/status',
      }),
      nodeData: expect.objectContaining({
        appendPublicStatusLink: true,
        appendAfterHoursSupportLink: true,
      }),
      workflowScheduleMode: 'after_hours',
    }));
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workflowRunId: 77,
        workflowStepRunId: 703,
        ticketId: 501,
        recipient: 'admin@example.com',
        toRecipients: ['admin@example.com'],
        notificationType: 'notification_workflow_test_email',
        subject: '[TEST] Ticket #225001 received',
        htmlBody: expect.stringContaining('Helpful ticket links'),
        payload: expect.objectContaining({
          mockAuditReplay: true,
          auditId: 'TP-NWF-77',
        }),
      }),
    }));
    expect(processDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 900,
      recipient: 'admin@example.com',
    }));
  });
});
