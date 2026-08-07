import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// FR 08-05 #1 (Phase 1a) — the public create endpoint round-trip with QA's
// EXACT Project Accounting sample payload: category/subcategory resolve by
// name against the seeded workspace taxonomy, extra top-level keys are
// tolerated but reported via meta.ignoredFields, and the same fields sent the
// documented way (inside `customFields`) are stored + auto-provisioned.
// Real ticketService + customFieldService + categoryNameResolver; prisma and
// the side-effect services are mocked.

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  customFieldDefinition: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn() },
  ticketTypeDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 2, name: 'Case', aliases: [], isActive: true, aiAssignable: true, isDefault: true, fsTypeValue: 'Case', sortOrder: 0 },
    ]),
  },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 2, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 2, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 2, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 2, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
};

// Seeded taxonomy for the Project Accounting workspace (ws 2).
const TAXONOMY = [
  { id: 11, workspaceId: 2, name: 'Project Setup', parentId: null, isActive: true },
  { id: 12, workspaceId: 2, name: 'Proposal Setup', parentId: null, isActive: true },
  { id: 21, workspaceId: 2, name: 'Quebec', parentId: 11, isActive: true },
  { id: 22, workspaceId: 2, name: 'Chile', parentId: 11, isActive: true },
  { id: 23, workspaceId: 2, name: 'Other', parentId: 11, isActive: true },
];
const CATEGORY_NAMES = Object.fromEntries(TAXONOMY.map((t) => [t.id, t.name]));

const noiseRuleServiceMock = { evaluate: jest.fn() };
const ticketActivityRepositoryMock = { create: jest.fn() };
const lifecycleMock = { emitTicketLifecycleNotifications: jest.fn() };
const requesterRepositoryMock = { findByEmail: jest.fn(), createNative: jest.fn() };
const mirrorServiceMock = {
  enqueueTicketCreate: jest.fn().mockResolvedValue({ id: 1 }),
  enqueueFieldSync: jest.fn().mockResolvedValue({ id: 2 }),
};

