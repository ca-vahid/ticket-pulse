import { jest } from '@jest/globals';

/** Assetron Part B (24 Sep 2026): every hold ends with a PATCH, retried until it lands. */
let holds;
let approvalRows;
let tickets;
const notes = [];

const prismaMock = {
  assetronReservation: {
    findMany: jest.fn(async ({ where }) => holds.filter((h) => (where.requestGroupId
      ? h.requestGroupId === where.requestGroupId
      : where.OR.some((c) => h.state === c.state && (!c.outcomeWhy || h.outcomeWhy === c.outcomeWhy))))),
    findUnique: jest.fn(async ({ where }) => holds.find((h) => (where.id ? h.id === where.id : h.requestGroupId === where.requestGroupId)) || null),
    update: jest.fn(async ({ where, data }) => { const h = holds.find((x) => x.id === where.id); Object.assign(h, data); return h; }),
    create: jest.fn(async ({ data }) => { const h = { id: holds.length + 1, attempts: 0, ...data }; holds.push(h); return h; }),
  },
  ticketApproval: {
    findMany: jest.fn(async ({ where }) => approvalRows.filter((r) => r.requestGroupId === where.requestGroupId)),
    findFirst: jest.fn(async ({ where }) => approvalRows.find((r) => r.id === where.id) || null),
  },
  ticket: {
    findUnique: jest.fn(async ({ where }) => tickets.find((t) => t.id === where.id) || null),
    findFirst: jest.fn(async ({ where }) => tickets.find((t) => t.id === where.id) || null),
  },
  ticketThreadEntry: { create: jest.fn(async ({ data }) => { notes.push(data.bodyText); return data; }) },
};
const clientMock = { isConfigured: jest.fn(() => true), createReservation: jest.fn(), decideReservation: jest.fn(), getAsset: jest.fn() };
class AssetronError extends Error {
  constructor({ status = null, code = 'X', reason = null, message }) { super(message); this.name = 'AssetronError'; this.status = status; this.code = code; this.reason = reason; }
  get retryable() { return this.status === null || this.status === 429 || this.status >= 500; }
}

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/assetronClient.js', () => ({ default: clientMock, AssetronError }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn(async () => ({ id: 'entra-oid-1' })) } }));

const { default: svc, desiredOutcome, assetLabel } = await import('../src/services/assetronReservationService.js');

const ASSET = { id: '4c1e9d2a-0000-4000-8000-000000000001', make: 'Dell', model: 'Latitude 7650', serialNumber: '5CG4XYZ123', cpu: 'Intel Core Ultra 7 165U', ram: '32 GB', storage: '1 TB', screenSize: '16"' };
const HOLD = () => ({ id: 1, workspaceId: 1, ticketId: 10, requestGroupId: 'g1', reservationId: 'res-1', assetId: ASSET.id, asset: ASSET, recipientEmail: 'jsmith@bgc.ca', recipientName: 'Jordan Smith', state: 'reserved', attempts: 0, pendingOutcome: null, requestedByEmail: 'agent@bgc.ca' });
const future = new Date(Date.now() + 5 * 864e5);
const past = new Date(Date.now() - 864e5);

beforeEach(() => {
  jest.clearAllMocks();
  notes.length = 0;
  holds = [HOLD()];
  tickets = [{ id: 10, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1700 }];
  approvalRows = [{ id: 5, requestGroupId: 'g1', status: 'pending', expiresAt: future, approverEmail: 'nvyland@bgc.ca', approverName: 'Neville Vyland', requestedBy: 'agent@bgc.ca', approvalCategoryId: 4 }];
  clientMock.decideReservation.mockResolvedValue({ reservationId: 'res-1', status: 'X', asset: { assignedTo: { displayName: 'Jordan Smith' } } });
  clientMock.createReservation.mockResolvedValue({ status: 201, data: { reservationId: 'res-2', status: 'PENDING' } });
  clientMock.getAsset.mockResolvedValue(ASSET);
});

