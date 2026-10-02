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
  assignmentPipelineRun: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  ticketHandBack: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  teamForward: { findMany: jest.fn().mockResolvedValue([]) },
  $queryRaw: jest.fn(),
};

const queueReboundRunMock = jest.fn().mockResolvedValue({ outcome: 'queued' });
const ticketActivityCreate = jest.fn().mockResolvedValue({});
const fsClientMock = { updateTicketFields: jest.fn(), deleteTicket: jest.fn() };

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
const sseBroadcast = jest.fn();
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: sseBroadcast } }));
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
const { default: mirrorService } = await import('../src/services/mirrorService.js');
const { ValidationError, NotFoundError, ServiceBusyError } = await import('../src/utils/errors.js');

// 2 Oct 2026: "Delete in FreshService" for FS-born tickets.
const actor = { email: 'rae@x.io', name: 'Rae Reviewer', technicianId: 2, kind: 'member', workspaceRole: 'reviewer' };
const fsTicket = {
  id: 701, workspaceId: 1, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: BigInt(243555),
  subject: 'Printer jam', status: 'Open', priority: 2, isNoise: false, assignedTechId: 3,
  assignedTech: { id: 3, name: 'Ava' }, requester: null, internalCategory: null, internalSubcategory: null,
};

function fsError(status, description) {
  const err = new Error(`FreshService API error: ${description}`);
  err.freshserviceStatus = status;
  err.freshserviceDetail = { description };
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
  mirrorService.getInteractiveClient.mockImplementation(async () => fsClientMock);
  prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
  prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...fsTicket, ...data }));
  prismaMock.assignmentPipelineRun.updateMany.mockResolvedValue({ count: 0 });
  fsClientMock.deleteTicket.mockResolvedValue({ id: 243555, deleted: true });
});

describe('deleteFsTicketInFreshService', () => {
  test('deletes in FreshService with the FS id, then marks the row Deleted, audits and broadcasts', async () => {
    const order = [];
    fsClientMock.deleteTicket.mockImplementation(async () => { order.push('fs'); return { id: 243555, deleted: true }; });
    prismaMock.ticket.update.mockImplementation(({ data }) => { order.push('db'); return Promise.resolve({ ...fsTicket, ...data }); });

    const out = await ticketService.deleteFsTicketInFreshService(701, 1, actor);

    expect(mirrorService.getInteractiveClient).toHaveBeenCalledWith(1);
    expect(fsClientMock.deleteTicket).toHaveBeenCalledWith(243555);
    expect(order[0]).toBe('fs');
    const statusWrite = prismaMock.ticket.update.mock.calls.find((c) => c[0].data.status === 'Deleted');
    expect(statusWrite[0].where).toEqual({ id: 701 });
    expect(out.status).toBe('Deleted');
    expect(out.deleted).toBe(true);
    expect(out.alreadyGone).toBe(false);
    // Same side effects as a sync-observed FS deletion.
    expect(prismaMock.assignmentPipelineRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketId: 701, status: 'queued' }, data: expect.objectContaining({ status: 'skipped_stale' }),
    }));
    expect(prismaMock.assignmentPipelineRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketId: 701, status: 'completed', decision: 'pending_review' }, data: expect.objectContaining({ status: 'superseded' }),
    }));
    const audit = ticketActivityCreate.mock.calls.find((c) => c[0].activityType === 'status_changed')[0];
    expect(audit.performedBy).toBe('Rae Reviewer');
    expect(audit.details).toEqual(expect.objectContaining({
      oldStatus: 'Open', newStatus: 'Deleted', deletedInFreshService: true, freshserviceTicketId: 243555,
    }));
    expect(audit.details.note).toMatch(/Deleted in FreshService from Ticket Pulse by Rae Reviewer/);
    expect(sseBroadcast).toHaveBeenCalledWith('ticket-change', expect.objectContaining({ action: 'deleted', ticketId: 701, status: 'Deleted' }), 1);
  });

  test('FreshService 404/405 (already gone) is treated as deleted', async () => {
    fsClientMock.deleteTicket.mockResolvedValue({ id: 243555, deleted: true, alreadyGone: true });
    const out = await ticketService.deleteFsTicketInFreshService(701, 1, actor);
    expect(out.status).toBe('Deleted');
    expect(out.alreadyGone).toBe(true);
    const audit = ticketActivityCreate.mock.calls.find((c) => c[0].activityType === 'status_changed')[0];
    expect(audit.details.note).toMatch(/already gone in FreshService/);
  });

  test('a FreshService refusal changes nothing locally and surfaces the FS reason', async () => {
    fsClientMock.deleteTicket.mockRejectedValue(fsError(403, 'You are not authorized to perform this action'));
    await expect(ticketService.deleteFsTicketInFreshService(701, 1, actor))
      .rejects.toThrow(/FreshService refused the delete — You are not authorized to perform this action\. Nothing was changed/);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.updateMany).not.toHaveBeenCalled();
    expect(ticketActivityCreate).not.toHaveBeenCalled();
    expect(sseBroadcast).not.toHaveBeenCalled();
  });

  test('a FreshService 5xx is a 502 and changes nothing', async () => {
    fsClientMock.deleteTicket.mockRejectedValue(fsError(500, 'Internal error'));
    const err = await ticketService.deleteFsTicketInFreshService(701, 1, actor).catch((e) => e);
    expect(err.statusCode).toBe(502);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('a rate-limit queue timeout is the honest busy 503', async () => {
    fsClientMock.deleteTicket.mockRejectedValue(Object.assign(new Error('rate-limit queue wait exceeded'), { code: 'FS_QUEUE_TIMEOUT' }));
    await expect(ticketService.deleteFsTicketInFreshService(701, 1, actor)).rejects.toThrow(ServiceBusyError);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('a TP-born ticket is refused, pointing at the normal delete', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket, origin: 'ticketpulse', nativeNumber: 1200 });
    await expect(ticketService.deleteFsTicketInFreshService(701, 1, actor)).rejects.toThrow(ValidationError);
    await expect(ticketService.deleteFsTicketInFreshService(701, 1, actor)).rejects.toThrow(/Delete ticket/);
    expect(fsClientMock.deleteTicket).not.toHaveBeenCalled();
  });

  test('an already-Deleted ticket is idempotent — no second FreshService call', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket, status: 'Deleted' });
    const out = await ticketService.deleteFsTicketInFreshService(701, 1, actor);
    expect(out.alreadyDeleted).toBe(true);
    expect(fsClientMock.deleteTicket).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('unknown ticket is 404; no FreshService configured is a clear refusal', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(null);
    await expect(ticketService.deleteFsTicketInFreshService(999, 1, actor)).rejects.toThrow(NotFoundError);
    mirrorService.getInteractiveClient.mockResolvedValueOnce(null);
    await expect(ticketService.deleteFsTicketInFreshService(701, 1, actor)).rejects.toThrow(/not configured/);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });
});