// Auth mock with switchable scopes — the ROUTE-level scope gate is bypassed,
// so what these tests exercise is the conditional customfields:write check
// INSIDE the create handler (real scopeSatisfies).
const authState = { scopes: ['*'] };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => {
    req.workspaceId = 2;
    req.apiKey = { id: 5, name: 'intake key', keyPrefix: 'tp_live_x', mode: 'live', scopes: authState.scopes, oauthClientId: null };
    next();
  },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/middleware/apiIdempotency.js', () => ({
  withIdempotency: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({
  default: { hit: jest.fn().mockResolvedValue({ allowed: true, reset: 0 }) },
}));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({
  verifyClientCredentials: jest.fn(),
  issueAccessToken: jest.fn(),
  verifyAccessToken: jest.fn(),
  clientUsable: jest.fn(),
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: noiseRuleServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: ticketActivityRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepositoryMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: { runPipeline: jest.fn().mockResolvedValue({ id: 900 }) },
}));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({
  default: { getUserProfile: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));

const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');
const { default: ticketService } = await import('../src/services/ticketService.js');
const { invalidateStatusCache } = await import('../src/services/statusService.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Routes);
  return app;
}

// QA's exact sample payload from "Features Request -08-05.docx".
const QA_PAYLOAD = {
  subject: 'Coyote Landslide',
  description: 'Created from Power Automate',
  priority: 2,
  requesterEmail: 'jdoe@bgcengineering.ca',
  requesterName: 'Jane Doe',
  runAiTriage: true,
  category: 'Project Setup',
  subcategory: 'Quebec',
  clientName: 'ACME Inc',
  clientLocation: 'Quebec',
  projectOrProposalName: 'Coyote Landslide',
  powerAppRecordId: '1260',
  sharePointItemLink: 'https://ibgcengineering.sharepoint.com/sites/ProjectProposalSetup/Lists/Project%20Requests/DispForm.aspx?ID=1260',
  powerAppFormLink: 'https://apps.powerapps.com/play/...',
  sourceSystem: 'Power App / Coreshack',
  sourceRequestType: 'Project Setup',
};

let provisionedId = 9000;

function armCreateDefaults() {
  authState.scopes = ['*'];
  prismaMock.workspace.findUnique.mockResolvedValue({
    id: 2, name: 'Project Accounting', isActive: true, nativeTicketingEnabled: true,
  });
  requesterRepositoryMock.findByEmail.mockResolvedValue({
    id: 40, name: 'Jane Doe', email: 'jdoe@bgcengineering.ca', department: null, freshserviceId: null,
  });
  noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null });
  prismaMock.$queryRaw.mockResolvedValue([{ nextval: 1042 }]);
  prismaMock.competencyCategory.findMany.mockResolvedValue(TAXONOMY);
  prismaMock.competencyCategory.findFirst.mockImplementation(({ where }) => Promise.resolve(
    TAXONOMY.find((t) => t.id === where.id
      && (where.parentId === null ? t.parentId === null : t.parentId === where.parentId)) || null,
  ));
  prismaMock.customFieldDefinition.findMany.mockResolvedValue([]);
  prismaMock.customFieldDefinition.create.mockImplementation(({ data }) => Promise.resolve({ id: provisionedId++, isActive: true, ...data }));
  prismaMock.ticket.create.mockImplementation(({ data }) => Promise.resolve({
    id: 501,
    ...data,
    requester: { id: 40, name: 'Jane Doe', email: 'jdoe@bgcengineering.ca' },
    assignedTech: null,
    internalCategory: data.internalCategoryId ? { id: data.internalCategoryId, name: CATEGORY_NAMES[data.internalCategoryId] } : null,
    internalSubcategory: data.internalSubcategoryId ? { id: data.internalSubcategoryId, name: CATEGORY_NAMES[data.internalSubcategoryId] } : null,
    group: null,
    tags: [],
  }));
  ticketActivityRepositoryMock.create.mockResolvedValue({});
  lifecycleMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
}

