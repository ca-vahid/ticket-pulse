import { jest } from '@jest/globals';

/**
 * QA 09-25 items 3 + 6.
 *  - Hand-back reasons: validation, TP-born episode 'rejected' + rejectionCount
 *    + stored reason + shared rebound helper; coordinator "Skip" stays a
 *    plain release; FS-born unassign records a pending row.
 *  - FS group-membership refusal names the person and the group.
 *  - Assignable-only people: in getMeta with a flag, accepted by validation.
 */

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
jest.unstable_mockModule('../src/services/ticketRollUpService.js', () => ({
  default: { afterChildStatusChange: jest.fn(), recomputeReadiness: jest.fn() },
}));
jest.unstable_mockModule('../src/services/reboundRunService.js', () => ({
  queueReboundRun: queueReboundRunMock,
  reboundPrecheck: jest.fn(),
  default: { queueReboundRun: queueReboundRunMock },
}));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { default: ticketHandBackService, normalizeHandBack, describeNext, parseRangeBound } = await import('../src/services/ticketHandBackService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const agent = { email: 'terry@x.io', name: 'Terry Tech', technicianId: 7, kind: 'agent' };
const coordinator = { email: 'cora@x.io', name: 'Cora Coordinator', technicianId: 2, kind: 'member' };

const tpTicket = {
  id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null,
  subject: 'Printer', status: 'Open', priority: 3, isNoise: false, createdAt: new Date('2026-09-01T10:00:00Z'),
  assignedTechId: 7, assignedTech: { id: 7, name: 'Terry Tech' }, firstAssignedAt: new Date('2026-09-01T11:00:00Z'),
  requester: null, internalCategory: null, internalSubcategory: null,
};

function armTp() {
  jest.clearAllMocks();
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true });
  prismaMock.ticket.findFirst.mockResolvedValue({ ...tpTicket });
  prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...tpTicket, ...data, assignedTechId: null, assignedTech: null }));
  prismaMock.ticketAssignmentEpisode.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValue({ id: 88, startMethod: 'self_picked' });
  prismaMock.ticketAssignmentEpisode.count.mockResolvedValue(1);
  prismaMock.ticketHandBack.create.mockResolvedValue({ id: 5 });
  queueReboundRunMock.mockResolvedValue({ outcome: 'queued' });
}

describe('normalizeHandBack', () => {
  test('absent → null; known codes pass; notes trimmed', () => {
    expect(normalizeHandBack(undefined)).toBeNull();
    expect(normalizeHandBack({ code: 'location', note: '  on site  ' })).toEqual({ code: 'location', note: 'on site' });
    expect(normalizeHandBack({ code: 'capacity' })).toEqual({ code: 'capacity', note: null });
  });
  test('unknown code and Other without a note are refused', () => {
    expect(() => normalizeHandBack({ code: 'lazy' })).toThrow(ValidationError);
    expect(() => normalizeHandBack({ code: 'other', note: '  ' })).toThrow(/note/);
    expect(() => normalizeHandBack('capacity')).toThrow(ValidationError);
  });
  test('skipped never keeps a note', () => {
    expect(normalizeHandBack({ code: 'skipped', note: 'x' })).toEqual({ code: 'skipped', note: null });
  });
});