describe('desiredOutcome (pure)', () => {
  test('approved row wins — any tier, any sibling', () => {
    expect(desiredOutcome([{ status: 'escalated' }, { status: 'approved', approverEmail: 'a@b', approverName: 'A', decidedAt: past, conditionNote: 'bring the old one back' }]))
      .toMatchObject({ outcome: 'APPROVED', decidedByEmail: 'a@b', reason: 'bring the old one back' });
  });
  test('a live pending row → still undecided (null), even next to a cancelled sibling', () => {
    expect(desiredOutcome([{ status: 'cancelled' }, { status: 'pending', expiresAt: future }])).toBeNull();
  });
  test('rejected → REJECTED; expired pending → CANCELLED expired; cancelled → CANCELLED; no rows → deleted', () => {
    expect(desiredOutcome([{ status: 'rejected', approverEmail: 'n@b' }])).toMatchObject({ outcome: 'REJECTED' });
    expect(desiredOutcome([{ status: 'pending', expiresAt: past }])).toEqual({ outcome: 'CANCELLED', why: 'expired' });
    expect(desiredOutcome([{ status: 'cancelled' }])).toEqual({ outcome: 'CANCELLED', why: 'cancelled' });
    expect(desiredOutcome([])).toEqual({ outcome: 'CANCELLED', why: 'request_deleted' });
  });
  test('assetLabel reads like a person would say it', () => {
    expect(assetLabel(ASSET)).toBe('Dell Latitude 7650 (S/N 5CG4XYZ123) — Intel Core Ultra 7 165U · 32 GB · 1 TB · 16"');
  });
});

