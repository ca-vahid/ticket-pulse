import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Urgent response routes (plans/URGENT_RESPONSE_PLAN.md): the mode, the on-call
 * schedule and a person's own cover requests for any member or agent;
 * everything else workspace-admin only. "Me" is the signed-in person's active
 * technician in the workspace. The log reads (/actions, /stats) run through the
 * real service skeleton against a mocked Prisma; /preview and undo answer 501
 * until the engine is written.
 */
const settingsSvc = {
  getMode: jest.fn(),
  getSettings: jest.fn(),
  listTechnicians: jest.fn(),
  teamsEnabled: jest.fn(),
  updateSettings: jest.fn(),
  listChanges: jest.fn(),
  technicianForEmail: jest.fn(),
  timezone: jest.fn(),
};
const onCallSvc = {
  schedule: jest.fn(),
  current: jest.fn(),
  requestsFor: jest.fn(),
  respond: jest.fn(),
  createCover: jest.fn(),
  cancelCover: jest.fn(),
  createRequest: jest.fn(),
  cancelRequest: jest.fn(),
};
const prismaMock = {
  urgentResponseAction: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), groupBy: jest.fn() },
  ticket: { findMany: jest.fn() },
};
const wsRepo = { getAccessRole: jest.fn() };

jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: wsRepo }));
jest.unstable_mockModule('../src/services/urgentResponse/settingsService.js', () => ({
  default: settingsSvc,
  soft: (fn, fallback = null) => Promise.resolve().then(fn).catch(() => fallback),
}));
jest.unstable_mockModule('../src/services/urgentResponse/onCallService.js', () => ({ default: onCallSvc }));
// The engine reads "open" from the AI's workload helper; the preview only needs it to answer.
jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({ openWorkloadStatuses: jest.fn(async () => ['Open', 'Pending']) }));

const { default: router } = await import('../src/routes/urgentResponse.routes.js');
const { ConflictError } = await import('../src/utils/errors.js');

const ADMIN = { email: 'root@example.com', name: 'Root', role: 'admin' };
const MEMBER = { email: 'viewer@example.com', name: 'Viewer', role: 'user' };
const AGENT = { email: 'afong@example.com', name: 'Andrew Fong', role: 'agent' };

function app(user, { workspaceId = 1, bearer = false } = {}) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    if (bearer) req.user = user; else req.session = { user };
    req.workspaceId = workspaceId;
    next();
  });
  a.use('/api/urgent-response', router);
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code }));
  return a;
}

