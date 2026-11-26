import { jest } from '@jest/globals';

// FreshService switch (25 Nov 2026) — ticketService paths.
//  Off: a write to imported history (FS-born) adopts the ticket and goes the
//  Ticket Pulse way; no FreshService call. Adopted tickets never touch their
//  old FS ticket. Connected stays exactly as before.

const fsMode = { mode: 'connected' };
const fsGate = jest.fn(async () => fsMode.mode !== 'off');
const isFreshServiceOff = jest.fn(async () => fsMode.mode === 'off');
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  default: {}, fsGate, isFreshServiceOff, onModeChange: jest.fn(() => () => {}),
  getMode: jest.fn(async () => fsMode.mode),
  getModeRecord: jest.fn(async () => ({ mode: fsMode.mode })),
  setMode: jest.fn(),
  getShadowReport: jest.fn(async () => ({ since: null, counts: {}, total: 0 })),
  flushShadow: jest.fn(),
  FS_MODES: ['connected', 'shadow', 'off'],
  FS_PURPOSES: [],
  modeSettingKey: (ws) => `freshservice_mode_ws${ws}`,
  shadowSettingKey: (ws) => `freshservice_shadow_ws${ws}`,
  _resetFsModeCache: jest.fn(),
}));
// Mirrors the real rule (fsAdoptionService.isBackgroundWriter, tested there):
// background writers never adopt.
const isBackgroundWriter = (a) => !a || ['system', 'workflow', 'automation'].includes(String(a.role || ''));
const adoptionMock = {
  adoptForWrite: jest.fn(async (_id, _ws, a) => (isBackgroundWriter(a) ? null : { adopted: true })),
  adoptTicket: jest.fn(),
};
jest.unstable_mockModule('../src/services/fsAdoptionService.js', () => ({ default: adoptionMock, isBackgroundWriter }));

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), findMany: jest.fn(async () => []), update: jest.fn() },
  assignmentPipelineRun: { updateMany: jest.fn(async () => ({ count: 0 })) },
  ticketActivity: { findMany: jest.fn(async () => []) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const activityRepoMock = { create: jest.fn(async () => ({ id: 1 })) };
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityRepoMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn(async () => []) } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketLifecycleNotifications: jest.fn(), emitTicketEvent: jest.fn(async () => ({})) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: jest.fn(() => false) } }));
const fsClient = {
  createReply: jest.fn(), addNote: jest.fn(), updateTicketFields: jest.fn(), getTicket: jest.fn(),
  deleteTicket: jest.fn(), updateConversation: jest.fn(), fetchTicketConversations: jest.fn(async () => []),
};
const mirrorServiceMock = {
  getInteractiveClient: jest.fn(async () => fsClient),
  getClient: jest.fn(async () => fsClient),
  enqueueDelete: jest.fn(async () => ({})),
  enqueueFieldSync: jest.fn(async () => ({})),
  enqueueThreadEntry: jest.fn(async () => ({})),
  reconcileTicket: jest.fn(async () => ({})),
};
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
const syncServiceMock = { reconcileSingleTicket: jest.fn(async () => ({})) };
jest.unstable_mockModule('../src/services/syncService.js', () => ({ default: syncServiceMock }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: { isConfigured: jest.fn(() => true), validateUpload: jest.fn(), ingestForFsTicket: jest.fn() },
  MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
  MAX_ATTACHMENTS_PER_TICKET: 20,
}));

const { default: ticketService, FreshServiceOffError } = await import('../src/services/ticketService.js');

const actor = { email: 'ada@example.com', name: 'Ada Agent', role: 'agent' };
const fsBorn = (over = {}) => ({
  id: 77, workspaceId: 1, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 245001n,
  mirrorState: null, status: 'Open', subject: 'Printer jam', requester: { email: 'rita@example.com' }, ...over,
});
const adopted = (over = {}) => fsBorn({ origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted', ...over });
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  fsMode.mode = 'connected';
  mirrorServiceMock.getInteractiveClient.mockImplementation(async () => fsClient);
});

