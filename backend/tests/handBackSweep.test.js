import { jest } from '@jest/globals';

/**
 * QA 10-07 #2 (#245867 and #245870, 6 Oct 2026): an agent unassigned a
 * FreshService ticket inside Ticket Pulse and it then sat unassigned for 22
 * and 17 hours. Re-routing waited for the sync to notice FreshService's
 * activity; when that pass missed it, nothing looked again. The hand-back
 * sweep routes from the row Ticket Pulse wrote itself.
 */
const prismaMock = {
  ticketHandBack: { findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  ticket: { findUnique: jest.fn() },
  assignmentPipelineRun: { findFirst: jest.fn() },
  technician: { findUnique: jest.fn() },
  ticketAssignmentEpisode: { count: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const queueReboundRun = jest.fn();
const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/reboundRunService.js', () => ({ queueReboundRun, default: { queueReboundRun } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn().mockResolvedValue(['Open', 'Pending', 'Pending Response']) },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: logger }));

const { default: ticketHandBackService, FS_REBOUND_GRACE_MS } = await import('../src/services/ticketHandBackService.js');

const NOW = new Date('2026-10-06T23:00:00.000Z');
let nextId = 100;
const row = (over = {}) => ({
  id: nextId++, workspaceId: 1, ticketId: 62041, technicianId: 648411, actorTechId: 648411, actorName: 'Adrian Lo',
  selfHandBack: true, reasonCode: 'other', reasonNote: 'no permission', origin: 'freshservice', episodeId: null, pipelineRunId: null,
  createdAt: new Date('2026-10-06T22:26:20.000Z'),
  ...over,
});
const openTicket = (over = {}) => ({ id: 62041, workspaceId: 1, status: 'Open', isNoise: false, assignedTechId: null, freshserviceTicketId: BigInt(245867), ...over });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketHandBack.update.mockResolvedValue({});
  prismaMock.ticket.findUnique.mockResolvedValue(openTicket());
  prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue(null);
  prismaMock.technician.findUnique.mockResolvedValue({ name: 'Adrian Lo' });
  prismaMock.ticketAssignmentEpisode.count.mockResolvedValue(2);
  queueReboundRun.mockResolvedValue({ outcome: 'queued' });
});

describe('hand-back sweep', () => {
  test('only looks at FreshService-origin rows past the grace period that no run picked up', async () => {
    prismaMock.ticketHandBack.findMany.mockResolvedValue([]);
    const out = await ticketHandBackService.sweepUnroutedFsHandBacks(1, { now: NOW });
    expect(out).toEqual({ checked: 0, queued: 0 });
    const where = prismaMock.ticketHandBack.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: 1, origin: 'freshservice', pipelineRunId: null });
    expect(where.createdAt.lte.getTime()).toBe(NOW.getTime() - FS_REBOUND_GRACE_MS);
    expect(queueReboundRun).not.toHaveBeenCalled();
  });

  test('an open, unassigned ticket with no run since the hand-back gets its rebound run, with the reason', async () => {
    const r = row();
    prismaMock.ticketHandBack.findMany.mockResolvedValue([r]);
    const out = await ticketHandBackService.sweepUnroutedFsHandBacks(1, { now: NOW });
    expect(out.queued).toBe(1);
    const args = queueReboundRun.mock.calls[0][0];
    expect(args).toMatchObject({ ticketId: 62041, workspaceId: 1 });
    expect(args.reboundFrom).toMatchObject({
      previousTechId: 648411,
      previousTechName: 'Adrian Lo',
      unassignedAt: '2026-10-06T22:26:20.000Z',
      unassignedByName: 'Adrian Lo',
      reboundCount: 2,
      source: 'ticketpulse',
      reason: { code: 'other', label: 'Other', note: 'no permission' },
    });
    // The run it produced is tied back to the row, so the sweep never repeats it.
    await args.onRun({ id: 9001 });
    expect(prismaMock.ticketHandBack.update).toHaveBeenCalledWith({ where: { id: r.id }, data: { pipelineRunId: 9001 } });
    expect(prismaMock.assignmentPipelineRun.findFirst.mock.calls[0][0].where).toEqual({ ticketId: 62041, createdAt: { gte: r.createdAt } });
  });

  test.each([
    ['somebody took it since', openTicket({ assignedTechId: 6 })],
    ['it was closed since', openTicket({ status: 'Closed' })],
    ['it is noise', openTicket({ isNoise: true })],
  ])('leaves the ticket alone when %s', async (_label, ticket) => {
    prismaMock.ticketHandBack.findMany.mockResolvedValue([row()]);
    prismaMock.ticket.findUnique.mockResolvedValue(ticket);
    const out = await ticketHandBackService.sweepUnroutedFsHandBacks(1, { now: NOW });
    expect(out.queued).toBe(0);
    expect(queueReboundRun).not.toHaveBeenCalled();
  });

  test('a routing run created after the hand-back means it was looked at - no second run', async () => {
    prismaMock.ticketHandBack.findMany.mockResolvedValue([row()]);
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue({ id: 28515 });
    await ticketHandBackService.sweepUnroutedFsHandBacks(1, { now: NOW });
    expect(queueReboundRun).not.toHaveBeenCalled();
  });

  test('a rebound the shared guard already handled is tied to the row instead of run again', async () => {
    const r = row();
    prismaMock.ticketHandBack.findMany.mockResolvedValue([r]);
    queueReboundRun.mockResolvedValue({ outcome: 'already_handled', runId: 777 });
    const out = await ticketHandBackService.sweepUnroutedFsHandBacks(1, { now: NOW });
    expect(out.queued).toBe(0);
    expect(prismaMock.ticketHandBack.update).toHaveBeenCalledWith({ where: { id: r.id }, data: { pipelineRunId: 777 } });
  });

  test('only the newest hand-back of a ticket is considered, and a row is tried three times at most', async () => {
    const newest = row({ createdAt: new Date('2026-10-06T22:40:00.000Z') });
    const older = row({ createdAt: new Date('2026-10-06T21:25:00.000Z') });
    prismaMock.ticketHandBack.findMany.mockResolvedValue([newest, older]);
    for (let i = 0; i < 5; i += 1) await ticketHandBackService.sweepUnroutedFsHandBacks(1, { now: NOW });
    expect(queueReboundRun).toHaveBeenCalledTimes(3);
    expect(queueReboundRun.mock.calls.every(([a]) => a.reboundFrom.unassignedAt === '2026-10-06T22:40:00.000Z')).toBe(true);
  });

  test('a failed read never throws into the sync tick', async () => {
    prismaMock.ticketHandBack.findMany.mockRejectedValue(new Error('relation does not exist'));
    await expect(ticketHandBackService.sweepUnroutedFsHandBacks(1, { now: NOW })).resolves.toEqual({ checked: 0, queued: 0 });
  });
});