describe('assignTicket — TP-born hand-back', () => {
  beforeEach(armTp);

  test('the assignee handing back with a reason: rejected episode, count++, row kept, rebound queued with reason', async () => {
    await ticketService.assignTicket(501, 1, null, agent, { handBack: { code: 'location', note: 'Needs someone in Calgary' } });

    expect(prismaMock.ticketAssignmentEpisode.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ endMethod: 'rejected' }),
    }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ assignedTechId: null, rejectionCount: { increment: 1 } }),
    }));
    expect(prismaMock.ticketHandBack.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ticketId: 501, technicianId: 7, actorTechId: 7, selfHandBack: true,
        reasonCode: 'location', reasonNote: 'Needs someone in Calgary', origin: 'ticketpulse', episodeId: 88,
      }),
    });
    expect(queueReboundRunMock).toHaveBeenCalledTimes(1);
    const args = queueReboundRunMock.mock.calls[0][0];
    expect(args.ticketId).toBe(501);
    expect(args.reboundFrom).toEqual(expect.objectContaining({
      previousTechId: 7, previousTechName: 'Terry Tech', source: 'ticketpulse', reboundCount: 1,
      reason: { code: 'location', label: 'Location issue', note: 'Needs someone in Calgary' },
    }));
    // the run id lands on the hand-back row once known
    prismaMock.ticketHandBack.update.mockResolvedValue({});
    await args.onRun({ id: 321 });
    expect(prismaMock.ticketHandBack.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { pipelineRunId: 321 } });
    expect(ticketActivityCreate).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ note: 'Handed back — Location issue' }),
    }));
  });

  test('a coordinator clearing someone else with Skip: plain release, skipped row, no rebound', async () => {
    await ticketService.assignTicket(501, 1, null, coordinator, { handBack: { code: 'skipped' } });

    expect(prismaMock.ticketAssignmentEpisode.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ endMethod: 'reassigned' }),
    }));
    expect(prismaMock.ticket.update.mock.calls[0][0].data.rejectionCount).toBeUndefined();
    expect(prismaMock.ticketHandBack.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reasonCode: 'skipped', selfHandBack: false, actorTechId: 2 }),
    });
    expect(queueReboundRunMock).not.toHaveBeenCalled();
  });

  test('a coordinator giving a real reason counts as a hand-back', async () => {
    await ticketService.assignTicket(501, 1, null, coordinator, { handBack: { code: 'competency' } });
    expect(prismaMock.ticketAssignmentEpisode.updateMany.mock.calls[0][0].data.endMethod).toBe('rejected');
    expect(queueReboundRunMock).toHaveBeenCalledTimes(1);
  });

  test('a bad reason is refused before anything changes', async () => {
    await expect(ticketService.assignTicket(501, 1, null, agent, { handBack: { code: 'other' } })).rejects.toThrow(ValidationError);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    expect(prismaMock.ticketAssignmentEpisode.updateMany).not.toHaveBeenCalled();
  });

  test('a resolved ticket keeps the reason but queues no rebound', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...tpTicket, status: 'Resolved' });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...tpTicket, status: 'Resolved', ...data }));
    await ticketService.assignTicket(501, 1, null, agent, { handBack: { code: 'capacity' } });
    expect(prismaMock.ticketHandBack.create).toHaveBeenCalled();
    expect(queueReboundRunMock).not.toHaveBeenCalled();
  });

  test('bulk release passes one reason to every ticket and validates it once', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 501, origin: 'ticketpulse', status: 'Open', nativeNumber: 1042 }]);
    const spy = jest.spyOn(ticketService, 'assignTicket');
    await ticketService.bulkByQuery(1, { query: {}, action: { type: 'assign', value: null, handBack: { code: 'capacity' } } }, coordinator);
    expect(spy).toHaveBeenCalledWith(501, 1, null, coordinator, { handBack: { code: 'capacity' }, allowAssignableOnly: true });
    await expect(ticketService.bulkByQuery(1, { query: {}, action: { type: 'assign', value: null, handBack: { code: 'nope' } } }, coordinator))
      .rejects.toThrow(ValidationError);
    spy.mockRestore();
  });
});

