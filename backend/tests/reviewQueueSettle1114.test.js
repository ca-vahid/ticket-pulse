import { jest } from '@jest/globals';

/**
 * MEGA 11-14 Part B — the review queue settles itself.
 *
 * An AI suggestion waiting for review is settled ('settled_elsewhere') once
 * its ticket has an owner, is closed / resolved, deleted, spam or noise: who,
 * when and why are recorded, and nothing else happens (no assignment, no
 * e-mail, no Teams, no competency feedback). A ticket still unassigned and
 * open keeps its suggestion in the queue. The backlog button runs the same
 * rule and is idempotent.
 */

const prismaMock = {
  assignmentPipelineRun: { findMany: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  ticket: { findUnique: jest.fn(), update: jest.fn() },
  technician: { findUnique: jest.fn() },
  notificationDelivery: { create: jest.fn() },
};
const broadcast = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    listStatuses: jest.fn().mockResolvedValue([
      { name: 'Open', baseStatus: 'Open', isActive: true },
      { name: 'Pending', baseStatus: 'Pending', isActive: true },
      { name: 'Resolved', baseStatus: 'Resolved', isActive: true },
      { name: 'Closed', baseStatus: 'Closed', isActive: true },
      { name: 'Done', baseStatus: 'Resolved', isActive: false },
    ]),
    resolveBaseStatus: jest.fn(async (_ws, name) => ({
      Open: 'Open', Pending: 'Pending', Resolved: 'Resolved', Closed: 'Closed', Done: 'Resolved',
    }[name] || null)),
  },
}));

const {
  default: settle, settleReasonFor, settleNote, decidedByFor, systemMarker, SETTLED_DECISION,
} = await import('../src/services/reviewQueueSettleService.js');

const person = { name: 'Sam Ortiz', email: 'sam.ortiz@example.com' };
const ticket = (over = {}) => ({ id: 700, workspaceId: 2, status: 'Open', assignedTechId: null, isNoise: false, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([{ id: 11, workspaceId: 2 }, { id: 12, workspaceId: 2 }]);
  prismaMock.assignmentPipelineRun.updateMany.mockResolvedValue({ count: 2 });
  prismaMock.technician.findUnique.mockResolvedValue({ name: 'Alex Rivera' });
});

describe('the rule', () => {
  test('owner, close, removal and noise settle; an open, unowned ticket does not', () => {
    expect(settleReasonFor(ticket({ assignedTechId: 5 }))).toEqual({ kind: 'assigned', techId: 5 });
    expect(settleReasonFor(ticket({ status: 'Closed' }), { base: 'Closed' })).toEqual({ kind: 'closed', status: 'Closed' });
    expect(settleReasonFor(ticket({ status: 'Done' }), { base: 'Resolved' })).toEqual({ kind: 'closed', status: 'Done' });
    expect(settleReasonFor(ticket({ status: 'Deleted', assignedTechId: 5 }))).toEqual({ kind: 'deleted' });
    expect(settleReasonFor(ticket({ status: 'Spam' }))).toEqual({ kind: 'spam' });
    expect(settleReasonFor(ticket({ isNoise: true }))).toEqual({ kind: 'noise' });
    expect(settleReasonFor(ticket(), { base: 'Open' })).toBeNull();
    expect(settleReasonFor(ticket({ status: 'Pending' }), { base: 'Pending' })).toBeNull();
  });

  test('who: the person when there is one, a system marker otherwise', () => {
    expect(decidedByFor(person, 'ticketpulse_native')).toBe('sam.ortiz@example.com');
    expect(decidedByFor(null, 'freshservice_sync')).toBe('system:freshservice_sync');
    expect(decidedByFor({ name: 'Notification workflow', email: null }, 'workflow')).toBe('system:workflow');
    expect(systemMarker('')).toBe('system:ticket-pulse');
  });

  test('why: one plain sentence that says nothing was assigned and nobody was told', () => {
    expect(settleNote({ kind: 'assigned' }, { techName: 'Alex Rivera', actorName: 'Sam Ortiz' }))
      .toBe('Ticket assigned to Alex Rivera by Sam Ortiz. The suggestion was settled; nothing was assigned and nobody was told.');
    expect(settleNote({ kind: 'closed', status: 'Closed' }, { via: 'in FreshService' })).toMatch(/^Ticket closed in FreshService\./);
    expect(settleNote({ kind: 'spam' })).toMatch(/^Ticket marked as spam\./);
  });
});

