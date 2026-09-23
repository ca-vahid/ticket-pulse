import { jest } from '@jest/globals';

/**
 * Public API status change on FreshService-born tickets (23 Sep 2026):
 * validation and roll-up BEFORE FreshService is touched; FS first via
 * ticketService.updateFsTicket; TP-only resolution fields stamped after.
 */
const prismaMock = { ticket: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) } };
const updateFsTicket = jest.fn();
const rollUp = {
  assertNoOpenChildren: jest.fn().mockResolvedValue(undefined),
  afterChildStatusChange: jest.fn().mockResolvedValue(undefined),
  recomputeReadiness: jest.fn().mockResolvedValue(undefined),
};
const BASES = { Open: 'Open', Pending: 'Pending', 'Pending Response': 'Pending', Resolved: 'Resolved', Closed: 'Closed' };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { updateFsTicket } }));
jest.unstable_mockModule('../src/services/ticketRollUpService.js', () => ({ default: rollUp }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    assertValidStatus: jest.fn(async (_ws, s) => {
      const hit = Object.keys(BASES).find((k) => k.toLowerCase() === String(s).toLowerCase());
      if (!hit) { const { ValidationError } = await import('../src/utils/errors.js'); throw new ValidationError(`Unknown status "${s}"`); }
      return hit;
    }),
    baseStatusOf: jest.fn(async (_ws, s) => BASES[s] || null),
  },
}));

const { changeFsBornStatus, isFreshServiceBorn } = await import('../src/services/fsBornStatusService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const API = { name: 'ContinuIT', email: 'apikey:tpc_x', role: 'api' };
const FS_TICKET = { id: 25023, status: 'Open', origin: 'freshservice', freshserviceTicketId: 222417n, resolutionReason: null, resolvedByKind: null, internalCategory: { name: 'Hardware' } };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findFirst.mockResolvedValue(FS_TICKET);
  updateFsTicket.mockResolvedValue({ id: 25023, status: 'Resolved' });
});

test('isFreshServiceBorn: FS origin with an FS id → true; TP-born → false', async () => {
  prismaMock.ticket.findFirst.mockResolvedValueOnce({ origin: 'freshservice', freshserviceTicketId: 1n });
  expect(await isFreshServiceBorn(1, 1)).toBe(true);
  prismaMock.ticket.findFirst.mockResolvedValueOnce({ origin: 'ticketpulse', freshserviceTicketId: 9n });
  expect(await isFreshServiceBorn(2, 1)).toBe(false);
  // Missing row or a lookup failure → false (the TP path reports it as before).
  prismaMock.ticket.findFirst.mockResolvedValueOnce(null);
  expect(await isFreshServiceBorn(3, 1)).toBe(false);
  prismaMock.ticket.findFirst.mockRejectedValueOnce(new Error('db down'));
  expect(await isFreshServiceBorn(4, 1)).toBe(false);
});

test('resolve: FreshService first with the canonical label, then the TP-only resolution fields', async () => {
  const r = await changeFsBornStatus(25023, 1, 'resolved', API, { resolutionReason: 'other', resolutionNote: 'Done in the Kelowna visit' });
  expect(updateFsTicket).toHaveBeenCalledWith(25023, 1, { status: 'Resolved' }, API);
  expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 25023 }, data: expect.objectContaining({ resolutionReason: 'other', resolutionNote: 'Done in the Kelowna visit', resolvedByKind: 'api' }) });
  expect(rollUp.assertNoOpenChildren).toHaveBeenCalledWith(25023, 1);
  expect(rollUp.afterChildStatusChange).toHaveBeenCalled();
  expect(r).toMatchObject({ changed: true, status: 'Resolved', from: 'Open' });
});

test('same status → nothing written anywhere', async () => {
  const r = await changeFsBornStatus(25023, 1, 'Open', API);
  expect(r.changed).toBe(false);
  expect(updateFsTicket).not.toHaveBeenCalled();
  expect(prismaMock.ticket.update).not.toHaveBeenCalled();
});

test('Security ticket without a reason is refused BEFORE FreshService is touched', async () => {
  prismaMock.ticket.findFirst.mockResolvedValue({ ...FS_TICKET, internalCategory: { name: 'Security' } });
  await expect(changeFsBornStatus(25023, 1, 'Resolved', API)).rejects.toThrow();
  expect(updateFsTicket).not.toHaveBeenCalled();
});

test('a parent with open children cannot be closed; FreshService untouched', async () => {
  const err = Object.assign(new Error('open children'), { statusCode: 409, code: 'open_children' });
  rollUp.assertNoOpenChildren.mockRejectedValueOnce(err);
  await expect(changeFsBornStatus(25023, 1, 'Closed', API)).rejects.toMatchObject({ code: 'open_children' });
  expect(updateFsTicket).not.toHaveBeenCalled();
});

test('FreshService refusing (or not keeping) the value → 409 freshservice_rejected, no TP stamp', async () => {
  updateFsTicket.mockRejectedValue(new ValidationError('FreshService kept status Open'));
  await expect(changeFsBornStatus(25023, 1, 'Resolved', API, { resolutionReason: 'duplicate' })).rejects.toMatchObject({ statusCode: 409, code: 'freshservice_rejected' });
  expect(prismaMock.ticket.update).not.toHaveBeenCalled();
});

test('an unknown status is a 400 before any write', async () => {
  await expect(changeFsBornStatus(25023, 1, 'Done-ish', API)).rejects.toBeInstanceOf(ValidationError);
  expect(updateFsTicket).not.toHaveBeenCalled();
});

test('reopening clears the resolution fields and re-checks the parent readiness', async () => {
  prismaMock.ticket.findFirst.mockResolvedValue({ ...FS_TICKET, status: 'Resolved', resolutionReason: 'other', resolvedByKind: 'api' });
  await changeFsBornStatus(25023, 1, 'Open', API);
  expect(updateFsTicket).toHaveBeenCalledWith(25023, 1, { status: 'Open' }, API);
  expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 25023 }, data: { resolutionReason: null, resolutionNote: null, resolvedByKind: null } });
  expect(rollUp.recomputeReadiness).toHaveBeenCalled();
  expect(rollUp.assertNoOpenChildren).not.toHaveBeenCalled();
});