describe('updateFsTicket', () => {
  test('Off: adopts the imported ticket, then applies fields, assignee and status the Ticket Pulse way', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(fsBorn())
      .mockResolvedValueOnce(adopted())
      .mockResolvedValueOnce(adopted({ status: 'Resolved', priority: 3 }));
    const fields = jest.spyOn(ticketService, 'updateTicketFields').mockResolvedValue({ changed: true });
    const assign = jest.spyOn(ticketService, 'assignTicket').mockResolvedValue({ changed: true });
    const status = jest.spyOn(ticketService, 'changeStatus').mockResolvedValue({ changed: true });

    const out = await ticketService.updateFsTicket(77, 1, { priority: '3', assignedTechId: 9, status: 'Resolved' }, actor, { allowAssignableOnly: true });

    expect(adoptionMock.adoptForWrite).toHaveBeenCalledWith(77, 1, actor);
    expect(fields).toHaveBeenCalledWith(77, 1, { priority: 3 }, actor);
    expect(assign).toHaveBeenCalledWith(77, 1, 9, actor, { handBack: null, allowAssignableOnly: true, notifyLifecycle: true });
    expect(status).toHaveBeenCalledWith(77, 1, 'Resolved', actor, { notifyLifecycle: true });
    expect(fsClient.updateTicketFields).not.toHaveBeenCalled();
    expect(mirrorServiceMock.getInteractiveClient).not.toHaveBeenCalled();
    expect(out).toEqual(expect.objectContaining({ adopted: true, skipped: 'freshservice_off', displayRef: 'TP-2001' }));
    fields.mockRestore(); assign.mockRestore(); status.mockRestore();
  });

  test('Connected: unchanged — FreshService is written first, nothing is adopted', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    prismaMock.workspace.findUnique.mockResolvedValueOnce({ id: 1, isActive: true, freshserviceWorkspaceId: 2 });
    mirrorServiceMock.getInteractiveClient.mockResolvedValueOnce(null);
    await expect(ticketService.updateFsTicket(77, 1, { priority: 3 }, actor)).rejects.toThrow('FreshService is not configured for this workspace');
    expect(mirrorServiceMock.getInteractiveClient).toHaveBeenCalledWith(1);
    expect(adoptionMock.adoptForWrite).not.toHaveBeenCalled();
  });

  test('an API key writing to imported history adopts it too (the reason follows the actor)', async () => {
    fsMode.mode = 'off';
    const apiActor = { role: 'api', email: 'apikey:tpk_abc', name: 'Integration' };
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn()).mockResolvedValueOnce(adopted()).mockResolvedValueOnce(adopted());
    const fields = jest.spyOn(ticketService, 'updateTicketFields').mockResolvedValue({ changed: true });
    await ticketService.updateFsTicket(77, 1, { subject: 'Printer jam (again)' }, apiActor);
    expect(adoptionMock.adoptForWrite).toHaveBeenCalledWith(77, 1, apiActor);
    fields.mockRestore();
  });
});

describe('_addThreadEntry (notes and replies)', () => {
  test('Off: a note on imported history adopts the ticket and is written as a Ticket Pulse note; no FreshService call', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn()).mockResolvedValueOnce(adopted());
    const original = ticketService._addThreadEntry;
    const spy = jest.spyOn(ticketService, '_addThreadEntry')
      .mockImplementationOnce(function first(...args) { return original.apply(this, args); })
      .mockImplementationOnce(async () => ({ entry: { id: 1 }, native: true }));

    const out = await ticketService.addPrivateNote(77, 1, { bodyHtml: '<p>Checked the tray</p>' }, actor);

    expect(adoptionMock.adoptForWrite).toHaveBeenCalledWith(77, 1, actor);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ entry: { id: 1 }, native: true });
    expect(fsClient.addNote).not.toHaveBeenCalled();
    expect(fsClient.createReply).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('Connected: an FS-born note still posts to FreshService (no adoption)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    mirrorServiceMock.getInteractiveClient.mockResolvedValueOnce(null);
    await expect(ticketService.addPrivateNote(77, 1, { bodyHtml: '<p>Checked the tray</p>' }, actor))
      .rejects.toThrow('FreshService is not configured for this workspace');
    expect(adoptionMock.adoptForWrite).not.toHaveBeenCalled();
  });
});

describe('deleteFsTicketInFreshService', () => {
  test('Off: a local-only delete; FreshService is never called and the FS id is kept', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    prismaMock.ticket.update.mockImplementation(async ({ data }) => ({ ...fsBorn(), ...data }));
    const out = await ticketService.deleteFsTicketInFreshService(77, 1, actor);
    expect(fsClient.deleteTicket).not.toHaveBeenCalled();
    expect(mirrorServiceMock.getInteractiveClient).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'Deleted', updatedAt: expect.any(Date) } }));
    expect(out).toEqual(expect.objectContaining({ deleted: true, skipped: 'freshservice_off', freshserviceTicketId: 245001n }));
    expect(activityRepoMock.create).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ deletedLocallyOnly: true, freshserviceTicketId: 245001 }),
    }));
  });

  test('Connected: deletes in FreshService first, as before', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    fsClient.deleteTicket.mockResolvedValueOnce({});
    prismaMock.ticket.update.mockImplementation(async ({ data }) => ({ ...fsBorn(), ...data }));
    await ticketService.deleteFsTicketInFreshService(77, 1, actor);
    expect(fsClient.deleteTicket).toHaveBeenCalledWith(245001);
  });
});

