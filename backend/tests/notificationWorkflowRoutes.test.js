import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const prismaMock = {
  ticket: {
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  notificationWorkflow: {
    groupBy: jest.fn(),
    count: jest.fn(),
  },
  notificationWorkflowRun: {
    findFirst: jest.fn(),
    count: jest.fn(),
  },
  notificationWorkflowStepRun: {
    findMany: jest.fn(),
  },
  notificationDelivery: {
    create: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  aiProviderAttempt: {
    groupBy: jest.fn(),
  },
};

const repositoryMock = {
  listWorkflows: jest.fn(),
  ensureDefaultWorkflows: jest.fn(),
  getWorkflow: jest.fn(),
  createWorkflowVariant: jest.fn(),
  duplicateWorkflowVariant: jest.fn(),
  updateWorkflowRouting: jest.fn(),
  setWorkflowArchived: jest.fn(),
  deleteArchivedWorkflowVariant: jest.fn(),
  listAuditRuns: jest.fn(),
  listRuns: jest.fn(),
  saveDraft: jest.fn(),
  publishWorkflow: jest.fn(),
  setWorkflowMockMode: jest.fn(),
  setWorkflowEnabled: jest.fn(),
};

const buildNotificationLlmContextMock = jest.fn();
const summarizeNotificationLlmContextMock = jest.fn();
const getNotificationLlmToolPolicyMock = jest.fn();
const processDeliveryMock = jest.fn();
const finalizeWorkflowSendEmailMock = jest.fn();
const getSendGridConfigMock = jest.fn();
const listWorkspaceEmailBlocksMock = jest.fn();
const createWorkspaceEmailBlockMock = jest.fn();
const updateWorkspaceEmailBlockMock = jest.fn();
const deleteWorkspaceEmailBlockMock = jest.fn();
const setDefaultWorkspaceEmailBlockMock = jest.fn();
const getWorkspaceSignatureMock = jest.fn();
const upsertWorkspaceSignatureMock = jest.fn();

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
  sanitizeWorkflowAuditPayload: (value) => value,
}));

jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: processDeliveryMock,
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {
    getSendGridConfig: getSendGridConfigMock,
  },
}));

jest.unstable_mockModule('../src/services/notificationWorkflowSignatureService.js', () => ({
  createWorkspaceEmailBlock: createWorkspaceEmailBlockMock,
  deleteWorkspaceEmailBlock: deleteWorkspaceEmailBlockMock,
  getWorkspaceSignature: getWorkspaceSignatureMock,
  listWorkspaceEmailBlocks: listWorkspaceEmailBlocksMock,
  setDefaultWorkspaceEmailBlock: setDefaultWorkspaceEmailBlockMock,
  updateWorkspaceEmailBlock: updateWorkspaceEmailBlockMock,
  upsertWorkspaceSignature: upsertWorkspaceSignatureMock,
}));

