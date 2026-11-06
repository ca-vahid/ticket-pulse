import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * QA 11-05 #9 — workflowRuns rides on the INTERNAL ticket page payload
 * (GET /api/tickets/:id) only. The public v1 GET /tickets/:id never carries
 * it, even if getTicket ever returned it.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $queryRaw: jest.fn(),
};
const ticketServiceMock = { getTicket: jest.fn() };
const workflowRunsMock = { listTicketWorkflowRuns: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketWorkflowRunsService.js', () => ({ default: workflowRunsMock, ...workflowRunsMock }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 7; next(); },
}));
jest.unstable_mockModule('../src/middleware/apiKeyAuth.js', () => ({
  requireApiKey: () => (req, _res, next) => {
    req.workspaceId = 7;
    req.apiKey = { name: 'test key', keyPrefix: 'tp_test_x', mode: 'live', scopes: ['*'], oauthClientId: null };
    next();
  },
  apiRequestContext: (_req, _res, next) => next(),
  clientIp: () => '127.0.0.1',
}));
jest.unstable_mockModule('../src/services/oauthClientService.js', () => ({ verifyClientCredentials: jest.fn(), issueAccessToken: jest.fn() }));
jest.unstable_mockModule('../src/services/apiRateLimitService.js', () => ({
  default: { hit: jest.fn().mockResolvedValue({ allowed: true, reset: 0 }) },
}));
jest.unstable_mockModule('../src/middleware/apiIdempotency.js', () => ({ withIdempotency: (_req, _res, next) => next() }));

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');
const { default: apiV1Routes } = await import('../src/routes/apiV1.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { email: 'ada@example.com', name: 'Ada Admin', role: 'admin' } }; next(); });
  app.use('/api/tickets', ticketsRouter);
  app.use('/api/v1', apiV1Routes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  return app;
}

const TICKET = {
  id: 501, displayRef: 'TP-1076', origin: 'ticketpulse', subject: 'New laptop', status: 'Open', priority: 2,
  requester: { id: 9, name: 'Sam Ortiz', email: 'sortiz@example.com' }, assignedTech: null, tags: [], customFields: {},
  createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z', thread: [],
};
const RUNS = [{ id: 11, workflowName: 'New ticket acknowledgement', outcome: 'acted', shadow: false, actions: [{ type: 'email', to: 1, cc: 0, sent: true }], steps: [] }];

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, defaultTimezone: 'America/Vancouver', internalDomains: [] });
  prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  ticketServiceMock.getTicket.mockResolvedValue({ ...TICKET });
  workflowRunsMock.listTicketWorkflowRuns.mockResolvedValue(RUNS);
});

describe('workflowRuns on the ticket payload (QA 11-05 #9)', () => {
  test('the internal ticket page gets the ticket\'s workflow runs', async () => {
    const res = await request(buildApp()).get('/api/tickets/501').expect(200);
    expect(workflowRunsMock.listTicketWorkflowRuns).toHaveBeenCalledWith(501);
    expect(res.body.data.workflowRuns).toEqual(RUNS);
  });

  test('a failed read leaves an empty list, never a failed page', async () => {
    workflowRunsMock.listTicketWorkflowRuns.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).get('/api/tickets/501').expect(200);
    expect(res.body.data.workflowRuns).toEqual([]);
  });

  test('the public v1 GET /tickets/:id never carries workflowRuns, even if getTicket had it', async () => {
    ticketServiceMock.getTicket.mockResolvedValue({ ...TICKET, workflowRuns: RUNS });
    const res = await request(buildApp()).get('/api/v1/tickets/501').expect(200);
    expect(res.body.data.id).toBe(501);
    expect(res.body.data).not.toHaveProperty('workflowRuns');
    expect(JSON.stringify(res.body)).not.toMatch(/New ticket acknowledgement/);
    expect(workflowRunsMock.listTicketWorkflowRuns).not.toHaveBeenCalled();
  });
});
