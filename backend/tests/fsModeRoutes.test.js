import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * FreshService switch routes (25 Nov 2026, plans/FRESHSERVICE_SWITCH_PLAN.md).
 *  - reads: workspace admins of THAT workspace and super admins; writes: super admins only
 *  - a never-connected workspace (FS id 0) is refused, with nothing to switch
 *  - Off needs the typed workspace name, refuses while the preflight blocks,
 *    adopts in the background, and only then sets the mode Off
 *  - a failed adoption leaves the mode alone; one job per workspace
 */

const prismaMock = {
  workspace: { findUnique: jest.fn(), findMany: jest.fn() },
  mailboxConnection: { count: jest.fn() },
  ticket: { count: jest.fn(), findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  notificationWorkflow: { findFirst: jest.fn() },
};
const settings = new Map();
const settingsRepo = {
  get: jest.fn(async (k) => (settings.has(k) ? settings.get(k) : null)),
  set: jest.fn(async (k, v) => { settings.set(k, v); }),
};
const fsMode = {
  FS_MODES: ['connected', 'shadow', 'off'], FS_PURPOSES: [],
  getMode: jest.fn(),
  getModeRecord: jest.fn(),
  getShadowReport: jest.fn(),
  setMode: jest.fn(),
  isFreshServiceOff: jest.fn(), fsGate: jest.fn(), onModeChange: jest.fn(() => () => {}), flushShadow: jest.fn(),
  modeSettingKey: (ws) => `freshservice_mode_ws${ws}`, shadowSettingKey: (ws) => `freshservice_shadow_ws${ws}`, _resetFsModeCache: jest.fn(),
};
const adoption = {
  previewWorkspace: jest.fn(),
  adoptWorkspace: jest.fn(),
};
const recordAccessEvent = jest.fn().mockResolvedValue({});
const accessRole = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepo }));
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({ ...fsMode, default: fsMode }));
jest.unstable_mockModule('../src/services/fsAdoptionService.js', () => ({ ...adoption, default: adoption }));
jest.unstable_mockModule('../src/services/accessAuditService.js', () => ({
  recordAccessEvent,
  ACTIONS: { FRESHSERVICE_MODE_CHANGED: 'freshservice_mode_changed', FRESHSERVICE_TICKETS_ADOPTED: 'freshservice_tickets_adopted' },
}));
jest.unstable_mockModule('../src/services/autoCloseResolvedService.js', () => ({
  default: { getSettings: jest.fn().mockResolvedValue({ enabled: true }) },
}));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAccessRole: accessRole },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const routes = await import('../src/routes/fsMode.routes.js');
const { default: fsModeRoutes, _jobPromise, jobSettingKey, failureSentence } = routes;
const { errorHandler } = await import('../src/middleware/errorHandler.js');

function makeApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = user ? { user } : {}; next(); });
  app.use('/api/workspaces', fsModeRoutes);
  app.use(errorHandler);
  return app;
}

const superAdmin = { email: 'root@example.com', role: 'admin' };
const wsAdmin = { email: 'lead@example.com', role: 'viewer', selectedWorkspaceId: 5 };
const viewer = { email: 'someone@example.com', role: 'viewer', selectedWorkspaceId: 5 };

const PA = { id: 5, name: 'Project Accounting', freshserviceWorkspaceId: 9n, isActive: true };
const FACILITIES = { id: 10, name: 'Facilities', freshserviceWorkspaceId: 0n, isActive: true };

