import { jest } from '@jest/globals';

/**
 * FreshService switch (FreshService exit A1/A3, 25 Nov 2026), the fallback
 * mirror:
 *  - a workspace switched OFF sends nothing, queues nothing, and keeps the
 *    jobs it already had PENDING (parked, not done) so a rollback resumes them;
 *  - an ADOPTED ticket (mirrorState 'adopted') keeps its old FreshService id as
 *    a tombstone: no job writes to it or deletes it, and no reconcile reads it.
 */

const modes = new Map(); // workspaceId -> 'connected' | 'shadow' | 'off'
const gateCalls = [];
let modeListener = null;
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  getModeRecord: jest.fn(async (ws) => ({ mode: modes.get(Number(ws)) || 'connected' })),
  fsGate: jest.fn(async (ws, purpose) => {
    gateCalls.push([Number(ws), purpose]);
    return (modes.get(Number(ws)) || 'connected') !== 'off';
  }),
  onModeChange: jest.fn((fn) => { modeListener = fn; return () => {}; }),
}));

const prismaMock = {
  mirrorJob: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  ticketThreadEntry: { findUnique: jest.fn(), update: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  ticketActivity: { findFirst: jest.fn() },
  technician: { findFirst: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const clientMock = {
  createTicket: jest.fn(),
  updateTicket: jest.fn(),
  deleteTicket: jest.fn(),
  addNote: jest.fn(),
  updateConversation: jest.fn(),
  deleteConversation: jest.fn(),
  fetchTicketSafe: jest.fn(),
  fetchTicketConversations: jest.fn(),
  fetchTicketActivities: jest.fn(),
};
const settingsMock = {
  getFreshServiceConfigForWorkspace: jest.fn().mockResolvedValue({ domain: 'demo', apiKey: 'key' }),
  get: jest.fn().mockResolvedValue(null),
};
const ticketServiceMock = { deleteTicket: jest.fn(), changeStatus: jest.fn(), assignTicket: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: { buffersForThreadEntry: jest.fn().mockResolvedValue([]) } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn(async (ws, bases) => bases), resolveBase: jest.fn() },
}));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn(() => clientMock) }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: mirrorService, OFF_WAIT_NOTE } = await import('../src/services/mirrorService.js');

const LIVE = 1;
const OFF = 5;

const adoptedTicket = {
  id: 900,
  workspaceId: LIVE,
  origin: 'ticketpulse',
  nativeNumber: 20001,
  mirrorState: 'adopted',
  freshserviceTicketId: 123456n, // the OLD FreshService ticket: a tombstone
  subject: 'Printer jam',
  status: 'Open',
  priority: 2,
  workspace: { id: LIVE, freshserviceWorkspaceId: 10n },
  requester: { id: 1, email: 'pat@example.com' },
  assignedTech: null,
};

function job(kind, extra = {}) {
  return { id: 70 + Math.floor(Math.random() * 1000), ticketId: adoptedTicket.id, workspaceId: LIVE, kind, attempts: 0, status: 'pending', updatedAt: new Date(), threadEntryId: 31, payload: null, ...extra };
}

function expectNoFsWrite() {
  for (const fn of ['createTicket', 'updateTicket', 'deleteTicket', 'addNote', 'updateConversation', 'deleteConversation']) {
    expect(clientMock[fn]).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  modes.clear();
  gateCalls.length = 0;
  process.env.NATIVE_TICKET_MIRROR_ENABLED = 'true';
  mirrorService._clients.clear();
  mirrorService._interactiveClients.clear();
  mirrorService._activeCache.clear();
  prismaMock.workspace.findUnique.mockImplementation(async ({ where }) => ({ id: where.id, isActive: true, freshserviceWorkspaceId: 10n }));
  prismaMock.mirrorJob.update.mockResolvedValue({});
  prismaMock.mirrorJob.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.mirrorJob.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticket.count.mockResolvedValue(0);
  prismaMock.ticket.findUnique.mockResolvedValue(adoptedTicket);
  prismaMock.ticketThreadEntry.findUnique.mockResolvedValue({ id: 31, ticketId: 900, mirrorState: null, externalEntryId: 'mirror-55', bodyHtml: '<p>x</p>' });
});

