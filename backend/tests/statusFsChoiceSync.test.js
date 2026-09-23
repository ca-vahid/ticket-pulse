import { jest } from '@jest/globals';

/**
 * Pending Response build (23 Sep 2026): FreshService's tenant statuses
 * ("Pending response" = 6 on every workspace) bind to registry rows so the
 * name round-trips. IT already had a "Pending Response" row (unbound, so it
 * wrote 3); the other workspaces had none.
 */
const prismaMock = {
  ticketStatusDefinition: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    aggregate: jest.fn().mockResolvedValue({ _max: { sortOrder: 4 } }),
  },
  workspace: { findMany: jest.fn().mockResolvedValue([]) },
  ticket: { count: jest.fn().mockResolvedValue(0) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: statusService } = await import('../src/services/statusService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const CHOICES = [
  { id: 2, value: 'Open' }, { id: 3, value: 'Pending' }, { id: 4, value: 'Resolved' }, { id: 5, value: 'Closed' },
  { id: 6, value: 'Pending response' },
];
const client = { listTicketFormFields: jest.fn().mockResolvedValue([{ name: 'status', choices: CHOICES }]) };
const SYSTEM = ['Open', 'Pending', 'Resolved', 'Closed'].map((name, i) => ({ id: i + 1, name, baseStatus: name, freshserviceStatusId: null }));

describe('statusService.syncFsStatusChoices', () => {
  beforeEach(() => jest.clearAllMocks());

  test('binds an existing row with the same name (IT) — never touches 2–5', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([...SYSTEM, { id: 9, name: 'Pending Response', baseStatus: 'Pending', freshserviceStatusId: null }]);
    const r = await statusService.syncFsStatusChoices(1, client, 2);
    expect(r).toEqual({ detected: 5, bound: 1, created: 0 });
    expect(prismaMock.ticketStatusDefinition.update).toHaveBeenCalledWith({ where: { id: 9 }, data: expect.objectContaining({ freshserviceStatusId: 6 }) });
    expect(prismaMock.ticketStatusDefinition.create).not.toHaveBeenCalled();
  });

  test('creates "Pending Response" (Pending base, bound to 6) where the workspace\'s tickets use it', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(SYSTEM);
    prismaMock.ticket.count.mockResolvedValue(2); // Accounting: 2 tickets still "Waiting on Customer"
    const r = await statusService.syncFsStatusChoices(2, client, 4);
    expect(prismaMock.ticket.count).toHaveBeenCalledWith({ where: { workspaceId: 2, status: { in: ['Pending Response', 'Pending response', 'Waiting on Customer'] } } });
    expect(r.created).toBe(1);
    expect(prismaMock.ticketStatusDefinition.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      workspaceId: 2, name: 'Pending Response', baseStatus: 'Pending', freshserviceStatusId: 6, isSystem: false, isActive: true,
    }) });
  });

  test('a workspace that never uses the status does not get it in its list (IT-only process)', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(SYSTEM);
    prismaMock.ticket.count.mockResolvedValue(0);
    const r = await statusService.syncFsStatusChoices(3, client, 5);
    expect(r).toEqual({ detected: 5, bound: 0, created: 0 });
    expect(prismaMock.ticketStatusDefinition.create).not.toHaveBeenCalled();
  });

  test('an already-bound row is only stamped as seen', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([...SYSTEM, { id: 9, name: 'Pending Response', baseStatus: 'Pending', freshserviceStatusId: 6 }]);
    const r = await statusService.syncFsStatusChoices(1, client, 2);
    expect(r).toEqual({ detected: 5, bound: 0, created: 0 });
    expect(prismaMock.ticketStatusDefinition.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { fsDetectedAt: expect.any(Date) } });
  });

  test('Settings can link a row to a FreshService status, but not to a fixed one or a taken one', async () => {
    prismaMock.ticketStatusDefinition.findFirst
      .mockResolvedValueOnce({ id: 9, workspaceId: 1, name: 'Pending Response', baseStatus: 'Pending', isSystem: false })
      .mockResolvedValueOnce(null);
    prismaMock.$transaction = jest.fn(async (fn) => fn({ ticketStatusDefinition: { update: jest.fn().mockResolvedValue({ id: 9 }) }, ticket: { updateMany: jest.fn() } }));
    await expect(statusService.updateStatus(1, 9, { freshserviceStatusId: 6 }, 'admin@x')).resolves.toBeTruthy();

    prismaMock.ticketStatusDefinition.findFirst.mockResolvedValueOnce({ id: 9, workspaceId: 1, name: 'Pending Response', baseStatus: 'Pending', isSystem: false });
    await expect(statusService.updateStatus(1, 9, { freshserviceStatusId: 3 }, 'admin@x')).rejects.toThrow(ValidationError);

    prismaMock.ticketStatusDefinition.findFirst
      .mockResolvedValueOnce({ id: 9, workspaceId: 1, name: 'Pending Response', baseStatus: 'Pending', isSystem: false })
      .mockResolvedValueOnce({ name: 'Awaiting Requester' });
    await expect(statusService.updateStatus(1, 9, { freshserviceStatusId: 6 }, 'admin@x')).rejects.toThrow(/already linked/);
  });
});