describe('deleteTicket (TP-owned)', () => {
  test('an adopted ticket never queues a FreshService delete of its old FS ticket', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(adopted());
    prismaMock.ticket.update.mockImplementation(async ({ data }) => ({ ...adopted(), ...data }));
    await ticketService.deleteTicket(77, 1, actor);
    expect(mirrorServiceMock.enqueueDelete).not.toHaveBeenCalled();
  });

  test('a mirrored TP-born ticket still queues the copy delete', async () => {
    const tp = adopted({ mirrorState: 'mirrored', nativeNumber: 1500, freshserviceTicketId: 246100n });
    prismaMock.ticket.findFirst.mockResolvedValueOnce(tp);
    prismaMock.ticket.update.mockImplementation(async ({ data }) => ({ ...tp, ...data }));
    await ticketService.deleteTicket(77, 1, actor);
    expect(mirrorServiceMock.enqueueDelete).toHaveBeenCalledWith(1, 77);
  });
});

describe('getTicket on-open FreshService reads', () => {
  async function open(ticket) {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(ticket);
    const refresh = jest.spyOn(ticketService, '_refreshFsBornThread').mockResolvedValue(undefined);
    await ticketService.getTicket(ticket.id, 1).catch(() => null);
    await tick();
    const calls = refresh.mock.calls.length;
    refresh.mockRestore();
    return calls;
  }

  test('Connected FS-born: reconcile + thread refresh as before', async () => {
    expect(await open(fsBorn())).toBe(1);
    expect(syncServiceMock.reconcileSingleTicket).toHaveBeenCalledWith(77, 1);
  });

  test('Off: nothing is read from FreshService', async () => {
    fsMode.mode = 'off';
    expect(await open(fsBorn())).toBe(0);
    expect(syncServiceMock.reconcileSingleTicket).not.toHaveBeenCalled();
  });

  test('adopted: never reconciled with (or read from) the old FS ticket, even while connected', async () => {
    expect(await open(adopted())).toBe(0);
    expect(syncServiceMock.reconcileSingleTicket).not.toHaveBeenCalled();
    expect(mirrorServiceMock.reconcileTicket).not.toHaveBeenCalled();
  });
});

describe('_refreshFsBornThread', () => {
  test('skips adopted tickets and Off workspaces', async () => {
    await ticketService._refreshFsBornThread(adopted());
    fsMode.mode = 'off';
    await ticketService._refreshFsBornThread(fsBorn());
    expect(mirrorServiceMock.getInteractiveClient).not.toHaveBeenCalled();
    expect(fsClient.fetchTicketConversations).not.toHaveBeenCalled();
  });
});

describe('mirrorState stops flipping to pending', () => {
  test.each([
    ['connected', { mirrorState: 'mirrored' }, { mirrorState: 'pending' }],
    ['off', { mirrorState: 'mirrored' }, {}],
    ['connected', { mirrorState: 'adopted' }, {}],
    ['connected', { mirrorState: 'none' }, {}],
  ])('%s + %o → %o', async (mode, ticket, expected) => {
    fsMode.mode = mode;
    expect(await ticketService._mirrorStatePatch({ ...ticket, workspaceId: 1 }, 1, 'pending')).toEqual(expected);
  });
});