describe('reconcile', () => {
  test('undecided → nothing sent', async () => {
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.decideReservation).not.toHaveBeenCalled();
  });

  test('approved → PATCH APPROVED with the approver, state assigned, note on the ticket', async () => {
    approvalRows[0] = { ...approvalRows[0], status: 'approved', decidedAt: past };
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.decideReservation).toHaveBeenCalledWith('res-1', expect.objectContaining({ status: 'APPROVED', decidedBy: { email: 'nvyland@bgc.ca', displayName: 'Neville Vyland' } }));
    expect(holds[0]).toMatchObject({ state: 'assigned', outcome: 'APPROVED', pendingOutcome: null });
    expect(notes.join('\n')).toMatch(/now assigned to Jordan Smith/);
  });

  test('rejected → REJECTED; expired → CANCELLED; deleted request → CANCELLED; ticket gone → CANCELLED', async () => {
    approvalRows[0].status = 'rejected';
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.decideReservation).toHaveBeenLastCalledWith('res-1', expect.objectContaining({ status: 'REJECTED' }));
    expect(holds[0].state).toBe('released');

    holds = [HOLD()]; approvalRows = [{ ...approvalRows[0], status: 'pending', expiresAt: past }];
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.decideReservation).toHaveBeenLastCalledWith('res-1', expect.objectContaining({ status: 'CANCELLED', reason: 'Ticket Pulse: the approval request expired' }));

    holds = [HOLD()]; approvalRows = [];
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.decideReservation).toHaveBeenLastCalledWith('res-1', expect.objectContaining({ status: 'CANCELLED', reason: 'Ticket Pulse: the approval request was deleted' }));

    holds = [HOLD()]; tickets = [];
    approvalRows = [{ id: 5, requestGroupId: 'g1', status: 'pending', expiresAt: future }];
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.decideReservation).toHaveBeenLastCalledWith('res-1', expect.objectContaining({ status: 'CANCELLED', reason: 'Ticket Pulse: the ticket was deleted' }));
  });

  test('Assetron down → kept, attempts + backoff; the sweep sends it later', async () => {
    approvalRows[0].status = 'rejected';
    clientMock.decideReservation.mockRejectedValueOnce(new AssetronError({ status: 503, message: 'busy' }));
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(holds[0]).toMatchObject({ state: 'reserved', pendingOutcome: 'REJECTED', attempts: 1 });
    expect(holds[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // due now → retried
    holds[0].nextAttemptAt = new Date(Date.now() - 1000);
    await svc.reconcile({});
    expect(holds[0].state).toBe('released');
  });

  test('409 RESERVATION_CLOSED → failed, with a note for an admin; never retried', async () => {
    approvalRows[0].status = 'approved';
    clientMock.decideReservation.mockRejectedValueOnce(new AssetronError({ status: 409, code: 'CONFLICT', reason: 'RESERVATION_CLOSED', message: 'Reservation already closed as CANCELLED' }));
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(holds[0].state).toBe('failed');
    expect(notes.join('\n')).toMatch(/Assetron refused to assign/);
    clientMock.decideReservation.mockClear();
    await svc.reconcile({});
    expect(clientMock.decideReservation).not.toHaveBeenCalled();
  });

  test('an EXPIRED hold is taken again when the request is renewed', async () => {
    Object.assign(holds[0], { state: 'released', outcome: 'CANCELLED', outcomeWhy: 'expired' });
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.createReservation).toHaveBeenCalledWith(expect.objectContaining({ assetId: ASSET.id, approvalId: 'g1', requestedFor: expect.objectContaining({ email: 'jsmith@bgc.ca' }) }));
    expect(holds[0]).toMatchObject({ state: 'reserved', reservationId: 'res-2' });
  });

  test('the sweep reads live holds and recently expired ones — never finished history', async () => {
    holds = [
      { ...HOLD(), id: 1, requestGroupId: 'done', state: 'released', outcome: 'REJECTED', outcomeWhy: 'rejected' },
      { ...HOLD(), id: 2, requestGroupId: 'g1' },
    ];
    await svc.reconcile({});
    const where = prismaMock.assetronReservation.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { state: 'reserved' },
      { state: 'released', outcomeWhy: 'expired', updatedAt: { gte: expect.any(Date) } },
    ]);
    expect(prismaMock.ticketApproval.findMany).toHaveBeenCalledTimes(1); // only g1 was read
  });

  test('approved after it expired: the laptop is taken again and assigned in one pass', async () => {
    Object.assign(holds[0], { state: 'released', outcome: 'CANCELLED', outcomeWhy: 'expired' });
    approvalRows[0] = { ...approvalRows[0], status: 'approved', decidedAt: past };
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.createReservation).toHaveBeenCalledTimes(1);
    expect(clientMock.decideReservation).toHaveBeenCalledWith('res-2', expect.objectContaining({ status: 'APPROVED' }));
    expect(holds[0]).toMatchObject({ state: 'assigned', reservationId: 'res-2' });
  });

  test('a rejection changed to an approval takes the laptop again and assigns it', async () => {
    Object.assign(holds[0], { state: 'released', outcome: 'REJECTED', outcomeWhy: 'rejected' });
    approvalRows[0] = { ...approvalRows[0], status: 'approved', decidedAt: past };
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(holds[0]).toMatchObject({ state: 'assigned', reservationId: 'res-2' });
  });

  test('laptop gone by then: no assignment, a note asks for another laptop', async () => {
    Object.assign(holds[0], { state: 'released', outcome: 'REJECTED', outcomeWhy: 'rejected' });
    approvalRows[0] = { ...approvalRows[0], status: 'approved', decidedAt: past };
    clientMock.createReservation.mockRejectedValueOnce(new AssetronError({ status: 409, reason: 'ASSET_UNAVAILABLE', message: 'This laptop is Assigned to someone else.' }));
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.decideReservation).not.toHaveBeenCalled();
    expect(holds[0]).toMatchObject({ state: 'released', outcomeWhy: 'not_rereserved' });
    expect(notes.join('\n')).toMatch(/could not be held again/);
  });

  test('assigned, then the approval is changed to rejected: one note, no PATCH (Assetron cannot undo it)', async () => {
    Object.assign(holds[0], { state: 'assigned', outcome: 'APPROVED', outcomeWhy: 'approved' });
    approvalRows[0] = { ...approvalRows[0], status: 'rejected', decidedAt: past };
    await svc.reconcile({ requestGroupId: 'g1' });
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.decideReservation).not.toHaveBeenCalled();
    expect(notes.filter((n) => /cannot undo an assignment/.test(n))).toHaveLength(1);
  });

  test('a rejected hold is never taken again', async () => {
    Object.assign(holds[0], { state: 'released', outcome: 'REJECTED', outcomeWhy: 'rejected' });
    await svc.reconcile({ requestGroupId: 'g1' });
    expect(clientMock.createReservation).not.toHaveBeenCalled();
  });
});