describe('updateFsTicket — FS-born hand-back + group refusal', () => {
  const fsTicket = {
    ...tpTicket, id: 601, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: BigInt(231309), groupId: BigInt(1000210021),
    assignedTechId: 3, assignedTech: { id: 3, name: 'Ava Original' },
  };
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true });
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...fsTicket, ...data }));
    prismaMock.ticketHandBack.create.mockResolvedValue({ id: 9 });
  });

  test('unassign with a reason records a pending FS row (sync attaches the episode later)', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ responder_id: null, updated_at: '2026-09-25T10:00:00Z' });
    await ticketService.updateFsTicket(601, 1, { assignedTechId: null, handBack: { code: 'capacity', note: 'Full week' } }, { ...agent, technicianId: 3 });
    expect(prismaMock.ticketHandBack.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ticketId: 601, technicianId: 3, origin: 'freshservice', reasonCode: 'capacity', reasonNote: 'Full week',
        selfHandBack: true, episodeId: null, pipelineRunId: null,
      }),
    });
  });

  test('a bad reason is refused before FreshService is written', async () => {
    await expect(ticketService.updateFsTicket(601, 1, { assignedTechId: null, handBack: { code: 'x' } }, agent)).rejects.toThrow(ValidationError);
    expect(fsClientMock.updateTicketFields).not.toHaveBeenCalled();
  });

  test('"isn\'t a member of the group" names the person and the group', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 12, name: 'Juan Gonzalez', freshserviceId: '5001', origin: 'freshservice' });
    prismaMock.group.findFirst.mockResolvedValue({ name: 'IT Service Desk' });
    const err = new Error('FS 400');
    err.freshserviceDetail = { description: 'Validation failed', errors: [{ field: 'responder_id', message: "Assigned agent isn't a member of the group.", code: 'invalid_value' }] };
    fsClientMock.updateTicketFields.mockRejectedValue(err);
    await expect(ticketService.updateFsTicket(601, 1, { assignedTechId: 12 }, coordinator))
      .rejects.toThrow(/Juan Gonzalez isn't in FreshService group "IT Service Desk"/);
  });
});

