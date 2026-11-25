import { jest } from '@jest/globals';

// FreshService switch (25 Nov 2026) — ticket tasks.
//  Off: a task write on imported history adopts the ticket, then runs as on any
//  Ticket Pulse ticket (no FreshService call). Adopted tickets never sync tasks
//  with their old FS ticket. Connected → unchanged.

const fsMode = { mode: 'connected' };
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  default: {},
  fsGate: jest.fn(async () => fsMode.mode !== 'off'),
  isFreshServiceOff: jest.fn(async () => fsMode.mode === 'off'),
  onModeChange: jest.fn(() => () => {}),
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
// Mirrors the real rule (tested in fsAdoptionService.test.js): background writers never adopt.
const adoptionMock = { adoptForWrite: jest.fn(async (_id, _ws, a) => (!a || ['system', 'workflow', 'automation'].includes(a.role) ? null : { adopted: true })) };
jest.unstable_mockModule('../src/services/fsAdoptionService.js', () => ({ default: adoptionMock }));

const prismaMock = {
  ticket: { findFirst: jest.fn(), findUnique: jest.fn() },
  ticketTask: {
    findFirst: jest.fn(), findMany: jest.fn(async () => []), create: jest.fn(), update: jest.fn(),
    delete: jest.fn(async () => ({})), aggregate: jest.fn(async () => ({ _max: { sortOrder: 0 } })),
  },
  technician: { findFirst: jest.fn(), findUnique: jest.fn() },
  ticketActivity: { create: jest.fn(async () => ({})) },
};
const fsClient = {
  createTicketTask: jest.fn(async () => ({ id: 555 })),
  updateTicketTask: jest.fn(async () => ({})),
  deleteTicketTask: jest.fn(async () => ({})),
  listTicketTasks: jest.fn(async () => []),
};
const mirrorMock = { getInteractiveClient: jest.fn(async () => fsClient) };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({
  sendTransactionalEmail: jest.fn(async () => ({ sent: true })), default: {},
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: ticketTaskService } = await import('../src/services/ticketTaskService.js');

const FS = { id: 3, workspaceId: 1, origin: 'freshservice', mirrorState: null, freshserviceTicketId: 233398n, nativeNumber: null, subject: 'FS ticket', assignedTech: null };
const ADOPTED = { ...FS, origin: 'ticketpulse', nativeNumber: 2001, mirrorState: 'adopted' };
const actor = { email: 'ada@example.com', name: 'Ada Agent', role: 'agent' };

beforeEach(() => {
  jest.clearAllMocks();
  fsMode.mode = 'connected';
  prismaMock.ticket.findFirst.mockReset();
  prismaMock.ticketTask.create.mockImplementation(async ({ data }) => ({ id: 100, ...data, assignedTech: null }));
  prismaMock.ticketTask.update.mockImplementation(async ({ data }) => ({ id: 100, ...data }));
});

describe('create', () => {
  test('Off + imported history: adopts, creates a Ticket Pulse task, no FreshService call', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(FS).mockResolvedValueOnce(ADOPTED);
    const out = await ticketTaskService.create(3, 1, { title: 'Swap the toner' }, actor);
    expect(adoptionMock.adoptForWrite).toHaveBeenCalledWith(3, 1, actor);
    expect(fsClient.createTicketTask).not.toHaveBeenCalled();
    expect(prismaMock.ticketTask.create.mock.calls[0][0].data.origin).toBe('ticketpulse');
    expect(out.title).toBe('Swap the toner');
  });

  test('adopted (connected): a Ticket Pulse task, never written to the old FS ticket', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(ADOPTED);
    await ticketTaskService.create(3, 1, { title: 'Swap the toner' }, actor);
    expect(adoptionMock.adoptForWrite).not.toHaveBeenCalled();
    expect(fsClient.createTicketTask).not.toHaveBeenCalled();
  });

  test('Connected FS-born: FreshService owns the task, as before', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(FS);
    await ticketTaskService.create(3, 1, { title: 'Swap the toner' }, actor);
    expect(fsClient.createTicketTask).toHaveBeenCalledWith(233398, expect.objectContaining({ title: 'Swap the toner' }));
  });
});