describe('updateNote on a FreshService conversation', () => {
  const entry = {
    id: 5, ticketId: 77, workspaceId: 1, eventType: 'note', authorType: 'agent', source: 'ticketpulse_user',
    actorEmail: 'ada@example.com', externalEntryId: 'fs-conversation:9001', bodyHtml: '<p>old</p>', rawPayload: {},
  };

  test('adopted: edited in Ticket Pulse only, never on the old FS ticket', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(adopted());
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValueOnce(entry);
    prismaMock.ticketThreadEntry.update.mockResolvedValueOnce({ ...entry, bodyHtml: '<p>new</p>' });
    await ticketService.updateNote(77, 1, 5, { bodyHtml: '<p>new</p>' }, actor);
    expect(fsClient.updateConversation).not.toHaveBeenCalled();
    expect(adoptionMock.adoptForWrite).not.toHaveBeenCalled();
  });

  test('Off + imported history: adopts, then edits here only', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn()).mockResolvedValueOnce(adopted());
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValueOnce(entry);
    prismaMock.ticketThreadEntry.update.mockResolvedValueOnce({ ...entry, bodyHtml: '<p>new</p>' });
    await ticketService.updateNote(77, 1, 5, { bodyHtml: '<p>new</p>' }, actor);
    expect(adoptionMock.adoptForWrite).toHaveBeenCalledWith(77, 1, actor);
    expect(fsClient.updateConversation).not.toHaveBeenCalled();
  });

  test('Connected FS-born: the FS conversation is updated first, as before', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValueOnce(entry);
    prismaMock.ticketThreadEntry.update.mockResolvedValueOnce({ ...entry, bodyHtml: '<p>new</p>' });
    await ticketService.updateNote(77, 1, 5, { bodyHtml: '<p>new</p>' }, actor);
    expect(fsClient.updateConversation).toHaveBeenCalledWith(9001, expect.any(Object));
  });
});

describe('new thread entries on Ticket Pulse tickets: no stuck "waiting to copy"', () => {
  const tpMirrored = (over = {}) => adopted({ mirrorState: 'mirrored', nativeNumber: 1500, freshserviceTicketId: 246100n, ...over });
  async function note(ticket) {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(ticket);
    prismaMock.ticketThreadEntry.create = jest.fn(async ({ data }) => ({ id: 901, ...data }));
    prismaMock.ticket.update.mockResolvedValue({});
    await ticketService.addPrivateNote(ticket.id, 1, { bodyHtml: '<p>Checked the tray</p>' }, actor);
    return prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
  }

  test("adopted ticket → entry 'none', nothing queued for the mirror", async () => {
    const data = await note(adopted());
    expect(data.mirrorState).toBe('none');
    expect(mirrorServiceMock.enqueueThreadEntry).not.toHaveBeenCalled();
  });

  test("Off workspace (TP-born, mirrored before) → entry 'none', nothing queued", async () => {
    fsMode.mode = 'off';
    const data = await note(tpMirrored());
    expect(data.mirrorState).toBe('none');
    expect(mirrorServiceMock.enqueueThreadEntry).not.toHaveBeenCalled();
  });

  test("Connected TP-born → 'pending' and queued, as before", async () => {
    const data = await note(tpMirrored());
    expect(data.mirrorState).toBe('pending');
    expect(mirrorServiceMock.enqueueThreadEntry).toHaveBeenCalledWith(1, 77, 901);
  });

  test.each([
    ['connected', 'mirrored', 'pending'],
    ['shadow', 'mirrored', 'pending'],
    ['off', 'mirrored', 'none'],
    ['connected', 'adopted', 'none'],
  ])('_entryMirrorState: %s + ticket %s → %s', async (mode, state, expected) => {
    fsMode.mode = mode;
    expect(await ticketService._entryMirrorState({ workspaceId: 1, mirrorState: state }, 1)).toBe(expected);
  });
});

describe('_recordReplyOnFreshService', () => {
  test('never for an adopted ticket or an Off workspace', async () => {
    expect(await ticketService._recordReplyOnFreshService(adopted(), { id: 1, bodyHtml: '<p>x</p>' }, actor)).toBeNull();
    fsMode.mode = 'off';
    expect(await ticketService._recordReplyOnFreshService(fsBorn(), { id: 1, bodyHtml: '<p>x</p>' }, actor)).toBeNull();
    expect(fsClient.addNote).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.update).not.toHaveBeenCalled();
  });
});

test('FreshServiceOffError is a 409 with code freshservice_off (kept for actions that truly need FreshService)', () => {
  const err = new FreshServiceOffError();
  expect(err.statusCode).toBe(409);
  expect(err.code).toBe('freshservice_off');
});

