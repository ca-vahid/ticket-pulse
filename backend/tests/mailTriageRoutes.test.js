import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Mail triage routes (plans/MAIL_TRIAGE_PLAN.md, the API contract):
 *   /api/tickets/mail-review...   staff (agents and admins); "judge again" admins only
 *   /api/settings/mail-triage     workspace admins
 * against the real routers and the real auth middleware. A role refusal is a
 * 403, never a 401 (a 401 sends a signed-in person into the sign-in loop).
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  mailboxConnection: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  $queryRaw: jest.fn(),
};
const triage = {
  list: jest.fn(), detail: jest.fn(), resolve: jest.fn(), bulkAccept: jest.fn(), undo: jest.fn(), rejudge: jest.fn(), ticketSearch: jest.fn(),
  settingsWithStats: jest.fn(), saveSettings: jest.fn(), getSettings: jest.fn(),
};
const holdMock = { list: jest.fn(), count: jest.fn() };
const wsRepo = { getAccessRole: jest.fn() };
const stub = () => ({ default: {} });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/mailTriageService.js', () => ({ default: triage }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: wsRepo }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 2; next(); },
}));
// tickets.routes.js
jest.unstable_mockModule('../src/services/mailboxHoldService.js', () => ({ default: holdMock, NEW_TICKET_POLICIES: ['create', 'replies_only', 'hold_unmatched'] }));
jest.unstable_mockModule('../src/services/emailHealthService.js', stub);
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: jest.fn(() => true) } }));
jest.unstable_mockModule('../src/services/ticketService.js', stub);
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() } }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() }, sendAssignmentEmail: jest.fn() }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', stub);
// settings.routes.js
jest.unstable_mockModule('../src/services/settingsRepository.js', stub);
jest.unstable_mockModule('../src/services/technicianRepository.js', stub);
jest.unstable_mockModule('../src/services/groupRepository.js', stub);
jest.unstable_mockModule('../src/services/groupCoordinatorService.js', stub);
jest.unstable_mockModule('../src/services/approvalCategoryService.js', stub);
jest.unstable_mockModule('../src/services/syncService.js', stub);
jest.unstable_mockModule('../src/services/scheduledSyncService.js', stub);
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn(), readCache: () => (_req, _res, next) => next() }));
jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({ placeVoiceCall: jest.fn(), sendSms: jest.fn(), sendWhatsApp: jest.fn() }));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => ({
  buildPublicTicketStatusUrl: jest.fn(), ensurePublicTicketStatusLink: jest.fn(), getPublicTicketStatusSettings: jest.fn(), previewPublicTicketStatus: jest.fn(),
  resetPublicTicketStatusLink: jest.fn(), revokePublicTicketStatusLink: jest.fn(), updatePublicTicketStatusSettings: jest.fn(),
}));
jest.unstable_mockModule('../src/services/publicFeedbackService.js', () => ({
  getFeedbackSettings: jest.fn(), updateFeedbackSettings: jest.fn(), listFeedbackSubmissions: jest.fn(), deleteFeedbackSubmission: jest.fn(),
}));
jest.unstable_mockModule('../src/services/afterHoursUrgentEscalationService.js', stub);

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');
const { default: settingsRouter } = await import('../src/routes/settings.routes.js');
const { ConflictError } = await import('../src/utils/errors.js');

const AGENT = { email: 'ari@example.com', name: 'Ari Agent', role: 'agent' };
const ADMIN = { email: 'root@example.com', name: 'Root', role: 'admin' };
const VIEWER = { email: 'viewer@example.com', name: 'Viewer', role: 'user' };
const WS_ADMIN = { email: 'lead@example.com', name: 'Lead', role: 'user' };

function buildApp(sessionUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: sessionUser }; next(); });
  app.use('/api/tickets', ticketsRouter);
  app.use('/api/settings', settingsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 2, nativeTicketingEnabled: true, defaultTimezone: 'America/Vancouver', internalDomains: [] });
  wsRepo.getAccessRole.mockResolvedValue(null);
  triage.list.mockResolvedValue({ data: [{ heldId: 501 }], meta: { waiting: 1, doneToday: 0, mode: 'shadow', sureCount: 0 } });
  triage.detail.mockResolvedValue({ heldId: 501, bodyHtml: '<p>x</p>', candidates: [], decisions: [] });
  triage.resolve.mockResolvedValue({ heldId: 501, resolution: { status: 'attached' } });
  triage.bulkAccept.mockResolvedValue({ accepted: [501], skipped: [] });
  triage.undo.mockResolvedValue({ heldId: 501, resolution: null });
  triage.rejudge.mockResolvedValue({ heldId: 501 });
  triage.ticketSearch.mockResolvedValue([{ id: 9, ref: 'TP-9' }]);
  triage.settingsWithStats.mockResolvedValue({ mode: 'off', guidance: '', monthlyCapUsd: 10, stats: { last30: { judged: 0, sureAccepted: 0, sureChanged: 0, agreementPct: null } } });
  triage.saveSettings.mockResolvedValue({});
  triage.getSettings.mockResolvedValue({ mode: 'shadow' });
  holdMock.list.mockResolvedValue([{ id: 501 }]);
  holdMock.count.mockResolvedValue(1);
});