describe('settling one ticket', () => {
  test('assigned by hand: settled, with who, when and why — and nothing else touched', async () => {
    const out = await settle.settleForTicket(ticket({ assignedTechId: 5 }), { actor: person, source: 'ticketpulse_native' });
    expect(out).toEqual({ settled: 2, reason: 'assigned' });
    expect(prismaMock.assignmentPipelineRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketId: 700, status: 'completed', decision: 'pending_review' },
    }));
    const call = prismaMock.assignmentPipelineRun.updateMany.mock.calls[0][0];
    // Race-safe: only runs still pending are touched.
    expect(call.where).toEqual({ id: { in: [11, 12] }, status: 'completed', decision: 'pending_review' });
    expect(call.data).toEqual({
      decision: SETTLED_DECISION,
      decidedAt: expect.any(Date),
      decidedByEmail: 'sam.ortiz@example.com',
      decisionNote: 'Ticket assigned to Alex Rivera by Sam Ortiz. The suggestion was settled; nothing was assigned and nobody was told.',
    });
    // No assignment on the run, no ticket write, no delivery.
    expect(call.data.assignedTechId).toBeUndefined();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
    // The review-queue SSE tells open queues to refresh.
    expect(broadcast).toHaveBeenCalledWith('ticket-change', expect.objectContaining({ action: 'pipeline', ticketId: 700, decision: 'settled_elsewhere' }), 2);
  });

  test('closed in FreshService (sync): a system marker and "in FreshService"', async () => {
    await settle.settleForTicket(ticket({ status: 'Closed' }), { source: 'freshservice_sync' });
    const { data } = prismaMock.assignmentPipelineRun.updateMany.mock.calls[0][0];
    expect(data.decidedByEmail).toBe('system:freshservice_sync');
    expect(data.decisionNote).toMatch(/^Ticket closed in FreshService\./);
  });

  test('a custom Resolved-base status counts as closed', async () => {
    const out = await settle.settleForTicket(ticket({ status: 'Done' }), { source: 'workflow' });
    expect(out.reason).toBe('closed');
    expect(prismaMock.assignmentPipelineRun.updateMany.mock.calls[0][0].data.decisionNote).toMatch(/^Ticket closed \(Done\) by a workflow\./);
  });

  test('marked as spam, and deleted', async () => {
    expect((await settle.settleForTicket(ticket({ status: 'Spam' }), { source: 'freshservice' })).reason).toBe('spam');
    expect((await settle.settleForTicket(ticket({ status: 'Deleted' }), { actor: person })).reason).toBe('deleted');
  });

  test('marked as noise by hand', async () => {
    const out = await settle.settleForTicket(ticket(), { actor: person, noise: true });
    expect(out.reason).toBe('noise');
  });

  test('a ticket still unassigned and open stays in the queue', async () => {
    const out = await settle.settleForTicket(ticket({ status: 'Pending' }), { actor: person });
    expect(out).toEqual({ settled: 0 });
    expect(prismaMock.assignmentPipelineRun.updateMany).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('cheap: no open review means one indexed read and nothing more', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([]);
    const out = await settle.settleForTicket(700);
    expect(out).toEqual({ settled: 0 });
    expect(prismaMock.ticket.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.updateMany).not.toHaveBeenCalled();
  });

  test('given only an id, the ticket is read once', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...ticket({ assignedTechId: 5 }), assignedTech: { id: 5, name: 'Alex Rivera' } });
    const out = await settle.settleForTicket(700, { source: 'pipeline' });
    expect(out.reason).toBe('assigned');
    expect(prismaMock.technician.findUnique).not.toHaveBeenCalled(); // the name came with the ticket
  });

  test('a database failure never reaches the caller', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockRejectedValue(new Error('pool exhausted'));
    await expect(settle.settleForTicket(ticket({ assignedTechId: 5 }))).resolves.toEqual({ settled: 0 });
  });

  test('settleOnChange only reads when the owner or the status moved', async () => {
    await settle.settleOnChange(ticket({ assignedTechId: 5 }), ticket({ assignedTechId: 5, priority: 3 }));
    expect(prismaMock.assignmentPipelineRun.findMany).not.toHaveBeenCalled();
    await settle.settleOnChange(ticket(), ticket({ assignedTechId: 5 }), { source: 'freshservice_webhook' });
    expect(prismaMock.assignmentPipelineRun.updateMany.mock.calls[0][0].data.decidedByEmail).toBe('system:freshservice_webhook');
  });
});

