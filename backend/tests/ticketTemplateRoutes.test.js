import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Mega 08-26 Phase TT (QA 08-26 #2) — Settings → Ticket Ops create-form
 * templates: POST persists every captured field (subject/type/category),
 * PATCH accepts the SAME whitelist (type/category/sortOrder used to be
 * silently dropped), priority is range-checked on both verbs, ids are
 * workspace-scoped (404 across workspaces), and a (workspaceId, name)
 * collision surfaces as a friendly 400 `template_name_taken` (create + rename).
 */

const prismaMock = {
  ticketTemplate: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

const roleOf = (req) => req.headers['x-test-role'] || 'admin';
const requireAdminMock = jest.fn((req, res, next) => {
  if (roleOf(req) === 'admin') return next();
  return res.status(403).json({ success: false, error: 'Admin access required' });
});

const stub = () => ({ default: {} });
jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (_req, _res, next) => next(),
  requireAdmin: requireAdminMock,
  requireReviewer: (_req, _res, next) => next(),
  requireWorkspaceAccess: (_req, _res, next) => next(),
  requireWorkspaceMemberOrAgent: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => {
    req.workspaceId = Number(req.headers['x-test-ws'] || 1);
    req.session = { user: { email: 'admin@x.io', role: roleOf(req) } };
    next();
  },
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', stub);
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/technicianRepository.js', stub);
jest.unstable_mockModule('../src/services/groupRepository.js', stub);
jest.unstable_mockModule('../src/services/approvalCategoryService.js', stub);
jest.unstable_mockModule('../src/services/azureAdService.js', stub);
jest.unstable_mockModule('../src/services/syncService.js', stub);
jest.unstable_mockModule('../src/services/scheduledSyncService.js', stub);
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ sendAssignmentEmail: jest.fn() }));
jest.unstable_mockModule('../src/services/emailHealthService.js', stub);
jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({
  placeVoiceCall: jest.fn(), sendSms: jest.fn(), sendWhatsApp: jest.fn(),
}));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => ({
  buildPublicTicketStatusUrl: jest.fn(),
  ensurePublicTicketStatusLink: jest.fn(),
  getPublicTicketStatusSettings: jest.fn(),
  previewPublicTicketStatus: jest.fn(),
  resetPublicTicketStatusLink: jest.fn(),
  revokePublicTicketStatusLink: jest.fn(),
  updatePublicTicketStatusSettings: jest.fn(),
}));
jest.unstable_mockModule('../src/services/publicFeedbackService.js', () => ({
  getFeedbackSettings: jest.fn(),
  updateFeedbackSettings: jest.fn(),
  listFeedbackSubmissions: jest.fn(),
  deleteFeedbackSubmission: jest.fn(),
}));
jest.unstable_mockModule('../src/services/afterHoursUrgentEscalationService.js', stub);
jest.unstable_mockModule('../src/services/ticketFormConfigService.js', stub);
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: settingsRouter } = await import('../src/routes/settings.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/settings', settingsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code });
  });
  return app;
}

const QA_SUBJECT = '{A2XXXX - NAME OF PROPOSAL} is now active in BST';
const EXISTING = {
  id: 3, workspaceId: 5, name: 'Internal Proposals',
  subject: QA_SUBJECT,
  description: null, priority: null, ticketType: null,
  internalCategoryId: null, internalSubcategoryId: null, isActive: true, sortOrder: 0,
};

const p2002 = () => Object.assign(new Error('Unique constraint failed on the fields: (workspace_id,name)'), { code: 'P2002' });