function wire({ mode = 'connected', mailboxes = 1, recentMail = 0, openFsBorn = 1 } = {}) {
  settings.clear();
  prismaMock.workspace.findUnique.mockImplementation(async ({ where }) => (where.id === 5 ? PA : where.id === 10 ? FACILITIES : null));
  prismaMock.workspace.findMany.mockResolvedValue([{ id: 5 }, { id: 10 }]);
  prismaMock.mailboxConnection.count.mockResolvedValue(mailboxes);
  prismaMock.ticket.count.mockImplementation(async ({ where }) => (where.source === 1 ? recentMail : recentMail + 2));
  prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.id.in || []).map((id) => ({ id, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: BigInt(900000 + id) })));
  prismaMock.notificationWorkflow.findFirst.mockImplementation(async ({ where }) => (
    where.triggerType === 'ticket.created' ? { id: 31, name: 'Ticket arrived', mockModeEnabled: false } : null));
  fsMode.getMode.mockImplementation(async (ws) => (Number(ws) === 10 ? 'never_connected' : mode));
  fsMode.getModeRecord.mockResolvedValue({ mode, changedBy: null, changedAt: null, history: [] });
  fsMode.getShadowReport.mockResolvedValue({ since: '2026-11-24T17:12:00.000Z', counts: { sync: { n: 180, first: 'a', last: 'b' } }, total: 180 });
  fsMode.setMode.mockImplementation(async (ws, m) => ({ mode: m, changedBy: 'root@example.com', changedAt: '2026-11-25T18:00:00.000Z', history: [] }));
  adoption.previewWorkspace.mockResolvedValue({ openFsBorn, uncachedAttachments: 3, sample: [{ id: 1, ref: '#900101', subject: 'Invoice', status: 'Open' }] });
  adoption.adoptWorkspace.mockResolvedValue({ adopted: openFsBorn, failed: [] });
  accessRole.mockImplementation(async (email, ws) => (email === 'lead@example.com' && Number(ws) === 5 ? 'admin' : email === 'someone@example.com' ? 'viewer' : null));
  prismaMock.technician.findMany.mockResolvedValue([{ name: 'Morgan Reyes', email: 'Morgan.Reyes@example.com' }]);
}

beforeEach(() => {
  jest.clearAllMocks();
  wire();
});

describe('role gating', () => {
  test('a workspace admin reads the panel, canWrite false', async () => {
    const res = await request(makeApp(wsAdmin)).get('/api/workspaces/5/freshservice');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mode: 'connected', canWrite: false, workspace: { id: 5, name: 'Project Accounting', freshserviceWorkspaceId: '9' } });
    expect(res.body.data.shadow.total).toBe(180);
  });

  test('who changed it reads as a name (record and history); an unknown e-mail stays unnamed', async () => {
    fsMode.getModeRecord.mockResolvedValue({
      mode: 'shadow', changedBy: 'morgan.reyes@example.com', changedAt: '2026-11-24T17:12:00.000Z',
      history: [
        { from: 'connected', to: 'shadow', by: 'morgan.reyes@example.com', at: '2026-11-24T17:12:00.000Z' },
        { from: 'shadow', to: 'connected', by: 'stranger@example.com', at: '2026-11-23T17:12:00.000Z' },
      ],
    });
    const res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice');
    expect(res.body.data.record).toMatchObject({ changedBy: 'morgan.reyes@example.com', changedByName: 'Morgan Reyes' });
    expect(res.body.data.record.history.map((h) => h.byName)).toEqual(['Morgan Reyes', null]);
  });

  test('a viewer cannot read it', async () => {
    const res = await request(makeApp(viewer)).get('/api/workspaces/5/freshservice');
    expect(res.status).toBe(403);
  });

  test('a workspace admin cannot change the mode or start Off', async () => {
    let res = await request(makeApp(wsAdmin)).put('/api/workspaces/5/freshservice').send({ mode: 'shadow' });
    expect(res.status).toBe(403);
    res = await request(makeApp(wsAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    expect(res.status).toBe(403);
    expect(fsMode.setMode).not.toHaveBeenCalled();
    expect(adoption.adoptWorkspace).not.toHaveBeenCalled();
  });

  test('the mode list is for super admins', async () => {
    let res = await request(makeApp(wsAdmin)).get('/api/workspaces/freshservice-modes');
    expect(res.status).toBe(403);
    res = await request(makeApp(superAdmin)).get('/api/workspaces/freshservice-modes');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ 5: { mode: 'connected', changedAt: null }, 10: { mode: 'never_connected', changedAt: null } });
  });
});

