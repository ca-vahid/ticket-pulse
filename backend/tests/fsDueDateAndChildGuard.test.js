import { jest } from '@jest/globals';

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  queueCardConfig: { findUnique: jest.fn() },
  ticketFormConfig: { findUnique: jest.fn() },
  customFieldDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  approvalCategory: { findMany: jest.fn().mockResolvedValue([]) },
  ticketTag: { findMany: jest.fn().mockResolvedValue([]) },
  categoryGroupLink: { findMany: jest.fn().mockResolvedValue([]) },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  workspaceAccess: { findMany: jest.fn().mockResolvedValue([]) },
  assignmentConfig: { findUnique: jest.fn().mockResolvedValue(null) },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
  assignmentPipelineRun: { findFirst: jest.fn() },
  ticketHandBack: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  teamForward: { findMany: jest.fn().mockResolvedValue([]) },
  $queryRaw: jest.fn(),
};

const queueReboundRunMock = jest.fn().mockResolvedValue({ outcome: 'queued' });
const ticketActivityCreate = jest.fn().mockResolvedValue({});
const fsClientMock = { updateTicketFields: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: ticketActivityCreate } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(),
    getClient: jest.fn(), getInteractiveClient: jest.fn(async () => fsClientMock), resolveDepartmentId: jest.fn(),
  },
}));
const assertNoOpenFsChildren = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/services/fsTicketRelationService.js', () => ({
  assertNoOpenFsChildren,
  syncFsRelations: jest.fn(),
  default: { assertNoOpenFsChildren },
}));
jest.unstable_mockModule('../src/services/ticketRollUpService.js', () => ({
  default: { afterChildStatusChange: jest.fn(), recomputeReadiness: jest.fn() },
}));
jest.unstable_mockModule('../src/services/reboundRunService.js', () => ({
  queueReboundRun: queueReboundRunMock,
  reboundPrecheck: jest.fn(),
  default: { queueReboundRun: queueReboundRunMock },
}));


const { default: ticketService } = await import('../src/services/ticketService.js');
const { ValidationError, ConflictError } = await import('../src/utils/errors.js');

// 29 Sep 2026: FS-born resolution due write-back + the open-children close guard.
const actor = { email: 'cora@x.io', name: 'Cora Coordinator', technicianId: 2, kind: 'member' };
const fsTicket = {
  id: 601, workspaceId: 1, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: BigInt(241813),
  subject: 'Departure', status: 'Open', priority: 2, isNoise: false,
  createdAt: new Date('2026-09-11T20:20:25Z'), dueBy: new Date('2026-09-26T01:00:00Z'), frDueBy: new Date('2026-09-25T16:00:00Z'),
  assignedTechId: 3, assignedTech: { id: 3, name: 'Ava' }, requester: null, internalCategory: null, internalSubcategory: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true });
  prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
  prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...fsTicket, ...data }));
  assertNoOpenFsChildren.mockResolvedValue(undefined);
});

describe('updateFsTicket — resolution due', () => {
  test('writes due_by to FreshService first, then stores the echoed date as a manual due', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ due_by: '2026-10-02T23:59:00Z', updated_at: '2026-09-29T20:00:00Z' });
    const out = await ticketService.updateFsTicket(601, 1, { dueBy: '2026-10-02T23:59:00.000Z' }, actor);
    expect(fsClientMock.updateTicketFields).toHaveBeenCalledWith(241813, { due_by: '2026-10-02T23:59:00.000Z' });
    const data = prismaMock.ticket.update.mock.calls[0][0].data;
    expect(data.dueBy.toISOString()).toBe('2026-10-02T23:59:00.000Z');
    expect(data.dueBySetBy).toBe('manual');
    expect(out.synced).toEqual(['dueBy']);
  });

  test('FreshService keeping a different date is a refusal; nothing changes locally', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ due_by: '2026-09-26T01:00:00Z', updated_at: '2026-09-29T20:00:00Z' });
    await expect(ticketService.updateFsTicket(601, 1, { dueBy: '2026-10-02T23:59:00Z' }, actor)).rejects.toThrow(/resolution due/);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('removing, invalid and before-creation dates are refused before FreshService is touched', async () => {
    await expect(ticketService.updateFsTicket(601, 1, { dueBy: null }, actor)).rejects.toThrow(ValidationError);
    await expect(ticketService.updateFsTicket(601, 1, { dueBy: 'next tuesday' }, actor)).rejects.toThrow(ValidationError);
    await expect(ticketService.updateFsTicket(601, 1, { dueBy: '2026-09-01T00:00:00Z' }, actor)).rejects.toThrow(/after the ticket was created/);
    expect(fsClientMock.updateTicketFields).not.toHaveBeenCalled();
  });

  test('the same date again is a no-op', async () => {
    const out = await ticketService.updateFsTicket(601, 1, { dueBy: '2026-09-26T01:00:00Z' }, actor);
    expect(out.noChanges).toBe(true);
    expect(fsClientMock.updateTicketFields).not.toHaveBeenCalled();
  });
});

describe('updateFsTicket — open FreshService children block resolve/close', () => {
  test('closing asks FreshService about children first; open children stop the write', async () => {
    const err = new ConflictError('FreshService will not close this ticket while 2 child tickets are still open: #241814 (Open), #241815 (Pending). Resolve or close them first.');
    err.code = 'open_children';
    assertNoOpenFsChildren.mockRejectedValueOnce(err);
    await expect(ticketService.updateFsTicket(601, 1, { status: 'Closed' }, actor)).rejects.toThrow('#241814 (Open)');
    expect(assertNoOpenFsChildren).toHaveBeenCalledWith(expect.objectContaining({ id: 601 }), 1, fsClientMock);
    expect(fsClientMock.updateTicketFields).not.toHaveBeenCalled();
  });

  test('no open children: the close goes through', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ status: 5, updated_at: '2026-09-29T20:00:00Z' });
    await ticketService.updateFsTicket(601, 1, { status: 'Closed' }, actor);
    expect(assertNoOpenFsChildren).toHaveBeenCalledTimes(1);
    expect(fsClientMock.updateTicketFields).toHaveBeenCalledWith(241813, { status: 5 });
  });

  test('non-terminal status changes never ask', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ status: 3, updated_at: '2026-09-29T20:00:00Z' });
    await ticketService.updateFsTicket(601, 1, { status: 'Pending' }, actor);
    expect(assertNoOpenFsChildren).not.toHaveBeenCalled();
  });
});
