import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';

/**
 * 4.4.08: POST /api/tickets/:id/attachments/:attId/name (Revert / Edit) and the
 * download's Content-Disposition with the display name. Invented names only.
 */

let rows = [];
let activities = [];
const settings = new Map();
const match = (row, where = {}) => Object.entries(where).every(([k, v]) => (k === 'NOT' ? !match(row, v) : row[k] === v));

const prismaMock = {
  workspace: { findUnique: jest.fn(async () => ({ id: 7, nativeTicketingEnabled: true, internalDomains: ['ourco.example'] })) },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  ticketAttachment: {
    findFirst: jest.fn(async ({ where }) => rows.find((r) => match(r, where)) || null),
    findMany: jest.fn(async ({ where }) => rows.filter((r) => match(r, where))),
    update: jest.fn(async ({ where, data }) => { const r = rows.find((x) => x.id === where.id); Object.assign(r, data); return { ...r }; }),
  },
  ticketActivity: { create: jest.fn(async ({ data }) => { activities.push(data); return data; }) },
  appSettings: {
    findUnique: jest.fn(async ({ where }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null)),
    upsert: jest.fn(async ({ where, create }) => { settings.set(where.key, create.value); return create; }),
  },
  $queryRaw: jest.fn(),
};

const openDownload = jest.fn();
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() } }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { enqueueAttachment: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null), merge: jest.fn() } }));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: { openDownload, listForTicket: jest.fn(), upload: jest.fn() },
  MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
}));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 7; next(); },
}));

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');
const { blockReadonlyWrites } = await import('../src/middleware/auth.js');

function buildApp(sessionUser, { withReadonlyGate = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: sessionUser }; next(); });
  if (withReadonlyGate) app.use('/api', (req, _res, next) => { req.headers['x-workspace-id'] = '7'; next(); }, blockReadonlyWrites);
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(err.statusCode || 500).json({ success: false, message: err.message }); });
  return app;
}

const agent = { email: 'dana.fox@ourco.example', name: 'Dana Fox', role: 'agent' };

function addRow(over = {}) {
  const row = {
    id: 500 + rows.length, workspaceId: 7, ticketId: 1042, fileName: 'INV-100234.pdf', contentType: 'application/pdf', sizeBytes: 3,
    source: 'email', uploadedBy: 'billing@acme.example', blobName: 'b', createdAt: new Date('2026-11-23T18:00:00Z'),
    displayName: null, nameSource: null, nameDetails: null, namedAt: null, namedBy: null, ...over,
  };
  rows.push(row);
  return row;
}

beforeEach(() => {
  rows = []; activities = []; settings.clear();
  jest.clearAllMocks();
  // An agent: an active technician in the workspace, no membership row.
  prismaMock.technician.findFirst.mockResolvedValue({ id: 9, name: 'Dana Fox' });
  prismaMock.workspaceAccess.findUnique.mockResolvedValue(null);
  prismaMock.workspaceAccess.findFirst.mockResolvedValue(null);
});