const WEEK = {
  index: 0, startsAt: '2026-10-13T00:00:00.000Z', endsAt: '2026-10-20T00:00:00.000Z', scheduled: { id: 11, name: 'Andrew Fong' }, covers: [], leaveDays: [], needsCover: false, openRequest: null,
};
const actionRow = (id, extra = {}) => ({
  id, workspaceId: 1, ticketId: 500, layer: 'raise', action: 'moved', shadow: false, priority: 4, fromTechnicianId: 33, toTechnicianId: 11, fromName: 'David Zapata', toName: 'Andrew Fong',
  sentence: 'Moved from David Zapata to Andrew Fong by the Urgent rule.', details: { why: 'at work' }, dedupeKey: null, undoneAt: null, undoneBy: null, undoOfId: null,
  createdAt: new Date('2026-10-12T15:00:00Z'), ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  wsRepo.getAccessRole.mockResolvedValue('viewer');
  settingsSvc.getMode.mockResolvedValue('observe');
  settingsSvc.getSettings.mockResolvedValue({ mode: 'observe', onCallOrder: [11, 22], onCallOrderSuggested: true });
  settingsSvc.listTechnicians.mockResolvedValue([{ id: 11, name: 'Andrew Fong', email: 'afong@example.com', isActive: true, timezone: 'America/Vancouver', workStartTime: '08:00', workEndTime: '16:00' }]);
  settingsSvc.teamsEnabled.mockResolvedValue(true);
  settingsSvc.timezone.mockResolvedValue('America/Vancouver');
  settingsSvc.updateSettings.mockImplementation(async (_ws, body) => ({ settings: body, changes: [{ field: 'mode', before: 'off', after: body.mode }] }));
  settingsSvc.listChanges.mockResolvedValue([{ id: 1, field: 'mode' }]);
  settingsSvc.technicianForEmail.mockImplementation(async (_ws, email) => (email === AGENT.email ? { id: 11, name: 'Andrew Fong', email } : null));
  onCallSvc.schedule.mockResolvedValue({ timezone: 'America/Vancouver', handoverDay: 1, handoverTime: '17:00', configured: true, order: [11, 22], weeks: [WEEK] });
  onCallSvc.current.mockResolvedValue({
    configured: true, timezone: 'America/Vancouver', technician: { id: 11, name: 'Andrew Fong', email: 'afong@example.com' }, scheduled: { id: 11, name: 'Andrew Fong' },
    cover: null, until: '2026-10-20T00:00:00.000Z', onLeaveNoCover: false, week: { index: 0 },
  });
  onCallSvc.requestsFor.mockResolvedValue([{ id: 40, original: { id: 22, name: 'Maria Lee' }, startsAt: 'a', endsAt: 'b', message: null, createdBy: 'root@example.com' }]);
  onCallSvc.respond.mockResolvedValue({ status: 'filled', cover: { id: 70 } });
  onCallSvc.createCover.mockResolvedValue({ id: 70 });
  onCallSvc.cancelCover.mockResolvedValue({ id: 70, cancelled: true });
  onCallSvc.createRequest.mockResolvedValue({ id: 40, status: 'open' });
  onCallSvc.cancelRequest.mockResolvedValue({ id: 40, status: 'cancelled' });
  prismaMock.urgentResponseAction.findMany.mockResolvedValue([]);
  prismaMock.urgentResponseAction.findFirst.mockResolvedValue(null);
  prismaMock.urgentResponseAction.groupBy.mockResolvedValue([]);
  prismaMock.ticket.findMany.mockResolvedValue([]);
});

