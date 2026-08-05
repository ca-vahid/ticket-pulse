import { jest } from '@jest/globals';

/**
 * Per-workspace ticket-status registry (QA 08-04 #12, Phase 8a): cached
 * lookups with canonical fallback, base-status resolution, and the Settings
 * CRUD rules — rename relabels tickets transactionally, system rows keep
 * their base and can't be retired, retire-don't-delete.
 */

const txMock = {
  ticketStatusDefinition: { update: jest.fn() },
  ticket: { updateMany: jest.fn() },
};
const prismaMock = {
  ticketStatusDefinition: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn(),
  },
  ticket: { updateMany: jest.fn() },
  $transaction: jest.fn(async (fn) => fn(txMock)),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: statusService, invalidateStatusCache, BASE_STATUSES } = await import('../src/services/statusService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const WS1_ROWS = [
  { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
  { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true, isActive: true },
  { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true, isActive: true },
  { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true, isActive: true },
  { id: 5, workspaceId: 1, name: 'Waiting on vendor', baseStatus: 'Pending', color: 'violet', sortOrder: 4, isSystem: false, isActive: true },
  { id: 6, workspaceId: 1, name: 'Needs Rework', baseStatus: 'Open', color: 'orange', sortOrder: 5, isSystem: false, isActive: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  invalidateStatusCache();
  prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(WS1_ROWS);
  prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
  txMock.ticket.updateMany.mockResolvedValue({ count: 0 });
  txMock.ticketStatusDefinition.update.mockImplementation(({ data }) => Promise.resolve({ ...WS1_ROWS[4], ...data }));
  prismaMock.$transaction.mockImplementation(async (fn) => fn(txMock));
});

describe('registry reads + cache', () => {
  test('listStatuses returns active rows by default, everything with includeInactive', async () => {
    const active = await statusService.listStatuses(1);
    expect(active.map((r) => r.name)).toEqual(['Open', 'Pending', 'Resolved', 'Closed', 'Waiting on vendor']);
    const all = await statusService.listStatuses(1, { includeInactive: true });
    expect(all).toHaveLength(6);
  });

  test('second read within the TTL is served from cache (one DB query)', async () => {
    await statusService.listStatuses(1);
    await statusService.listStatuses(1, { includeInactive: true });
    expect(prismaMock.ticketStatusDefinition.findMany).toHaveBeenCalledTimes(1);
  });

  test('invalidateStatusCache forces a re-read', async () => {
    await statusService.listStatuses(1);
    invalidateStatusCache(1);
    await statusService.listStatuses(1);
    expect(prismaMock.ticketStatusDefinition.findMany).toHaveBeenCalledTimes(2);
  });

  test('falls back to the 4 canonical statuses when the registry is empty (pre-seed workspace)', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([]);
    const rows = await statusService.listStatuses(9);
    expect(rows.map((r) => r.name)).toEqual(BASE_STATUSES);
    expect(rows.every((r) => r.isSystem && r.isActive)).toBe(true);
  });

  test('falls back to the 4 canonical statuses when the registry is unreadable (down migration / mocked prisma)', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockRejectedValue(new Error('relation does not exist'));
    const rows = await statusService.listStatuses(9);
    expect(rows.map((r) => r.name)).toEqual(BASE_STATUSES);
  });
});

describe('baseStatusOf', () => {
  test('resolves definitions case-insensitively, including inactive (retired labels linger on tickets)', async () => {
    expect(await statusService.baseStatusOf(1, 'waiting on VENDOR')).toBe('Pending');
    expect(await statusService.baseStatusOf(1, 'Needs Rework')).toBe('Open'); // inactive row
  });

  test('exact canonical names map to themselves even without a definition row', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([
      { id: 7, workspaceId: 2, name: 'Case Open', baseStatus: 'Open', sortOrder: 0, isSystem: false, isActive: true },
    ]);
    expect(await statusService.baseStatusOf(2, 'Resolved')).toBe('Resolved');
  });

  test('unknown labels return null (legacy free-text like "Deleted")', async () => {
    expect(await statusService.baseStatusOf(1, 'Deleted')).toBeNull();
    expect(await statusService.baseStatusOf(1, '')).toBeNull();
    expect(await statusService.baseStatusOf(1, null)).toBeNull();
  });
});