describe('POST /api/tickets/:id/attachments/:attId/name', () => {
  test('revert: the original name comes back, history row written', async () => {
    const row = addRow({ displayName: 'Acme Supplies_INV-100234_2026_11_23.pdf', nameSource: 'auto', nameDetails: { vendor: 'Acme Supplies', method: 'rules' } });
    const res = await request(buildApp(agent)).post(`/api/tickets/1042/attachments/${row.id}/name`).send({ action: 'revert' }).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: row.id, displayName: null, originalName: 'INV-100234.pdf', fileName: 'INV-100234.pdf', nameSource: 'reverted', nameDetails: { vendor: 'Acme Supplies' } });
    expect(activities[0]).toMatchObject({ ticketId: 1042, activityType: 'attachment_renamed', performedBy: 'Dana Fox' });
    expect(activities[0].details).toMatchObject({ action: 'revert', to: 'INV-100234.pdf' });
  });

  test('edit: the typed name with the original extension; the vendor list learns the sender domain', async () => {
    const row = addRow();
    const res = await request(buildApp(agent)).post(`/api/tickets/1042/attachments/${row.id}/name`).send({ action: 'edit', name: 'Acme Supplies_INV-100234' }).expect(200);
    expect(res.body.data).toMatchObject({ displayName: 'Acme Supplies_INV-100234.pdf', nameSource: 'manual', originalName: 'INV-100234.pdf', namedBy: 'Dana Fox' });
    expect(activities[0].details).toMatchObject({ action: 'edit', from: 'INV-100234.pdf', to: 'Acme Supplies_INV-100234.pdf', actorEmail: 'dana.fox@ourco.example' });
    expect(JSON.parse(settings.get('attachment_vendor_aliases_ws7'))).toEqual({ 'acme.example': 'Acme Supplies' });
  });

  test('another ticket\'s attachment is a 404, and nothing changes', async () => {
    const row = addRow({ ticketId: 2001, displayName: 'Acme_1.pdf', nameSource: 'auto' });
    const res = await request(buildApp(agent)).post(`/api/tickets/1042/attachments/${row.id}/name`).send({ action: 'revert' }).expect(404);
    expect(res.body.message).toBe('Attachment not found');
    expect(rows[0].displayName).toBe('Acme_1.pdf');
    expect(activities).toHaveLength(0);
  });

  test('workspace scoping: the same ids in another workspace are a 404', async () => {
    const row = addRow({ workspaceId: 8 });
    await request(buildApp(agent)).post(`/api/tickets/1042/attachments/${row.id}/name`).send({ action: 'edit', name: 'Acme' }).expect(404);
    expect(prismaMock.ticketAttachment.findFirst).toHaveBeenCalledWith({ where: { id: row.id, ticketId: 1042, workspaceId: 7 } });
  });

  test('bad input: unknown action 400, empty name 400, bad attachment id 404', async () => {
    const row = addRow();
    await request(buildApp(agent)).post(`/api/tickets/1042/attachments/${row.id}/name`).send({ action: 'rename' }).expect(400);
    const empty = await request(buildApp(agent)).post(`/api/tickets/1042/attachments/${row.id}/name`).send({ action: 'edit', name: '  ' }).expect(400);
    expect(empty.body.message).toBe('Type a name for the file.');
    await request(buildApp(agent)).post('/api/tickets/1042/attachments/abc/name').send({ action: 'revert' }).expect(404);
  });

  test('someone with no access to the workspace gets 403; a read-only member gets 403', async () => {
    prismaMock.technician.findFirst.mockResolvedValue(null);
    const row = addRow({ displayName: 'Acme_1.pdf', nameSource: 'auto' });
    await request(buildApp({ email: 'stranger@example.com', name: 'Sam Okafor', role: 'viewer' })).post(`/api/tickets/1042/attachments/${row.id}/name`).send({ action: 'revert' }).expect(403);
    prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'readonly' });
    prismaMock.workspaceAccess.findFirst.mockResolvedValue({ role: 'readonly' });
    await request(buildApp({ email: 'olly@example.com', name: 'Priya Nair', role: 'viewer' }, { withReadonlyGate: true }))
      .post(`/api/tickets/1042/attachments/${row.id}/name`).send({ action: 'revert' }).expect(403);
    expect(rows[0].displayName).toBe('Acme_1.pdf');
  });
});

describe('download Content-Disposition', () => {
  const download = (row) => {
    openDownload.mockResolvedValueOnce({ attachment: row, stream: Readable.from([Buffer.from('pdf')]) });
    return request(buildApp(agent)).get(`/api/tickets/1042/attachments/${row.id}/download`).expect(200);
  };

  test('uses the display name when set', async () => {
    const res = await download(addRow({ displayName: 'Acme Supplies_INV-100234_2026_11_23.pdf' }));
    expect(res.headers['content-disposition'])
      .toBe('attachment; filename="Acme Supplies_INV-100234_2026_11_23.pdf"; filename*=UTF-8\'\'Acme%20Supplies_INV-100234_2026_11_23.pdf');
  });

  test('falls back to the original name', async () => {
    const res = await download(addRow());
    expect(res.headers['content-disposition']).toBe('attachment; filename="INV-100234.pdf"; filename*=UTF-8\'\'INV-100234.pdf');
  });

  test('non-ASCII display names are RFC 5987-encoded with an ASCII fallback', async () => {
    const res = await download(addRow({ displayName: 'Café Müller_2026_11_23.pdf' }));
    expect(res.headers['content-disposition'])
      .toBe('attachment; filename="Cafe Muller_2026_11_23.pdf"; filename*=UTF-8\'\'Caf%C3%A9%20M%C3%BCller_2026_11_23.pdf');
  });
});