describe('/settings/ticket-templates routes (Phase TT)', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticketTemplate.create.mockImplementation(async ({ data }) => ({ id: 9, ...data }));
    prismaMock.ticketTemplate.update.mockImplementation(async ({ where, data }) => ({ ...EXISTING, ...where, ...data }));
    prismaMock.ticketTemplate.findFirst.mockImplementation(async ({ where }) => (
      where.id === EXISTING.id && where.workspaceId === EXISTING.workspaceId ? EXISTING : null
    ));
  });

  describe('POST', () => {
    test('persists subject, description, priority, type, category and subcategory', async () => {
      const res = await request(app).post('/settings/ticket-templates').set('x-test-ws', '5').send({
        name: '  Internal Proposals ',
        subject: QA_SUBJECT,
        description: 'Proposal:\nClient:',
        priority: '3',
        ticketType: 'Case',
        internalCategoryId: '12',
        internalSubcategoryId: '34',
        sortOrder: '2',
      });
      expect(res.status).toBe(201);
      expect(prismaMock.ticketTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 5,
          name: 'Internal Proposals',
          subject: QA_SUBJECT,
          description: 'Proposal:\nClient:',
          priority: 3,
          ticketType: 'Case',
          internalCategoryId: 12,
          internalSubcategoryId: 34,
          sortOrder: 2,
          createdBy: 'admin@x.io',
        }),
      });
      expect(res.body.data.subject).toBe(QA_SUBJECT);
    });

    test('blank optional fields persist as null (no empty strings)', async () => {
      const res = await request(app).post('/settings/ticket-templates').send({ name: 'Bare', subject: '', priority: '', ticketType: '', internalCategoryId: '' });
      expect(res.status).toBe(201);
      expect(prismaMock.ticketTemplate.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
        subject: null, priority: null, ticketType: null, internalCategoryId: null, internalSubcategoryId: null, sortOrder: 0,
      }));
    });

    test('rejects a missing name and out-of-range priority (0 and 5)', async () => {
      expect((await request(app).post('/settings/ticket-templates').send({ subject: 'x' })).status).toBe(400);
      expect((await request(app).post('/settings/ticket-templates').send({ name: 'P0', priority: 0 })).status).toBe(400);
      expect((await request(app).post('/settings/ticket-templates').send({ name: 'P5', priority: 5 })).status).toBe(400);
      expect(prismaMock.ticketTemplate.create).not.toHaveBeenCalled();
    });

    test('duplicate name in the workspace → 400 template_name_taken (not a raw Prisma error)', async () => {
      prismaMock.ticketTemplate.create.mockRejectedValueOnce(p2002());
      const res = await request(app).post('/settings/ticket-templates').set('x-test-ws', '5').send({ name: 'Internal Proposals' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('template_name_taken');
      expect(res.body.message).toMatch(/already exists/);
    });

    test('non-admins are rejected', async () => {
      const res = await request(app).post('/settings/ticket-templates').set('x-test-role', 'viewer').send({ name: 'Nope' });
      expect(res.status).toBe(403);
      expect(prismaMock.ticketTemplate.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH', () => {
    const patch = (body, ws = '5') => request(app).patch(`/settings/ticket-templates/${EXISTING.id}`).set('x-test-ws', ws).send(body);

    test.each([
      ['name', { name: ' Proposals v2 ' }, { name: 'Proposals v2' }],
      ['subject', { subject: 'New subject' }, { subject: 'New subject' }],
      ['description', { description: 'Scaffold' }, { description: 'Scaffold' }],
      ['priority', { priority: '4' }, { priority: 4 }],
      ['ticketType', { ticketType: 'Case' }, { ticketType: 'Case' }],
      ['internalCategoryId', { internalCategoryId: '12' }, { internalCategoryId: 12 }],
      ['internalSubcategoryId', { internalSubcategoryId: 34 }, { internalSubcategoryId: 34 }],
      ['sortOrder', { sortOrder: '7' }, { sortOrder: 7 }],
      ['isActive', { isActive: false }, { isActive: false }],
    ])('PATCH %s is whitelisted and coerced', async (_field, body, expected) => {
      const res = await patch(body);
      expect(res.status).toBe(200);
      expect(prismaMock.ticketTemplate.update).toHaveBeenCalledWith({ where: { id: EXISTING.id }, data: expected });
    });

    test('only the sent fields are patched — omitted ones are untouched', async () => {
      await patch({ subject: 'Only this' });
      const { data } = prismaMock.ticketTemplate.update.mock.calls[0][0];
      expect(Object.keys(data)).toEqual(['subject']);
    });

    test('clearing type/category/priority with empty strings writes null', async () => {
      await patch({ ticketType: '', internalCategoryId: '', internalSubcategoryId: '', priority: '' });
      expect(prismaMock.ticketTemplate.update.mock.calls[0][0].data).toEqual({
        ticketType: null, internalCategoryId: null, internalSubcategoryId: null, priority: null,
      });
    });

    test('priority 0 / 5 are rejected on PATCH too (was unchecked)', async () => {
      expect((await patch({ priority: 0 })).status).toBe(400);
      expect((await patch({ priority: 5 })).status).toBe(400);
      expect((await patch({ priority: 'high' })).status).toBe(400);
      expect(prismaMock.ticketTemplate.update).not.toHaveBeenCalled();
    });

    test('blank name on rename is rejected', async () => {
      expect((await patch({ name: '   ' })).status).toBe(400);
      expect(prismaMock.ticketTemplate.update).not.toHaveBeenCalled();
    });

    test('a template from another workspace is a 404, never patched', async () => {
      const res = await patch({ subject: 'cross-ws' }, '1');
      expect(res.status).toBe(404);
      expect(prismaMock.ticketTemplate.update).not.toHaveBeenCalled();
    });

    test('rename onto an existing name → 400 template_name_taken', async () => {
      prismaMock.ticketTemplate.update.mockRejectedValueOnce(p2002());
      const res = await patch({ name: 'Other existing' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('template_name_taken');
      expect(res.body.message).toMatch(/"Other existing"/);
    });
  });

  describe('DELETE', () => {
    test('workspace-scoped: other workspace → 404', async () => {
      const res = await request(app).delete(`/settings/ticket-templates/${EXISTING.id}`).set('x-test-ws', '1');
      expect(res.status).toBe(404);
      expect(prismaMock.ticketTemplate.delete).not.toHaveBeenCalled();
    });
    test('own workspace → deleted', async () => {
      prismaMock.ticketTemplate.delete.mockResolvedValue(EXISTING);
      const res = await request(app).delete(`/settings/ticket-templates/${EXISTING.id}`).set('x-test-ws', '5');
      expect(res.status).toBe(200);
      expect(prismaMock.ticketTemplate.delete).toHaveBeenCalledWith({ where: { id: 3 } });
    });
  });
});
