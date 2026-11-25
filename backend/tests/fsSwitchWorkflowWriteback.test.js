import { jest } from '@jest/globals';

/**
 * FreshService switch (25 Nov 2026): in an Off workspace the update_ticket
 * node never asks FreshService and never parks for a retry. Its status write
 * goes through updateFsTicket, which adopts imported history and sets the
 * status in Ticket Pulse; any failure fails the step once.
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

const { applyFsBornStatusWriteback } = await import('../src/services/notificationWorkflowEngine.js');

const FS_TICKET = { id: 39618, workspaceId: 2, origin: 'freshservice', freshserviceTicketId: BigInt(237051), status: 'Closed', customFields: {} };
const NODE = { id: 'reopen', type: 'update_ticket', data: { setStatus: 'Open' } };

beforeEach(() => {
  jest.clearAllMocks();
  fsMode.mode = 'off';
});

test('Off: FreshService is not asked; the status goes through updateFsTicket (adopt + TP status)', async () => {
  updateFsTicketMock.mockResolvedValueOnce({ adopted: true });
  const out = await applyFsBornStatusWriteback({ node: NODE, ticket: FS_TICKET, setStatus: 'Open', state: {} });
  expect(getInteractiveClientMock).not.toHaveBeenCalled();
  expect(fetchTicketSafeMock).not.toHaveBeenCalled();
  expect(updateFsTicketMock).toHaveBeenCalledWith(39618, 2, { status: 'Open' }, expect.objectContaining({ role: 'workflow' }), { notifyLifecycle: false });
  expect(out).toEqual(expect.objectContaining({ applied: true, adopted: true, via: 'adopted_freshservice_off' }));
});

test('Off: a failure fails the step once with "FreshService is off for this workspace" — no retry park', async () => {
  updateFsTicketMock.mockRejectedValueOnce(new Error('Status "Open" is not valid'));
  const state = {};
  await expect(applyFsBornStatusWriteback({ node: NODE, ticket: FS_TICKET, setStatus: 'Open', state }))
    .rejects.toThrow(/^FreshService is off for this workspace/);
  expect(state.__fsWritebackAttempts).toBeUndefined();
  expect(recordFailureMock).not.toHaveBeenCalled();
});

test('Connected: unchanged — FreshService is asked first', async () => {
  fsMode.mode = 'connected';
  fetchTicketSafeMock.mockResolvedValueOnce({ status: 5 });
  updateFsTicketMock.mockResolvedValueOnce({});
  await applyFsBornStatusWriteback({ node: NODE, ticket: FS_TICKET, setStatus: 'Open', state: {} });
  expect(getInteractiveClientMock).toHaveBeenCalledWith(2);
  expect(fetchTicketSafeMock).toHaveBeenCalledWith(237051);
});