describe('POST /api/v1/tickets — QA sample payload round-trip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateStatusCache();
    armCreateDefaults();
  });

  afterAll(() => invalidateStatusCache());

  test("QA's exact payload: names resolve to the taxonomy, extras are reported as ignored", async () => {
    const response = await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send(QA_PAYLOAD)
      .expect(201);

    // Category/subcategory resolved BY NAME onto the ticket row.
    expect(prismaMock.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ internalCategoryId: 11, internalSubcategoryId: 21 }),
    }));
    expect(response.body.data.category).toBe('Project Setup');
    expect(response.body.data.subcategory).toBe('Quebec');
    expect(response.body.data.customFields).toEqual({});

    // The extra top-level keys did NOT land — and the sender is told exactly
    // which ones (they belong inside `customFields`).
    expect(response.body.meta.ignoredFields).toEqual([
      'clientName', 'clientLocation', 'projectOrProposalName', 'powerAppRecordId',
      'sharePointItemLink', 'powerAppFormLink', 'sourceSystem', 'sourceRequestType',
    ]);
    expect(response.body.meta.rejectedCustomFields).toEqual([]);
    expect(response.body.meta.provisionedCustomFields).toEqual([]);
  });

  test('the documented shape: the same fields inside customFields are stored + auto-provisioned', async () => {
    const {
      clientName, clientLocation, projectOrProposalName, powerAppRecordId,
      sharePointItemLink, powerAppFormLink, sourceSystem, sourceRequestType, ...base
    } = QA_PAYLOAD;
    const response = await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send({
        ...base,
        customFields: {
          clientName, clientLocation, projectOrProposalName, powerAppRecordId,
          sharePointItemLink, powerAppFormLink, sourceSystem, sourceRequestType,
        },
      })
      .expect(201);

    const expectedKeys = [
      'client_name', 'client_location', 'project_or_proposal_name', 'power_app_record_id',
      'share_point_item_link', 'power_app_form_link', 'source_system', 'source_request_type',
    ];
    expect(response.body.meta.ignoredFields).toEqual([]);
    expect(response.body.meta.rejectedCustomFields).toEqual([]);
    expect(response.body.meta.provisionedCustomFields).toEqual(expectedKeys);

    // Values landed on the ticket row (normalized keys) and echo in the read shape.
    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.customFields).toEqual({
      client_name: 'ACME Inc',
      client_location: 'Quebec',
      project_or_proposal_name: 'Coyote Landslide',
      power_app_record_id: '1260',
      share_point_item_link: QA_PAYLOAD.sharePointItemLink,
      power_app_form_link: QA_PAYLOAD.powerAppFormLink,
      source_system: 'Power App / Coreshack',
      source_request_type: 'Project Setup',
    });
    expect(response.body.data.customFields).toEqual(data.customFields);

    // Definitions were provisioned as API-born.
    expect(prismaMock.customFieldDefinition.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: 2, key: 'client_name', label: 'Client Name', type: 'text', source: 'api' }),
    }));

    // The created audit records the provisioning.
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'created',
      details: expect.objectContaining({ provisionedCustomFields: expectedKeys }),
    }));
  });

  test('an unknown category name 400s listing the allowed values (nothing created)', async () => {
    const response = await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ ...QA_PAYLOAD, category: 'Accounts Payable' })
      .expect(400);

    expect(response.body.detail).toMatch(/Unknown category "Accounts Payable".*Project Setup, Proposal Setup/);
    expect(prismaMock.ticket.create).not.toHaveBeenCalled();
  });

  test('a wrong-parent subcategory 400s naming the valid children', async () => {
    const response = await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ ...QA_PAYLOAD, category: 'Proposal Setup', subcategory: 'Quebec' })
      .expect(400);
    expect(response.body.detail).toMatch(/Unknown subcategory "Quebec" under "Proposal Setup"/);
  });

  test('explicit internalCategoryId is NOT part of the public surface — it is reported as ignored, names win', async () => {
    const response = await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ ...QA_PAYLOAD, internalCategoryId: 12 })
      .expect(201);
    expect(response.body.meta.ignoredFields).toContain('internalCategoryId');
    expect(prismaMock.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ internalCategoryId: 11 }),
    }));
  });

  test('scope gating: customFields in the payload demands customfields:write', async () => {
    authState.scopes = ['tickets:write'];
    const response = await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ ...QA_PAYLOAD, customFields: { clientName: 'ACME' } })
      .expect(403);
    expect(response.body.code).toBe('insufficient_scope');
    expect(response.body.detail).toMatch(/customfields:write/);
    expect(prismaMock.ticket.create).not.toHaveBeenCalled();

    // …but the same key WITHOUT customFields sails through on tickets:write.
    await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send(QA_PAYLOAD)
      .expect(201);
  });

  test('unusable custom-field keys come back in meta.rejectedCustomFields (create still succeeds)', async () => {
    const response = await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ ...QA_PAYLOAD, customFields: { 'été!': 'x', clientName: 'ACME' } })
      .expect(201);
    expect(response.body.meta.rejectedCustomFields).toEqual([{ key: 'été!', reason: 'invalid_key' }]);
    expect(response.body.meta.provisionedCustomFields).toEqual(['client_name']);
  });
});