describe('any member, agents included', () => {
  test.each([['a member', MEMBER], ['an agent', AGENT], ['an admin', ADMIN]])('%s reads /status', async (_label, user) => {
    const r = await request(app(user)).get('/api/urgent-response/status');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, data: { mode: 'observe', onCall: true } });
    // The saved order only: a suggested one is not in force.
    expect(settingsSvc.getSettings).toHaveBeenCalledWith(1, { suggest: false });
  });

  test('/status: no saved on-call order, or an unknown mode', async () => {
    settingsSvc.getSettings.mockResolvedValue({ mode: 'live', onCallOrder: [] });
    expect((await request(app(AGENT)).get('/api/urgent-response/status')).body.data).toEqual({ mode: 'live', onCall: false });
    settingsSvc.getSettings.mockResolvedValue({ mode: 'loud' });
    expect((await request(app(AGENT)).get('/api/urgent-response/status')).body.data).toEqual({ mode: 'off', onCall: false });
  });

  test('GET /on-call: the schedule, who is on call now, and me', async () => {
    const r = await request(app(AGENT)).get('/api/urgent-response/on-call');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      timezone: 'America/Vancouver',
      handoverDay: 1,
      handoverTime: '17:00',
      current: { technician: { id: 11, name: 'Andrew Fong' }, scheduled: { id: 11, name: 'Andrew Fong' }, cover: null, until: '2026-10-20T00:00:00.000Z' },
      weeks: [WEEK],
      me: { technicianId: 11 },
    });
    expect(onCallSvc.schedule).toHaveBeenCalledWith(1, { from: expect.any(Date), weeks: 8 });
    expect(settingsSvc.technicianForEmail).toHaveBeenCalledWith(1, 'afong@example.com');
  });

  test('GET /on-call for someone who is not a technician here: me is null; nobody on call: nulls', async () => {
    onCallSvc.schedule.mockResolvedValue({ timezone: 'America/Vancouver', handoverDay: 1, handoverTime: '17:00', configured: false, order: [], weeks: [] });
    onCallSvc.current.mockResolvedValue({ configured: false, technician: null, scheduled: null, cover: null, until: null });
    const r = await request(app(MEMBER)).get('/api/urgent-response/on-call');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ current: { technician: null, scheduled: null, cover: null, until: null }, weeks: [], me: { technicianId: null } });
  });

  test('a cookie-less (Bearer) agent is recognised the same way', async () => {
    const r = await request(app(AGENT, { bearer: true })).get('/api/urgent-response/on-call/requests/mine');
    expect(r.status).toBe(200);
    expect(onCallSvc.requestsFor).toHaveBeenCalledWith(11, { workspaceId: 1 });
  });

  test('GET /on-call/requests/mine: my open requests; empty when I am not a technician here', async () => {
    const mine = await request(app(AGENT)).get('/api/urgent-response/on-call/requests/mine');
    // Each request carries the workspace zone its dates are told in.
    expect(mine.body.data).toEqual([{ id: 40, original: { id: 22, name: 'Maria Lee' }, startsAt: 'a', endsAt: 'b', message: null, createdBy: 'root@example.com', timezone: 'America/Vancouver' }]);
    expect(settingsSvc.timezone).toHaveBeenCalledWith(1);
    const none = await request(app(MEMBER)).get('/api/urgent-response/on-call/requests/mine');
    expect(none.body).toEqual({ success: true, data: [] });
    expect(onCallSvc.requestsFor).toHaveBeenCalledTimes(1);
    expect(settingsSvc.timezone).toHaveBeenCalledTimes(1);
  });

  test('POST respond: an agent answers as their own technician, in their workspace', async () => {
    const r = await request(app(AGENT)).post('/api/urgent-response/on-call/requests/40/respond').send({ answer: 'accept', technicianId: 999 });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ status: 'filled', cover: { id: 70 } });
    // The person is the session, never the body.
    expect(onCallSvc.respond).toHaveBeenCalledWith(40, 11, 'accept', { workspaceId: 1 });
  });

  test('POST respond: 409 when somebody else already took it', async () => {
    onCallSvc.respond.mockRejectedValue(new ConflictError('Somebody else has already taken it'));
    const r = await request(app(AGENT)).post('/api/urgent-response/on-call/requests/40/respond').send({ answer: 'accept' });
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('Somebody else has already taken it');
  });

  test('POST respond: a bad answer, a bad id, or not a technician here → 400, nothing answered', async () => {
    expect((await request(app(AGENT)).post('/api/urgent-response/on-call/requests/40/respond').send({ answer: 'maybe' })).status).toBe(400);
    expect((await request(app(AGENT)).post('/api/urgent-response/on-call/requests/abc/respond').send({ answer: 'accept' })).status).toBe(400);
    expect((await request(app(MEMBER)).post('/api/urgent-response/on-call/requests/40/respond').send({ answer: 'accept' })).status).toBe(400);
    expect(onCallSvc.respond).not.toHaveBeenCalled();
  });
});

