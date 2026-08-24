import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Per-user UI preferences (Mega 08-23 Phase QC — QC1): GET/PUT
 * /api/tickets/preferences/:key through the real tickets router.
 *  - hard key ALLOWLIST (unknown key → 404, both verbs)
 *  - 8KB value cap + value-required validation
 *  - upsert keyed on (workspace, actor email, key) — actor comes from the
 *    session, workspace from the request scope, never from the body
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn() },
  userPreference: { findUnique: jest.fn(), upsert: jest.fn() },
  // Router-level collaborators (unused by these tests but imported transitively).
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  slaPolicy: { findFirst: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  $queryRaw: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: { runPipeline: jest.fn() },
}));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({
  default: { getUserProfile: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(),
    reconcileTicket: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn(),
  },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({
  default: { mergedInto: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 7; next(); },
}));

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');

function buildApp(sessionUser = { email: 'Ada@X.io', name: 'Ada Admin', role: 'admin' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: sessionUser }; next(); });
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

const WHERE_KEY = (key) => ({
  workspaceId_ownerEmail_key: { workspaceId: 7, ownerEmail: 'ada@x.io', key },
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null); // admin needs no tech profile
  prismaMock.userPreference.findUnique.mockResolvedValue(null);
  prismaMock.userPreference.upsert.mockImplementation(({ where, create, update }) => Promise.resolve({
    id: 1, ...where.workspaceId_ownerEmail_key, value: update?.value ?? create.value,
  }));
});

describe('GET /api/tickets/preferences/:key', () => {
  test('unknown key → 404 (allowlist)', async () => {
    const res = await request(buildApp()).get('/api/tickets/preferences/evil.key').expect(404);
    expect(res.body.message).toMatch(/unknown preference key/i);
    expect(prismaMock.userPreference.findUnique).not.toHaveBeenCalled();
  });

  test('never customized → value:null; actor email is lowercased and workspace comes from scope', async () => {
    const res = await request(buildApp()).get('/api/tickets/preferences/queue.columns').expect(200);
    expect(res.body).toEqual({ success: true, data: { key: 'queue.columns', value: null } });
    expect(prismaMock.userPreference.findUnique).toHaveBeenCalledWith({ where: WHERE_KEY('queue.columns') });
  });

  test('stored row returns its JSON value', async () => {
    prismaMock.userPreference.findUnique.mockResolvedValue({ id: 3, value: ['subject', 'requester', 'status'] });
    const res = await request(buildApp()).get('/api/tickets/preferences/queue.columns').expect(200);
    expect(res.body.data.value).toEqual(['subject', 'requester', 'status']);
  });

  test('queue.columnWidths is on the allowlist too (Phase QR store)', async () => {
    await request(buildApp()).get('/api/tickets/preferences/queue.columnWidths').expect(200);
    expect(prismaMock.userPreference.findUnique).toHaveBeenCalledWith({ where: WHERE_KEY('queue.columnWidths') });
  });
});

describe('PUT /api/tickets/preferences/:key', () => {
  test('unknown key → 404, nothing written', async () => {
    await request(buildApp()).put('/api/tickets/preferences/nope').send({ value: [] }).expect(404);
    expect(prismaMock.userPreference.upsert).not.toHaveBeenCalled();
  });

  test('missing/null value → 400', async () => {
    const res1 = await request(buildApp()).put('/api/tickets/preferences/queue.columns').send({}).expect(400);
    expect(res1.body.message).toMatch(/value is required/i);
    const res2 = await request(buildApp()).put('/api/tickets/preferences/queue.columns').send({ value: null }).expect(400);
    expect(res2.body.message).toMatch(/value is required/i);
    expect(prismaMock.userPreference.upsert).not.toHaveBeenCalled();
  });

  test('oversized value (>8KB serialized) → 400, nothing written', async () => {
    const res = await request(buildApp())
      .put('/api/tickets/preferences/queue.columns')
      .send({ value: ['x'.repeat(9000)] })
      .expect(400);
    expect(res.body.message).toMatch(/too large/i);
    expect(prismaMock.userPreference.upsert).not.toHaveBeenCalled();
  });

  test('upserts scoped to (workspace, actor email, key) and echoes the stored value', async () => {
    const value = ['subject', 'requester', 'category', 'status', 'createdAt'];
    const res = await request(buildApp())
      .put('/api/tickets/preferences/queue.columns')
      .send({ value })
      .expect(200);
    expect(res.body).toEqual({ success: true, data: { key: 'queue.columns', value } });
    expect(prismaMock.userPreference.upsert).toHaveBeenCalledWith({
      where: WHERE_KEY('queue.columns'),
      update: { value },
      create: { workspaceId: 7, ownerEmail: 'ada@x.io', key: 'queue.columns', value },
    });
  });

  test('non-admin members write under their OWN email (actor scoping, not body-controlled)', async () => {
    // Member: no admin role → getAccessRole path; a viewer access row grants entry.
    prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'viewer' });
    prismaMock.workspaceAccess.findFirst.mockResolvedValue({ role: 'viewer' });
    const app = buildApp({ email: 'Marcus@BGC.ca', name: 'Marcus', role: 'user' });
    await request(app)
      .put('/api/tickets/preferences/queue.columns')
      .send({ value: ['subject', 'requester'], ownerEmail: 'someone-else@bgc.ca', workspaceId: 99 })
      .expect(200);
    const call = prismaMock.userPreference.upsert.mock.calls[0][0];
    expect(call.create.ownerEmail).toBe('marcus@bgc.ca');
    expect(call.create.workspaceId).toBe(7);
  });
});