jest.unstable_mockModule('../src/services/notificationWorkflowPolicyService.js', () => ({
  enrichEventContextWithNotificationPolicy: jest.fn((context) => context),
  getNotificationWorkflowSchedulePreview: jest.fn(),
  getNotificationWorkflowPolicy: jest.fn(),
  isOffHoursWorkflow: jest.fn(),
  selectWorkflowsForNotificationTiming: jest.fn((workflows) => ({
    selected: workflows,
    suppressed: [],
    mode: 'standard',
    reason: null,
  })),
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
    prismaMock.notificationWorkflow.groupBy.mockResolvedValue([
      { isEnabled: true, _count: { _all: 2 } },
      { isEnabled: false, _count: { _all: 1 } },
    ]);
    prismaMock.notificationWorkflow.count.mockResolvedValue(1);
    prismaMock.notificationWorkflowRun.findFirst.mockResolvedValue(null);
    prismaMock.notificationWorkflowRun.count.mockResolvedValue(4);
    prismaMock.notificationWorkflowStepRun.findMany.mockResolvedValue([]);
    prismaMock.aiProviderAttempt.groupBy.mockResolvedValue([]);
    prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
    prismaMock.notificationDelivery.count.mockResolvedValue(3);
    prismaMock.notificationDelivery.findMany.mockResolvedValue([]);
    prismaMock.notificationDelivery.groupBy.mockResolvedValue([]);
    getSendGridConfigMock.mockResolvedValue({ configured: true, mode: 'mock' });
    processDeliveryMock.mockResolvedValue({ success: true, providerMessageId: 'sg-test' });
    finalizeWorkflowSendEmailMock.mockImplementation(async ({ email }) => email);
    listWorkspaceEmailBlocksMock.mockResolvedValue({
      items: [
        { id: 11, workspaceId: 1, type: 'header', name: 'Default header', enabled: true, isDefault: true, html: '<p>Header</p>', text: 'Header' },
        { id: 12, workspaceId: 1, type: 'footer', name: 'Default footer', enabled: true, isDefault: true, html: '<p>Footer</p>', text: 'Footer' },
      ],
      headers: [{ id: 11, workspaceId: 1, type: 'header', name: 'Default header', enabled: true, isDefault: true, html: '<p>Header</p>', text: 'Header' }],
      footers: [{ id: 12, workspaceId: 1, type: 'footer', name: 'Default footer', enabled: true, isDefault: true, html: '<p>Footer</p>', text: 'Footer' }],
      maxHtmlBytes: 524288,
    });
    createWorkspaceEmailBlockMock.mockResolvedValue({ id: 13, workspaceId: 1, type: 'footer', name: 'Alt footer' });
    updateWorkspaceEmailBlockMock.mockResolvedValue({ id: 12, workspaceId: 1, type: 'footer', name: 'Updated footer' });
    deleteWorkspaceEmailBlockMock.mockResolvedValue({ id: 12, workspaceId: 1, type: 'footer', name: 'Deleted footer' });
    setDefaultWorkspaceEmailBlockMock.mockResolvedValue({ id: 12, workspaceId: 1, type: 'footer', name: 'Default footer' });
    getWorkspaceSignatureMock.mockResolvedValue({ enabled: true, html: '<p>Footer</p>', text: 'Footer', maxHtmlBytes: 524288 });
    upsertWorkspaceSignatureMock.mockResolvedValue({ workspaceId: 1 });
    repositoryMock.getWorkflow.mockResolvedValue({
      id: 7,
      workspaceId: 1,
      key: 'ticket_created',
      name: 'Ticket arrived',
      triggerType: 'ticket.created',
      routingMode: 'exclusive',
      routingPriority: 100,
      routingRule: null,
      isDefaultVariant: true,
      archivedAt: null,
      publishedVersion: 1,
    });
    repositoryMock.listWorkflows.mockResolvedValue([
      {
        id: 7,
        workspaceId: 1,
        key: 'ticket_created',
        name: 'Ticket arrived',
        triggerType: 'ticket.created',
        routingMode: 'exclusive',
        routingPriority: 100,
        routingRule: null,
        isDefaultVariant: true,
        archivedAt: null,
        publishedVersion: 1,
        draftDefinition: { metadata: { scheduleMode: 'standard' } },
        publishedDefinition: { metadata: { scheduleMode: 'standard' } },
      },
    ]);
    repositoryMock.ensureDefaultWorkflows.mockResolvedValue([]);
    repositoryMock.createWorkflowVariant.mockResolvedValue({
      id: 81,
      workspaceId: 1,
      key: 'ticket_created_brisbane',
      name: 'Brisbane variant',
      triggerType: 'ticket.created',
      routingMode: 'exclusive',
      routingPriority: 25,
      routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] },
      isDefaultVariant: false,
      archivedAt: null,
      publishedVersion: 0,
    });
    repositoryMock.duplicateWorkflowVariant.mockResolvedValue({
      id: 82,
      workspaceId: 1,
      key: 'ticket_created_copy',
      name: 'Ticket arrived variant',
      triggerType: 'ticket.created',
      routingMode: 'exclusive',
      routingPriority: 60,
      routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] },
      isDefaultVariant: false,
      archivedAt: null,
      publishedVersion: 0,
    });
    repositoryMock.updateWorkflowRouting.mockResolvedValue({
      id: 81,
      workspaceId: 1,
      routingMode: 'additive',
      routingPriority: 30,
      routingRule: { '==': [{ var: 'requester.locationKey' }, 'AU-BRISBANE'] },
    });
    repositoryMock.setWorkflowArchived.mockResolvedValue({
      id: 81,
      workspaceId: 1,
      archivedAt: new Date('2026-06-04T00:00:00.000Z'),
      archivedBy: 'admin@example.com',
      isEnabled: false,
    });
    repositoryMock.listAuditRuns.mockResolvedValue([]);
    repositoryMock.listRuns.mockResolvedValue([]);
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

  test('email block routes list workspace-scoped blocks', async () => {
    const response = await request(buildApp(3))
      .get('/api/notification-workflows/email-blocks')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.headers).toHaveLength(1);
    expect(listWorkspaceEmailBlocksMock).toHaveBeenCalledWith(3);
  });

  test('email block routes create update default and delete blocks', async () => {
    await request(buildApp())
      .post('/api/notification-workflows/email-blocks')
      .send({ type: 'footer', name: 'Alt footer', html: '<p>Alt</p>' })
      .expect(201);
    expect(createWorkspaceEmailBlockMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: 'footer', name: 'Alt footer' }),
      expect.objectContaining({ email: 'admin@example.com' }),
    );

    await request(buildApp())
      .put('/api/notification-workflows/email-blocks/12')
      .send({ name: 'Updated footer', enabled: false })
      .expect(200);
    expect(updateWorkspaceEmailBlockMock).toHaveBeenCalledWith(
      1,
      12,
      expect.objectContaining({ name: 'Updated footer', enabled: false }),
      expect.objectContaining({ email: 'admin@example.com' }),
    );

    await request(buildApp())
      .post('/api/notification-workflows/email-blocks/12/default')
      .expect(200);
    expect(setDefaultWorkspaceEmailBlockMock).toHaveBeenCalledWith(
      1,
      12,
      expect.objectContaining({ email: 'admin@example.com' }),
    );

    await request(buildApp())
      .delete('/api/notification-workflows/email-blocks/12')
      .expect(200);
    expect(deleteWorkspaceEmailBlockMock).toHaveBeenCalledWith(1, 12);
  });

  test('email block routes return not found when a block is outside the workspace scope', async () => {
    const error = new Error('Email branding block not found');
    error.statusCode = 404;
    updateWorkspaceEmailBlockMock.mockRejectedValueOnce(error);

    const response = await request(buildApp(2))
      .put('/api/notification-workflows/email-blocks/12')
      .send({ name: 'Wrong workspace' })
      .expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Email branding block not found');
    expect(updateWorkspaceEmailBlockMock).toHaveBeenCalledWith(
      2,
      12,
      expect.objectContaining({ name: 'Wrong workspace' }),
      expect.any(Object),
    );
  });

  test('legacy signature routes still read and write the default footer shape', async () => {
    const getResponse = await request(buildApp())
      .get('/api/notification-workflows/signature')
      .expect(200);

    expect(getResponse.body.data).toEqual(expect.objectContaining({
      enabled: true,
      html: '<p>Footer</p>',
      text: 'Footer',
    }));
    expect(getWorkspaceSignatureMock).toHaveBeenCalledWith(1);

    const putResponse = await request(buildApp())
      .put('/api/notification-workflows/signature')
      .send({ enabled: true, html: '<p>Updated</p>' })
      .expect(200);

    expect(putResponse.body.data).toEqual(expect.objectContaining({ enabled: true }));
    expect(upsertWorkspaceSignatureMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ enabled: true, html: '<p>Updated</p>' }),
      expect.objectContaining({ email: 'admin@example.com' }),
    );
  });

  test('variant lifecycle routes create duplicate update routing archive and delete within workspace', async () => {
    const routingRule = { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] };

    const createResponse = await request(buildApp(3))
      .post('/api/notification-workflows')
      .send({
        triggerType: 'ticket.created',
        name: 'Brisbane variant',
        routingMode: 'exclusive',
        routingPriority: 25,
        routingRule,
      })
      .expect(201);

    expect(createResponse.body.data).toEqual(expect.objectContaining({
      id: 81,
      isDefaultVariant: false,
      publishedVersion: 0,
    }));
    expect(repositoryMock.createWorkflowVariant).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ triggerType: 'ticket.created', routingRule }),
      expect.objectContaining({ email: 'admin@example.com' }),
    );

    await request(buildApp(3))
      .post('/api/notification-workflows/81/duplicate')
      .send({ name: 'Brisbane variant copy' })
      .expect(201);
    expect(repositoryMock.duplicateWorkflowVariant).toHaveBeenCalledWith(
      3,
      '81',
      expect.objectContaining({ name: 'Brisbane variant copy' }),
      expect.objectContaining({ email: 'admin@example.com' }),
    );

    await request(buildApp(3))
      .put('/api/notification-workflows/81/routing')
      .send({
        routingMode: 'additive',
        routingPriority: 30,
        routingRule: { '==': [{ var: 'requester.locationKey' }, 'AU-BRISBANE'] },
      })
      .expect(200);
    expect(repositoryMock.updateWorkflowRouting).toHaveBeenCalledWith(
      3,
      '81',
      expect.objectContaining({ routingMode: 'additive', routingPriority: 30 }),
      expect.objectContaining({ email: 'admin@example.com' }),
    );

    await request(buildApp(3))
      .put('/api/notification-workflows/81/archive')
      .send({ archived: true })
      .expect(200);
    expect(repositoryMock.setWorkflowArchived).toHaveBeenCalledWith(
      3,
      '81',
      true,
      expect.objectContaining({ email: 'admin@example.com' }),
    );

    repositoryMock.deleteArchivedWorkflowVariant.mockResolvedValueOnce({
      id: 81,
      deleted: true,
      deletedRunCount: 2,
    });

    const deleteResponse = await request(buildApp(3))
      .delete('/api/notification-workflows/81')
      .expect(200);

    expect(deleteResponse.body.data).toEqual(expect.objectContaining({
      id: 81,
      deleted: true,
    }));
    expect(repositoryMock.deleteArchivedWorkflowVariant).toHaveBeenCalledWith(
      3,
      '81',
    );
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

  test('routing metadata lists normalized requester values for the workspace', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([{
      ...sampleTicket,
      requester: {
        ...sampleTicket.requester,
        department: 'Brisbane',
        entraOfficeLocation: null,
        entraCity: null,
        entraCountry: null,
        entraCountryCode: null,
      },
    }]);

    const response = await request(buildApp())
      .get('/api/notification-workflows/routing/metadata')
      .query({ field: 'requester.regionKey' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'requester.regionKey', label: 'Requester region' }),
    ]));
    expect(response.body.data.values).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: 'AU-BRISBANE',
        count: 1,
        sources: expect.arrayContaining(['FreshService fallback']),
      }),
    ]));
  });

  test('routing preview evaluates current routing settings against a real ticket without sending', async () => {
    const brisbaneWorkflow = {
      id: 81,
      workspaceId: 1,
      key: 'ticket_created_brisbane',
      name: 'Brisbane variant',
      triggerType: 'ticket.created',
      routingMode: 'exclusive',
      routingPriority: 1,
      routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] },
      isDefaultVariant: false,
      archivedAt: null,
      publishedVersion: 1,
      draftDefinition: { metadata: { scheduleMode: 'standard' } },
      publishedDefinition: { metadata: { scheduleMode: 'standard' } },
    };
    const brisbaneTicket = {
      ...sampleTicket,
      requester: {
        ...sampleTicket.requester,
        department: 'Brisbane',
        entraOfficeLocation: null,
        entraCity: null,
        entraCountry: 'Australia',
        entraCountryCode: 'AU',
      },
    };
    repositoryMock.getWorkflow.mockResolvedValueOnce(brisbaneWorkflow);
    repositoryMock.listWorkflows.mockResolvedValueOnce([
      {
        id: 7,
        workspaceId: 1,
        key: 'ticket_created',
        name: 'Ticket arrived',
        triggerType: 'ticket.created',
        routingMode: 'exclusive',
        routingPriority: 100,
        routingRule: null,
        isDefaultVariant: true,
        archivedAt: null,
        draftDefinition: { metadata: { scheduleMode: 'standard' } },
        publishedDefinition: { metadata: { scheduleMode: 'standard' } },
      },
      brisbaneWorkflow,
    ]);
    prismaMock.ticket.findFirst.mockResolvedValueOnce(brisbaneTicket);

    const response = await request(buildApp())
      .post('/api/notification-workflows/routing/preview')
      .send({
        workflowId: 81,
        freshserviceTicketId: '225001',
        triggerType: 'ticket.created',
        routingMode: 'exclusive',
        routingPriority: 1,
        routingRule: { '==': [{ var: 'requester.regionKey' }, 'AU-BRISBANE'] },
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.requester).toEqual(expect.objectContaining({
      regionKey: 'AU-BRISBANE',
      locationKey: 'AU-BRISBANE',
    }));
    expect(response.body.data.routingPreview).toEqual(expect.objectContaining({
      wouldRunSelectedWorkflow: true,
      selectedWorkflowIds: [81],
      fallbackWorkflowId: null,
    }));
    expect(response.body.data.routingPreview.selectedWorkflows).toEqual([
      expect.objectContaining({ id: 81, name: 'Brisbane variant' }),
    ]);
  });

  test('health exposes duplicate mock delivery groups as a warning', async () => {
    prismaMock.notificationDelivery.groupBy.mockResolvedValueOnce([
      {
        ticketId: 501,
        eventType: 'ticket.assigned',
        notificationType: 'ticket.assigned',
        _count: { _all: 2 },
      },
      {
        ticketId: 502,
        eventType: 'ticket.created',
        notificationType: 'ticket.created',
        _count: { _all: 1 },
      },
    ]);
    prismaMock.notificationWorkflowStepRun.findMany.mockResolvedValueOnce([
      {
        nodeType: 'send_email',
        output: { duplicateDelivery: true },
        run: { eventType: 'ticket.assigned', triggerSource: 'freshservice_webhook' },
      },
      {
        nodeType: 'send_email',
        output: { duplicateDelivery: true },
        run: { eventType: 'ticket.assigned', triggerSource: 'freshservice_webhook' },
      },
      {
        nodeType: 'send_email',
        output: { duplicateDelivery: false },
        run: { eventType: 'ticket.created', triggerSource: 'freshservice_sync' },
      },
    ]);
    prismaMock.aiProviderAttempt.groupBy.mockResolvedValueOnce([
      {
        provider: 'openai',
        model: 'gpt-test',
        errorClass: 'bad_request',
        _count: { _all: 2 },
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-test',
        errorClass: 'api_timeout',
        _count: { _all: 3 },
      },
    ]);

    const response = await request(buildApp())
      .get('/api/notification-workflows/health')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.duplicateMockDeliveryGroups7d).toEqual([
      {
        ticketId: 501,
        eventType: 'ticket.assigned',
        notificationType: 'ticket.assigned',
        count: 2,
      },
    ]);
    expect(response.body.data.suppressedDuplicateDeliveriesBySource7d).toEqual([
      {
        triggerSource: 'freshservice_webhook',
        eventType: 'ticket.assigned',
        count: 2,
      },
    ]);
    expect(response.body.data.providerSchemaFailures7d).toBe(2);
    expect(response.body.data.providerTimeoutFailures7d).toBe(3);
    expect(response.body.data.providerFailuresSummary7d).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-test',
        errorClass: 'api_timeout',
        count: 3,
      },
      {
        provider: 'openai',
        model: 'gpt-test',
        errorClass: 'bad_request',
        count: 2,
      },
    ]);
    expect(response.body.data.warnings).toEqual([
      expect.objectContaining({
        type: 'duplicate_mock_delivery_groups',
        count: 1,
      }),
      expect.objectContaining({
        type: 'provider_schema_failures',
        count: 2,
      }),
      expect.objectContaining({
        type: 'provider_timeout_failures',
        count: 3,
      }),
    ]);
    expect(prismaMock.notificationDelivery.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['ticketId', 'eventType', 'notificationType'],
      where: expect.objectContaining({
        workspaceId: 1,
        channel: 'email',
        status: 'mocked',
        notificationType: { not: 'notification_workflow_test_email' },
        queuedAt: { gte: expect.any(Date) },
      }),
    }));
    expect(prismaMock.notificationDelivery.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({
        ticketId: expect.anything(),
      }),
    }));
    expect(prismaMock.notificationWorkflowStepRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: 1,
        nodeType: { in: ['send_email', 'llm_generate'] },
        startedAt: { gte: expect.any(Date) },
      }),
      select: expect.objectContaining({
        nodeType: true,
        output: true,
        run: expect.any(Object),
      }),
    }));
    expect(prismaMock.aiProviderAttempt.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['provider', 'model', 'errorClass'],
      where: expect.objectContaining({
        workspaceId: 1,
        operation: 'notification_workflow_generation',
        status: 'failed',
        startedAt: { gte: expect.any(Date) },
      }),
      _count: { _all: true },
    }));
    expect(prismaMock.aiProviderAttempt.groupBy.mock.calls[0][0].where).not.toHaveProperty('createdAt');
  });

  test('health exposes operational monitoring warnings for degraded workflow quality', async () => {
    prismaMock.notificationWorkflowStepRun.findMany.mockResolvedValueOnce([
      ...Array.from({ length: 10 }, () => ({
        nodeType: 'send_email',
        output: { duplicateDelivery: true },
        run: { eventType: 'ticket.assigned', triggerSource: 'assignment_pipeline' },
      })),
      {
        nodeType: 'llm_generate',
        output: {
          llm: {
            templateFallbackUsed: true,
            guard: { issues: [{ policyTier: 'hard_block', ruleId: 'internal_reference' }] },
            context: { signalLevel: 'possible_broader_issue' },
          },
        },
        run: { eventType: 'ticket.assigned', triggerSource: 'assignment_pipeline' },
      },
      {
        nodeType: 'llm_generate',
        output: { llm: { context: { signalLevel: 'watch' } } },
        run: { eventType: 'ticket.created', triggerSource: 'freshservice_webhook' },
      },
    ]);
    prismaMock.notificationDelivery.findMany.mockResolvedValueOnce([
      {
        id: 991,
        payload: {
          actionLinks: {
            afterHoursSupport: {
              activeContact: { phone: '+16045551234' },
            },
          },
        },
      },
    ]);

    const response = await request(buildApp())
      .get('/api/notification-workflows/health')
      .expect(200);

    expect(response.body.data.duplicateSuppressions7d).toBe(10);
    expect(response.body.data.workflowQuality7d).toEqual(expect.objectContaining({
      llmGenerateSteps: 2,
      templateFallbacks: 1,
      guardHardBlocks: 1,
      possibleBroaderIssueCount: 1,
      possibleBroaderIssueRatePct: 50,
      payloadMinimizationFailures: 1,
      payloadMinimizationFailureSampleIds: [991],
    }));
    expect(response.body.data.notificationWorkflowHealthThresholds).toEqual(expect.objectContaining({
      duplicateSuppressionSpike7d: 10,
      templateFallbacks7d: 0,
      guardHardBlocks7d: 0,
      payloadMinimizationFailures7d: 0,
      possibleBroaderIssueRatePct: 25,
    }));
    expect(response.body.data.warnings.map((warning) => warning.type)).toEqual([
      'duplicate_suppression_spike',
      'template_fallback_rate',
      'guard_hard_block_count',
      'payload_minimization_failure',
      'possible_broader_issue_rate',
    ]);
    expect(prismaMock.notificationDelivery.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: 1,
        workflowRunId: { not: null },
        notificationType: { not: 'notification_workflow_test_email' },
        queuedAt: { gte: expect.any(Date) },
      }),
      select: expect.objectContaining({
        id: true,
        payload: true,
      }),
    }));
  });

  test('audit run list includes computed health and fallback cause', async () => {
    repositoryMock.listAuditRuns.mockResolvedValueOnce([
      {
        id: 77,
        workspaceId: 1,
        workflowId: 7,
        eventType: 'ticket.assigned',
        status: 'completed',
        executionMode: 'mock',
        startedAt: new Date('2026-06-03T20:10:00.000Z'),
        completedAt: new Date('2026-06-03T20:10:08.000Z'),
        eventContext: {},
        workflow: { id: 7, key: 'ticket_assigned', name: 'Ticket assigned' },
        ticket: { id: 501, freshserviceTicketId: BigInt(225001), subject: 'VPN access problem' },
        steps: [
          {
            id: 701,
            nodeId: 'llm-1',
            nodeType: 'llm_generate',
            status: 'completed',
            input: {},
            output: {
              failed: true,
              failureType: 'provider_or_schema',
              templateFallbackUsed: true,
              error: "400 Unknown parameter: input[2].parsed_arguments",
              provider: 'openai',
              model: 'gpt-5.5',
            },
          },
        ],
        deliveries: [],
        aiProviderAttempts: [
          {
            provider: 'openai',
            model: 'gpt-5.5',
            status: 'failed',
            errorClass: 'bad_request',
            errorMessage: "400 Unknown parameter: input[2].parsed_arguments",
          },
        ],
      },
    ]);

    const response = await request(buildApp())
      .get('/api/notification-workflows/runs?health=completed_with_fallback&search=parsed_arguments')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toEqual(expect.objectContaining({
      auditId: 'TP-NWF-77',
      health: expect.objectContaining({
        state: 'completed_with_fallback',
        fallbackUsed: true,
        fallbackSummary: expect.objectContaining({
          type: 'provider_or_schema',
          reason: "400 Unknown parameter: input[2].parsed_arguments",
          provider: 'openai',
          model: 'gpt-5.5',
        }),
      }),
      fallbackSummary: expect.objectContaining({
        type: 'provider_or_schema',
      }),
    }));
  });

  test('audit run list marks audit-only LLM findings as warnings', async () => {
    repositoryMock.listAuditRuns.mockResolvedValueOnce([
      {
        id: 88,
        workspaceId: 1,
        status: 'completed',
        eventType: 'ticket.created',
        triggerSource: 'preview',
        executionMode: 'preview',
        startedAt: new Date('2026-06-04T06:00:00.000Z'),
        completedAt: new Date('2026-06-04T06:00:05.000Z'),
        workflow: { id: 7, key: 'ticket_created', name: 'Ticket arrived' },
        ticket: { id: 501, freshserviceTicketId: BigInt(225001), subject: 'VPN access problem' },
        steps: [
          {
            id: 702,
            nodeId: 'llm-1',
            nodeType: 'llm_generate',
            status: 'completed',
            input: {},
            output: {
              llm: {
                provider: 'anthropic',
                model: 'claude-sonnet-4-6',
                warning: 'Requester-facing LLM output has audit-only style findings.',
                guard: {
                  accepted: true,
                  auditOnlyIssues: [{ id: 'playful_tone', policyTier: 'audit_only', actionTaken: 'warned' }],
                },
              },
            },
          },
        ],
        deliveries: [],
        aiProviderAttempts: [],
      },
    ]);

    const response = await request(buildApp())
      .get('/api/notification-workflows/runs')
      .expect(200);

    expect(response.body.data[0].health).toEqual(expect.objectContaining({
      state: 'completed_with_warning',
      degraded: true,
    }));
    expect(response.body.data[0].warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'llm_warning',
        templateFallbackUsed: false,
      }),
    ]));
    expect(response.body.data[0].warnings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'llm_failed' }),
    ]));
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

  test('test-email sends the displayed preview body when an audit id is present', async () => {
    prismaMock.notificationWorkflowRun.findFirst.mockResolvedValueOnce({
      id: 295,
      workspaceId: 1,
      workflowId: 7,
      eventType: 'ticket.created',
      ticketId: 501,
      eventContext: {
        event: { type: 'ticket.created' },
        availability: { isBusinessHours: false, isAfterHours: true },
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
      steps: [
        {
          id: 951,
          nodeId: 'template',
          nodeType: 'template_render',
          output: {
            email: {
              subject: 'Ticket #225574 received',
              html: '<p>We received it.</p><div>Helpful ticket links</div>',
              text: 'We received it.\n\nHelpful ticket links',
            },
          },
        },
        {
          id: 952,
          nodeId: 'send',
          nodeType: 'send_email',
          output: { skipped: true, reason: 'Mock delivery' },
        },
      ],
      deliveries: [],
    });

    const response = await request(buildApp())
      .post('/api/notification-workflows/test-email')
      .send({
        workflowId: 7,
        ticketId: 501,
        previewRunId: 'TP-NWF-295',
        auditId: 'TP-NWF-295',
        subject: 'Ticket #225574 received',
        html: '<p>We received it.</p><div>Need immediate after-hours support?</div>',
        text: 'We received it.\n\nNeed immediate after-hours support?',
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(finalizeWorkflowSendEmailMock).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workflowRunId: 295,
        workflowStepRunId: 952,
        ticketId: 501,
        recipient: 'admin@example.com',
        subject: '[TEST] Ticket #225574 received',
        htmlBody: expect.stringContaining('Need immediate after-hours support?'),
        textBody: expect.stringContaining('Need immediate after-hours support?'),
        payload: expect.objectContaining({
          previewRunTest: true,
          auditId: 'TP-NWF-295',
        }),
      }),
    }));
    const createdDelivery = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(createdDelivery.htmlBody).not.toContain('Helpful ticket links');
  });

  test('sends a test email from a mock audit run even when no delivery row was created', async () => {
    finalizeWorkflowSendEmailMock.mockResolvedValueOnce({
      subject: 'Ticket #225001 received',
      html: '<p>We received it.</p><div>Helpful ticket links</div><div>Request immediate support</div>',
      text: 'We received it.\n\nHelpful ticket links\n\nRequest immediate support',
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

  test('replays mock audit test email with finalized header and footer content', async () => {
    finalizeWorkflowSendEmailMock.mockResolvedValueOnce({
      subject: 'Ticket #225001 received',
      html: '<div class="tp-header">Workspace header</div><p>We received it.</p><div class="tp-footer">Alternate footer</div>',
      text: 'Workspace header\n\nWe received it.\n\nAlternate footer',
      branding: {
        header: {
          requested: true,
          applied: true,
          blockId: 31,
          blockName: 'Workspace header',
        },
        footer: {
          requested: true,
          applied: true,
          blockId: 41,
          blockName: 'Alternate footer',
        },
      },
    });
    prismaMock.notificationWorkflowRun.findFirst.mockResolvedValueOnce({
      id: 78,
      workspaceId: 1,
      workflowId: 7,
      eventType: 'ticket.created',
      eventContext: {
        event: { type: 'ticket.created' },
        availability: { isBusinessHours: false, isAfterHours: true },
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
                includeHeader: true,
                headerBlockId: 31,
                includeFooter: true,
                footerBlockId: 41,
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
          id: 801,
          nodeType: 'recipient_resolver',
          output: { recipients: { to: ['requester@example.com'], cc: [], bcc: [] } },
        },
        {
          id: 802,
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
          id: 803,
          nodeId: 'send',
          nodeType: 'send_email',
          output: { skipped: true, reason: 'Mock delivery' },
        },
      ],
      deliveries: [],
    });

    const response = await request(buildApp())
      .post('/api/notification-workflows/audits/TP-NWF-78/send-test-email')
      .send({})
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(finalizeWorkflowSendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      nodeData: expect.objectContaining({
        includeHeader: true,
        headerBlockId: 31,
        includeFooter: true,
        footerBlockId: 41,
      }),
      workflowScheduleMode: 'after_hours',
    }));
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workflowRunId: 78,
        workflowStepRunId: 803,
        ticketId: 501,
        recipient: 'admin@example.com',
        subject: '[TEST] Ticket #225001 received',
        htmlBody: expect.stringContaining('Workspace header'),
        textBody: expect.stringContaining('Alternate footer'),
        payload: expect.objectContaining({
          mockAuditReplay: true,
          auditId: 'TP-NWF-78',
          originalRecipients: expect.objectContaining({
            to: ['requester@example.com'],
          }),
        }),
      }),
    }));
    const createdDelivery = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(createdDelivery.htmlBody).toContain('We received it.');
    expect(createdDelivery.htmlBody).toContain('Alternate footer');
    expect(createdDelivery.htmlBody.indexOf('Workspace header')).toBeLessThan(createdDelivery.htmlBody.indexOf('We received it.'));
    expect(createdDelivery.htmlBody.indexOf('We received it.')).toBeLessThan(createdDelivery.htmlBody.indexOf('Alternate footer'));
  });
});