describe('workspace admins only', () => {
  const ADMIN_ROUTES = [
    ['get', '/settings'],
    ['put', '/settings'],
    ['get', '/settings/changes'],
    ['post', '/preview'],
    ['get', '/actions'],
    ['get', '/stats'],
    ['post', '/actions/5/undo'],
    ['post', '/on-call/covers'],
    ['delete', '/on-call/covers/70'],
    ['post', '/on-call/requests'],
    ['post', '/on-call/requests/40/cancel'],
  ];

  test.each(ADMIN_ROUTES)('%s %s is refused for a member, an agent and a read-only observer', async (method, path) => {
    for (const [user, role] of [[MEMBER, 'viewer'], [MEMBER, 'reviewer'], [MEMBER, 'readonly'], [AGENT, null]]) {
      wsRepo.getAccessRole.mockResolvedValue(role);
      const r = await request(app(user))[method](`/api/urgent-response${path}`).send({ mode: 'live' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('admin_required');
    }
    for (const fn of [settingsSvc.getSettings, settingsSvc.updateSettings, onCallSvc.createCover, onCallSvc.cancelCover, onCallSvc.createRequest, onCallSvc.cancelRequest]) expect(fn).not.toHaveBeenCalled();
    expect(prismaMock.urgentResponseAction.findMany).not.toHaveBeenCalled();
    expect(prismaMock.urgentResponseAction.groupBy).not.toHaveBeenCalled();
    expect(prismaMock.urgentResponseAction.findFirst).not.toHaveBeenCalled();
  });

  test('a workspace admin (not a global one) passes', async () => {
    wsRepo.getAccessRole.mockResolvedValue('admin');
    const r = await request(app(MEMBER)).get('/api/urgent-response/settings');
    expect(r.status).toBe(200);
    expect(wsRepo.getAccessRole).toHaveBeenCalledWith('viewer@example.com', 1);
  });

  test('GET /settings: settings, technicians, Teams state, and whether the order is only a suggestion', async () => {
    const r = await request(app(ADMIN)).get('/api/urgent-response/settings');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      settings: { mode: 'observe', onCallOrder: [11, 22], onCallOrderSuggested: true },
      technicians: [{ id: 11, name: 'Andrew Fong', email: 'afong@example.com', isActive: true, timezone: 'America/Vancouver', workStartTime: '08:00', workEndTime: '16:00' }],
      teamsEnabled: true,
      onCallOrderSuggested: true,
      timezone: 'America/Vancouver',
    });
  });

  test('PUT /settings carries the session user to the audit; a refused save is a 400', async () => {
    const ok = await request(app(ADMIN)).put('/api/urgent-response/settings').send({ mode: 'live' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ settings: { mode: 'live' }, changes: [{ field: 'mode', before: 'off', after: 'live' }] });
    expect(settingsSvc.updateSettings).toHaveBeenCalledWith(1, { mode: 'live' }, ADMIN);
    // "This person is on call this week" travels with the save untouched.
    await request(app(ADMIN)).put('/api/urgent-response/settings').send({ onCallOrder: [11, 22], onCallCurrentTechnicianId: 22 });
    expect(settingsSvc.updateSettings).toHaveBeenLastCalledWith(1, { onCallOrder: [11, 22], onCallCurrentTechnicianId: 22 }, ADMIN);
    const { ValidationError } = await import('../src/utils/errors.js');
    settingsSvc.updateSettings.mockRejectedValue(new ValidationError('"Move after" cannot be shorter than "Tell the team after"'));
    const bad = await request(app(ADMIN)).put('/api/urgent-response/settings').send({ clockMoveMinutes: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('cannot be shorter');
  });

  test('GET /settings/changes passes the limit', async () => {
    const r = await request(app(ADMIN)).get('/api/urgent-response/settings/changes?limit=50');
    expect(r.body.data).toEqual([{ id: 1, field: 'mode' }]);
    expect(settingsSvc.listChanges).toHaveBeenCalledWith(1, { limit: '50' });
  });

  test('covers and requests go to the on-call service with the workspace and the session user', async () => {
    const body = { originalTechnicianId: 11, coverTechnicianId: 22, startsAt: '2026-10-13T00:00:00Z', endsAt: '2026-10-20T00:00:00Z', note: 'Swap' };
    expect((await request(app(ADMIN)).post('/api/urgent-response/on-call/covers').send(body)).body.data).toEqual({ id: 70 });
    expect(onCallSvc.createCover).toHaveBeenCalledWith(1, body, ADMIN);
    expect((await request(app(ADMIN)).delete('/api/urgent-response/on-call/covers/70')).body.data).toEqual({ id: 70, cancelled: true });
    expect(onCallSvc.cancelCover).toHaveBeenCalledWith(1, 70, ADMIN);
    const ask = { originalTechnicianId: 11, startsAt: body.startsAt, endsAt: body.endsAt, message: 'Away', askTechnicianIds: [22] };
    expect((await request(app(ADMIN)).post('/api/urgent-response/on-call/requests').send(ask)).body.data).toEqual({ id: 40, status: 'open' });
    expect(onCallSvc.createRequest).toHaveBeenCalledWith(1, ask, ADMIN);
    expect((await request(app(ADMIN)).post('/api/urgent-response/on-call/requests/40/cancel')).body.data).toEqual({ id: 40, status: 'cancelled' });
    expect(onCallSvc.cancelRequest).toHaveBeenCalledWith(1, 40, ADMIN);
    expect((await request(app(ADMIN)).delete('/api/urgent-response/on-call/covers/zero')).status).toBe(400);
  });
});

describe('the log (real service, mocked Prisma)', () => {
  test('GET /actions: items with the ticket, the people, and undoable; one batched ticket read, no photo', async () => {
    prismaMock.urgentResponseAction.findMany.mockResolvedValue([
      actionRow(9),
      actionRow(8, { ticketId: 501, shadow: true, sentence: 'Shadow: would have moved…' }),
      actionRow(7, { ticketId: 502 }),
      actionRow(6, { ticketId: 500, undoneAt: new Date('2026-10-12T16:00:00Z'), undoneBy: 'root@example.com' }),
      actionRow(5, { ticketId: 500, action: 'team_told', fromTechnicianId: null, toTechnicianId: null, fromName: null, toName: null }),
      actionRow(4, { ticketId: null, layer: 'on_call', action: 'cover_set', priority: null }),
      actionRow(3, { ticketId: 777 }),
    ]);
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 500, subject: 'VPN down', origin: 'ticketpulse', nativeNumber: 1700, freshserviceTicketId: 99n, assignedTechId: 11 },
      { id: 501, subject: 'Printer', origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 242611n, assignedTechId: 11 },
      { id: 502, subject: 'Moved on since', origin: 'ticketpulse', nativeNumber: 1701, freshserviceTicketId: null, assignedTechId: 44 },
    ]);
    const r = await request(app(ADMIN)).get('/api/urgent-response/actions?limit=50');
    expect(r.status).toBe(200);
    const { items, nextBefore } = r.body.data;
    expect(nextBefore).toBeNull();
    expect(items[0]).toEqual({
      id: 9, createdAt: '2026-10-12T15:00:00.000Z', layer: 'raise', action: 'moved', shadow: false, priority: 4,
      ticket: { id: 500, displayRef: 'TP-1700', subject: 'VPN down' }, from: { id: 33, name: 'David Zapata' }, to: { id: 11, name: 'Andrew Fong' },
      sentence: 'Moved from David Zapata to Andrew Fong by the Urgent rule.', details: { why: 'at work' }, undoable: true, undoneAt: null, undoneBy: null,
    });
    expect(items[1]).toMatchObject({ id: 8, shadow: true, ticket: { id: 501, displayRef: '#242611', subject: 'Printer' } });
    // Shadow, moved on since, already undone, not a move, not a ticket, ticket gone: none can be undone.
    expect(items.map((i) => [i.id, i.undoable])).toEqual([[9, true], [8, false], [7, false], [6, false], [5, false], [4, false], [3, false]]);
    expect(items[3]).toMatchObject({ undoneAt: '2026-10-12T16:00:00.000Z', undoneBy: 'root@example.com' });
    expect(items[4]).toMatchObject({ from: null, to: null });
    expect(items[5]).toMatchObject({ ticket: null, layer: 'on_call' });
    expect(items[6].ticket).toBeNull();

    expect(prismaMock.urgentResponseAction.findMany).toHaveBeenCalledWith({ where: { workspaceId: 1 }, orderBy: { id: 'desc' }, take: 51 });
    expect(prismaMock.ticket.findMany).toHaveBeenCalledTimes(1);
    const ticketQuery = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(ticketQuery.where).toEqual({ id: { in: [500, 501, 502, 777] }, workspaceId: 1 });
    expect(ticketQuery.select).toEqual({ id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true, assignedTechId: true });
    expect(ticketQuery.take).toBe(4);
  });

  test('GET /actions: filters, paging and the cap', async () => {
    prismaMock.urgentResponseAction.findMany.mockResolvedValue([actionRow(9, { ticketId: null }), actionRow(8, { ticketId: null }), actionRow(7, { ticketId: null })]);
    const r = await request(app(ADMIN)).get('/api/urgent-response/actions?limit=2&before=10&layer=clock&shadow=true');
    expect(r.body.data.items.map((i) => i.id)).toEqual([9, 8]);
    expect(r.body.data.nextBefore).toBe(8);
    expect(prismaMock.urgentResponseAction.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 1, id: { lt: 10 }, layer: 'clock', shadow: true }, orderBy: { id: 'desc' }, take: 3,
    });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();

    await request(app(ADMIN)).get('/api/urgent-response/actions?limit=99999&layer=nonsense&shadow=false&before=x');
    expect(prismaMock.urgentResponseAction.findMany.mock.calls[1][0]).toEqual({ where: { workspaceId: 1, shadow: false }, orderBy: { id: 'desc' }, take: 201 });
  });

  test('GET /actions with the table missing: an empty log, not an error', async () => {
    prismaMock.urgentResponseAction.findMany.mockRejectedValue(new Error('relation "urgent_response_actions" does not exist'));
    const r = await request(app(ADMIN)).get('/api/urgent-response/actions');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ items: [], nextBefore: null });
  });

  test('GET /stats: counts by action, live and Shadow apart', async () => {
    prismaMock.urgentResponseAction.groupBy.mockResolvedValue([
      { action: 'moved', shadow: false, layer: 'raise', _count: { _all: 1 } },
      { action: 'moved', shadow: false, layer: 'clock', _count: { _all: 2 } },
      { action: 'moved', shadow: true, layer: 'clock', _count: { _all: 12 } },
      { action: 'team_told', shadow: true, layer: 'clock', _count: { _all: 5 } },
      { action: 'told_owner_away', shadow: false, _count: { _all: 2 } },
      { action: 'on_call_assigned', shadow: false, _count: { _all: 1 } },
    ]);
    const r = await request(app(ADMIN)).get('/api/urgent-response/stats?days=30');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      days: 30,
      live: { redirected: 0, held: 0, moved: 3, toldOwnerAway: 2, teamTold: 0, coordinator: 0, onCallAssigned: 1, undone: 0, raiseMoved: 1, clockMoved: 2 },
      shadow: { redirected: 0, held: 0, moved: 12, toldOwnerAway: 0, teamTold: 5, coordinator: 0, onCallAssigned: 0, undone: 0, raiseMoved: 0, clockMoved: 12 },
    });
    const query = prismaMock.urgentResponseAction.groupBy.mock.calls[0][0];
    expect(query.by).toEqual(['action', 'shadow', 'layer']);
    expect(query.where.workspaceId).toBe(1);
    expect(Date.now() - query.where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(30 * 86400e3);
    expect((await request(app(ADMIN)).get('/api/urgent-response/stats?days=0')).body.data.days).toBe(30);
    expect((await request(app(ADMIN)).get('/api/urgent-response/stats?days=9999')).body.data.days).toBe(365);
  });

  test('POST /preview answers the estimate (a bad draft is a 400); undo refuses a Shadow row with a 409', async () => {
    const { normalizeSettings } = await import('../src/services/urgentResponse/rules.js');
    settingsSvc.getSettings.mockResolvedValue({ workspaceId: 1, ...normalizeSettings({ mode: 'observe' }) });
    settingsSvc.timezone.mockResolvedValue('America/Vancouver');
    const preview = await request(app(ADMIN)).post('/api/urgent-response/preview').send({ clockNotifyMinutes: 10 });
    expect(preview.status).toBe(200);
    // Nothing to replay in this mocked database: every section degrades to zero.
    expect(preview.body.data).toEqual({
      days: 30, estimate: true, assign: { redirected: 0, held: 0 }, raise: { moved: 0, told: 0 }, clock: { teamTold: 0, moved: 0, coordinator: 0 }, inScopeTickets: 0,
    });
    const bad = await request(app(ADMIN)).post('/api/urgent-response/preview').send({ clockNotifyMinutes: 60, clockMoveMinutes: 10 });
    expect(bad.status).toBe(400);

    prismaMock.urgentResponseAction.findFirst.mockResolvedValue(actionRow(5, { shadow: true }));
    prismaMock.urgentResponseAction.findUnique.mockResolvedValue(actionRow(5, { shadow: true }));
    const undo = await request(app(ADMIN)).post('/api/urgent-response/actions/5/undo');
    expect(undo.status).toBe(409);
    expect(undo.body.message).toBe('This is a Shadow entry: nothing was moved, so there is nothing to undo');
  });

  test('undo: a log row of another workspace is a 404 before anything else', async () => {
    const r = await request(app(ADMIN)).post('/api/urgent-response/actions/5/undo');
    expect(r.status).toBe(404);
    expect(prismaMock.urgentResponseAction.findFirst).toHaveBeenCalledWith({ where: { id: 5, workspaceId: 1 } });
  });
});