describe('bulkDeleteTickets — mixed selection', () => {
  const rows = [
    { id: 11, origin: 'ticketpulse', nativeNumber: 1201, freshserviceTicketId: BigInt(250001) },
    { id: 12, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: BigInt(243001) },
    { id: 13, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: BigInt(243002) },
    { id: 14, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: BigInt(243003) },
  ];
  let tpSpy;
  let fsSpy;
  beforeEach(() => {
    prismaMock.ticket.findMany.mockResolvedValue(rows);
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, nativeTicketingEnabled: true });
    tpSpy = jest.spyOn(ticketService, 'deleteTicket').mockResolvedValue({ deleted: true });
    fsSpy = jest.spyOn(ticketService, 'deleteFsTicketInFreshService');
  });
  afterEach(() => { tpSpy.mockRestore(); fsSpy.mockRestore(); });

  test('runs strictly one at a time in the given order, TP via the TP delete and FS via FreshService', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];
    const slow = (label) => async () => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); order.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1; order.push(`end:${label}`);
      return { deleted: true };
    };
    tpSpy.mockImplementation((id) => slow(`tp${id}`)());
    fsSpy.mockImplementation((id) => slow(`fs${id}`)());

    const results = await ticketService.bulkDeleteTickets([12, 11, 13, 14], 1, actor);

    expect(maxInFlight).toBe(1);
    expect(order).toEqual(['start:fs12', 'end:fs12', 'start:tp11', 'end:tp11', 'start:fs13', 'end:fs13', 'start:fs14', 'end:fs14']);
    expect(tpSpy).toHaveBeenCalledWith(11, 1, actor);
    expect(fsSpy.mock.calls.map((c) => c[0])).toEqual([12, 13, 14]);
    expect(results).toEqual([
      { id: 12, ref: '#243001', origin: 'freshservice', ok: true },
      { id: 11, ref: 'TP-1201', origin: 'ticketpulse', ok: true },
      { id: 13, ref: '#243002', origin: 'freshservice', ok: true },
      { id: 14, ref: '#243003', origin: 'freshservice', ok: true },
    ]);
  });

  test('a failure is recorded and the rest still run', async () => {
    fsSpy.mockImplementation(async (id) => {
      if (id === 13) throw new ValidationError('FreshService refused the delete — locked. Nothing was changed in Ticket Pulse.');
      return { deleted: true };
    });
    const results = await ticketService.bulkDeleteTickets([12, 13, 14, 99], 1, actor);
    expect(fsSpy.mock.calls.map((c) => c[0])).toEqual([12, 13, 14]);
    expect(results).toEqual([
      { id: 12, ref: '#243001', origin: 'freshservice', ok: true },
      { id: 13, ref: '#243002', origin: 'freshservice', ok: false, error: 'FreshService refused the delete — locked. Nothing was changed in Ticket Pulse.' },
      { id: 14, ref: '#243003', origin: 'freshservice', ok: true },
      { id: 99, ref: '#99', origin: null, ok: false, error: 'Ticket not found in this workspace' },
    ]);
  });

  test('TP-born tickets fail (per ticket) when native ticketing is off; FS-born ones still go', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, nativeTicketingEnabled: false });
    fsSpy.mockResolvedValue({ deleted: true });
    const results = await ticketService.bulkDeleteTickets([11, 12], 1, actor);
    expect(tpSpy).not.toHaveBeenCalled();
    expect(results[0]).toEqual({ id: 11, ref: 'TP-1201', origin: 'ticketpulse', ok: false, error: 'Native ticketing is not enabled for this workspace' });
    expect(results[1].ok).toBe(true);
  });

  test('already deleted / already gone are reported as successes with a marker', async () => {
    tpSpy.mockResolvedValue({ deleted: true, alreadyDeleted: true });
    fsSpy.mockResolvedValue({ deleted: true, alreadyGone: true });
    const results = await ticketService.bulkDeleteTickets([11, 12], 1, actor);
    expect(results).toEqual([
      { id: 11, ref: 'TP-1201', origin: 'ticketpulse', ok: true, alreadyDeleted: true },
      { id: 12, ref: '#243001', origin: 'freshservice', ok: true, alreadyGone: true },
    ]);
  });
});