describe('adopted tickets are never written to, deleted or reconciled with the old FreshService ticket', () => {
  test.each([
    ['create_ticket', {}],
    ['update_fields', {}],
    ['thread_entry', {}],
    ['thread_entry_update', {}],
    ['delete_ticket', {}],
    ['attachment', { payload: { attachmentId: 4 } }],
  ])('%s job: done, skipped "adopted", nothing sent', async (kind, extra) => {
    const j = job(kind, extra);
    const ok = await mirrorService._processJob(j);
    expect(ok).toBe(true);
    expectNoFsWrite();
    expect(prismaMock.mirrorJob.update).toHaveBeenCalledWith({
      where: { id: j.id },
      data: { status: 'done', lastError: 'Skipped: adopted', attempts: 1 },
    });
    // Never flagged as a mirror error on the ticket (no red chip).
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('delete_thread_entry job: the old FreshService conversation is not deleted', async () => {
    prismaMock.ticket.count.mockResolvedValue(1); // adopted
    const j = job('delete_thread_entry', { payload: { fsConversationId: 55 } });
    await expect(mirrorService._processJob(j)).resolves.toBe(true);
    expect(clientMock.deleteConversation).not.toHaveBeenCalled();
  });

  test('nothing is queued for an adopted ticket', async () => {
    prismaMock.ticket.count.mockResolvedValue(1);
    await expect(mirrorService.enqueueThreadEntry(LIVE, 900, 31)).resolves.toBeNull();
    await expect(mirrorService.enqueueAttachment(LIVE, 900, 4)).resolves.toBeNull();
    prismaMock.mirrorJob.findFirst.mockResolvedValue(null);
    await expect(mirrorService.enqueueDelete(LIVE, 900)).resolves.toBeNull();
    expect(prismaMock.mirrorJob.create).not.toHaveBeenCalled();
    // A normal TP-born ticket still queues.
    prismaMock.ticket.count.mockResolvedValue(0);
    await expect(mirrorService.enqueueThreadEntry(LIVE, 901, 32)).resolves.toMatchObject({ ticketId: 901 });
  });

  test('the reconcile queries leave adopted tickets out', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([]);
    await mirrorService.reconcile(LIVE, { activeOnly: true, limit: 30 });
    const notAdopted = { OR: [{ mirrorState: null }, { mirrorState: { not: 'adopted' } }] };
    expect(prismaMock.ticket.findMany.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of prismaMock.ticket.findMany.mock.calls) {
      expect(args.where.AND).toEqual(expect.arrayContaining([notAdopted]));
    }
  });

  test('reconcileTicket (the webhook / page-open pull) skips an adopted ticket', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(adoptedTicket);
    await expect(mirrorService.reconcileTicket(900, LIVE)).resolves.toEqual({ skipped: true, reason: 'adopted' });
    expect(clientMock.fetchTicketSafe).not.toHaveBeenCalled();
    expect(clientMock.fetchTicketConversations).not.toHaveBeenCalled();
  });

  test('a reconcile pass that reaches an adopted row reads nothing and changes nothing', async () => {
    await expect(mirrorService._reconcileTicketAgainstFs(adoptedTicket, clientMock)).resolves.toMatchObject({ imported: 0, conflicts: 0 });
    expect(clientMock.fetchTicketSafe).not.toHaveBeenCalled();
    expect(ticketServiceMock.deleteTicket).not.toHaveBeenCalled();
  });

  test('latest-change-wins never deletes, re-statuses or re-assigns an adopted ticket', async () => {
    clientMock.fetchTicketActivities.mockResolvedValue([{ content: 'deleted the ticket' }]);
    const out = await mirrorService._applyLatestChangeWins(adoptedTicket, { id: 123456, deleted: true, status: 5 }, clientMock, { statusDrift: true, assigneeDrift: true });
    expect(out).toMatchObject({ status: true, agent: true });
    expect(clientMock.fetchTicketActivities).not.toHaveBeenCalled();
    expect(ticketServiceMock.deleteTicket).not.toHaveBeenCalled();
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
  });

  test('adopted while a reconcile pass waited: the drift check stops', async () => {
    const live = { ...adoptedTicket, mirrorState: 'mirrored' };
    clientMock.fetchTicketSafe.mockResolvedValue({ id: 123456, status: 5, responder_id: 77 });
    clientMock.fetchTicketConversations.mockResolvedValue([]);
    prismaMock.ticket.findUnique.mockResolvedValue({ status: 'Open', mirrorState: 'adopted', assignedTechId: null, assignedTech: null });
    const res = await mirrorService._reconcileTicketAgainstFs(live, clientMock);
    expect(res).toEqual({ imported: 0, conflicts: 0 });
    expect(clientMock.fetchTicketActivities).not.toHaveBeenCalled();
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
  });
});