describe('statusNamesForBase / normalizeStatusName / assertValidStatus', () => {
  test('statusNamesForBase accepts a single base or an array, active rows only', async () => {
    expect(await statusService.statusNamesForBase(1, 'Pending')).toEqual(['Pending', 'Waiting on vendor']);
    expect(await statusService.statusNamesForBase(1, ['Open', 'Pending']))
      .toEqual(['Open', 'Pending', 'Waiting on vendor']); // Needs Rework is retired
  });

  test('normalizeStatusName returns the canonical-cased name for active rows, null otherwise', async () => {
    expect(await statusService.normalizeStatusName(1, '  WAITING ON VENDOR ')).toBe('Waiting on vendor');
    expect(await statusService.normalizeStatusName(1, 'Needs Rework')).toBeNull(); // retired
    expect(await statusService.normalizeStatusName(1, 'Nope')).toBeNull();
  });

  test('assertValidStatus returns the canonical name or throws naming the valid values', async () => {
    expect(await statusService.assertValidStatus(1, 'resolved')).toBe('Resolved');
    await expect(statusService.assertValidStatus(1, 'Bogus')).rejects.toThrow(
      /Status must be one of: Open, Pending, Resolved, Closed, Waiting on vendor/,
    );
  });

  test('assertValidStatus matches the legacy NATIVE_TICKET_STATUSES behavior when only system rows exist', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(WS1_ROWS.slice(0, 4));
    await expect(statusService.assertValidStatus(3, 'Weird')).rejects.toThrow(
      'Status must be one of: Open, Pending, Resolved, Closed',
    );
  });
});