function asAgent() {
  prismaMock.technician.findFirst.mockResolvedValue({ id: 3, name: 'Ari Agent' });
  wsRepo.getAccessRole.mockResolvedValue('member');
  return buildApp(AGENT);
}
function asViewer() {
  prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'viewer' });
  prismaMock.workspaceAccess.findFirst.mockResolvedValue({ role: 'viewer' });
  wsRepo.getAccessRole.mockResolvedValue('viewer');
  return buildApp(VIEWER);
}
function asWorkspaceAdmin() {
  prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'admin' });
  prismaMock.workspaceAccess.findFirst.mockResolvedValue({ role: 'admin' });
  wsRepo.getAccessRole.mockResolvedValue('admin');
  return buildApp(WS_ADMIN);
}

describe('GET /api/tickets/mail-review', () => {
  test('every agent in the workspace may read it; the tab and filters pass through', async () => {
    const res = await request(asAgent()).get('/api/tickets/mail-review?tab=log&limit=20&before=99&outcome=changed&confidence=sure&action=attach').expect(200);
    expect(res.body).toEqual({ success: true, data: [{ heldId: 501 }], meta: { waiting: 1, doneToday: 0, mode: 'shadow', sureCount: 0 } });
    expect(triage.list).toHaveBeenCalledWith(2, { tab: 'log', limit: '20', before: '99', outcome: 'changed', confidence: 'sure', action: 'attach' });
    await request(buildApp(ADMIN)).get('/api/tickets/mail-review').expect(200);
    expect(triage.list).toHaveBeenLastCalledWith(2, expect.objectContaining({ tab: 'waiting' }));
    await request(asAgent()).get('/api/tickets/mail-review?tab=everything').expect(200);
    expect(triage.list).toHaveBeenLastCalledWith(2, expect.objectContaining({ tab: 'waiting' }));
  });

  test('a viewer is refused with 403, never 401', async () => {
    const app = asViewer();
    for (const [method, path] of [
      ['get', '/api/tickets/mail-review'], ['get', '/api/tickets/mail-review/501'], ['get', '/api/tickets/mail-review/ticket-search?q=abc'],
      ['post', '/api/tickets/mail-review/501/resolve'], ['post', '/api/tickets/mail-review/bulk-accept'], ['post', '/api/tickets/mail-review/501/undo'], ['post', '/api/tickets/mail-review/501/rejudge'],
    ]) {
      const res = await request(app)[method](path).send({});
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.body.code).toMatch(/staff_required|admin_required/);
    }
    for (const fn of Object.values(triage)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('GET /api/tickets/mailboxes/held (the Tickets button)', () => {
  test('the held count also says which mode Mail triage is in, and reads Off when that cannot be read', async () => {
    const res = await request(asAgent()).get('/api/tickets/mailboxes/held').expect(200);
    expect(res.body.meta).toEqual({ heldCount: 1, triageMode: 'shadow' });
    expect(triage.getSettings).toHaveBeenCalledWith(2);
    triage.getSettings.mockRejectedValue(new Error('settings unreadable'));
    const off = await request(asAgent()).get('/api/tickets/mailboxes/held').expect(200);
    expect(off.body.meta).toEqual({ heldCount: 1, triageMode: 'off' });
  });
});

describe('the specific paths come before /:heldId', () => {
  test('ticket-search and bulk-accept are not read as a held id', async () => {
    const search = await request(asAgent()).get('/api/tickets/mail-review/ticket-search?q=invoice').expect(200);
    expect(search.body.data).toEqual([{ id: 9, ref: 'TP-9' }]);
    expect(triage.ticketSearch).toHaveBeenCalledWith(2, 'invoice');
    const bulk = await request(asAgent()).post('/api/tickets/mail-review/bulk-accept').send({ heldIds: [501, 502] }).expect(200);
    expect(bulk.body.data).toEqual({ accepted: [501], skipped: [] });
    expect(triage.bulkAccept).toHaveBeenCalledWith(2, [501, 502], expect.objectContaining({ email: 'ari@example.com', technicianId: 3 }));
    expect(triage.detail).not.toHaveBeenCalled();
    expect(triage.resolve).not.toHaveBeenCalled();
  });

  test('a held id that is not a number is a 400', async () => {
    await request(asAgent()).get('/api/tickets/mail-review/not-a-number').expect(400);
    await request(asAgent()).post('/api/tickets/mail-review/0/undo').expect(400);
    expect(triage.detail).not.toHaveBeenCalled();
  });
});

describe('one held mail', () => {
  test('detail, resolve and undo for an agent', async () => {
    const detail = await request(asAgent()).get('/api/tickets/mail-review/501').expect(200);
    expect(detail.body.data).toMatchObject({ heldId: 501, candidates: [], decisions: [] });
    expect(triage.detail).toHaveBeenCalledWith(2, 501);

    await request(asAgent()).post('/api/tickets/mail-review/501/resolve').send({ action: 'attach', ticketId: 77, reopen: false, decisionId: 12 }).expect(200);
    expect(triage.resolve).toHaveBeenCalledWith(2, 501, { action: 'attach', ticketId: 77, reopen: false, decisionId: 12 }, expect.objectContaining({ email: 'ari@example.com' }));
    // reopen is passed only when the person answered it; a requester only when one was sent.
    await request(asAgent()).post('/api/tickets/mail-review/501/resolve').send({ action: 'create', requesterEmail: 'robin.vale@client.example', reopen: 'yes' }).expect(200);
    expect(triage.resolve).toHaveBeenLastCalledWith(2, 501, { action: 'create', ticketId: undefined, requesterEmail: 'robin.vale@client.example', decisionId: null }, expect.anything());

    await request(asAgent()).post('/api/tickets/mail-review/501/undo').expect(200);
    expect(triage.undo).toHaveBeenCalledWith(2, 501, expect.objectContaining({ email: 'ari@example.com' }));
  });

  test('an undo that is no longer safe is a 409 with the plain message', async () => {
    triage.undo.mockRejectedValue(new ConflictError('The ticket was worked since this e-mail was added, so it cannot be undone here'));
    const res = await request(asAgent()).post('/api/tickets/mail-review/501/undo').expect(409);
    expect(res.body.message).toBe('The ticket was worked since this e-mail was added, so it cannot be undone here');
  });

  test('"judge again" is for admins: an agent gets 403, a workspace admin and a global admin pass', async () => {
    const res = await request(asAgent()).post('/api/tickets/mail-review/501/rejudge').expect(403);
    expect(res.body.code).toBe('admin_required');
    expect(triage.rejudge).not.toHaveBeenCalled();
    await request(asWorkspaceAdmin()).post('/api/tickets/mail-review/501/rejudge').expect(200);
    await request(buildApp(ADMIN)).post('/api/tickets/mail-review/501/rejudge').expect(200);
    expect(triage.rejudge).toHaveBeenCalledTimes(2);
    expect(triage.rejudge).toHaveBeenCalledWith(2, 501);
  });
});

describe('GET / PUT /api/settings/mail-triage', () => {
  test('workspace admins read and save it; the answer carries the read-only stats', async () => {
    const read = await request(asWorkspaceAdmin()).get('/api/settings/mail-triage').expect(200);
    expect(read.body.data).toEqual({ mode: 'off', guidance: '', monthlyCapUsd: 10, stats: { last30: { judged: 0, sureAccepted: 0, sureChanged: 0, agreementPct: null } } });
    expect(triage.settingsWithStats).toHaveBeenCalledWith(2);

    await request(buildApp(ADMIN)).put('/api/settings/mail-triage').send({ mode: 'shadow', guidance: 'Remittance advice notices need no ticket.', monthlyCapUsd: 15, stats: { last30: { judged: 999 } } }).expect(200);
    expect(triage.saveSettings).toHaveBeenCalledWith(2, { mode: 'shadow', guidance: 'Remittance advice notices need no ticket.', monthlyCapUsd: 15 });
    await request(buildApp(ADMIN)).put('/api/settings/mail-triage').send({ mode: 'on' }).expect(200);
    expect(triage.saveSettings).toHaveBeenLastCalledWith(2, { mode: 'on' });
  });

  test('agents and viewers are refused with 403, never 401', async () => {
    for (const app of [asAgent(), asViewer()]) {
      const read = await request(app).get('/api/settings/mail-triage');
      const save = await request(app).put('/api/settings/mail-triage').send({ mode: 'on' });
      expect([read.status, save.status]).toEqual([403, 403]);
    }
    expect(triage.settingsWithStats).not.toHaveBeenCalled();
    expect(triage.saveSettings).not.toHaveBeenCalled();
  });
});
