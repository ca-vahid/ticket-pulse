import { jest } from '@jest/globals';

/**
 * FreshService switch (25 Nov 2026):
 *  - Off: a workflow never touches imported history (no FreshService call, no
 *    adoption, no retry park): the status step is a clean skip;
 *  - the update_ticket node never un-adopts: an adopted ticket keeps 'adopted',
 *    an Off workspace never flips to 'pending', and no mirror job is queued.
 *
 * Harness from MEGA 09-01 Phase RO-4 / RO-5 — the update_ticket node writes a status to an
 * FS-born ticket THROUGH FreshService (ticketService.updateFsTicket), skips
 * when FreshService already shows that status (its own automator beat us),
 * and on failure leaves the local row untouched: attempts 1..2 park the run
 * for a delay-resume retry AT the node, attempt 3 fails the step visibly.
 */

const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflow: { findUnique: jest.fn(), findFirst: jest.fn() },
  notificationWorkflowVersion: { findUnique: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  customFieldDefinition: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketActivity: { create: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn(), create: jest.fn() },
  notificationDelivery: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
};
const activityCreateMock = jest.fn().mockResolvedValue({});
const fetchTicketSafeMock = jest.fn();
const getInteractiveClientMock = jest.fn().mockResolvedValue({ fetchTicketSafe: fetchTicketSafeMock });
const updateFsTicketMock = jest.fn();
const recordFailureMock = jest.fn().mockResolvedValue({});
const recordSuccessMock = jest.fn().mockResolvedValue({});

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: jest.fn().mockResolvedValue({ success: true, status: 'sent' }),
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: activityCreateMock } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueFieldSync: jest.fn().mockResolvedValue({}),
    enqueueThreadEntry: jest.fn().mockResolvedValue({}),
    getInteractiveClient: getInteractiveClientMock,
  },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({
  default: { updateFsTicket: updateFsTicketMock, assignTicket: jest.fn() },
}));
jest.unstable_mockModule('../src/services/emailHealthService.js', () => ({
  default: { recordFailure: recordFailureMock, recordSuccess: recordSuccessMock },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/customFieldService.js', () => ({
  default: { setValues: jest.fn() },
  prettifyKeyLabel: (key) => String(key),
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));


const fsMode = { mode: 'off' };
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

const { applyFsBornStatusWriteback, executeUpdateTicketNode } = await import('../src/services/notificationWorkflowEngine.js');
const { default: mirrorService } = await import('../src/services/mirrorService.js');

const FS_TICKET = { id: 39618, workspaceId: 2, origin: 'freshservice', freshserviceTicketId: BigInt(237051), status: 'Closed', customFields: {}, createdAt: new Date('2026-11-01T10:00:00Z') };
const NODE = { id: 'reopen', type: 'update_ticket', data: { setStatus: 'Open' } };
const ctx = (ticket) => ({ ticket: { id: ticket.id, workspaceId: ticket.workspaceId }, workspace: { id: ticket.workspaceId }, event: { type: 'ticket.reply_received' } });

beforeEach(() => {
  jest.clearAllMocks();
  fsMode.mode = 'off';
  prismaMock.ticket.update.mockResolvedValue({});
});

describe('Off: a workflow leaves imported history as it is', () => {
  test('FreshService not asked, nothing adopted, no retry park', async () => {
    const state = {};
    const out = await applyFsBornStatusWriteback({ node: NODE, ticket: FS_TICKET, setStatus: 'Open', state });
    expect(getInteractiveClientMock).not.toHaveBeenCalled();
    expect(fetchTicketSafeMock).not.toHaveBeenCalled();
    expect(updateFsTicketMock).not.toHaveBeenCalled();
    expect(out).toEqual(expect.objectContaining({ skipped: true, via: 'freshservice_off' }));
    expect(out.__waitMinutes).toBeUndefined();
    expect(state.__fsWritebackAttempts).toBeUndefined();
  });

  test('the update_ticket node reports the skip and writes nothing', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(FS_TICKET);
    const out = await executeUpdateTicketNode(NODE, ctx(FS_TICKET), { workflowId: 9701 });
    expect(out).toEqual(expect.objectContaining({ skipped: true }));
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('Connected: unchanged — FreshService is asked first', async () => {
    fsMode.mode = 'connected';
    fetchTicketSafeMock.mockResolvedValueOnce({ status: 5 });
    updateFsTicketMock.mockResolvedValueOnce({});
    await applyFsBornStatusWriteback({ node: NODE, ticket: FS_TICKET, setStatus: 'Open', state: {} });
    expect(getInteractiveClientMock).toHaveBeenCalledWith(2);
    expect(fetchTicketSafeMock).toHaveBeenCalledWith(237051);
  });
});

describe('the update_ticket node never un-adopts a ticket', () => {
  const tp = (over) => ({ ...FS_TICKET, id: 500, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 2001, status: 'Resolved', resolvedAt: new Date(), ...over });

  test("adopted (connected): reopened, keeps 'adopted', nothing queued for the mirror", async () => {
    fsMode.mode = 'connected';
    prismaMock.ticket.findUnique.mockResolvedValue(tp({ mirrorState: 'adopted', freshserviceTicketId: 245001n }));
    await executeUpdateTicketNode(NODE, ctx(tp({})), { workflowId: 9702 });
    const { data } = prismaMock.ticket.update.mock.calls[0][0];
    expect(data.status).toBe('Open');
    expect(data).not.toHaveProperty('mirrorState');
    expect(mirrorService.enqueueFieldSync).not.toHaveBeenCalled();
  });

  test("Off workspace (TP-born mirrored): no 'pending' flip, nothing queued", async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(tp({ mirrorState: 'mirrored', freshserviceTicketId: 246100n }));
    await executeUpdateTicketNode(NODE, ctx(tp({})), { workflowId: 9703 });
    expect(prismaMock.ticket.update.mock.calls[0][0].data).not.toHaveProperty('mirrorState');
    expect(mirrorService.enqueueFieldSync).not.toHaveBeenCalled();
  });

  test("Connected TP-born: 'pending' and queued, as before; 'none' stays 'none'", async () => {
    fsMode.mode = 'connected';
    prismaMock.ticket.findUnique.mockResolvedValue(tp({ mirrorState: 'mirrored', freshserviceTicketId: 246100n }));
    await executeUpdateTicketNode(NODE, ctx(tp({})), { workflowId: 9704 });
    expect(prismaMock.ticket.update.mock.calls[0][0].data.mirrorState).toBe('pending');
    expect(mirrorService.enqueueFieldSync).toHaveBeenCalledWith(1, 500);

    jest.clearAllMocks();
    prismaMock.ticket.findUnique.mockResolvedValue(tp({ mirrorState: 'none', freshserviceTicketId: null }));
    await executeUpdateTicketNode(NODE, ctx(tp({})), { workflowId: 9705 });
    expect(prismaMock.ticket.update.mock.calls[0][0].data).not.toHaveProperty('mirrorState');
  });
});
describe('workflow assignment on imported history', () => {
  test('Off: updateFsTicket leaves it unchanged → the step reports skipped, not assigned', async () => {
    const { applyWorkflowAssignment, IMPORTED_LEFT_UNCHANGED } = await import('../src/services/notificationWorkflowActionNodes.js');
    updateFsTicketMock.mockResolvedValueOnce({ id: 39618, noChanges: true, skipped: 'freshservice_off_imported' });
    const out = await applyWorkflowAssignment(FS_TICKET, 9);
    expect(out).toEqual({ via: 'freshservice_off', skipped: true, reason: IMPORTED_LEFT_UNCHANGED });
    expect(IMPORTED_LEFT_UNCHANGED).toBe('Imported from FreshService; left unchanged');
  });

  test('Connected: still a FreshService write-back', async () => {
    const { applyWorkflowAssignment } = await import('../src/services/notificationWorkflowActionNodes.js');
    updateFsTicketMock.mockResolvedValueOnce({ id: 39618, synced: ['assignee'] });
    expect(await applyWorkflowAssignment(FS_TICKET, 9)).toEqual({ via: 'freshservice_writeback' });
  });
});