import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * FreshService switch on the tickets router (25 Nov 2026):
 *  - GET /tickets/meta carries freshserviceEnabled + freshserviceMode
 *    (connected and shadow are enabled; off and never connected are not; a
 *    mode read error is "connected")
 *  - POST /tickets/:id/adopt: agents and admins, FreshService-born only
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn() },
  ticket: { findFirst: jest.fn() },
};
const getMode = jest.fn();
const adoptTicket = jest.fn();
const accessRole = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({
  default: { getMeta: jest.fn().mockResolvedValue({ statuses: [{ name: 'Open', baseStatus: 'Open' }], technicians: [] }) },
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: { getAccessRole: accessRole } }));
const fsModeMock = {
  FS_MODES: ['connected', 'shadow', 'off'], FS_PURPOSES: [],
  getMode, getModeRecord: jest.fn(), isFreshServiceOff: jest.fn().mockResolvedValue(false), fsGate: jest.fn().mockResolvedValue(true),
  setMode: jest.fn(), onModeChange: jest.fn(() => () => {}), getShadowReport: jest.fn(), flushShadow: jest.fn(),
  modeSettingKey: (ws) => `freshservice_mode_ws${ws}`, shadowSettingKey: (ws) => `freshservice_shadow_ws${ws}`, _resetFsModeCache: jest.fn(),
};
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({ ...fsModeMock, default: fsModeMock }));
jest.unstable_mockModule('../src/services/fsAdoptionService.js', () => ({ default: { adoptTicket } }));
jest.unstable_mockModule('../src/services/replyGreetingService.js', () => ({ getReplyGreetingSettings: jest.fn().mockResolvedValue(null) }));
jest.unstable_mockModule('../src/services/assigneeAwayService.js', () => ({ default: { forWorkspace: jest.fn().mockResolvedValue(new Map()) } }));
jest.unstable_mockModule('../src/services/autoCloseResolvedService.js', () => ({ default: { isResolvedRetired: jest.fn().mockResolvedValue(false) } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 5; next(); },
}));

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user }; next(); });
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code });
  });
  return app;
}

const admin = { email: 'root@example.com', name: 'Root', role: 'admin' };
const agent = { email: 'agent@example.com', name: 'Agent', role: 'agent' };
const viewer = { email: 'viewer@example.com', name: 'Viewer', role: 'viewer' };

beforeEach(() => {
  jest.clearAllMocks();
  getMode.mockResolvedValue('connected');
  fsModeMock.isFreshServiceOff.mockResolvedValue(true); // adopt tests run in an Off workspace unless they say otherwise
  prismaMock.workspace.findUnique.mockResolvedValue({ nativeTicketingEnabled: true });
  accessRole.mockImplementation(async (email) => (email === 'viewer@example.com' ? 'viewer' : null));
  prismaMock.technician.findFirst.mockImplementation(async ({ where }) => (
    String(where.email?.equals || '').toLowerCase() === 'agent@example.com' ? { id: 12, name: 'Agent' } : null));
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 900, origin: 'freshservice', status: 'Closed', nativeNumber: null, mirrorState: null, freshserviceTicketId: 900001n });
  adoptTicket.mockResolvedValue({ id: 900, nativeNumber: 1500, displayRef: 'TP-1500', origin: 'ticketpulse', mirrorState: 'adopted' });
});

describe('meta flag', () => {
  test.each([
    ['connected', true],
    ['shadow', true],
    ['off', false],
    ['never_connected', false],
  ])('%s → freshserviceEnabled %s', async (mode, enabled) => {
    getMode.mockResolvedValue(mode);
    const res = await request(buildApp(admin)).get('/api/tickets/meta');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ freshserviceEnabled: enabled, freshserviceMode: mode });
    expect(getMode).toHaveBeenCalledWith(5);
  });

  test('a mode read error reads as connected (today\'s behaviour)', async () => {
    getMode.mockRejectedValue(new Error('db'));
    const res = await request(buildApp(admin)).get('/api/tickets/meta');
    expect(res.body.data).toMatchObject({ freshserviceEnabled: true, freshserviceMode: 'connected' });
  });
});

describe('POST /tickets/:id/adopt', () => {
  test('an agent adopts an imported ticket', async () => {
    const res = await request(buildApp(agent)).post('/api/tickets/900/adopt');
    expect(res.status).toBe(200);
    expect(adoptTicket).toHaveBeenCalledWith(900, 5, { actorEmail: 'agent@example.com', reason: 'agent' });
    expect(res.body.data).toMatchObject({ id: 900, nativeNumber: 1500, displayRef: 'TP-1500', mirrorState: 'adopted', alreadyAdopted: false });
  });

  test('a member who is neither agent nor admin is refused', async () => {
    const res = await request(buildApp(viewer)).post('/api/tickets/900/adopt');
    expect(res.status).toBe(403);
    expect(adoptTicket).not.toHaveBeenCalled();
  });

  test('a Ticket Pulse-born ticket has nothing to adopt', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 901, origin: 'ticketpulse', status: 'Open', nativeNumber: 1501, mirrorState: 'mirrored', freshserviceTicketId: 900002n });
    const res = await request(buildApp(admin)).post('/api/tickets/901/adopt');
    expect(res.status).toBe(400);
    expect(adoptTicket).not.toHaveBeenCalled();
  });

  test('an adopted ticket answers 200 with its own TP reference, without adopting again', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 900, origin: 'ticketpulse', status: 'Open', nativeNumber: 1500, mirrorState: 'adopted', freshserviceTicketId: 900001n });
    const res = await request(buildApp(admin)).post('/api/tickets/900/adopt');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ alreadyAdopted: true, nativeNumber: 1500, displayRef: 'TP-1500' });
    expect(adoptTicket).not.toHaveBeenCalled();
  });

  test.each(['connected', 'shadow'])('refused while FreshService is %s (409 freshservice_on)', async () => {
    fsModeMock.isFreshServiceOff.mockResolvedValue(false);
    const res = await request(buildApp(admin)).post('/api/tickets/900/adopt');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'freshservice_on', message: 'Adopt is only available once FreshService is off for this workspace.' });
    expect(fsModeMock.isFreshServiceOff).toHaveBeenCalledWith(5);
    expect(adoptTicket).not.toHaveBeenCalled();
  });

  test('a deleted ticket is refused', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 900, origin: 'freshservice', status: 'Deleted', nativeNumber: null, mirrorState: null, freshserviceTicketId: 900001n });
    const res = await request(buildApp(admin)).post('/api/tickets/900/adopt');
    expect(res.status).toBe(400);
    expect(adoptTicket).not.toHaveBeenCalled();
  });

  test('native ticketing must be on, as for every ticket write', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ nativeTicketingEnabled: false });
    const res = await request(buildApp(admin)).post('/api/tickets/900/adopt');
    expect(res.status).toBe(400);
    expect(adoptTicket).not.toHaveBeenCalled();
  });

  test('another workspace\'s ticket is not found', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    const res = await request(buildApp(admin)).post('/api/tickets/999/adopt');
    expect(res.status).toBe(404);
    expect(prismaMock.ticket.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 999, workspaceId: 5 } }));
  });
});