describe('Off: background writers never adopt imported history', () => {
  const systemActor = { email: 'autoclose@ticketpulse.internal', name: 'Ticket Pulse (closed after resolving)', role: 'system' };

  test('a system status write leaves the imported ticket unchanged; an agent adopts', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    const status = jest.spyOn(ticketService, 'changeStatus').mockResolvedValue({ changed: true });
    const out = await ticketService.updateFsTicket(77, 1, { status: 'Closed' }, systemActor);
    expect(out).toEqual(expect.objectContaining({ id: 77, noChanges: true, skipped: 'freshservice_off_imported', displayRef: '#245001' }));
    expect(status).not.toHaveBeenCalled();
    expect(fsClient.updateTicketFields).not.toHaveBeenCalled();
    expect(adoptionMock.adoptTicket).not.toHaveBeenCalled();

    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn()).mockResolvedValueOnce(adopted()).mockResolvedValueOnce(adopted({ status: 'Closed' }));
    await ticketService.updateFsTicket(77, 1, { status: 'Closed' }, actor);
    expect(status).toHaveBeenCalledWith(77, 1, 'Closed', actor, { notifyLifecycle: true });
    status.mockRestore();
  });

  test('a workflow note on imported history is skipped (no entry, no FreshService call)', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    prismaMock.ticketThreadEntry.create = jest.fn();
    const out = await ticketService.addPrivateNote(77, 1, { bodyText: 'Auto-note' }, { name: 'Notification workflow', role: 'workflow' });
    expect(out).toEqual(expect.objectContaining({ entry: null, skipped: 'freshservice_off_imported' }));
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    expect(fsClient.addNote).not.toHaveBeenCalled();
  });

  test('a background delete of imported history is skipped', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn());
    prismaMock.ticket.update.mockClear();
    const out = await ticketService.deleteFsTicketInFreshService(77, 1, { name: 'Ticket Pulse burst grouping', role: 'system' });
    expect(out.skipped).toBe('freshservice_off_imported');
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });
});

describe('Off: notifyLifecycle:false is honoured on the adopted path', () => {
  test('carried into assignTicket and changeStatus', async () => {
    fsMode.mode = 'off';
    const hrActor = { email: 'hr-coordinator@example.com', name: 'Hana HR', role: 'agent' };
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn()).mockResolvedValueOnce(adopted()).mockResolvedValueOnce(adopted());
    const assign = jest.spyOn(ticketService, 'assignTicket').mockResolvedValue({ changed: true });
    const status = jest.spyOn(ticketService, 'changeStatus').mockResolvedValue({ changed: true });
    await ticketService.updateFsTicket(77, 1, { assignedTechId: 9, status: 'Open' }, hrActor, { notifyLifecycle: false });
    expect(assign).toHaveBeenCalledWith(77, 1, 9, hrActor, expect.objectContaining({ notifyLifecycle: false }));
    expect(status).toHaveBeenCalledWith(77, 1, 'Open', hrActor, { notifyLifecycle: false });
    assign.mockRestore(); status.mockRestore();
  });

  test('changeStatus with notifyLifecycle:false runs no lifecycle notification', async () => {
    const lifecycle = jest.spyOn(ticketService, '_notifyLifecycle').mockResolvedValue(undefined);
    const tp = adopted({ status: 'Closed', createdAt: new Date('2026-11-01T10:00:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValueOnce(tp);
    prismaMock.ticket.update.mockImplementation(async ({ data }) => ({ ...tp, ...data }));
    const out = await ticketService.changeStatus(77, 1, 'Open', { email: 'ada@example.com', name: 'Ada', role: 'agent' }, { notifyLifecycle: false });
    expect(out.changed).toBe(true);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'Open' }) }));
    expect(lifecycle).not.toHaveBeenCalled();
    // and with the default, it does notify
    prismaMock.ticket.findFirst.mockResolvedValueOnce(tp);
    await ticketService.changeStatus(77, 1, 'Open', { email: 'ada@example.com', name: 'Ada', role: 'agent' });
    expect(lifecycle).toHaveBeenCalledTimes(1);
    lifecycle.mockRestore();
  });
});

describe('Off: a partial edit says what was already applied', () => {
  test('fields applied, then the status fails → the error names the applied fields', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(fsBorn()).mockResolvedValueOnce(adopted());
    const fields = jest.spyOn(ticketService, 'updateTicketFields').mockResolvedValue({ changed: true });
    const { ValidationError } = await import('../src/utils/errors.js');
    const status = jest.spyOn(ticketService, 'changeStatus').mockRejectedValue(new ValidationError('A resolution reason is required'));
    const err = await ticketService.updateFsTicket(77, 1, { priority: 3, status: 'Resolved' }, actor).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe('A resolution reason is required (already applied in Ticket Pulse: priority)');
    expect(err.partial).toBe(true);
    expect(err.applied).toEqual(['priority']);
    expect(err.details).toEqual({ applied: ['priority'] });
    fields.mockRestore(); status.mockRestore();
  });
});