describe('never connected', () => {
  test('reads as never_connected with no preflight; writes are refused', async () => {
    let res = await request(makeApp(superAdmin)).get('/api/workspaces/10/freshservice');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mode: 'never_connected', preflight: null, canWrite: false });
    res = await request(makeApp(superAdmin)).put('/api/workspaces/10/freshservice').send({ mode: 'shadow' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('never_connected');
    res = await request(makeApp(superAdmin)).post('/api/workspaces/10/freshservice/off').send({ confirmName: 'Facilities' });
    expect(res.status).toBe(409);
    expect(fsMode.setMode).not.toHaveBeenCalled();
  });
});

describe('mode picker', () => {
  test('Shadow is set at once and written to Access history', async () => {
    const res = await request(makeApp(superAdmin)).put('/api/workspaces/5/freshservice').send({ mode: 'shadow' });
    expect(res.status).toBe(200);
    expect(fsMode.setMode).toHaveBeenCalledWith(5, 'shadow', { actorEmail: 'root@example.com' });
    expect(recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 5, action: 'freshservice_mode_changed', oldValue: 'connected', newValue: 'shadow' }));
  });

  test('Off is not a PUT', async () => {
    const res = await request(makeApp(superAdmin)).put('/api/workspaces/5/freshservice').send({ mode: 'off' });
    expect(res.status).toBe(400);
    expect(fsMode.setMode).not.toHaveBeenCalled();
  });
});

describe('preflight', () => {
  test('ready workspace: no blockers, the facts and one sentence per item', async () => {
    const res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice');
    const p = res.body.data.preflight;
    expect(p.blockers).toEqual([]);
    expect(p.openFsBorn).toBe(1);
    expect(p.uncachedAttachments).toBe(3);
    expect(p.ackWorkflow).toEqual({ id: 31, name: 'Ticket arrived', shadow: false });
    expect(p.reminderWorkflow).toBeNull();
    const byKey = Object.fromEntries(p.items.map((i) => [i.key, i.state]));
    expect(byKey).toMatchObject({ mail_intake: 'ok', adopt: 'ok', attachments: 'warn', ack_workflow: 'ok', reminder_workflow: 'warn', auto_close: 'ok' });
    expect(p.warnings.length).toBeGreaterThan(0);
  });

  test('every item that is not OK says what to do; linked ones end on the link', async () => {
    wire({ mailboxes: 0, recentMail: 4 });
    prismaMock.notificationWorkflow.findFirst.mockResolvedValue(null);
    const res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice');
    const notOk = res.body.data.preflight.items.filter((i) => i.state !== 'ok');
    expect(notOk.map((i) => i.key).sort()).toEqual(['ack_workflow', 'attachments', 'fs_mail_forwarding', 'mail_intake', 'recent_intake', 'reminder_workflow'].sort());
    for (const i of notOk) expect(i.todo).toEqual(expect.any(String));
    const reminder = notOk.find((i) => i.key === 'reminder_workflow');
    expect(reminder).toMatchObject({ text: 'FreshService reminded requesters who went quiet.', todo: 'Set up the same in', link: 'notification-workflows' });
    expect(res.body.data.preflight.warnings).toContain('FreshService reminded requesters who went quiet. Set up the same in Mail Workflows.');
    expect(res.body.data.preflight.blockers[0]).toMatch(/Connect the team’s mailbox in Ticket Mailboxes\.$/);
  });

  test('auto-close off says to turn it on in Ticket Ops', async () => {
    const { default: autoClose } = await import('../src/services/autoCloseResolvedService.js');
    autoClose.getSettings.mockResolvedValueOnce({ enabled: false });
    const res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice');
    expect(res.body.data.preflight.items.find((i) => i.key === 'auto_close'))
      .toMatchObject({ state: 'warn', text: 'FreshService closed resolved tickets for you.', todo: 'Turn on auto-close of resolved tickets in', link: 'ticket-ops' });
  });

  test('no mailbox while FreshService mail arrived this week blocks Off', async () => {
    wire({ mailboxes: 0, recentMail: 4 });
    const res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice');
    expect(res.body.data.preflight.blockers).toHaveLength(1);
    expect(res.body.data.preflight.blockers[0]).toMatch(/No mailbox is connected/);
    const off = await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('preflight_blocked');
    expect(adoption.adoptWorkspace).not.toHaveBeenCalled();
  });

  test('FreshService still receiving the team\'s mail is a warning about its forwarding', async () => {
    wire({ mailboxes: 1, recentMail: 2 });
    let res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice');
    const item = res.body.data.preflight.items.find((i) => i.key === 'fs_mail_forwarding');
    expect(item).toMatchObject({ state: 'warn' });
    expect(item.text).toBe('FreshService is still receiving mail for this team.');
    expect(item.todo).toMatch(/^Turn off its mail forwarding before switching off/);
    expect(res.body.data.preflight.warnings).toContain('FreshService is still receiving mail for this team. Turn off its mail forwarding before switching off, or the same e-mails will become tickets in both places if you ever switch back.');
    expect(res.body.data.preflight.blockers).toEqual([]);
    wire({ mailboxes: 1, recentMail: 0 });
    res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice');
    expect(res.body.data.preflight.items.find((i) => i.key === 'fs_mail_forwarding')).toBeUndefined();
  });

  test('no mailbox and no FreshService mail is only a warning', async () => {
    wire({ mailboxes: 0, recentMail: 0 });
    const res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice');
    expect(res.body.data.preflight.blockers).toEqual([]);
    expect(res.body.data.preflight.items.find((i) => i.key === 'mail_intake').state).toBe('warn');
  });
});

