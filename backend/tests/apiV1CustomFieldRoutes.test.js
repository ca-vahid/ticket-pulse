import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// FR 08-05 #1 (Phase 1a) — public API custom-field surfaces beyond create:
// GET /custom-fields (definitions), PATCH /tickets/:id customFields merge
// (setValues, NO auto-provision → unknown keys 422 listing every offender),
// PATCH category/subcategory by name, and the conditional customfields:write
// gate. ticketService/customFieldService/resolver are mocked — the routes'
// own wiring is under test here.

const prismaMock = {};
const ticketServiceMock = {
  createTicket: jest.fn(),
  getTicket: jest.fn(),
  listTickets: jest.fn(),
  updateTicketFields: jest.fn(),
  changeStatus: jest.fn(),
  assignTicket: jest.fn(),
};
const customFieldServiceMock = {
  listDefinitions: jest.fn(),
  setValues: jest.fn(),
  setValuesAtCreate: jest.fn(),
};
const resolveCategoryNamesMock = jest.fn();
const authState = { scopes: ['*'] };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => {
    req.workspaceId = 1;
    req.apiKey = { id: 5, name: 'test key', keyPrefix: 'tp_live_x', mode: 'live', scopes: authState.scopes, oauthClientId: null };
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
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/customFieldService.js', () => ({ default: customFieldServiceMock }));
jest.unstable_mockModule('../src/services/categoryNameResolver.js', () => ({
  resolveCategoryNames: resolveCategoryNamesMock,
}));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/groupRepository.js', () => ({ default: {} }));

const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Routes);
  return app;
}

const FAKE_TICKET = {
  id: 501, displayRef: 'TP-1042', origin: 'ticketpulse', subject: 'Coyote Landslide',
  status: 'Open', priority: 2, ticketType: 'Case',
  requester: { id: 40, name: 'Jane Doe', email: 'jdoe@bgcengineering.ca' },
  assignedTech: null, group: null,
  internalCategory: { id: 11, name: 'Project Setup' },
  internalSubcategory: { id: 21, name: 'Quebec' },
  tags: [], customFields: { client_name: 'ACME Inc' },
  createdAt: new Date('2026-08-05T10:00:00Z'), updatedAt: new Date('2026-08-05T10:00:00Z'), resolvedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  authState.scopes = ['*'];
  ticketServiceMock.getTicket.mockResolvedValue({ ...FAKE_TICKET, thread: [] });
  ticketServiceMock.updateTicketFields.mockResolvedValue({ ...FAKE_TICKET, changed: true });
  customFieldServiceMock.listDefinitions.mockResolvedValue([
    { id: 1, key: 'client_name', label: 'Client Name', type: 'text', options: [], source: 'api', isActive: true },
    { id: 2, key: 'region', label: 'Region', type: 'select', options: ['Quebec', 'Chile'], source: 'manual', isActive: true },
  ]);
  customFieldServiceMock.setValues.mockResolvedValue({ customFields: { client_name: 'Updated' }, changes: {} });
});

describe('GET /api/v1/custom-fields', () => {
  test('lists the active definitions with key/label/type/options/source', async () => {
    const response = await request(buildApp())
      .get('/api/v1/custom-fields')
      .set('Authorization', 'Bearer tp_live_x')
      .expect(200);
    expect(response.body.data).toEqual([
      { key: 'client_name', label: 'Client Name', type: 'text', options: [], source: 'api' },
      { key: 'region', label: 'Region', type: 'select', options: ['Quebec', 'Chile'], source: 'manual' },
    ]);
    expect(customFieldServiceMock.listDefinitions).toHaveBeenCalledWith(1);
  });
});

describe('GET /api/v1/tickets/:id — read shape', () => {
  test('ticketShape now carries customFields', async () => {
    const response = await request(buildApp())
      .get('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .expect(200);
    expect(response.body.data.customFields).toEqual({ client_name: 'ACME Inc' });
    expect(response.body.data.category).toBe('Project Setup');
  });
});

describe('PATCH /api/v1/tickets/:id — customFields merge', () => {
  test('known keys merge via setValues (no auto-provisioning path)', async () => {
    await request(buildApp())
      .patch('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ customFields: { client_name: 'Updated' } })
      .expect(200);
    expect(customFieldServiceMock.setValues).toHaveBeenCalledWith(
      501, 1, { client_name: 'Updated' }, expect.objectContaining({ role: 'api' }),
    );
    expect(customFieldServiceMock.setValuesAtCreate).not.toHaveBeenCalled();
  });

  test('unknown keys → 422 problem listing EVERY offender; nothing written', async () => {
    const response = await request(buildApp())
      .patch('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ customFields: { mystery_one: 'x', mystery_two: 'y', client_name: 'ok' } })
      .expect(422);
    expect(response.body.code).toBe('unknown_custom_fields');
    expect(response.body.detail).toMatch(/mystery_one, mystery_two/);
    expect(response.body.errors).toEqual([
      { field: 'customFields.mystery_one', code: 'unknown_field' },
      { field: 'customFields.mystery_two', code: 'unknown_field' },
    ]);
    expect(customFieldServiceMock.setValues).not.toHaveBeenCalled();
  });

  test('customFields in a PATCH demands customfields:write; other fields do not', async () => {
    authState.scopes = ['tickets:write'];
    const response = await request(buildApp())
      .patch('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ customFields: { client_name: 'nope' } })
      .expect(403);
    expect(response.body.code).toBe('insufficient_scope');
    expect(customFieldServiceMock.setValues).not.toHaveBeenCalled();

    await request(buildApp())
      .patch('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ priority: 3 })
      .expect(200);
    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(501, 1, { priority: 3 }, expect.anything());
  });
});

describe('PATCH /api/v1/tickets/:id — category/subcategory by name', () => {
  test('names resolve through the resolver and land as internal IDs', async () => {
    resolveCategoryNamesMock.mockResolvedValue({
      categoryId: 12, subcategoryId: null, categoryName: 'Proposal Setup', subcategoryName: null,
    });
    await request(buildApp())
      .patch('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ category: 'proposal setup' })
      .expect(200);
    expect(resolveCategoryNamesMock).toHaveBeenCalledWith(1, 'proposal setup', undefined);
    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(
      501, 1, { internalCategoryId: 12, internalSubcategoryId: null }, expect.anything(),
    );
  });

  test('an explicit internalCategoryId wins — the resolver is not consulted', async () => {
    await request(buildApp())
      .patch('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ internalCategoryId: 12, category: 'Project Setup' })
      .expect(200);
    expect(resolveCategoryNamesMock).not.toHaveBeenCalled();
    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(
      501, 1, expect.objectContaining({ internalCategoryId: 12 }), expect.anything(),
    );
  });
});

// Phase 2 — the v1 list endpoint inherits cf_* custom-field filters by riding
// listTickets verbatim (buildListWhere speaks the grammar; nothing v1-specific).
describe('GET /api/v1/tickets — cf_* filter inheritance', () => {
  test('cf_* query params reach listTickets untouched', async () => {
    ticketServiceMock.listTickets.mockResolvedValue({ items: [], nextCursor: null, pageSize: 25, total: 0 });
    await request(buildApp())
      .get('/api/v1/tickets?cf_client_name=acme&cf_amount_gte=10')
      .set('Authorization', 'Bearer tp_live_x')
      .expect(200);
    expect(ticketServiceMock.listTickets).toHaveBeenCalledWith(1, expect.objectContaining({
      cf_client_name: 'acme',
      cf_amount_gte: '10',
    }));
  });
});
