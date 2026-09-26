import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/** /api/tone (QA 09-25 #5): settings, Straight-Talk List, preview; writes admin-only. */

const toneServiceMock = {
  getSettings: jest.fn(),
  updateSettings: jest.fn(),
  listContacts: jest.fn(),
  addContact: jest.fn(),
  removeContact: jest.fn(),
  resolveToneForTicket: jest.fn(),
};
const prismaMock = { ticket: { findFirst: jest.fn() } };
let isAdmin = true;
let isObserver = false;

jest.unstable_mockModule('../src/middleware/errorHandler.js', () => ({
  asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
}));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.workspaceId = 3; req.user = { email: 'admin@example.com' }; next(); },
  requireAdmin: (_req, res, next) => (isAdmin ? next() : res.status(403).json({ success: false })),
  requireAdminOrObserver: (req, res, next) => ((isAdmin || (isObserver && req.method === 'GET')) ? next() : res.status(403).json({ success: false })),
}));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/toneService.js', () => ({
  default: toneServiceMock,
  DEFAULT_SERIOUS_TONE_TEXT: 'Default text.',
  normalizeEmail: (v) => {
    const e = String(v || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
  },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router } = await import('../src/routes/tone.routes.js');
const app = express();
app.use(express.json());
app.use('/api/tone', router);

beforeEach(() => {
  jest.clearAllMocks();
  isAdmin = true;
  isObserver = false;
});

describe('/api/tone', () => {
  test('GET /settings is workspace-scoped and carries the default text', async () => {
    toneServiceMock.getSettings.mockResolvedValue({ defaultVoice: 'friendly' });
    const res = await request(app).get('/api/tone/settings');
    expect(res.status).toBe(200);
    expect(toneServiceMock.getSettings).toHaveBeenCalledWith(3);
    expect(res.body.data).toEqual({ defaultVoice: 'friendly', defaultSeriousToneText: 'Default text.' });
  });

  test('PUT /settings saves with the actor; validation errors are 400', async () => {
    toneServiceMock.updateSettings.mockResolvedValue({ defaultVoice: 'professional' });
    const res = await request(app).put('/api/tone/settings').send({ defaultVoice: 'professional', junk: 1 });
    expect(res.status).toBe(200);
    expect(toneServiceMock.updateSettings).toHaveBeenCalledWith(3, { defaultVoice: 'professional', seriousToneText: undefined, seriousWhenFrustrated: undefined }, 'admin@example.com');

    toneServiceMock.updateSettings.mockRejectedValue(new Error('Default voice must be friendly or professional'));
    const bad = await request(app).put('/api/tone/settings').send({ defaultVoice: 'x' });
    expect(bad.status).toBe(400);
  });

  test('writes are admin-only', async () => {
    isAdmin = false;
    expect((await request(app).post('/api/tone/contacts').send({ email: 'a@b.co' })).status).toBe(403);
    expect((await request(app).delete('/api/tone/contacts/1')).status).toBe(403);
    expect(toneServiceMock.addContact).not.toHaveBeenCalled();
  });

  test('contacts: list, add, remove', async () => {
    toneServiceMock.listContacts.mockResolvedValue([{ id: 1, email: 'pat@example.com' }]);
    expect((await request(app).get('/api/tone/contacts')).body.data).toHaveLength(1);

    toneServiceMock.addContact.mockResolvedValue({ id: 2, email: 'sam@example.com' });
    const added = await request(app).post('/api/tone/contacts').send({ email: 'sam@example.com', name: 'Sam', note: 'asked' });
    expect(added.status).toBe(201);
    expect(toneServiceMock.addContact).toHaveBeenCalledWith(3, { email: 'sam@example.com', name: 'Sam', note: 'asked' }, 'admin@example.com');

    toneServiceMock.removeContact.mockRejectedValue(new Error('Contact not found'));
    expect((await request(app).delete('/api/tone/contacts/99')).status).toBe(404);
  });

  test('POST /preview explains the override and uses the sample ticket sentiment', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 7, subject: 'VPN', sentiment: 'frustrated' });
    toneServiceMock.resolveToneForTicket.mockResolvedValue({ voice: 'friendly', override: { reason: 'frustrated', text: 'Be plain.' }, onStraightTalkList: false });
    const res = await request(app).post('/api/tone/preview').send({ email: 'Pat@Example.com', sampleTicketId: 7 });
    expect(res.status).toBe(200);
    expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual({ id: 7, workspaceId: 3 });
    expect(toneServiceMock.resolveToneForTicket).toHaveBeenCalledWith({ workspaceId: 3, requesterEmail: 'pat@example.com', sentiment: 'frustrated' });
    expect(res.body.data).toEqual(expect.objectContaining({ voice: 'professional', override: { reason: 'frustrated', text: 'Be plain.' }, sentiment: 'frustrated' }));
    expect(res.body.data.illustration.after).not.toBe(res.body.data.illustration.before);
  });

  test('POST /preview without an override keeps the workflow voice; bad e-mail is 400', async () => {
    toneServiceMock.resolveToneForTicket.mockResolvedValue({ voice: 'friendly', override: null, onStraightTalkList: false });
    const res = await request(app).post('/api/tone/preview').send({ email: 'x@example.com' });
    expect(res.body.data.voice).toBe('workflow');
    expect((await request(app).post('/api/tone/preview').send({ email: 'nope' })).status).toBe(400);
  });
  test('GET /contacts is admins and observers only; members still read settings (review N7)', async () => {
    toneServiceMock.listContacts.mockResolvedValue([{ id: 1, email: 'sam@example.com' }]);
    toneServiceMock.getSettings.mockResolvedValue({ defaultVoice: 'friendly' });
    isAdmin = false;
    expect((await request(app).get('/api/tone/contacts')).status).toBe(403);
    expect(toneServiceMock.listContacts).not.toHaveBeenCalled();
    const settings = await request(app).get('/api/tone/settings');
    expect(settings.status).toBe(200);
    expect(JSON.stringify(settings.body)).not.toContain('sam@example.com');
    isObserver = true;
    expect((await request(app).get('/api/tone/contacts')).status).toBe(200);
    isObserver = false;
    isAdmin = true;
    expect((await request(app).get('/api/tone/contacts')).status).toBe(200);
  });
});