describe('Off job', () => {
  test('the typed name must match', async () => {
    const res = await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accountin' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('confirm_name_mismatch');
    expect(adoption.adoptWorkspace).not.toHaveBeenCalled();
  });

  test('adopts, then switches off, records both, and the progress reads done', async () => {
    adoption.adoptWorkspace.mockImplementationOnce(async (ws, { onProgress }) => {
      await onProgress({ done: 1, total: 2, adopted: 1, failed: 0, ticketId: 41 });
      await onProgress({ done: 2, total: 2, adopted: 2, failed: 0, ticketId: 42 });
      return { adopted: 2, failed: [], total: 2 };
    }).mockResolvedValueOnce({ adopted: 0, failed: [], total: 0 }); // nothing arrived during the run
    const res = await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: '  project accounting ' });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ state: 'running', step: 'check', total: 1 });
    await _jobPromise(5);

    expect(adoption.adoptWorkspace).toHaveBeenCalledWith(5, expect.objectContaining({ actorEmail: 'root@example.com' }));
    expect(fsMode.setMode).toHaveBeenCalledWith(5, 'off', expect.objectContaining({ actorEmail: 'root@example.com', extra: expect.objectContaining({ adoptedCount: 2 }) }));
    expect(adoption.adoptWorkspace.mock.invocationCallOrder[0]).toBeLessThan(fsMode.setMode.mock.invocationCallOrder[0]);
    expect(recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'freshservice_tickets_adopted', newValue: '2' }));
    expect(recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'freshservice_mode_changed', newValue: 'off' }));

    const progress = await request(makeApp(wsAdmin)).get('/api/workspaces/5/freshservice/off');
    expect(progress.status).toBe(200);
    expect(progress.body.data).toMatchObject({ state: 'done', step: 'done', total: 2, done: 2, adopted: 2, failedCount: 0, failed: [] });
    expect(progress.body.data.finishedAt).toBeTruthy();
  });

  test('a failed adoption leaves FreshService on and says so in plain words, with references', async () => {
    adoption.adoptWorkspace.mockResolvedValue({ adopted: 0, failed: [{ id: 77, error: 'attachment store refused' }] });
    await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    await _jobPromise(5);
    expect(fsMode.setMode).not.toHaveBeenCalled();
    const job = JSON.parse(settings.get(jobSettingKey(5)));
    expect(job).toMatchObject({ state: 'failed', failedCount: 1, failed: [{ ref: '#900077' }] });
    expect(job.error).toBe('1 ticket could not be adopted (#900077). Nothing was switched off; try again.');
    expect(JSON.stringify(job)).not.toMatch(/attachment store refused|"id":77/);
    expect(recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'freshservice_tickets_adopted', details: expect.objectContaining({ adopted: 0, failed: 1 }) }));
  });

  test('a second pass after Off adopts tickets that arrived during the run; counts land in the job and Access history', async () => {
    adoption.adoptWorkspace
      .mockResolvedValueOnce({ adopted: 2, failed: [], total: 2 })
      .mockResolvedValueOnce({ adopted: 1, failed: [], total: 1 });
    await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    await _jobPromise(5);
    expect(adoption.adoptWorkspace).toHaveBeenCalledTimes(2);
    // The second pass runs only once the mode is Off (sync has stopped, the list is final).
    expect(fsMode.setMode.mock.invocationCallOrder[0]).toBeLessThan(adoption.adoptWorkspace.mock.invocationCallOrder[1]);
    const job = JSON.parse(settings.get(jobSettingKey(5)));
    expect(job).toMatchObject({ state: 'done', adopted: 3, adoptedBeforeOff: 2, adoptedAfterOff: 1, total: 3 });
    expect(recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'freshservice_tickets_adopted', newValue: '3',
      details: expect.objectContaining({ adopted: 3, failed: 0, adoptedBeforeOff: 2, adoptedAfterOff: 1 }),
    }));
  });

  test('a late ticket that cannot be adopted leaves FreshService off, with a note naming it', async () => {
    adoption.adoptWorkspace
      .mockResolvedValueOnce({ adopted: 1, failed: [], total: 1 })
      .mockResolvedValueOnce({ adopted: 0, failed: [{ id: 8, error: 'x' }], total: 1 });
    await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    await _jobPromise(5);
    const job = JSON.parse(settings.get(jobSettingKey(5)));
    expect(job.state).toBe('done');
    expect(job.note).toBe('1 ticket that arrived during the switch could not be adopted (#900008); open it and choose Adopt to edit.');
    expect(recordAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'freshservice_tickets_adopted', details: expect.objectContaining({ failed: 1 }) }));
  });

  test('a partial run says what it did: N adopted, FreshService still on', async () => {
    adoption.adoptWorkspace.mockResolvedValue({ adopted: 3, failed: [{ id: 5, error: 'x' }], total: 4 });
    await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    await _jobPromise(5);
    const res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice/off');
    expect(res.body.data.state).toBe('failed');
    expect(res.body.data.error).toBe('1 ticket could not be adopted (#900005). 3 tickets were adopted; FreshService is still on. Try again to finish.');
    expect(failureSentence('Lead.', 1)).toBe('Lead. 1 ticket was adopted; FreshService is still on. Try again to finish.');
  });

  test('an adoption that throws is a failed job with a plain sentence, not a crash', async () => {
    adoption.adoptWorkspace.mockRejectedValue(new Error('database went away'));
    await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    await _jobPromise(5);
    expect(fsMode.setMode).not.toHaveBeenCalled();
    const job = JSON.parse(settings.get(jobSettingKey(5)));
    expect(job.state).toBe('failed');
    expect(job.error).toBe('The switch stopped before it finished. Nothing was switched off; try again.');
  });

  test('two starts at the same moment: exactly one runs', async () => {
    let release;
    adoption.adoptWorkspace.mockImplementationOnce(() => new Promise((r) => { release = () => r({ adopted: 1, failed: [] }); }));
    const app = makeApp(superAdmin);
    const [a, b] = await Promise.all([
      request(app).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' }),
      request(app).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await _jobPromise(5);
    expect(adoption.adoptWorkspace).toHaveBeenCalledTimes(2); // one job: its pass before Off and its pass after
  });

  test('a refused start releases the slot (a later start works)', async () => {
    const bad = await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'nope' });
    expect(bad.status).toBe(400);
    const ok = await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    expect(ok.status).toBe(202);
    await _jobPromise(5);
  });

  test('another process\'s run (fresh heartbeat) blocks a start and a mode change; a stale one does not', async () => {
    settings.set(jobSettingKey(5), JSON.stringify({ state: 'running', step: 'adopt', total: 3, adopted: 1, failed: [], heartbeatAt: new Date().toISOString() }));
    let res = await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('switch_running');
    res = await request(makeApp(superAdmin)).put('/api/workspaces/5/freshservice').send({ mode: 'shadow' });
    expect(res.status).toBe(409);
    res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice/off');
    expect(res.body.data.state).toBe('running');

    settings.set(jobSettingKey(5), JSON.stringify({ state: 'running', step: 'adopt', total: 3, adopted: 1, failed: [], heartbeatAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }));
    res = await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    expect(res.status).toBe(202);
    await _jobPromise(5);
  });

  test('a running job writes a heartbeat', async () => {
    let release;
    adoption.adoptWorkspace.mockImplementationOnce(() => new Promise((r) => { release = () => r({ adopted: 1, failed: [] }); }));
    await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    await new Promise((r) => setTimeout(r, 10));
    const stored = JSON.parse(settings.get(jobSettingKey(5)));
    expect(stored.state).toBe('running');
    expect(Date.now() - Date.parse(stored.heartbeatAt)).toBeLessThan(5000);
    release();
    await _jobPromise(5);
  });

  test('once the mode is Off, the job reads done, never failed', async () => {
    wire({ mode: 'off' });
    settings.set(jobSettingKey(5), JSON.stringify({ state: 'failed', step: 'switch', total: 2, adopted: 2, failed: [], error: 'The switch stopped before it finished.' }));
    const res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice/off');
    expect(res.body.data).toMatchObject({ state: 'done', step: 'done', adopted: 2 });
    expect(res.body.data.error).toBeUndefined();
  });

  test('one job at a time per workspace', async () => {
    let release;
    adoption.adoptWorkspace.mockImplementationOnce(() => new Promise((r) => { release = () => r({ adopted: 1, failed: [] }); }));
    const first = await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    expect(first.status).toBe(202);
    const second = await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('switch_running');
    const put = await request(makeApp(superAdmin)).put('/api/workspaces/5/freshservice').send({ mode: 'connected' });
    expect(put.status).toBe(409);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await _jobPromise(5);
    expect(adoption.adoptWorkspace).toHaveBeenCalledTimes(2); // one job: its pass before Off and its pass after
  });

  test('a running job no process owns (stale heartbeat) reads as interrupted, with what it did', async () => {
    settings.set(jobSettingKey(5), JSON.stringify({ state: 'running', step: 'adopt', total: 3, adopted: 1, failed: [], heartbeatAt: '2026-11-25T08:00:00.000Z' }));
    const res = await request(makeApp(superAdmin)).get('/api/workspaces/5/freshservice/off');
    expect(res.body.data.state).toBe('failed');
    expect(res.body.data.error).toBe('The switch was interrupted (the server restarted). 1 ticket was adopted; FreshService is still on. Try again to finish.');
  });

  test('already off is refused', async () => {
    wire({ mode: 'off' });
    const res = await request(makeApp(superAdmin)).post('/api/workspaces/5/freshservice/off').send({ confirmName: 'Project Accounting' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_off');
  });
});
