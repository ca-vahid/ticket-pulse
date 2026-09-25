import { jest } from '@jest/globals';

/** Assetron Part B (24 Sep 2026): the laptop hold rides the approval request. */
const prismaMock = {
  ticket: { findFirst: jest.fn(), findUnique: jest.fn() },
  approvalCategory: { findFirst: jest.fn(), findUnique: jest.fn() },
  ticketApproval: {
    findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(),
  },
  ticketThreadEntry: { create: jest.fn() },
  mailboxConnection: { findFirst: jest.fn() },
  technician: { findFirst: jest.fn() },
  requester: { findFirst: jest.fn() },
  assetronReservation: { deleteMany: jest.fn() },
};
const activityMock = { create: jest.fn() };
const sendgridMock = { sendEmail: jest.fn().mockResolvedValue({ status: 'ok' }) };
const lifecycleMock = { emitTicketEvent: jest.fn() };
const publicStatusMock = { getPublicTicketStatusSettings: jest.fn(), ensurePublicTicketStatusLink: jest.fn() };
const azureAdMock = { isConfigured: jest.fn(() => false), getUserPhoto: jest.fn() };
const assetronMock = {
  normalizeHardware: jest.fn((h) => (h && h.assetId ? { assetId: h.assetId, recipient: h.recipient } : null)),
  reserve: jest.fn(), record: jest.fn(), abandon: jest.fn(), touch: jest.fn(), forGroup: jest.fn(async () => null),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock, sendEmail: sendgridMock.sendEmail }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: () => false } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => publicStatusMock);
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureAdMock }));
jest.unstable_mockModule('../src/services/assetronReservationService.js', () => ({ default: assetronMock }));

const { default: ticketApprovalService } = await import('../src/services/ticketApprovalService.js');

const ticket = { id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1700, subject: 'New laptop', requester: { name: 'Rita', email: 'rita@x.io' } };
const HW_CATEGORY = { id: 4, workspaceId: 1, name: 'New Computer Upgrade', isActive: true, managerEmails: ['nev@x.io'], tiers: null, hasAmount: false, gatesHardware: true };
const PLAIN_CATEGORY = { ...HW_CATEGORY, id: 9, name: 'AI Premium License Request', gatesHardware: false };
const HW = { assetId: '4c1e9d2a-0000-4000-8000-000000000001', recipient: { email: 'rita@x.io', name: 'Rita' } };

beforeEach(() => {
  jest.clearAllMocks();
  activityMock.create.mockResolvedValue({});
  sendgridMock.sendEmail.mockResolvedValue({ status: 'ok' });
  prismaMock.ticket.findFirst.mockResolvedValue(ticket);
  prismaMock.ticket.findUnique.mockResolvedValue(ticket);
  prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.create.mockResolvedValue({ id: 9 });
  prismaMock.ticketApproval.findFirst.mockResolvedValue(null);
  prismaMock.ticketApproval.findMany.mockResolvedValue([]);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.requester.findFirst.mockResolvedValue(null);
  prismaMock.assetronReservation.deleteMany.mockResolvedValue({ count: 1 });
  publicStatusMock.getPublicTicketStatusSettings.mockResolvedValue({ enabled: false });
  publicStatusMock.ensurePublicTicketStatusLink.mockResolvedValue({ url: null });
  let seq = 100;
  prismaMock.ticketApproval.create.mockImplementation(({ data }) => Promise.resolve({ id: ++seq, ...data }));
  assetronMock.reserve.mockResolvedValue({ reservationId: 'res-1', asset: { id: HW.assetId }, entraObjectId: null });
  assetronMock.record.mockResolvedValue(undefined);
});

test('a hardware request with a laptop: reserved FIRST (same request id), recorded, then the approval rows', async () => {
  prismaMock.approvalCategory.findFirst.mockResolvedValue(HW_CATEGORY);
  const order = [];
  assetronMock.reserve.mockImplementation(async () => { order.push('reserve'); return { reservationId: 'res-1', asset: {}, entraObjectId: null }; });
  assetronMock.record.mockImplementation(async () => { order.push('record'); });
  prismaMock.ticketApproval.create.mockImplementation(async ({ data }) => { order.push('row'); return { id: 101, ...data }; });
  const res = await ticketApprovalService.request(501, 1, { approvalCategoryId: 4, hardware: HW }, { email: 'agent@x.io', name: 'Ada' });
  expect(order).toEqual(['reserve', 'record', 'row']);
  const reserveArgs = assetronMock.reserve.mock.calls[0][0];
  expect(reserveArgs.requestGroupId).toBe(res.requestGroupId);
  expect(reserveArgs.hardware).toEqual(HW);
  expect(prismaMock.ticketApproval.create.mock.calls[0][0].data.requestGroupId).toBe(res.requestGroupId);
});

test('Assetron refusing the hold: nothing is created and the agent sees why', async () => {
  prismaMock.approvalCategory.findFirst.mockResolvedValue(HW_CATEGORY);
  assetronMock.reserve.mockRejectedValue(new Error('Assetron: This laptop is On Hold for TP-1650.'));
  await expect(ticketApprovalService.request(501, 1, { approvalCategoryId: 4, hardware: HW }, { email: 'agent@x.io' })).rejects.toThrow('On Hold for TP-1650');
  expect(prismaMock.ticketApproval.create).not.toHaveBeenCalled();
});

test('rows failing after the hold: the hold is released and its record removed', async () => {
  prismaMock.approvalCategory.findFirst.mockResolvedValue(HW_CATEGORY);
  prismaMock.ticketApproval.create.mockRejectedValue(new Error('db down'));
  await expect(ticketApprovalService.request(501, 1, { approvalCategoryId: 4, hardware: HW }, { email: 'agent@x.io' })).rejects.toThrow('db down');
  expect(assetronMock.abandon).toHaveBeenCalledWith('res-1', expect.any(Object));
  expect(prismaMock.assetronReservation.deleteMany).toHaveBeenCalled();
});

test('a laptop on a NON-hardware category is refused before anything is reserved', async () => {
  prismaMock.approvalCategory.findFirst.mockResolvedValue(PLAIN_CATEGORY);
  await expect(ticketApprovalService.request(501, 1, { approvalCategoryId: 9, hardware: HW }, { email: 'agent@x.io' })).rejects.toThrow(/not a hardware category/);
  expect(assetronMock.reserve).not.toHaveBeenCalled();
});

test('a hardware request WITHOUT a laptop (charger, battery) works as before', async () => {
  prismaMock.approvalCategory.findFirst.mockResolvedValue(HW_CATEGORY);
  await ticketApprovalService.request(501, 1, { approvalCategoryId: 4, note: 'charger' }, { email: 'agent@x.io' });
  expect(assetronMock.reserve).not.toHaveBeenCalled();
  expect(prismaMock.ticketApproval.create).toHaveBeenCalledTimes(1);
});

test('cancel tells the reconciler', async () => {
  prismaMock.ticketApproval.findFirst.mockResolvedValue({ id: 101, ticketId: 501, workspaceId: 1, status: 'pending', requestedBy: 'agent@x.io', requestGroupId: 'g1' });
  prismaMock.ticketApproval.updateMany.mockResolvedValue({ count: 1 });
  await ticketApprovalService.cancel(501, 1, 101, { email: 'agent@x.io' });
  expect(assetronMock.touch).toHaveBeenCalledWith('g1');
});