describe('list', () => {
  test('Off or adopted: served from Ticket Pulse, FreshService not asked', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(FS);
    await ticketTaskService.listForTicket(3, 1);
    fsMode.mode = 'connected';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(ADOPTED);
    await ticketTaskService.listForTicket(3, 1);
    expect(fsClient.listTicketTasks).not.toHaveBeenCalled();
  });

  test('Connected FS-born: pulled from FreshService as before', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(FS);
    await ticketTaskService.listForTicket(3, 1);
    expect(fsClient.listTicketTasks).toHaveBeenCalledWith(233398);
  });
});

describe('update and remove of an FS task', () => {
  const task = { id: 100, ticketId: 3, workspaceId: 1, title: 'Old', status: 'open', fsTaskId: 777n, assignedTechId: null };

  test('Off + imported history: adopts, updates locally, no FreshService call', async () => {
    fsMode.mode = 'off';
    prismaMock.ticketTask.findFirst.mockResolvedValueOnce(task);
    prismaMock.ticket.findFirst.mockResolvedValueOnce(FS).mockResolvedValueOnce(ADOPTED);
    await ticketTaskService.update(100, 1, { status: 'done' }, actor);
    expect(adoptionMock.adoptForWrite).toHaveBeenCalledWith(3, 1, actor);
    expect(fsClient.updateTicketTask).not.toHaveBeenCalled();
    expect(prismaMock.ticketTask.update).toHaveBeenCalled();
  });

  test('adopted: removed locally, never deleted on the old FS ticket', async () => {
    prismaMock.ticketTask.findFirst.mockResolvedValueOnce(task);
    prismaMock.ticket.findFirst.mockResolvedValueOnce(ADOPTED);
    await ticketTaskService.remove(100, 1, actor);
    expect(fsClient.deleteTicketTask).not.toHaveBeenCalled();
    expect(prismaMock.ticketTask.delete).toHaveBeenCalledWith({ where: { id: 100 } });
  });

  test('Connected FS-born: update goes to FreshService first, as before', async () => {
    prismaMock.ticketTask.findFirst.mockResolvedValueOnce(task);
    prismaMock.ticket.findFirst.mockResolvedValueOnce(FS);
    await ticketTaskService.update(100, 1, { status: 'done' }, actor);
    expect(fsClient.updateTicketTask).toHaveBeenCalledWith(233398, 777, expect.objectContaining({ status: expect.any(Number) }));
  });
});

describe('mirror reconcile entry point', () => {
  test('_syncMirroredStatusFromFs never reads an adopted ticket (even without mirrorState on the row)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ mirrorState: 'adopted' });
    await ticketTaskService._syncMirroredStatusFromFs({ id: 3, workspaceId: 1, freshserviceTicketId: 233398n });
    fsMode.mode = 'off';
    await ticketTaskService._syncMirroredStatusFromFs({ id: 4, workspaceId: 1, freshserviceTicketId: 233399n, mirrorState: 'mirrored' });
    expect(fsClient.listTicketTasks).not.toHaveBeenCalled();
  });
});

describe('background writers skip imported history', () => {
  test('a system task create on imported history is skipped: no adoption, no task, no FreshService call', async () => {
    fsMode.mode = 'off';
    prismaMock.ticket.findFirst.mockResolvedValueOnce(FS);
    const out = await ticketTaskService.create(3, 1, { title: 'Auto task' }, { name: 'Ticket Pulse', role: 'system' });
    expect(out).toEqual({ skipped: 'freshservice_off_imported', ticketId: 3 });
    expect(prismaMock.ticketTask.create).not.toHaveBeenCalled();
    expect(fsClient.createTicketTask).not.toHaveBeenCalled();
  });
});