describe('the backlog button', () => {
  test('the count reads open reviews whose ticket has an owner or is closed / removed (retired statuses too)', async () => {
    prismaMock.assignmentPipelineRun.count.mockResolvedValue(2131);
    await expect(settle.countBacklog(2)).resolves.toBe(2131);
    const { where } = prismaMock.assignmentPipelineRun.count.mock.calls[0][0];
    expect(where).toMatchObject({ workspaceId: 2, status: 'completed', decision: 'pending_review' });
    const or = where.ticket.is.OR;
    expect(or[0]).toEqual({ assignedTechId: { not: null } });
    expect(or[1].status.in).toEqual(expect.arrayContaining(['Resolved', 'Closed', 'Deleted', 'Spam', 'Done']));
  });

  test('clearing settles in batches through the same rule, then a second click finds nothing', async () => {
    prismaMock.assignmentPipelineRun.findMany
      .mockResolvedValueOnce([
        { id: 1, ticket: { id: 90, status: 'Closed', assignedTechId: 5, assignedTech: { id: 5, name: 'Alex Rivera' } } },
        { id: 2, ticket: { id: 91, status: 'Open', assignedTechId: 5, assignedTech: { id: 5, name: 'Alex Rivera' } } },
        { id: 3, ticket: { id: 92, status: 'Open', assignedTechId: 6, assignedTech: { id: 6, name: 'Jordan Lee' } } },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.assignmentPipelineRun.updateMany.mockImplementation(async ({ where }) => ({ count: where.id.in.length }));
    prismaMock.assignmentPipelineRun.count.mockResolvedValue(0);

    const first = await settle.clearBacklog(2, { actor: person });
    expect(first).toEqual({ settled: 3, remaining: 0 });
    const updates = prismaMock.assignmentPipelineRun.updateMany.mock.calls.map((c) => c[0]);
    // One update per distinct sentence; every one guarded on still-pending.
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect(u.where).toMatchObject({ status: 'completed', decision: 'pending_review' });
      expect(u.data).toMatchObject({ decision: 'settled_elsewhere', decidedByEmail: 'sam.ortiz@example.com' });
      expect(u.data.decisionNote).toMatch(/Cleared from the review queue by Sam Ortiz\.$/);
    }
    expect(updates.find((u) => u.where.id.in.includes(1)).data.decisionNote).toMatch(/^Ticket closed\./);
    expect(updates.find((u) => u.where.id.in.includes(2)).data.decisionNote).toMatch(/^Ticket assigned to Alex Rivera\./);

    jest.clearAllMocks();
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([]);
    prismaMock.assignmentPipelineRun.count.mockResolvedValue(0);
    const second = await settle.clearBacklog(2, { actor: person });
    expect(second).toEqual({ settled: 0, remaining: 0 });
    expect(prismaMock.assignmentPipelineRun.updateMany).not.toHaveBeenCalled();
  });

  test('a batch where nothing moves (decided meanwhile) stops instead of spinning', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([
      { id: 1, ticket: { id: 90, status: 'Closed', assignedTechId: null } },
    ]);
    prismaMock.assignmentPipelineRun.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.assignmentPipelineRun.count.mockResolvedValue(0);
    await expect(settle.clearBacklog(2, { actor: person })).resolves.toEqual({ settled: 0, remaining: 0 });
    expect(prismaMock.assignmentPipelineRun.findMany).toHaveBeenCalledTimes(1);
  });
});
