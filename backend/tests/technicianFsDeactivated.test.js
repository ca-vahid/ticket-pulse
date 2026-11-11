import { jest } from '@jest/globals';

/**
 * 10 Nov 2026: an agent deactivated in FreshService stayed active in Ticket
 * Pulse. FreshService keeps deactivated agents in /agents (active: false), so
 * deactivateNotInList never saw them, and upsert never writes isActive. The
 * agent sync now disables them, one way only.
 */

const prismaMock = {
  technician: { findMany: jest.fn(), updateMany: jest.fn() },
  ticket: { count: jest.fn() },
  approvalCategory: { count: jest.fn() },
  avApprovalGroupApprover: { count: jest.fn() },
  ticketApproval: { count: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));

const { default: technicianRepository } = await import('../src/services/technicianRepository.js');
const { transformAgent } = await import('../src/integrations/freshserviceTransformer.js');

beforeEach(() => {
  prismaMock.technician.findMany.mockReset();
  prismaMock.technician.updateMany.mockReset();
});

describe('technicianRepository.deactivateFsDeactivated', () => {
  test('disables only active FreshService technicians named, and returns them', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ id: 5, name: 'Dana Whitfield' }]);
    prismaMock.technician.updateMany.mockResolvedValue({ count: 1 });

    const out = await technicianRepository.deactivateFsDeactivated(1, [1001, 1002]);

    expect(out).toEqual([{ id: 5, name: 'Dana Whitfield' }]);
    const where = prismaMock.technician.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ workspaceId: 1, isActive: true, origin: 'freshservice', freshserviceId: { in: [1001n, 1002n] } });
    const update = prismaMock.technician.updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({ ...where, id: { in: [5] } });
    expect(update.data.isActive).toBe(false);
  });

  test('nothing to do: no ids, no workspace, or nobody still active', async () => {
    expect(await technicianRepository.deactivateFsDeactivated(1, [])).toEqual([]);
    expect(await technicianRepository.deactivateFsDeactivated(null, [1001])).toEqual([]);
    expect(prismaMock.technician.findMany).not.toHaveBeenCalled();

    prismaMock.technician.findMany.mockResolvedValue([]);
    expect(await technicianRepository.deactivateFsDeactivated(1, [1001])).toEqual([]);
    expect(prismaMock.technician.updateMany).not.toHaveBeenCalled();
  });

  test('never writes isActive: true', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ id: 9, name: 'Sam Okafor' }]);
    prismaMock.technician.updateMany.mockResolvedValue({ count: 1 });
    await technicianRepository.deactivateFsDeactivated(2, [2001]);
    for (const [arg] of prismaMock.technician.updateMany.mock.calls) expect(arg.data.isActive).toBe(false);
  });
});

describe('technicianRepository.looseEnds', () => {
  test('counts open tickets, manager seats, approver seats and pending approvals by e-mail', async () => {
    prismaMock.ticket.count.mockResolvedValue(14);
    prismaMock.approvalCategory.count.mockResolvedValue(1);
    prismaMock.avApprovalGroupApprover.count.mockResolvedValue(2);
    prismaMock.ticketApproval.count.mockResolvedValue(0);

    const out = await technicianRepository.looseEnds({ id: 5, email: 'Dana@Example.com' }, 1);

    expect(out).toEqual({ openTickets: 14, categoryManager: 1, availabilityApprover: 2, pendingApprovals: 0 });
    expect(prismaMock.ticket.count.mock.calls[0][0].where.assignedTechId).toBe(5);
    expect(prismaMock.approvalCategory.count.mock.calls[0][0].where).toMatchObject({ workspaceId: 1, managerEmails: { has: 'dana@example.com' } });
  });

  test('a failed read counts as 0, and no e-mail skips the e-mail lookups', async () => {
    prismaMock.ticket.count.mockRejectedValue(new Error('db down'));
    prismaMock.approvalCategory.count.mockClear();
    const out = await technicianRepository.looseEnds({ id: 5, email: null }, 1);
    expect(out).toEqual({ openTickets: 0, categoryManager: 0, availabilityApprover: 0, pendingApprovals: 0 });
    expect(prismaMock.approvalCategory.count).not.toHaveBeenCalled();
  });
});

describe('transformAgent carries FreshService active flag', () => {
  test('active: false stays false; a missing flag reads as active', () => {
    expect(transformAgent({ id: 1, first_name: 'Dana', last_name: 'Whitfield', active: false }, 2).isActive).toBe(false);
    expect(transformAgent({ id: 1, first_name: 'Dana', last_name: 'Whitfield' }, 2).isActive).toBe(true);
  });
});