describe('CRUD', () => {
  test('createStatus validates base, defaults sortOrder to max+1, and invalidates the cache', async () => {
    await statusService.listStatuses(1); // prime cache
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(WS1_ROWS.map((r) => ({ id: r.id, name: r.name })));
    prismaMock.ticketStatusDefinition.aggregate.mockResolvedValue({ _max: { sortOrder: 5 } });
    prismaMock.ticketStatusDefinition.create.mockImplementation(({ data }) => Promise.resolve({ id: 7, ...data }));

    const created = await statusService.createStatus(1, { name: 'On hold', baseStatus: 'Pending', color: 'cyan' }, 'admin@x.io');

    expect(prismaMock.ticketStatusDefinition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 1, name: 'On hold', baseStatus: 'Pending', color: 'cyan', sortOrder: 6, isSystem: false, isActive: true,
      }),
    });
    expect(created.name).toBe('On hold');
    // Cache was invalidated by the write.
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(WS1_ROWS);
    await statusService.listStatuses(1);
    expect(prismaMock.ticketStatusDefinition.findMany.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test('createStatus rejects bad bases, long/empty names, bad colors, and duplicate names (case-insensitive)', async () => {
    await expect(statusService.createStatus(1, { name: 'X', baseStatus: 'Sideways' }))
      .rejects.toThrow(/baseStatus must be one of/);
    await expect(statusService.createStatus(1, { name: '', baseStatus: 'Open' }))
      .rejects.toThrow(/name is required/);
    await expect(statusService.createStatus(1, { name: 'y'.repeat(51), baseStatus: 'Open' }))
      .rejects.toThrow(/max 50 chars/);
    await expect(statusService.createStatus(1, { name: 'Z', baseStatus: 'Open', color: 'chartreuse' }))
      .rejects.toThrow(/color must be one of/);
    await expect(statusService.createStatus(1, { name: 'waiting ON vendor', baseStatus: 'Open' }))
      .rejects.toThrow(/already exists/);
  });

  test('rename relabels the workspace tickets carrying the old name, in the same transaction', async () => {
    prismaMock.ticketStatusDefinition.findFirst.mockResolvedValue(WS1_ROWS[4]); // Waiting on vendor
    txMock.ticket.updateMany.mockResolvedValue({ count: 12 });

    await statusService.updateStatus(1, 5, { name: 'Waiting on supplier' }, 'admin@x.io');

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.ticketStatusDefinition.update).toHaveBeenCalledWith({
      where: { id: 5 }, data: { name: 'Waiting on supplier' },
    });
    expect(txMock.ticket.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 1, status: 'Waiting on vendor' },
      data: { status: 'Waiting on supplier' },
    });
  });

  test('recolor/reorder never touch tickets', async () => {
    prismaMock.ticketStatusDefinition.findFirst.mockResolvedValue(WS1_ROWS[4]);

    await statusService.updateStatus(1, 5, { color: 'pink', sortOrder: 2 });

    expect(txMock.ticketStatusDefinition.update).toHaveBeenCalledWith({
      where: { id: 5 }, data: { color: 'pink', sortOrder: 2 },
    });
    expect(txMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  test('rename to a name another row holds is rejected', async () => {
    prismaMock.ticketStatusDefinition.findFirst.mockResolvedValue(WS1_ROWS[4]);
    await expect(statusService.updateStatus(1, 5, { name: 'PENDING' })).rejects.toThrow(/already exists/);
  });

  test('base change is blocked on system rows and needs an explicit confirm on custom rows', async () => {
    prismaMock.ticketStatusDefinition.findFirst.mockResolvedValue(WS1_ROWS[0]); // system Open
    await expect(statusService.updateStatus(1, 1, { baseStatus: 'Pending' }))
      .rejects.toThrow(/system status/);

    prismaMock.ticketStatusDefinition.findFirst.mockResolvedValue(WS1_ROWS[4]);
    await expect(statusService.updateStatus(1, 5, { baseStatus: 'Open' }))
      .rejects.toThrow(/confirmBaseChange/);

    await statusService.updateStatus(1, 5, { baseStatus: 'Open', confirmBaseChange: true });
    expect(txMock.ticketStatusDefinition.update).toHaveBeenCalledWith({
      where: { id: 5 }, data: { baseStatus: 'Open' },
    });
  });

  test('deactivate retires custom rows but refuses system rows; reactivate restores', async () => {
    prismaMock.ticketStatusDefinition.findFirst.mockResolvedValue(WS1_ROWS[2]); // system Resolved
    await expect(statusService.deactivateStatus(1, 3)).rejects.toThrow(ValidationError);
    await expect(statusService.deactivateStatus(1, 3)).rejects.toThrow(/cannot be deactivated/);

    prismaMock.ticketStatusDefinition.findFirst.mockResolvedValue(WS1_ROWS[4]);
    prismaMock.ticketStatusDefinition.update.mockImplementation(({ data }) => Promise.resolve({ ...WS1_ROWS[4], ...data }));
    const retired = await statusService.deactivateStatus(1, 5, 'admin@x.io');
    expect(prismaMock.ticketStatusDefinition.update).toHaveBeenCalledWith({
      where: { id: 5 }, data: { isActive: false },
    });
    expect(retired.isActive).toBe(false);

    prismaMock.ticketStatusDefinition.findFirst.mockResolvedValue({ ...WS1_ROWS[4], isActive: false });
    const back = await statusService.reactivateStatus(1, 5, 'admin@x.io');
    expect(prismaMock.ticketStatusDefinition.update).toHaveBeenLastCalledWith({
      where: { id: 5 }, data: { isActive: true },
    });
    expect(back.isActive).toBe(true);
  });

  test('there is no hard delete on the service', () => {
    expect(statusService.deleteStatus).toBeUndefined();
    expect(statusService.removeStatus).toBeUndefined();
  });
});

describe('resolveBaseStatus / heuristicBaseStatus (Phase 8c)', () => {
  test('registry labels resolve to their configured base (custom + retired rows)', async () => {
    expect(await statusService.resolveBaseStatus(1, 'Waiting on vendor')).toBe('Pending');
    expect(await statusService.resolveBaseStatus(1, 'needs rework')).toBe('Open'); // inactive rows still resolve
  });

  test('registry-unknown labels fall back to FS ints and substrings', async () => {
    const { heuristicBaseStatus } = await import('../src/services/statusService.js');
    expect(await statusService.resolveBaseStatus(1, '4')).toBe('Resolved'); // raw FS code
    expect(await statusService.resolveBaseStatus(1, 'Waiting on Customer')).toBe('Pending');
    expect(await statusService.resolveBaseStatus(1, 'On Hold')).toBe('Pending');
    expect(heuristicBaseStatus('2')).toBe('Open');
    expect(heuristicBaseStatus('In Progress')).toBe('Open');
    expect(heuristicBaseStatus('Auto-Closed')).toBe('Closed');
  });

  test('truly unknown labels return null (Deleted/Spam never get a base)', async () => {
    expect(await statusService.resolveBaseStatus(1, 'Deleted')).toBeNull();
    expect(await statusService.resolveBaseStatus(1, 'Spam')).toBeNull();
    expect(await statusService.resolveBaseStatus(1, '')).toBeNull();
    expect(await statusService.resolveBaseStatus(1, null)).toBeNull();
  });
});