describe('a workspace switched off', () => {
  beforeEach(() => { modes.set(OFF, 'off'); });

  test('a job stays pending (parked an hour, no attempt used, no ticket error) and nothing is sent', async () => {
    const j = { ...job('update_fields'), workspaceId: OFF, ticketId: 950, attempts: 2 };
    const before = Date.now();
    await expect(mirrorService._processJob(j)).resolves.toBe(false);
    expectNoFsWrite();
    const [[update]] = prismaMock.mirrorJob.update.mock.calls;
    expect(update.where).toEqual({ id: j.id });
    expect(update.data.status).toBe('pending');
    expect(update.data.lastError).toBe(OFF_WAIT_NOTE);
    expect(update.data).not.toHaveProperty('attempts');
    expect(update.data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('a failed job keeps its status while parked', async () => {
    const j = { ...job('update_fields'), workspaceId: OFF, status: 'failed' };
    await mirrorService._processJob(j);
    expect(prismaMock.mirrorJob.update.mock.calls[0][0].data.status).toBe('failed');
  });

  test('nothing new is queued; no clients are handed out', async () => {
    await expect(mirrorService.enqueueThreadEntry(OFF, 950, 1)).resolves.toBeNull();
    expect(prismaMock.mirrorJob.create).not.toHaveBeenCalled();
    await expect(mirrorService.getClient(OFF)).resolves.toBeNull();
    await expect(mirrorService.getInteractiveClient(OFF)).resolves.toBeNull();
    await expect(mirrorService.getClient(LIVE)).resolves.toBe(clientMock);
  });

  test('"Mirror now", the reconcile, reconcileTicket and latest-change-wins all skip', async () => {
    await expect(mirrorService.drainForTicket(950, OFF)).resolves.toEqual({ skipped: true, reason: 'freshservice_off' });
    await expect(mirrorService.reconcile(OFF)).resolves.toEqual({ skipped: true, reason: 'freshservice_off' });
    await expect(mirrorService.reconcileTicket(950, OFF)).resolves.toEqual({ skipped: true, reason: 'freshservice_off' });
    const out = await mirrorService._applyLatestChangeWins({ ...adoptedTicket, mirrorState: 'mirrored', workspaceId: OFF }, { deleted: true }, clientMock, { statusDrift: true, assigneeDrift: false });
    expect(out.status).toBe(true);
    expect(clientMock.fetchTicketActivities).not.toHaveBeenCalled();
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
    expect(prismaMock.mirrorJob.findMany).not.toHaveBeenCalled();
  });

  test('the periodic sweep passes the workspace by', async () => {
    prismaMock.ticket.groupBy = jest.fn().mockResolvedValue([{ workspaceId: OFF }]);
    const spy = jest.spyOn(mirrorService, 'reconcile');
    await mirrorService._reconcileSweepOnce();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('a mode change clears the workspace caches; back on, its parked jobs are due at once', async () => {
    await mirrorService.getClient(LIVE);
    mirrorService._interactiveClients.set(OFF, {});
    await mirrorService._workspaceState(OFF);
    expect(typeof modeListener).toBe('function');

    modes.set(OFF, 'connected');
    await modeListener(OFF, 'connected', 'off');
    expect(mirrorService._activeCache.has(OFF)).toBe(false);
    expect(mirrorService._interactiveClients.has(OFF)).toBe(false);
    expect(mirrorService._clients.has(LIVE)).toBe(true); // other workspaces untouched
    expect(prismaMock.mirrorJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ workspaceId: OFF, lastError: OFF_WAIT_NOTE, status: { in: ['pending', 'failed'] } }),
      data: { nextAttemptAt: expect.any(Date) },
    });
    await expect(mirrorService.getClient(OFF)).resolves.toBe(clientMock);

    prismaMock.mirrorJob.updateMany.mockClear();
    await modeListener(LIVE, 'off', 'connected');
    expect(mirrorService._clients.has(LIVE)).toBe(false);
    expect(prismaMock.mirrorJob.updateMany).not.toHaveBeenCalled();
  });
});

describe('Shadow and Connected', () => {
  test('Shadow sends as today and counts the mirror call', async () => {
    modes.set(LIVE, 'shadow');
    const ticket = { ...adoptedTicket, mirrorState: 'mirrored' };
    prismaMock.ticket.findUnique.mockResolvedValue(ticket);
    const j = job('delete_ticket');
    await expect(mirrorService._processJob(j)).resolves.toBe(true);
    expect(clientMock.deleteTicket).toHaveBeenCalledWith(123456);
    expect(gateCalls).toContainEqual([LIVE, 'mirror']);
  });

  test('Connected: a normal job runs and nothing is counted', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...adoptedTicket, mirrorState: 'mirrored' });
    await expect(mirrorService._processJob(job('delete_ticket'))).resolves.toBe(true);
    expect(clientMock.deleteTicket).toHaveBeenCalledTimes(1);
    expect(gateCalls).toEqual([]);
  });
});
