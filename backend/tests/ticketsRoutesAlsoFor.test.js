import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Phase MR6 (QA 08-26 #3) — /api/tickets/also-for-settings: the workspace
 * "Also notify additional requesters" toggle. Any member reads it; only
 * admins write it; the body must be a boolean.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  $queryRaw: jest.fn(),
};
const alsoForMock = {
  isAlsoForNotifyEnabled: jest.fn(),
  setAlsoForNotifyEnabled: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/alsoForNotifyService.js', () => ({ default: alsoForMock, ...alsoForMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: {} }));
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

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');

function buildApp(sessionUser = { email: 'ada@example.com', name: 'Ada Admin', role: 'admin' }) {
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

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, defaultTimezone: 'America/Los_Angeles', internalDomains: [] });
  prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  alsoForMock.isAlsoForNotifyEnabled.mockResolvedValue(false);
  alsoForMock.setAlsoForNotifyEnabled.mockImplementation(async (_ws, v) => Boolean(v));
});

describe('GET/PUT /api/tickets/also-for-settings (Phase MR6)', () => {
  test('GET returns the workspace flag (default off)', async () => {
    const res = await request(buildApp()).get('/api/tickets/also-for-settings').expect(200);
    expect(res.body.data).toEqual({ notifyAdditionalRequesters: false });
    expect(alsoForMock.isAlsoForNotifyEnabled).toHaveBeenCalledWith(7);
  });

  test('PUT by an admin flips the flag and echoes it', async () => {
    const res = await request(buildApp()).put('/api/tickets/also-for-settings').send({ notifyAdditionalRequesters: true }).expect(200);
    expect(alsoForMock.setAlsoForNotifyEnabled).toHaveBeenCalledWith(7, true);
    expect(res.body.data).toEqual({ notifyAdditionalRequesters: true });
  });

  test('PUT by a non-admin is 403 and writes nothing', async () => {
    prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'viewer' });
    prismaMock.workspaceAccess.findFirst.mockResolvedValue({ role: 'viewer' });
    const res = await request(buildApp({ email: 'vic@example.com', name: 'Vic Viewer', role: 'viewer' }))
      .put('/api/tickets/also-for-settings').send({ notifyAdditionalRequesters: true });
    expect(res.status).toBe(403);
    expect(alsoForMock.setAlsoForNotifyEnabled).not.toHaveBeenCalled();
  });

  test('PUT without a boolean is 400', async () => {
    const res = await request(buildApp()).put('/api/tickets/also-for-settings').send({ notifyAdditionalRequesters: 'yes' });
    expect(res.status).toBe(400);
    expect(alsoForMock.setAlsoForNotifyEnabled).not.toHaveBeenCalled();
  });
});