describe('assignable-only people (QA 09-25 item 6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true });
    prismaMock.group.findMany.mockResolvedValue([]);
    prismaMock.competencyCategory.findMany.mockResolvedValue([]);
    prismaMock.ticket.groupBy.mockResolvedValue([]);
    prismaMock.ticket.count.mockResolvedValue(0);
  });

  test('getMeta lists the team first, then assignable-only people flagged', async () => {
    prismaMock.technician.findMany.mockImplementation(({ where }) => Promise.resolve(where.assignableOnly
      ? [{ id: 40, name: 'Juan Gonzalez', email: 'juan@x.io', photoUrl: null, origin: 'freshservice' }]
      : [{ id: 7, name: 'Terry Tech', email: 'terry@x.io', photoUrl: null, origin: 'freshservice' }]));
    prismaMock.teamForward.findMany.mockResolvedValue([
      { id: 1, label: 'Digital Solutions Team', email: 'ds@x.io', enabled: true },
      { id: 2, label: 'No inbox yet', email: null, enabled: true },
      { id: 3, label: 'Off', email: 'off@x.io', enabled: false },
    ]);
    const meta = await ticketService.getMeta(1);
    expect(meta.technicians.map((t) => [t.id, t.assignableOnly === true])).toEqual([[7, false], [40, true]]);
    // the team query itself is unchanged (active only)
    expect(prismaMock.technician.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 1, isActive: true });
    expect(meta.teamForwards).toEqual([{ id: 1, label: 'Digital Solutions Team', email: 'ds@x.io' }]);
  });

  test('getMeta survives a missing assignable_only column', async () => {
    prismaMock.technician.findMany.mockImplementation(({ where }) => (where.assignableOnly
      ? Promise.reject(new Error('column "assignable_only" does not exist'))
      : Promise.resolve([{ id: 7, name: 'Terry Tech', email: null, photoUrl: null, origin: 'freshservice' }])));
    prismaMock.teamForward.findMany.mockRejectedValue(new Error('relation does not exist'));
    const meta = await ticketService.getMeta(1);
    expect(meta.technicians).toHaveLength(1);
    expect(meta.teamForwards).toEqual([]);
  });

  test('validation accepts an assignable-only person and still refuses unknown ones', async () => {
    prismaMock.technician.findFirst.mockImplementation(({ where }) => Promise.resolve(where.assignableOnly
      ? { id: 40, name: 'Juan Gonzalez', freshserviceId: '5001', origin: 'freshservice' }
      : null));
    await expect(ticketService._validateTechnician(1, 40, { allowAssignableOnly: true })).resolves.toEqual(expect.objectContaining({ id: 40 }));
    prismaMock.technician.findFirst.mockResolvedValue(null);
    await expect(ticketService._validateTechnician(1, 41, { allowAssignableOnly: true })).rejects.toThrow('Technician not found');
  });

  test('review N1: without the option (workflow node, macro, API v1, pipeline) assignable-only is refused', async () => {
    prismaMock.technician.findFirst.mockImplementation(({ where }) => Promise.resolve(where.assignableOnly
      ? { id: 40, name: 'Juan Gonzalez', freshserviceId: '5001', origin: 'freshservice' }
      : null));
    await expect(ticketService._validateTechnician(1, 40)).rejects.toThrow('Technician not found');
    // only the active-team query ran
    expect(prismaMock.technician.findFirst).toHaveBeenCalledTimes(1);
  });

  test('review N1: assignTicket passes the option through; default callers stay strict', async () => {
    armTp();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...tpTicket, assignedTechId: null, assignedTech: null });
    prismaMock.technician.findFirst.mockImplementation(({ where }) => Promise.resolve(where.assignableOnly
      ? { id: 40, name: 'Juan Gonzalez', freshserviceId: '5001', origin: 'freshservice' }
      : null));
    await expect(ticketService.assignTicket(501, 1, 40, coordinator)).rejects.toThrow('Technician not found');
    const spy = jest.spyOn(ticketService, '_validateTechnician').mockResolvedValue({ id: 40, name: 'Juan Gonzalez' });
    try {
      await ticketService.assignTicket(501, 1, 40, coordinator, { allowAssignableOnly: true }).catch(() => {});
      expect(spy).toHaveBeenCalledWith(1, 40, { allowAssignableOnly: true });
      spy.mockClear();
      await ticketService.assignTicket(501, 1, 40, coordinator, { fromFreshService: true }).catch(() => {});
      expect(spy).toHaveBeenCalledWith(1, 40, { allowAssignableOnly: true });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('describeNext (where the AI sent it next)', () => {
  test('plain words per run state', () => {
    const techs = new Map([[9, { id: 9, name: 'Mehdi' }]]);
    expect(describeNext({ id: 1, decision: 'auto_assigned', assignedTechId: 9 }, techs).text).toBe('Assigned to Mehdi');
    expect(describeNext({ id: 2, decision: 'pending_review', recommendation: { recommendations: [{ techName: 'Gaby' }] } }).text)
      .toBe('Suggested Gaby (awaiting review)');
    expect(describeNext({ id: 3, triggerSource: 'rebound_exhausted' }).text).toMatch(/manual pick/);
    expect(describeNext(null)).toBeNull();
  });
});

describe('hand-back list date range (review S2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
    prismaMock.ticketHandBack.findMany.mockResolvedValue([]);
  });

  test('a date-only range is the whole day in the workspace timezone', async () => {
    await ticketHandBackService.listForWorkspace(1, { from: '2026-09-25', to: '2026-09-25', technicianId: 7 });
    const { where } = prismaMock.ticketHandBack.findMany.mock.calls[0][0];
    // PDT = UTC-7
    expect(where.createdAt.gte.toISOString()).toBe('2026-09-25T07:00:00.000Z');
    expect(where.createdAt.lte.toISOString()).toBe('2026-09-26T06:59:59.999Z');
  });

  test('daily view (from = to) returns a same-day afternoon row', async () => {
    const row = { createdAt: new Date('2026-09-25T22:30:00.000Z') }; // 3:30 pm Vancouver
    await ticketHandBackService.listForWorkspace(1, { from: '2026-09-25', to: '2026-09-25' });
    const { createdAt } = prismaMock.ticketHandBack.findMany.mock.calls[0][0].where;
    expect(row.createdAt >= createdAt.gte && row.createdAt <= createdAt.lte).toBe(true);
  });

  test('full timestamps pass through untouched (no timezone lookup)', async () => {
    await ticketHandBackService.listForWorkspace(1, { from: '2026-09-25T00:00:00.000Z', to: '2026-09-25T23:59:59.000Z' });
    const { createdAt } = prismaMock.ticketHandBack.findMany.mock.calls[0][0].where;
    expect(createdAt.lte.toISOString()).toBe('2026-09-25T23:59:59.000Z');
    expect(prismaMock.workspace.findUnique).not.toHaveBeenCalled();
    expect(parseRangeBound('nope', 'UTC')).toBeNull();
  });
});
