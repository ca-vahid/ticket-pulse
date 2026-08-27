import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Phase MR7 (QA 08-26 #3) — "Also for" additional requesters on the public
 * API: PATCH /tickets/:id accepts ccEmails (forwarded to updateTicketFields,
 * which validates/normalizes), and ticket responses carry ccEmails.
 */

const ticketServiceMock = {
  getTicket: jest.fn(),
  updateTicketFields: jest.fn(),
  changeStatus: jest.fn(),
  assignTicket: jest.fn(),
  listTickets: jest.fn(),
  createTicket: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => {
    req.workspaceId = 1;
    req.apiKey = { name: 'test key', keyPrefix: 'tp_test_x', mode: 'live', scopes: ['*'], oauthClientId: null };
    next();
  },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/groupRepository.js', () => ({ default: { listForWorkspace: jest.fn() } }));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({
  verifyClientCredentials: jest.fn(),
  issueAccessToken: jest.fn(),
}));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({
  default: { hit: jest.fn().mockResolvedValue({ allowed: true, reset: 0 }) },
}));
jest.unstable_mockModule('../src/middleware/apiIdempotency.js', () => ({
  withIdempotency: (_req, _res, next) => next(),
}));

const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');
const { buildOpenApiSpec } = await import('../src/routes/apiV1.openapi.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', apiV1Routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

const TICKET = {
  id: 501,
  displayRef: 'TP-1084',
  origin: 'ticketpulse',
  subject: 'New AP project',
  status: 'Open',
  priority: 2,
  ticketType: null,
  requester: { id: 9, name: 'Jane Doe', email: 'jdoe@example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
  internalGroup: null,
  tags: [],
  customFields: {},
  ccEmails: ['manager@example.com', 'assistant@example.com'],
  createdAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:00:00.000Z',
  resolvedAt: null,
  thread: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  ticketServiceMock.getTicket.mockResolvedValue(TICKET);
  ticketServiceMock.updateTicketFields.mockResolvedValue(TICKET);
});

describe('API v1 — additional requesters / carbon copies (Phase MR7)', () => {
  test('GET /tickets/:id carries ccEmails; [] when the row has none', async () => {
    const res = await request(buildApp()).get('/api/v1/tickets/501').expect(200);
    expect(res.body.data.ccEmails).toEqual(['manager@example.com', 'assistant@example.com']);

    ticketServiceMock.getTicket.mockResolvedValue({ ...TICKET, ccEmails: undefined });
    const bare = await request(buildApp()).get('/api/v1/tickets/501').expect(200);
    expect(bare.body.data.ccEmails).toEqual([]);
  });

  test('PATCH /tickets/:id forwards ccEmails to updateTicketFields (the validating seam) and echoes the result', async () => {
    const res = await request(buildApp())
      .patch('/api/v1/tickets/501')
      .send({ ccEmails: ['Manager@Example.com', 'assistant@example.com'] })
      .expect(200);
    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(
      501, 1, { ccEmails: ['Manager@Example.com', 'assistant@example.com'] }, expect.any(Object),
    );
    expect(res.body.data.ccEmails).toEqual(['manager@example.com', 'assistant@example.com']);
  });

  test('PATCH with an invalid address surfaces the service ValidationError as 400', async () => {
    const { ValidationError } = await import('../src/utils/errors.js');
    ticketServiceMock.updateTicketFields.mockRejectedValue(new ValidationError('Cc contains an invalid email address'));
    const res = await request(buildApp()).patch('/api/v1/tickets/501').send({ ccEmails: ['nope'] });
    expect(res.status).toBe(400);
    // problem+json (detail) or the plain {message} shape — either must name the cause.
    expect(JSON.stringify(res.body)).toMatch(/invalid email/i);
  });

  test('PATCH ccEmails: [] clears the list (still forwarded, not dropped as "empty")', async () => {
    await request(buildApp()).patch('/api/v1/tickets/501').send({ ccEmails: [] }).expect(200);
    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(501, 1, { ccEmails: [] }, expect.any(Object));
  });

  test('OpenAPI: Ticket, CreateTicket and UpdateTicket schemas all document ccEmails as additional requesters', () => {
    const spec = buildOpenApiSpec('https://example.test');
    const schemas = spec.components.schemas;
    expect(schemas.Ticket.properties.ccEmails.description).toMatch(/Additional requesters/);
    expect(schemas.CreateTicket.properties.ccEmails.description).toMatch(/max 10/);
    expect(schemas.UpdateTicket.properties.ccEmails.description).toMatch(/\[\] clears it/);
  });
});
