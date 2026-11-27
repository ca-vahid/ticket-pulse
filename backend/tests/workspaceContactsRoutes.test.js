import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Settings → Contacts routes (QA 11-26 item 2): workspace admin of the
 * SELECTED workspace or super admin. Refusals are 403 (never 401, which would
 * send the browser into sign-in recovery); a body/query workspace other than
 * the selected one is refused; the service always gets the selected workspace.
 */
const ACCESS = {
  'admin.one@example.com': { 1: 'admin', 2: 'viewer' },
  'dana.fox@example.com': { 1: 'viewer' },
  'riley.ward@example.com': { 1: 'readonly' },
};
const workspaceRepoMock = {
  getAccessRole: jest.fn(async (email, wsId) => ACCESS[String(email).toLowerCase()]?.[wsId] || null),
  hasActiveTechnician: jest.fn(async () => false),
};
const serviceMock = {
  list: jest.fn().mockResolvedValue({ contacts: [], total: 0, sandbox: false }),
  add: jest.fn().mockResolvedValue({ contact: { id: 1 }, existing: false, message: 'ok' }),
  update: jest.fn().mockResolvedValue({ contact: { id: 1 }, changed: ['note'] }),
  remove: jest.fn().mockResolvedValue({ removed: true, hidden: false }),
};

jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: workspaceRepoMock }));
jest.unstable_mockModule('../src/services/workspaceContactService.js', () => ({ default: serviceMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: contactsRouter } = await import('../src/routes/workspaceContacts.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

const USERS = {
  root: { email: 'root@example.com', role: 'admin' },
  adminOne: { email: 'admin.one@example.com', role: 'viewer', selectedWorkspaceId: 1 },
  dana: { email: 'dana.fox@example.com', role: 'viewer', selectedWorkspaceId: 1 },
  riley: { email: 'riley.ward@example.com', role: 'viewer', selectedWorkspaceId: 1 },
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = USERS[req.headers['x-test-user']];
  req.session = who ? { user: { ...who } } : {};
  next();
});
app.use('/api/settings/contacts', contactsRouter);
app.use(errorHandler);

const as = (user, req, ws = '1') => req.set('x-test-user', user).set('x-workspace-id', ws);

beforeEach(() => jest.clearAllMocks());

describe('who may use Contacts', () => {
  test.each(['dana', 'riley'])('%s (not a workspace admin) gets 403 on every route', async (who) => {
    const res = await Promise.all([
      as(who, request(app).get('/api/settings/contacts')),
      as(who, request(app).post('/api/settings/contacts')).send({ name: 'Avery Stone', email: 'avery@example.com' }),
      as(who, request(app).patch('/api/settings/contacts/5')).send({ note: 'x' }),
      as(who, request(app).delete('/api/settings/contacts/5')),
    ]);
    for (const r of res) expect(r.status).toBe(403);
    expect(serviceMock.list).not.toHaveBeenCalled();
    expect(serviceMock.add).not.toHaveBeenCalled();
    expect(serviceMock.update).not.toHaveBeenCalled();
    expect(serviceMock.remove).not.toHaveBeenCalled();
  });

  test('an admin of workspace 1 is refused in workspace 2, where they are only a viewer', async () => {
    const res = await as('adminOne', request(app).get('/api/settings/contacts'), '2');
    expect(res.status).toBe(403);
    expect(serviceMock.list).not.toHaveBeenCalled();
  });

  test('the workspace admin reaches the service with the selected workspace and their e-mail', async () => {
    await as('adminOne', request(app).get('/api/settings/contacts?q=avery')).expect(200);
    expect(serviceMock.list).toHaveBeenCalledWith(1, { search: 'avery' });
    await as('adminOne', request(app).post('/api/settings/contacts')).send({ name: 'Avery Stone', email: 'avery@example.com', extra: 'ignored' }).expect(201);
    expect(serviceMock.add).toHaveBeenCalledWith(1, { name: 'Avery Stone', email: 'avery@example.com', phone: undefined, jobTitle: undefined, note: undefined }, 'admin.one@example.com');
    await as('adminOne', request(app).patch('/api/settings/contacts/5')).send({ note: 'Billing' }).expect(200);
    expect(serviceMock.update).toHaveBeenCalledWith(1, '5', expect.objectContaining({ note: 'Billing' }), 'admin.one@example.com');
    await as('adminOne', request(app).delete('/api/settings/contacts/5')).expect(200);
    expect(serviceMock.remove).toHaveBeenCalledWith(1, '5', 'admin.one@example.com');
  });

  test('a known person linked answers 200, a new one 201', async () => {
    serviceMock.add.mockResolvedValueOnce({ contact: { id: 2 }, existing: true, message: 'already known' });
    const res = await as('root', request(app).post('/api/settings/contacts')).send({ name: 'Avery Stone', email: 'avery@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data.existing).toBe(true);
  });

  test('a body naming another workspace is refused, not followed', async () => {
    const res = await as('root', request(app).post('/api/settings/contacts')).send({ name: 'Avery Stone', email: 'avery@example.com', workspaceId: 2 });
    expect(res.status).toBe(400);
    expect(serviceMock.add).not.toHaveBeenCalled();
  });

  test('no user on the request: 403 here (sign-in itself is requireAuth\'s job upstream)', async () => {
    const res = await request(app).get('/api/settings/contacts').set('x-workspace-id', '1');
    expect(res.status).toBe(403);
  });
});