// Internal parity (checkbox 6): updateTicketSchema stays strict but accepts
// customFields, routed through setValues — NO auto-provisioning on update.
describe('updateTicketFields — customFields via the strict update schema', () => {
  const NATIVE_TICKET = {
    id: 501, workspaceId: 2, origin: 'ticketpulse', nativeNumber: 1042,
    freshserviceTicketId: null, subject: 'Coyote Landslide', status: 'Open',
    priority: 2, ticketType: 'Case', customFields: {},
    internalCategoryId: null, internalSubcategoryId: null,
    requester: { id: 40, name: 'Jane Doe', email: 'jdoe@bgcengineering.ca' },
    assignedTech: null, internalCategory: null, internalSubcategory: null,
  };
  const actor = { email: 'coord@example.com', name: 'Cora', role: 'viewer', technicianId: null };

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateStatusCache();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...NATIVE_TICKET });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...NATIVE_TICKET, ...data }));
    prismaMock.customFieldDefinition.findMany.mockResolvedValue([
      { id: 1, workspaceId: 2, key: 'client_name', label: 'Client Name', type: 'text', options: [], sortOrder: 0, isActive: true },
    ]);
    ticketActivityRepositoryMock.create.mockResolvedValue({});
  });

  test('a customFields-only update merges via setValues and reports changed', async () => {
    const result = await ticketService.updateTicketFields(501, 2, {
      customFields: { client_name: 'ACME Inc' },
    }, actor);
    expect(result.changed).toBe(true);
    expect(result.customFields).toEqual({ client_name: 'ACME Inc' });
    // setValues persisted the merge itself (Json column update)…
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { customFields: { client_name: 'ACME Inc' } },
    }));
    // …and audited it as custom_fields_changed.
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'custom_fields_changed',
    }));
    // No definitions were provisioned on the update path.
    expect(prismaMock.customFieldDefinition.create).not.toHaveBeenCalled();
  });

  test('unknown keys are a hard error on update (no auto-provisioning)', async () => {
    await expect(ticketService.updateTicketFields(501, 2, {
      customFields: { brand_new: 'x' },
    }, actor)).rejects.toThrow(/Unknown custom field "brand_new"/);
    expect(prismaMock.customFieldDefinition.create).not.toHaveBeenCalled();
  });

  test('the update schema stays strict for everything else', async () => {
    await expect(ticketService.updateTicketFields(501, 2, {
      customFields: { client_name: 'x' }, mysteryTopLevel: true,
    }, actor)).rejects.toThrow(/mysteryTopLevel|unrecognized/i);
  });
});

// QA 08-06 #1 — group placement through the public create endpoint, plus the
// workspace default internal group when no group is sent.
describe('POST /api/v1/tickets — group placement (QA 08-06 #1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateStatusCache();
    armCreateDefaults();
  });

  test('internalGroupId passes through and lands on the ticket row', async () => {
    prismaMock.group.findFirst.mockResolvedValue({ id: 9, isActive: true });

    const response = await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ subject: 'Coyote Landslide', requesterEmail: 'jdoe@bgcengineering.ca', internalGroupId: 9 })
      .expect(201);

    expect(response.body.meta.ignoredFields).toEqual([]);
    expect(prismaMock.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ internalGroupId: 9 }),
    }));
  });

  test('groupId (FreshService) passes through', async () => {
    prismaMock.group.findFirst.mockResolvedValue({ id: 3, name: 'Service Desk', isActive: true });

    const response = await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ subject: 'Coyote Landslide', requesterEmail: 'jdoe@bgcengineering.ca', groupId: 1000210021 })
      .expect(201);

    expect(response.body.meta.ignoredFields).toEqual([]);
    expect(prismaMock.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ groupId: BigInt(1000210021) }),
    }));
  });

  test('no group sent → the workspace default internal group applies', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({
      id: 2, name: 'Project Accounting', isActive: true, nativeTicketingEnabled: true, defaultInternalGroupId: 9,
    });
    prismaMock.group.findFirst.mockResolvedValue({ id: 9, isActive: true });

    await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ subject: 'Coyote Landslide', requesterEmail: 'jdoe@bgcengineering.ca' })
      .expect(201);

    expect(prismaMock.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ internalGroupId: 9 }),
    }));
  });

  test('an unknown internal group 400s (nothing created)', async () => {
    prismaMock.group.findFirst.mockResolvedValue(null);

    await request(buildApp())
      .post('/api/v1/tickets')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ subject: 'Coyote Landslide', requesterEmail: 'jdoe@bgcengineering.ca', internalGroupId: 999 })
      .expect(400);

    expect(prismaMock.ticket.create).not.toHaveBeenCalled();
  });
});