describe('reserve / change', () => {
  test('reserve sends ticket ref + url, the recipient with their Entra id, the request id and the agent', async () => {
    const r = await svc.reserve({ ticket: tickets[0], requestGroupId: 'g9', hardware: svc.normalizeHardware({ assetId: ASSET.id, recipient: { email: 'JSmith@bgc.ca', name: 'Jordan Smith' } }), actor: { email: 'agent@bgc.ca', name: 'Ada Agent' } });
    expect(clientMock.createReservation).toHaveBeenCalledWith({
      assetId: ASSET.id,
      requestedFor: { email: 'jsmith@bgc.ca', entraObjectId: 'entra-oid-1' },
      ticket: { ref: 'TP-1700', url: expect.stringMatching(/\/tickets\/10$/) },
      approvalId: 'g9',
      requestedBy: { email: 'agent@bgc.ca', displayName: 'Ada Agent' },
    });
    expect(r).toMatchObject({ reservationId: 'res-2', entraObjectId: 'entra-oid-1' });
  });

  test('USER_NOT_FOUND / ASSET_UNAVAILABLE surface as the agent-safe sentence, nothing created', async () => {
    clientMock.createReservation.mockRejectedValueOnce(new AssetronError({ status: 404, reason: 'USER_NOT_FOUND', message: 'This person is not in Assetron.' }));
    await expect(svc.reserve({ ticket: tickets[0], requestGroupId: 'g9', hardware: svc.normalizeHardware({ assetId: ASSET.id, recipient: { email: 'x@bgc.ca' } }), actor: {} }))
      .rejects.toThrow(/Sync from Entra ID/);
    clientMock.createReservation.mockRejectedValueOnce(new AssetronError({ status: 409, reason: 'ASSET_UNAVAILABLE', message: 'This laptop is On Hold for TP-1650.' }));
    await expect(svc.reserve({ ticket: tickets[0], requestGroupId: 'g9', hardware: svc.normalizeHardware({ assetId: ASSET.id, recipient: { email: 'x@bgc.ca' } }), actor: {} }))
      .rejects.toThrow('Assetron: This laptop is On Hold for TP-1650.');
  });

  test('change: only admins and the original requester; new hold first, old one released', async () => {
    const hw = { assetId: '4c1e9d2a-0000-4000-8000-000000000002', recipient: { email: 'other@bgc.ca', name: 'Other' } };
    await expect(svc.change(10, 1, 5, hw, { email: 'someone@bgc.ca', role: 'agent' })).rejects.toThrow(/Only an admin or the person who requested/);
    await svc.change(10, 1, 5, hw, { email: 'agent@bgc.ca', role: 'agent' });
    expect(clientMock.createReservation).toHaveBeenCalledTimes(1);
    expect(clientMock.decideReservation).toHaveBeenCalledWith('res-1', expect.objectContaining({ status: 'CANCELLED' }));
    expect(holds[0]).toMatchObject({ reservationId: 'res-2', assetId: hw.assetId, recipientEmail: 'other@bgc.ca', state: 'reserved' });
  });

  test('change: same laptop, new person — the old reservation is closed FIRST (Assetron would return it unchanged)', async () => {
    const order = [];
    clientMock.decideReservation.mockImplementation(async () => { order.push('cancel'); return {}; });
    clientMock.createReservation.mockImplementation(async () => { order.push('reserve'); return { status: 201, data: { reservationId: 'res-3', status: 'PENDING' } }; });
    await svc.change(10, 1, 5, { assetId: ASSET.id, recipient: { email: 'rita@bgc.ca', name: 'Rita' } }, { email: 'agent@bgc.ca', role: 'agent' });
    expect(order).toEqual(['cancel', 'reserve']);
    expect(holds[0]).toMatchObject({ reservationId: 'res-3', recipientEmail: 'rita@bgc.ca', state: 'reserved' });
  });

  test('change: same laptop, same person → nothing to do', async () => {
    await svc.change(10, 1, 5, { assetId: ASSET.id, recipient: { email: 'JSmith@bgc.ca' } }, { email: 'agent@bgc.ca', role: 'agent' });
    expect(clientMock.createReservation).not.toHaveBeenCalled();
    expect(clientMock.decideReservation).not.toHaveBeenCalled();
  });

  test('USER_NOT_FOUND: Assetron\'s sentence is not repeated when it already says what to do', async () => {
    clientMock.createReservation.mockRejectedValueOnce(new AssetronError({ status: 404, reason: 'USER_NOT_FOUND', message: 'x@bgc.ca is not in Assetron. Run "Sync from Entra ID" in Assetron, then try again.' }));
    const err = await svc.reserve({ ticket: tickets[0], requestGroupId: 'g9', hardware: svc.normalizeHardware({ assetId: ASSET.id, recipient: { email: 'x@bgc.ca' } }), actor: {} }).catch((e) => e);
    expect(err.message.match(/Sync from Entra ID/g)).toHaveLength(1);
  });

  test('change is refused once the request is decided', async () => {
    approvalRows[0].status = 'approved';
    await expect(svc.change(10, 1, 5, { assetId: ASSET.id, recipient: { email: 'a@bgc.ca' } }, { email: 'admin@bgc.ca', role: 'admin' })).rejects.toThrow(/already decided/);
  });
});
