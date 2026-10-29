import { jest } from '@jest/globals';

/**
 * QA 10-28 — list data behind two Tickets page fixes:
 *  - #2 approval mark: listTickets returns one approval state per row.
 *  - #4 grouped copies are not noise: the Noise & spam view and count leave them out,
 *    and the ticket page learns which ticket a copy was closed into.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  queueCardConfig: { findUnique: jest.fn(), upsert: jest.fn() },
  ticketFormConfig: { findUnique: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
  userPreference: { findUnique: jest.fn(), upsert: jest.fn() },
  customFieldDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketApproval: { findMany: jest.fn() },
  ticketGroupingEvent: { findFirst: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  approvalCategory: { findMany: jest.fn().mockResolvedValue([]) },
  ticketTag: { findMany: jest.fn().mockResolvedValue([]) },
  categoryGroupLink: { findMany: jest.fn().mockResolvedValue([]) },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 7, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 7, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 7, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 7, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  workspaceAccess: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  $queryRaw: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(),
    reconcileTicket: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn(),
  },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({ default: { mergedInto: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));


const { default: ticketService } = await import('../src/services/ticketService.js');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 7, defaultTimezone: 'America/Vancouver' });
});

describe('grouped copies are not noise (QA 10-28 #4)', () => {
  const groupedOut = { OR: [{ noiseRuleMatched: null }, { NOT: { noiseRuleMatched: { startsWith: 'Grouped:' } } }] };

  test('the Noise & spam view leaves grouped copies out, NULL-safely', async () => {
    const where = await ticketService.buildListWhere(7, { noise: 'only' });
    expect(where.isNoise).toBe(true);
    expect(where.AND).toEqual(expect.arrayContaining([groupedOut]));
  });

  test('the Noise card segment does the same', async () => {
    const where = await ticketService.buildListWhere(7, { segment: 'noise' });
    expect(where.isNoise).toBe(true);
    expect(where.AND).toEqual(expect.arrayContaining([groupedOut]));
  });

  test('the default queue is unchanged (no noise at all)', async () => {
    const where = await ticketService.buildListWhere(7, {});
    expect(where.isNoise).toBe(false);
    expect(JSON.stringify(where.AND || [])).not.toContain('Grouped:');
  });

  test('a grouped copy points at the ticket it was closed into', async () => {
    prismaMock.ticketGroupingEvent.findFirst.mockResolvedValue({ targetTicketId: 501, kind: 'duplicate' });
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 501, origin: 'ticketpulse', nativeNumber: 10593, freshserviceTicketId: null });
    await expect(ticketService._groupedInto(502, 7)).resolves.toEqual({ id: 501, displayRef: 'TP-10593', kind: 'duplicate' });
    expect(prismaMock.ticketGroupingEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 7, ticketId: 502, state: 'applied' }),
    }));
  });

  test('no applied event, or a failed read, gives null instead of throwing', async () => {
    prismaMock.ticketGroupingEvent.findFirst.mockResolvedValue(null);
    await expect(ticketService._groupedInto(502, 7)).resolves.toBeNull();
    prismaMock.ticketGroupingEvent.findFirst.mockRejectedValue(new Error('relation missing'));
    await expect(ticketService._groupedInto(502, 7)).resolves.toBeNull();
  });
});

describe('approval state per row (QA 10-28 #2)', () => {
  const at = (s) => new Date(`2026-10-2${s}T12:00:00Z`);

  test('waiting wins over earlier decisions and names who it waits on', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValue([
      { ticketId: 1, status: 'rejected', approverName: 'Dana Whitfield', approverEmail: 'd@x', decidedAt: at(1), createdAt: at(1) },
      { ticketId: 1, status: 'pending', approverName: 'Priya Nair', approverEmail: 'p@x', decidedAt: null, createdAt: at(2) },
    ]);
    const map = await ticketService._approvalStateByTicket([1]);
    expect(map.get(1)).toEqual({ state: 'pending', approvers: ['Priya Nair'], count: 2 });
  });

  test('every waiting row on hold reads as on hold', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValue([
      { ticketId: 2, status: 'info_requested', approverName: null, approverEmail: 'sam@x', decidedAt: null, createdAt: at(2) },
    ]);
    const map = await ticketService._approvalStateByTicket([2]);
    expect(map.get(2)).toMatchObject({ state: 'info_requested', approvers: ['sam@x'] });
  });

  test('with nothing waiting, the latest decision is the state (closed included)', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValue([
      { ticketId: 3, status: 'approved', approverName: 'Priya Nair', approverEmail: 'p@x', decidedAt: at(1), createdAt: at(1) },
      { ticketId: 3, status: 'closed', approverName: 'Sam Okafor', approverEmail: 's@x', decidedAt: at(3), createdAt: at(2) },
    ]);
    const map = await ticketService._approvalStateByTicket([3]);
    expect(map.get(3)).toMatchObject({ state: 'closed', approvers: ['Sam Okafor'], count: 2 });
  });

  test('superseded and cancelled rows are never read; no ids means no query', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValue([]);
    await ticketService._approvalStateByTicket([4]);
    const { where } = prismaMock.ticketApproval.findMany.mock.calls[0][0];
    expect(where.status.in).toEqual(['pending', 'info_requested', 'approved', 'rejected', 'closed']);
    prismaMock.ticketApproval.findMany.mockClear();
    expect((await ticketService._approvalStateByTicket([])).size).toBe(0);
    expect(prismaMock.ticketApproval.findMany).not.toHaveBeenCalled();
  });

  test('a failed read leaves the list without marks instead of failing it', async () => {
    prismaMock.ticketApproval.findMany.mockRejectedValue(new Error('column missing'));
    await expect(ticketService._approvalStateByTicket([5])).resolves.toEqual(new Map());
  });
});
