import { jest } from '@jest/globals';

/**
 * QA 10-16 item 1: one reason for every assignee change.
 *  - two new reason codes (access, escalate); escalate only on an unassign;
 *  - a change from one person to another keeps a hand-back row + an audit row
 *    marked kind 'reassign' (no rebound, no rejection);
 *  - a reason given over an AI pick also feeds the AI correction loop;
 *  - escalate snapshots the person's level in the ticket's category;
 *  - nothing is required: a reassignment without a reason (workflows, AI, API)
 *    behaves as before.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  queueCardConfig: { findUnique: jest.fn() },
  ticketFormConfig: { findUnique: jest.fn() },
  customFieldDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  technicianCompetency: { findMany: jest.fn() },
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
  ticketActivity: { findMany: jest.fn() },
  teamForward: { findMany: jest.fn().mockResolvedValue([]) },
  $queryRaw: jest.fn(),
};

const queueReboundRunMock = jest.fn().mockResolvedValue({ outcome: 'queued' });
const ticketActivityCreate = jest.fn().mockResolvedValue({});
const recordManualReassignReason = jest.fn().mockResolvedValue({ id: 1 });
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
jest.unstable_mockModule('../src/services/assignmentCorrectionService.js', () => ({
  default: { recordManualReassignReason },
  OVERRIDE_REASON_CODES: {},
}));
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
const {
  default: ticketHandBackService, normalizeHandBack, overrideCodeFor, HAND_BACK_REASONS, handBackEventDetails,
} = await import('../src/services/ticketHandBackService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const owner = { email: 'alex@example.com', name: 'Alex Doe', technicianId: 7, kind: 'agent' };
const coordinator = { email: 'cora@example.com', name: 'Cora Lane', technicianId: 2, kind: 'member' };
const samLee = { id: 9, name: 'Sam Lee', email: 'sam@example.com', isActive: true, origin: 'freshservice', freshserviceId: BigInt(9009) };

const tpTicket = {
  id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null,
  subject: 'VPN drops', status: 'Open', priority: 3, isNoise: false, createdAt: new Date('2026-10-01T10:00:00Z'),
  assignedTechId: 7, assignedTech: { id: 7, name: 'Alex Doe' }, firstAssignedAt: new Date('2026-10-01T11:00:00Z'),
  internalCategoryId: 40, internalSubcategoryId: 41,
  requester: null, internalCategory: null, internalSubcategory: null,
};

function arm() {
  jest.clearAllMocks();
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true });
  prismaMock.ticket.findFirst.mockResolvedValue({ ...tpTicket });
  prismaMock.technician.findFirst.mockResolvedValue(samLee);
  prismaMock.ticketAssignmentEpisode.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.ticketAssignmentEpisode.create.mockResolvedValue({ id: 90 });
  prismaMock.ticketAssignmentEpisode.findFirst.mockResolvedValue({ id: 88, startMethod: 'coordinator_assigned' });
  prismaMock.ticketAssignmentEpisode.count.mockResolvedValue(1);
  prismaMock.ticketHandBack.create.mockResolvedValue({ id: 5 });
  prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue(null);
  prismaMock.competencyCategory.findMany.mockResolvedValue([{ id: 40, name: 'Networking' }, { id: 41, name: 'VPN' }]);
  prismaMock.technicianCompetency.findMany.mockResolvedValue([{ technicianId: 7, competencyCategoryId: 41, proficiencyLevel: 'intermediate' }]);
  queueReboundRunMock.mockResolvedValue({ outcome: 'queued' });
}

describe('reason codes', () => {
  test('the two new reasons exist with plain labels', () => {
    expect(HAND_BACK_REASONS.access).toBe('Access / permission limited');
    expect(HAND_BACK_REASONS.escalate).toBe('Escalate to Advanced Troubleshooting Team');
    expect(normalizeHandBack({ code: 'access' })).toEqual({ code: 'access', note: null });
    expect(normalizeHandBack({ code: 'escalate', note: 'needs a senior' })).toEqual({ code: 'escalate', note: 'needs a senior' });
  });

  test('escalate is refused on a reassignment to a named person', () => {
    expect(() => normalizeHandBack({ code: 'escalate' }, { kind: 'reassign' })).toThrow(ValidationError);
    expect(normalizeHandBack({ code: 'capacity' }, { kind: 'reassign' })).toEqual({ code: 'capacity', note: null });
  });

  test('the AI correction loop gets its own code for each reason', () => {
    expect(overrideCodeFor('competency')).toBe('wrong_skill');
    expect(overrideCodeFor('capacity')).toBe('load_balancing');
    expect(overrideCodeFor('access')).toBe('other');
    expect(overrideCodeFor('skipped')).toBeNull();
  });
});

describe('assignTicket — a change to another person', () => {
  beforeEach(() => {
    arm();
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...tpTicket, ...data, assignedTech: { id: 9, name: 'Sam Lee' } }));
  });

  test('keeps a reason row and a reassign audit row; no rebound, no rejection', async () => {
    await ticketService.assignTicket(501, 1, 9, owner, { handBack: { code: 'capacity', note: 'Full week' } });

    expect(prismaMock.ticketAssignmentEpisode.updateMany.mock.calls[0][0].data.endMethod).toBe('reassigned');
    expect(prismaMock.ticket.update.mock.calls[0][0].data.rejectionCount).toBeUndefined();
    expect(prismaMock.ticketHandBack.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ticketId: 501, technicianId: 7, reasonCode: 'capacity', reasonNote: 'Full week', selfHandBack: true, origin: 'ticketpulse' }),
    });
    expect(queueReboundRunMock).not.toHaveBeenCalled();
    expect(ticketActivityCreate).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({
        note: 'Ticket reassigned — Capacity full',
        handBack: expect.objectContaining({ code: 'capacity', kind: 'reassign', fromTechId: 7, toTechId: 9, toTechName: 'Sam Lee' }),
      }),
    }));
  });

  test('no reason (workflows, the AI, the API) works exactly as before', async () => {
    const res = await ticketService.assignTicket(501, 1, 9, coordinator);
    expect(res.changed).toBe(true);
    expect(prismaMock.ticketHandBack.create).not.toHaveBeenCalled();
    expect(ticketActivityCreate.mock.calls[0][0].details.handBack).toBeUndefined();
  });

  test('escalate on a reassignment is refused before anything changes', async () => {
    await expect(ticketService.assignTicket(501, 1, 9, owner, { handBack: { code: 'escalate' } })).rejects.toThrow(ValidationError);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('assigning an unassigned ticket ignores any reason (not a change of agent)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...tpTicket, assignedTechId: null, assignedTech: null });
    await ticketService.assignTicket(501, 1, 9, coordinator, { handBack: { code: 'capacity' } });
    expect(prismaMock.ticketHandBack.create).not.toHaveBeenCalled();
  });

  test('over a completed AI pick the same reason feeds the correction loop - nobody is asked twice', async () => {
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue({ decision: 'auto_assigned', status: 'completed', assignedTechId: 7 });
    const res = await ticketService.assignTicket(501, 1, 9, coordinator, { handBack: { code: 'competency', note: 'VPN is Sam\'s area' } });
    expect(res.aiOverride).toBe(true);
    expect(res.reasonRecorded).toBe(true);
    expect(recordManualReassignReason).toHaveBeenCalledWith(501, 1, expect.objectContaining({
      toTechnicianId: 9, reasonCode: 'wrong_skill', reason: 'Competency mismatch - VPN is Sam\'s area',
    }));
  });

  test('bulk move to a person validates the reason as a reassignment', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 501, origin: 'ticketpulse', status: 'Open', nativeNumber: 1042 }]);
    await expect(ticketService.bulkByQuery(1, { query: {}, action: { type: 'assign', value: 9, handBack: { code: 'escalate' } } }, coordinator))
      .rejects.toThrow(ValidationError);
    const spy = jest.spyOn(ticketService, 'assignTicket');
    await ticketService.bulkByQuery(1, { query: {}, action: { type: 'assign', value: 9, handBack: { code: 'access' } } }, coordinator);
    expect(spy).toHaveBeenCalledWith(501, 1, 9, coordinator, { handBack: { code: 'access' }, allowAssignableOnly: true });
    spy.mockRestore();
  });
});

describe('assignTicket — Escalate on an unassign', () => {
  beforeEach(() => {
    arm();
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...tpTicket, ...data, assignedTechId: null, assignedTech: null }));
  });

  test('snapshots the level in the category / subcategory on the audit row and the rebound reason', async () => {
    await ticketService.assignTicket(501, 1, null, owner, { handBack: { code: 'escalate' } });
    const snapshot = expect.objectContaining({
      fromTechId: 7, fromTechName: 'Alex Doe', level: 'intermediate', rank: 2,
      categoryId: 40, categoryName: 'Networking', subcategoryId: 41, subcategoryName: 'VPN', scope: 'Networking / VPN',
    });
    expect(ticketActivityCreate).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ handBack: expect.objectContaining({ code: 'escalate', kind: 'unassign', escalation: snapshot }) }),
    }));
    expect(queueReboundRunMock).toHaveBeenCalledTimes(1);
    expect(queueReboundRunMock.mock.calls[0][0].reboundFrom.reason).toEqual(expect.objectContaining({ code: 'escalate', escalation: snapshot }));
  });
});

describe('updateFsTicket — FS-born change to another person', () => {
  const fsTicket = {
    ...tpTicket, id: 601, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: BigInt(231309), groupId: null,
    assignedTechId: 3, assignedTech: { id: 3, name: 'Ava Stone' },
  };
  beforeEach(() => {
    arm();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...fsTicket, ...data, assignedTech: { id: 9, name: 'Sam Lee' } }));
    prismaMock.ticketHandBack.create.mockResolvedValue({ id: 9 });
    fsClientMock.updateTicketFields.mockResolvedValue({ responder_id: 9009, updated_at: '2026-10-16T10:00:00Z' });
  });

  test('records the reason with kind reassign on the write-back audit row', async () => {
    await ticketService.updateFsTicket(601, 1, { assignedTechId: 9, handBack: { code: 'location' } }, coordinator);
    expect(prismaMock.ticketHandBack.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ticketId: 601, technicianId: 3, reasonCode: 'location', origin: 'freshservice', selfHandBack: false }),
    });
    const audit = ticketActivityCreate.mock.calls.find((c) => c[0].activityType === 'fs_write_back')[0];
    expect(audit.details.handBack).toEqual(expect.objectContaining({ code: 'location', kind: 'reassign', fromTechId: 3, toTechId: 9 }));
  });

  test('escalate on an FS reassignment is refused before FreshService is written', async () => {
    await expect(ticketService.updateFsTicket(601, 1, { assignedTechId: 9, handBack: { code: 'escalate' } }, coordinator))
      .rejects.toThrow(ValidationError);
    expect(fsClientMock.updateTicketFields).not.toHaveBeenCalled();
  });
});

describe('hand-back rows know a reassignment from its audit row', () => {
  beforeEach(arm);

  test('handBackEventDetails matches by ticket and time; forTicket marks kind + new person', async () => {
    const at = new Date('2026-10-16T17:00:00Z');
    prismaMock.ticketHandBack.findMany.mockResolvedValue([
      { id: 1, ticketId: 501, technicianId: 7, reasonCode: 'capacity', createdAt: at },
      { id: 2, ticketId: 501, technicianId: 9, reasonCode: 'escalate', createdAt: new Date(at.getTime() + 3600e3) },
    ]);
    prismaMock.ticketActivity.findMany.mockResolvedValue([
      { ticketId: 501, performedAt: new Date(at.getTime() - 500), details: { handBack: { kind: 'reassign', fromTechId: 7, toTechId: 9, toTechName: 'Sam Lee' } } },
      { ticketId: 501, performedAt: new Date(at.getTime() + 3600e3 - 200), details: { handBack: { kind: 'unassign', fromTechId: 9, escalation: { scope: 'Networking / VPN' } } } },
    ]);
    const rows = await ticketHandBackService.forTicket(501, 1);
    expect(rows[0]).toEqual(expect.objectContaining({ id: 1, kind: 'reassigned', toTechName: 'Sam Lee', escalation: null }));
    expect(rows[1]).toEqual(expect.objectContaining({ id: 2, kind: 'handed_back', escalation: { scope: 'Networking / VPN' } }));
  });

  test('the FS sync never treats a reassignment row as the unassign it saw', async () => {
    const at = new Date('2026-10-16T17:00:00Z');
    prismaMock.ticketHandBack.findFirst.mockResolvedValue({ id: 3, ticketId: 601, technicianId: 3, createdAt: at });
    prismaMock.ticketActivity.findMany.mockResolvedValue([
      { ticketId: 601, performedAt: at, details: { handBack: { kind: 'reassign', fromTechId: 3, toTechId: 9 } } },
    ]);
    expect(await ticketHandBackService.findPendingForRebound({ ticketId: 601, technicianId: 3, unassignedAt: at })).toBeNull();
    prismaMock.ticketActivity.findMany.mockResolvedValue([]);
    expect(await ticketHandBackService.findPendingForRebound({ ticketId: 601, technicianId: 3, unassignedAt: at })).toEqual(expect.objectContaining({ id: 3 }));
  });

  test('a missing activity table degrades to no details', async () => {
    prismaMock.ticketActivity.findMany.mockRejectedValue(new Error('relation does not exist'));
    const map = await handBackEventDetails([{ id: 1, ticketId: 1, createdAt: new Date() }]);
    expect(map.size).toBe(0);
  });
});
