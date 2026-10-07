import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// QA 10-06 #5/#6 — Power Automate sent bst_number, cc_recipients … as
// top-level keys beside `status`, and PATCH dropped them silently; the close
// also ran before any custom field was written, so the "closed" workflow
// could not see them.

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
    req.apiKey = { id: 5, name: 'test key', keyPrefix: 'tp_live_x', mode: 'live', scopes: authState.scopes, oauthClientId: null, trustedIntake: authState.trustedIntake === true };
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
jest.unstable_mockModule('../src/services/customFieldService.js', () => ({
  default: customFieldServiceMock,
  // Phase PA: apiV1.routes → ticketResubmissionService imports the named key normalizer too.
  normalizeFieldKey: (raw) => String(raw ?? '').trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s\-.]+/g, '_').toLowerCase(),
}));
jest.unstable_mockModule('../src/services/categoryNameResolver.js', () => ({
  resolveCategoryNames: resolveCategoryNamesMock,
}));
const order = [];
jest.unstable_mockModule('../src/services/fsBornStatusService.js', () => ({
  default: { isFreshServiceBorn: jest.fn().mockResolvedValue(false), changeFsBornStatus: jest.fn() },
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
    { id: 2, key: 'bst_number', label: 'BST Number', type: 'text', options: [], source: 'manual', isActive: true },
    { id: 3, key: 'project_accountant', label: 'Project Accountant', type: 'text', options: [], source: 'manual', isActive: true },
    { id: 4, key: 'cc_recipients', label: 'CC Recipients', type: 'text', options: [], source: 'manual', isActive: true },
  ]);
  order.length = 0;
  ticketServiceMock.changeStatus.mockImplementation(async () => { order.push('status'); });
  customFieldServiceMock.setValues.mockImplementation(async () => { order.push('customFields'); return { customFields: {}, changes: {} }; });
  prismaMock.technician = { findFirst: jest.fn().mockResolvedValue({ id: 77 }) };
  ticketServiceMock.assignTicket.mockImplementation(async () => { order.push('assignee'); });
});


describe('PATCH /api/v1/tickets/:id — top-level custom-field keys (QA 10-06)', () => {
  const QA_PAYLOAD = {
    status: 'closed',
    assigneeEmail: 'AFaerber@bgcengineering.ca',
    bst_number: 'P26663',
    project_accountant: 'Kai Nuanmanee',
    cc_recipients: 'EMatos@bgcengineering.ca; ECarey@bgcengineering.ca; SDickinson@bgcengineering.ca; ;VNuanmanee@bgcengineering.ca;',
    something_else: 'x',
  };

  test('known custom-field keys are stored, assigneeEmail is read, the rest is reported', async () => {
    const response = await request(buildApp())
      .patch('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .send(QA_PAYLOAD)
      .expect(200);
    expect(customFieldServiceMock.setValues).toHaveBeenCalledWith(501, 1, {
      bst_number: 'P26663',
      project_accountant: 'Kai Nuanmanee',
      cc_recipients: QA_PAYLOAD.cc_recipients,
    }, expect.anything());
    expect(ticketServiceMock.assignTicket).toHaveBeenCalledWith(501, 1, 77, expect.anything());
    expect(response.body.meta).toEqual({ ignoredFields: ['something_else'] });
  });

  test('custom fields and the assignee are written before the status change', async () => {
    await request(buildApp())
      .patch('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .send(QA_PAYLOAD)
      .expect(200);
    expect(order).toEqual(['customFields', 'assignee', 'status']);
  });

  test('an explicit customFields value wins over the same key at top level', async () => {
    await request(buildApp())
      .patch('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ bst_number: 'top', customFields: { bst_number: 'inner' } })
      .expect(200);
    expect(customFieldServiceMock.setValues).toHaveBeenCalledWith(501, 1, { bst_number: 'inner' }, expect.anything());
  });

  test('without customfields:write a lifted key is refused like an explicit one', async () => {
    authState.scopes = ['tickets:write', 'tickets:read'];
    await request(buildApp())
      .patch('/api/v1/tickets/501')
      .set('Authorization', 'Bearer tp_live_x')
      .send({ bst_number: 'P1' })
      .expect(403);
  });
});
