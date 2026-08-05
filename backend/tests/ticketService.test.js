import { jest } from '@jest/globals';

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  ticketActivity: { findMany: jest.fn() },
  // Per-workspace type registry (ticket-types plan): IT-style vocabulary.
  ticketTypeDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Incident', aliases: ['incident', 'issue'], isActive: true, aiAssignable: true, isDefault: true, fsTypeValue: 'Incident', sortOrder: 0 },
      { id: 2, workspaceId: 1, name: 'Service Request', aliases: ['service request', 'sr'], isActive: true, aiAssignable: true, isDefault: false, fsTypeValue: 'Service Request', sortOrder: 1 },
    ]),
  },
  // Per-workspace status registry (Phase 8a): canonical 4 by default;
  // custom-status tests override + invalidate the statusService cache.
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  assignmentPipelineRun: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
};
const noiseRuleServiceMock = { evaluate: jest.fn() };
const ticketActivityRepositoryMock = { create: jest.fn() };
const ticketThreadRepositoryMock = { listForTicket: jest.fn() };
const lifecycleMock = { emitTicketLifecycleNotifications: jest.fn() };
const requesterRepositoryMock = { findByEmail: jest.fn(), createNative: jest.fn() };
const sendgridMock = { sendEmail: jest.fn() };
const sseBroadcastMock = jest.fn();
const runPipelineMock = jest.fn();
const fsClientMock = {
  createReply: jest.fn(),
  addNote: jest.fn(),
  updateTicketFields: jest.fn(),
};
const mirrorServiceMock = {
  enqueueTicketCreate: jest.fn().mockResolvedValue({ id: 1 }),
  enqueueFieldSync: jest.fn().mockResolvedValue({ id: 2 }),
  enqueueThreadEntry: jest.fn().mockResolvedValue({ id: 3 }),
  getClient: jest.fn().mockResolvedValue(fsClientMock),
  getInteractiveClient: jest.fn().mockResolvedValue(fsClientMock),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: noiseRuleServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: ticketActivityRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: ticketThreadRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepositoryMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: sseBroadcastMock },
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: { runPipeline: runPipelineMock },
}));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({
  default: { getUserProfile: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: mirrorServiceMock,
}));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { invalidateStatusCache } = await import('../src/services/statusService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const actor = { email: 'coord@example.com', name: 'Cora Coordinator', role: 'viewer', technicianId: null, kind: 'member' };

function armCreateDefaults() {
  prismaMock.workspace.findUnique.mockResolvedValue({
    id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true,
  });
  requesterRepositoryMock.findByEmail.mockResolvedValue({
    id: 40, name: 'Rita Requester', email: 'rita@example.com', department: 'Finance', freshserviceId: null,
  });
  noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null });
  prismaMock.$queryRaw.mockResolvedValue([{ nextval: 1042 }]);
  prismaMock.ticket.create.mockImplementation(({ data }) => Promise.resolve({
    id: 501,
    ...data,
    requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
    assignedTech: data.assignedTechId ? { id: data.assignedTechId, name: 'Terry Tech' } : null,
    internalCategory: null,
    internalSubcategory: null,
  }));
  prismaMock.ticketAssignmentEpisode.create.mockResolvedValue({ id: 1 });
  prismaMock.ticketAssignmentEpisode.updateMany.mockResolvedValue({ count: 0 });
  ticketActivityRepositoryMock.create.mockResolvedValue({});
  lifecycleMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
  runPipelineMock.mockResolvedValue({ id: 900 });
}

describe('ticketService.createTicket', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    armCreateDefaults();
  });

  test('creates a TP-born ticket with native number, fires lifecycle events and AI triage', async () => {
    const result = await ticketService.createTicket(1, {
      subject: 'Laptop will not boot',
      description: '<p>Screen stays black</p>',
      priority: 3,
      requesterEmail: 'rita@example.com',
    }, actor);

    expect(prismaMock.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        origin: 'ticketpulse',
        nativeNumber: 1042,
        freshserviceTicketId: null,
        mirrorState: 'pending',
        status: 'Open',
        priority: 3,
        requesterId: 40,
        lastIngestSource: 'ticketpulse_native',
      }),
    }));
    expect(result.displayRef).toBe('TP-1042');
    expect(lifecycleMock.emitTicketLifecycleNotifications).toHaveBeenCalledWith(expect.objectContaining({
      existingTicket: null,
      source: 'ticketpulse_native',
      allowNotificationWorkflows: true,
    }));
    expect(runPipelineMock).toHaveBeenCalledWith(501, 1, 'app_native');
    expect(sseBroadcastMock).toHaveBeenCalledWith('ticket-change', expect.objectContaining({ action: 'created' }), 1);
    expect(mirrorServiceMock.enqueueTicketCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 501 }));
    expect(result.triage.queued).toBe(true);
  });

  test('refuses when native ticketing is disabled for the workspace', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: false });
    await expect(ticketService.createTicket(1, {
      subject: 'Laptop will not boot',
      requesterEmail: 'rita@example.com',
    }, actor)).rejects.toThrow(/not enabled/i);
  });

  test('requires a requester', async () => {
    await expect(ticketService.createTicket(1, { subject: 'No requester here' }, actor))
      .rejects.toThrow(ValidationError);
  });

  test('creates a TP-native requester (Entra-enriched, no FS id) when email is unknown', async () => {
    requesterRepositoryMock.findByEmail.mockResolvedValue(null);
    requesterRepositoryMock.createNative.mockResolvedValue({
      id: 41, name: 'New Person', email: 'new@example.com', department: null, freshserviceId: null,
    });

    await ticketService.createTicket(1, {
      subject: 'Access to shared drive',
      requesterEmail: 'new@example.com',
      requesterName: 'New Person',
    }, actor);

    expect(requesterRepositoryMock.createNative).toHaveBeenCalledWith(expect.objectContaining({
      email: 'new@example.com',
      name: 'New Person',
    }));
  });

  test('direct assignment at creation creates an episode and skips AI triage', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 7, name: 'Terry Tech' });

    const result = await ticketService.createTicket(1, {
      subject: 'Phone setup for new hire',
      requesterEmail: 'rita@example.com',
      assignedTechId: 7,
    }, actor);

    expect(prismaMock.ticketAssignmentEpisode.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        technicianId: 7,
        startMethod: 'coordinator_assigned',
        startAssignedByName: 'Cora Coordinator',
      }),
    }));
    expect(runPipelineMock).not.toHaveBeenCalled();
    expect(result.triage.queued).toBe(false);
  });

  test('noise tickets skip AI triage', async () => {
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: true, ruleId: 'rule-1' });
    await ticketService.createTicket(1, {
      subject: 'Automated alert: disk space',
      requesterEmail: 'rita@example.com',
    }, actor);
    expect(runPipelineMock).not.toHaveBeenCalled();
  });
});

describe('ticketService conversation + status + assignment', () => {
  const nativeTicket = {
    id: 501,
    workspaceId: 1,
    origin: 'ticketpulse',
    nativeNumber: 1042,
    freshserviceTicketId: null,
    subject: 'Laptop will not boot',
    status: 'Open',
    priority: 3,
    createdAt: new Date('2026-07-01T10:00:00Z'),
    assignedTechId: null,
    firstAssignedAt: null,
    firstPublicAgentReplyAt: null,
    resolutionTimeSeconds: null,
    resolvedAt: null,
    internalCategoryId: null,
    internalSubcategoryId: null,
    groupId: null,
    requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
    assignedTech: null,
    internalCategory: null,
    internalSubcategory: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({
      ...nativeTicket, ...data, requester: nativeTicket.requester, assignedTech: data.assignedTechId ? { id: data.assignedTechId, name: 'Terry Tech' } : null,
    }));
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
    prismaMock.notificationDelivery.create.mockResolvedValue({});
    prismaMock.ticketAssignmentEpisode.create.mockResolvedValue({ id: 2 });
    prismaMock.ticketAssignmentEpisode.updateMany.mockResolvedValue({ count: 1 });
    ticketActivityRepositoryMock.create.mockResolvedValue({});
    lifecycleMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
    sendgridMock.sendEmail.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'sg-1' });
  });

  test('addReply writes a public ticketpulse_user thread entry, emails the requester, stamps first reply', async () => {
    const { entry, email } = await ticketService.addReply(501, 1, { bodyText: 'We are on it!' }, actor);

    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        source: 'ticketpulse_user',
        eventType: 'reply',
        authorType: 'agent',
        isPrivate: false,
        visibility: 'public',
        mirrorState: 'pending',
        externalEntryId: null,
      }),
    }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ firstPublicAgentReplyAt: expect.any(Date) }),
    }));
    expect(sendgridMock.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: ['rita@example.com'],
      subject: expect.stringContaining('[TP-1042]'),
    }));
    expect(entry.eventType).toBe('reply');
    expect(email.sent).toBe(true);
  });

  test('private notes never email the requester', async () => {
    await ticketService.addPrivateNote(501, 1, { bodyText: 'internal context' }, actor);
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ isPrivate: true, visibility: 'private', eventType: 'note' }),
    }));
  });

  test('FS-born replies go through the FreshService API and cache locally as mirrored', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9) });
    fsClientMock.createReply.mockResolvedValue({ conversation: { id: 42001 } });

    const { entry, email } = await ticketService.addReply(501, 1, { bodyText: 'hello from TP' }, actor);

    expect(fsClientMock.createReply).toHaveBeenCalledWith(9, expect.stringContaining('hello from TP'), { ccEmails: [], attachments: [] });
    expect(entry.externalEntryId).toBe('fs-conv-42001');
    expect(entry.mirrorState).toBe('mirrored');
    expect(email).toEqual({ sent: true, via: 'freshservice' });
    // TP does NOT email the requester for FS-born replies — FS does.
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
    expect(mirrorServiceMock.enqueueThreadEntry).not.toHaveBeenCalled();
  });

  test('FS-born private notes mirror through addNote(private)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9) });
    fsClientMock.addNote.mockResolvedValue({ conversation: { id: 42002 } });

    await ticketService.addPrivateNote(501, 1, { bodyText: 'fs-born internal' }, actor);

    expect(fsClientMock.addNote).toHaveBeenCalledWith(9, expect.stringContaining('fs-born internal'), { isPrivate: true, attachments: [] });
  });

  test('FS-born sends use the high-priority interactive client, not the background mirror client', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9) });
    fsClientMock.createReply.mockResolvedValue({ conversation: { id: 42003 } });

    await ticketService.addReply(501, 1, { bodyText: 'jump the queue' }, actor);

    expect(mirrorServiceMock.getInteractiveClient).toHaveBeenCalledWith(1);
    expect(mirrorServiceMock.getClient).not.toHaveBeenCalled();
  });

  test('a rate-limit queue timeout surfaces as an honest 503 "busy — nothing changed" error', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9) });
    const queueTimeout = new Error('FreshService request timed out after 15s waiting in the rate-limit queue (240 queued, 3 in-flight) — the request was never sent');
    queueTimeout.code = 'FS_QUEUE_TIMEOUT';
    fsClientMock.createReply.mockRejectedValue(queueTimeout);

    await expect(ticketService.addReply(501, 1, { bodyText: 'busy queue' }, actor))
      .rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('nothing was changed') });
    // The local thread cache must not record a reply that never reached FS.
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('native replies queue for the mirror', async () => {
    await ticketService.addReply(501, 1, { bodyText: 'native reply' }, actor);
    expect(mirrorServiceMock.enqueueThreadEntry).toHaveBeenCalledWith(1, 501, 9001);
    expect(fsClientMock.createReply).not.toHaveBeenCalled();
  });

  test('resolving stamps resolvedAt + resolutionTimeSeconds and closes the active episode', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket, assignedTechId: 7 });

    const result = await ticketService.changeStatus(501, 1, 'Resolved', actor);

    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'Resolved',
        resolvedAt: expect.any(Date),
        resolutionTimeSeconds: expect.any(Number),
        mirrorState: 'pending',
      }),
    }));
    expect(prismaMock.ticketAssignmentEpisode.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ endMethod: 'closed' }),
    }));
    expect(result.changed).toBe(true);
  });

  test('reopening clears resolution fields', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...nativeTicket, status: 'Resolved', resolvedAt: new Date(), resolutionTimeSeconds: 3600,
    });

    await ticketService.changeStatus(501, 1, 'Open', actor);

    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Open', resolvedAt: null, closedAt: null, resolutionTimeSeconds: null }),
    }));
  });

  test('assignTicket self-pick creates a self_picked episode', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 7, name: 'Terry Tech' });
    const agentActor = { ...actor, technicianId: 7, name: 'Terry Tech' };

    await ticketService.assignTicket(501, 1, 7, agentActor);

    expect(prismaMock.ticketAssignmentEpisode.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ technicianId: 7, startMethod: 'self_picked' }),
    }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ assignedTechId: 7, isSelfPicked: true, mirrorState: 'pending' }),
    }));
  });

  test('reassignment ends the previous episode', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket, assignedTechId: 3 });
    prismaMock.technician.findFirst.mockResolvedValue({ id: 7, name: 'Terry Tech' });

    await ticketService.assignTicket(501, 1, 7, actor);

    expect(prismaMock.ticketAssignmentEpisode.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ technicianId: 3, endedAt: null }),
      data: expect.objectContaining({ endMethod: 'reassigned' }),
    }));
    expect(prismaMock.ticketAssignmentEpisode.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ technicianId: 7, startMethod: 'coordinator_assigned' }),
    }));
  });
});

// QA 08-04 #9: the FS-born write-back must flag manual reassignments that
// override a completed AI decision (aiOverride), exactly like assignTicket —
// this is what feeds the "Why the override?" one-click prompt in the UI.
describe('ticketService.updateFsTicket (FS-born write-back)', () => {
  const fsBornTicket = {
    id: 601,
    workspaceId: 1,
    origin: 'freshservice',
    nativeNumber: null,
    freshserviceTicketId: BigInt(231309),
    subject: 'Payment receipt',
    status: 'Open',
    priority: 3,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    assignedTechId: 3,
    firstAssignedAt: new Date('2026-08-01T11:00:00Z'),
    resolvedAt: null,
    closedAt: null,
    internalCategoryId: null,
    internalSubcategoryId: null,
    tpSkill: null,
    tpSubskill: null,
    requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
    assignedTech: { id: 3, name: 'Ava Original' },
    internalCategory: null,
    internalSubcategory: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.workspace.findUnique.mockResolvedValue({
      id: 1, name: 'IT', isActive: true, tpSkillCustomField: 'tp_skill', tpSubskillCustomField: 'tp_subskill',
    });
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsBornTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({
      ...fsBornTicket, ...data, assignedTech: data.assignedTechId ? { id: data.assignedTechId, name: 'Terry Tech' } : null,
    }));
    prismaMock.technician.findFirst.mockResolvedValue({ id: 7, name: 'Terry Tech', freshserviceId: '9007', origin: 'freshservice' });
    fsClientMock.updateTicketFields.mockResolvedValue({ responder_id: 9007, updated_at: '2026-08-04T10:00:00Z' });
    ticketActivityRepositoryMock.create.mockResolvedValue({});
  });

  test('reassigning away from the AI pick returns aiOverride: true (parity with assignTicket)', async () => {
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue({
      decision: 'auto_assigned', status: 'completed', assignedTechId: 3,
    });

    const result = await ticketService.updateFsTicket(601, 1, { assignedTechId: 7 }, actor);

    expect(fsClientMock.updateTicketFields).toHaveBeenCalledWith(231309, expect.objectContaining({ responder_id: 9007 }));
    expect(result.synced).toEqual(['assignee']);
    expect(result.aiOverride).toBe(true);
  });

  test('reassigning to the AI pick itself returns aiOverride: false', async () => {
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue({
      decision: 'auto_assigned', status: 'completed', assignedTechId: 7,
    });

    const result = await ticketService.updateFsTicket(601, 1, { assignedTechId: 7 }, actor);

    expect(result.aiOverride).toBe(false);
  });

  test('no completed AI decision on record returns aiOverride: false', async () => {
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue(null);

    const result = await ticketService.updateFsTicket(601, 1, { assignedTechId: 7 }, actor);

    expect(result.aiOverride).toBe(false);
  });

  test('unassigning never flags an override (and skips the pipeline lookup)', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ responder_id: null, updated_at: '2026-08-04T10:00:00Z' });

    const result = await ticketService.updateFsTicket(601, 1, { assignedTechId: null }, actor);

    expect(result.aiOverride).toBe(false);
    expect(prismaMock.assignmentPipelineRun.findFirst).not.toHaveBeenCalled();
  });

  test('non-assignment changes skip the override check entirely', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ priority: 2, updated_at: '2026-08-04T10:00:00Z' });

    const result = await ticketService.updateFsTicket(601, 1, { priority: 2 }, actor);

    expect(result.synced).toEqual(['priority']);
    expect(result.aiOverride).toBe(false);
    expect(prismaMock.assignmentPipelineRun.findFirst).not.toHaveBeenCalled();
  });
});

// QA 08-04 #13: editable resolution due date. TP-born tickets accept ISO
// dueBy/frDueBy (null clears), stamp the dueBySetBy ownership marker, audit
// as due_changed, and skip the FS mirror (its copy doesn't carry due dates).
describe('ticketService.updateTicketFields (due-date editing)', () => {
  const nativeTicket = {
    id: 501,
    workspaceId: 1,
    origin: 'ticketpulse',
    nativeNumber: 1042,
    freshserviceTicketId: null,
    subject: 'Laptop will not boot',
    status: 'Open',
    priority: 3,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    assignedTechId: null,
    dueBy: new Date('2026-08-06T23:59:00Z'),
    dueBySetBy: 'sla',
    frDueBy: new Date('2026-08-05T18:00:00Z'),
    internalCategoryId: null,
    internalSubcategoryId: null,
    groupId: null,
    internalGroupId: null,
    requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
    assignedTech: null,
    internalCategory: null,
    internalSubcategory: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({
      ...nativeTicket, ...data, requester: nativeTicket.requester, assignedTech: null,
    }));
    ticketActivityRepositoryMock.create.mockResolvedValue({});
  });

  test('an ISO dueBy sets the clock, stamps dueBySetBy=manual and audits due_changed', async () => {
    const iso = '2026-08-08T23:59:00.000Z';
    const result = await ticketService.updateTicketFields(501, 1, { dueBy: iso }, actor);

    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dueBy: new Date(iso), dueBySetBy: 'manual' }),
    }));
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'due_changed',
      details: expect.objectContaining({
        changes: { dueBy: { from: '2026-08-06T23:59:00.000Z', to: iso } },
      }),
    }));
    expect(result.changed).toBe(true);
  });

  test('null dueBy clears the date AND the ownership marker', async () => {
    await ticketService.updateTicketFields(501, 1, { dueBy: null }, actor);

    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dueBy: null, dueBySetBy: null }),
    }));
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'due_changed',
      details: expect.objectContaining({
        changes: { dueBy: { from: '2026-08-06T23:59:00.000Z', to: null } },
      }),
    }));
  });

  test('due-only edits skip the FS mirror (no mirrorState churn, no field-sync job)', async () => {
    await ticketService.updateTicketFields(501, 1, { dueBy: '2026-08-08T23:59:00.000Z' }, actor);

    const { data } = prismaMock.ticket.update.mock.calls.find(([args]) => args.data.dueBy)[0];
    expect(data.mirrorState).toBeUndefined();
    expect(mirrorServiceMock.enqueueFieldSync).not.toHaveBeenCalled();
  });

  test('a mixed edit (priority + dueBy) still mirrors and writes BOTH audit types', async () => {
    await ticketService.updateTicketFields(501, 1, { priority: 1, dueBy: '2026-08-08T23:59:00.000Z' }, actor);

    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ priority: 1, dueBy: expect.any(Date), mirrorState: 'pending' }),
    }));
    expect(mirrorServiceMock.enqueueFieldSync).toHaveBeenCalledWith(1, 501);
    const auditTypes = ticketActivityRepositoryMock.create.mock.calls.map(([a]) => a.activityType);
    expect(auditTypes).toEqual(expect.arrayContaining(['fields_updated', 'due_changed']));
    // The generic entry must NOT double-report the due change.
    const fieldsAudit = ticketActivityRepositoryMock.create.mock.calls.find(([a]) => a.activityType === 'fields_updated')[0];
    expect(fieldsAudit.details.changes.dueBy).toBeUndefined();
  });

  test('frDueBy edits never touch the dueBy ownership marker', async () => {
    await ticketService.updateTicketFields(501, 1, { frDueBy: '2026-08-05T20:00:00.000Z' }, actor);

    const { data } = prismaMock.ticket.update.mock.calls.find(([args]) => args.data.frDueBy)[0];
    expect(data.frDueBy).toEqual(new Date('2026-08-05T20:00:00.000Z'));
    expect(data.dueBySetBy).toBeUndefined();
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'due_changed',
      details: expect.objectContaining({
        changes: { frDueBy: { from: '2026-08-05T18:00:00.000Z', to: '2026-08-05T20:00:00.000Z' } },
      }),
    }));
  });

  test('re-sending the current dueBy is a no-op (no update, no audit)', async () => {
    const result = await ticketService.updateTicketFields(501, 1, { dueBy: '2026-08-06T23:59:00.000Z' }, actor);

    expect(result.changed).toBe(false);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    expect(ticketActivityRepositoryMock.create).not.toHaveBeenCalled();
  });

  test('rejects non-ISO garbage via the strict schema', async () => {
    await expect(ticketService.updateTicketFields(501, 1, { dueBy: 'next tuesday' }, actor))
      .rejects.toThrow(ValidationError);
  });

  test('FS-born tickets are rejected — FreshService owns their SLA clocks', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(231309),
    });

    await expect(ticketService.updateTicketFields(501, 1, { dueBy: '2026-08-08T23:59:00.000Z' }, actor))
      .rejects.toThrow(/owned by FreshService/i);
  });

  test('createTicket stamps dueBySetBy=sla when the policy clock sets dueBy', async () => {
    armCreateDefaults();
    prismaMock.slaPolicy.findFirst.mockResolvedValue({
      firstResponseMinutes: 60, resolveMinutes: 480, isActive: true,
    });

    await ticketService.createTicket(1, {
      subject: 'Laptop will not boot',
      requesterEmail: 'rita@example.com',
    }, actor);

    expect(prismaMock.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dueBy: expect.any(Date), dueBySetBy: 'sla' }),
    }));
  });
});

// QA 08-04 #14: queue sorting — dueBy joins the whitelist (nulls last) and
// sort=status orders by LIFECYCLE rank (Open first asc), not alphabetically.
// Status pages are assembled bucket-by-bucket (groupBy counts → per-status
// findMany slices), so these tests pin the slice math across pages.
describe('ticketService.listTickets sorting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, internalDomains: [] });
    prismaMock.ticket.count.mockResolvedValue(0);
    prismaMock.ticket.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);
  });

  test('sort=dueBy orders by due date with undated tickets last', async () => {
    await ticketService.listTickets(1, { sort: 'dueBy', dir: 'asc' });

    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ dueBy: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }],
    }));
  });

  test('unknown sort values still fall back to createdAt', async () => {
    await ticketService.listTickets(1, { sort: 'evil;drop', dir: 'asc' });

    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: 'asc' }, { id: 'desc' }],
    }));
  });

  test('sort=status asc assembles the page Open-first (lifecycle rank, not alphabetical)', async () => {
    // Alphabetically Closed < Open < Pending — the ranked page must still
    // start with Open even though groupBy returns Closed first.
    prismaMock.ticket.groupBy.mockResolvedValue([
      { status: 'Closed', _count: { _all: 2 } },
      { status: 'Open', _count: { _all: 1 } },
      { status: 'Pending', _count: { _all: 30 } },
    ]);

    const result = await ticketService.listTickets(1, { sort: 'status', dir: 'asc', pageSize: 25 });

    expect(result.total).toBe(33);
    const calls = prismaMock.ticket.findMany.mock.calls.map(([args]) => args);
    expect(calls).toHaveLength(2); // Closed never reached on page 1
    expect(calls[0]).toEqual(expect.objectContaining({
      where: { AND: [expect.any(Object), { status: 'Open' }] },
      orderBy: [{ id: 'desc' }],
      skip: 0,
      take: 1,
    }));
    expect(calls[1]).toEqual(expect.objectContaining({
      where: { AND: [expect.any(Object), { status: 'Pending' }] },
      skip: 0,
      take: 24,
    }));
  });

  test('sort=status desc page 2 continues the reversed rank exactly where page 1 ended', async () => {
    prismaMock.ticket.groupBy.mockResolvedValue([
      { status: 'Closed', _count: { _all: 2 } },
      { status: 'Open', _count: { _all: 1 } },
      { status: 'Pending', _count: { _all: 30 } },
    ]);

    // desc rank: Closed(2), Pending(30), Open(1); page 2 skips the first 25.
    const result = await ticketService.listTickets(1, { sort: 'status', dir: 'desc', page: 2, pageSize: 25 });

    expect(result.total).toBe(33);
    const calls = prismaMock.ticket.findMany.mock.calls.map(([args]) => args);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.objectContaining({
      where: { AND: [expect.any(Object), { status: 'Pending' }] },
      skip: 23, // 25 - Closed's 2
      take: 7,  // Pending's remaining rows
    }));
    expect(calls[1]).toEqual(expect.objectContaining({
      where: { AND: [expect.any(Object), { status: 'Open' }] },
      skip: 0,
      take: 1,
    }));
  });
});

describe('ticketService.buildListWhere q matching', () => {
  test('free-text q matches subject, requester name, AND requester email (QA 08-04 #2)', async () => {
    const where = await ticketService.buildListWhere(1, { q: 'ana@bgc' });
    const qClause = where.AND.find((c) => Array.isArray(c.OR));
    expect(qClause.OR).toEqual([
      { subject: { contains: 'ana@bgc', mode: 'insensitive' } },
      { requester: { is: { name: { contains: 'ana@bgc', mode: 'insensitive' } } } },
      { requester: { is: { email: { contains: 'ana@bgc', mode: 'insensitive' } } } },
    ]);
  });

  test('numeric q still adds the ref matches alongside the text clauses', async () => {
    const where = await ticketService.buildListWhere(1, { q: '#1042' });
    const qClause = where.AND.find((c) => Array.isArray(c.OR));
    expect(qClause.OR).toEqual(expect.arrayContaining([
      { nativeNumber: 1042 },
      { freshserviceTicketId: 1042n },
      { requester: { is: { email: { contains: '#1042', mode: 'insensitive' } } } },
    ]));
  });
});

describe('ticketService custom workspace statuses (Phase 8a)', () => {
  const CUSTOM_ROWS = [
    { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
    { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
    { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
    { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    { id: 5, workspaceId: 1, name: 'Waiting on vendor', baseStatus: 'Pending', sortOrder: 4, isSystem: false, isActive: true },
    { id: 6, workspaceId: 1, name: 'Fixed', baseStatus: 'Resolved', sortOrder: 5, isSystem: false, isActive: true },
  ];

  const nativeTicket = {
    id: 501,
    workspaceId: 1,
    origin: 'ticketpulse',
    nativeNumber: 1042,
    freshserviceTicketId: null,
    subject: 'Laptop will not boot',
    status: 'Open',
    priority: 3,
    createdAt: new Date('2026-07-01T10:00:00Z'),
    assignedTechId: 7,
    resolutionTimeSeconds: null,
    resolvedAt: null,
    requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
    assignedTech: { id: 7, name: 'Terry Tech' },
    internalCategory: null,
    internalSubcategory: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateStatusCache();
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(CUSTOM_ROWS);
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({
      ...nativeTicket, ...data, assignedTech: nativeTicket.assignedTech,
    }));
    prismaMock.ticketAssignmentEpisode.create.mockResolvedValue({ id: 2 });
    prismaMock.ticketAssignmentEpisode.updateMany.mockResolvedValue({ count: 1 });
    ticketActivityRepositoryMock.create.mockResolvedValue({});
    lifecycleMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
    mirrorServiceMock.enqueueFieldSync.mockResolvedValue({ id: 2 });
  });

  test('changeStatus accepts a custom Pending-base status: no resolution stamps, episode stays open', async () => {
    const result = await ticketService.changeStatus(501, 1, 'Waiting on vendor', actor);

    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'Waiting on vendor', mirrorState: 'pending' },
    }));
    // Not terminal: the active assignment episode is untouched.
    expect(prismaMock.ticketAssignmentEpisode.updateMany).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
  });

  test('changeStatus normalizes casing to the stored label', async () => {
    await ticketService.changeStatus(501, 1, 'waiting ON vendor', actor);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Waiting on vendor' }),
    }));
  });

  test('a custom Resolved-base status ("Fixed") stamps resolution fields and closes the episode', async () => {
    await ticketService.changeStatus(501, 1, 'Fixed', actor);

    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'Fixed',
        resolvedAt: expect.any(Date),
        resolutionTimeSeconds: expect.any(Number),
      }),
    }));
    expect(prismaMock.ticketAssignmentEpisode.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ endMethod: 'closed' }),
    }));
  });

  test('reopening FROM a custom Resolved-base status clears resolution fields and restarts the episode', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...nativeTicket, status: 'Fixed', resolvedAt: new Date(), resolutionTimeSeconds: 3600,
    });

    await ticketService.changeStatus(501, 1, 'Open', actor);

    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Open', resolvedAt: null, closedAt: null, resolutionTimeSeconds: null }),
    }));
    expect(prismaMock.ticketAssignmentEpisode.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ technicianId: 7, startedAt: expect.any(Date) }),
    }));
  });

  test('changeStatus rejects labels outside the workspace registry, naming the valid set', async () => {
    await expect(ticketService.changeStatus(501, 1, 'Bogus', actor)).rejects.toThrow(
      /Status must be one of: Open, Pending, Resolved, Closed, Waiting on vendor, Fixed/,
    );
  });

  test('createTicket accepts a custom Pending-base status but refuses terminal-base ones', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true });
    requesterRepositoryMock.findByEmail.mockResolvedValue({ id: 40, name: 'Rita', email: 'rita@example.com', department: null, freshserviceId: null });
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null });
    prismaMock.$queryRaw.mockResolvedValue([{ nextval: 1043 }]);
    prismaMock.ticket.create.mockImplementation(({ data }) => Promise.resolve({
      id: 502, ...data, requester: { id: 40, name: 'Rita', email: 'rita@example.com' }, assignedTech: null, internalCategory: null, internalSubcategory: null,
    }));

    await expect(ticketService.createTicket(1, {
      subject: 'Born done?', requesterEmail: 'rita@example.com', status: 'Fixed',
    }, actor)).rejects.toThrow(/Open- or Pending-based/);

    await ticketService.createTicket(1, {
      subject: 'Waiting from the start', requesterEmail: 'rita@example.com', status: 'waiting on vendor',
    }, actor);
    expect(prismaMock.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Waiting on vendor' }),
    }));
  });

  test('getMeta serves the workspace status registry as rich objects (active only)', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true });
    prismaMock.group.findMany.mockResolvedValue([]);
    prismaMock.technician.findMany.mockResolvedValue([]);
    prismaMock.competencyCategory.findMany.mockResolvedValue([]);
    prismaMock.ticket.groupBy.mockResolvedValue([]);
    prismaMock.ticket.count.mockResolvedValue(0);
    const approvalCategoryMock = { findMany: jest.fn().mockResolvedValue([]) };
    const ticketTagMock = { findMany: jest.fn().mockResolvedValue([]) };
    const categoryGroupLinkMock = { findMany: jest.fn().mockResolvedValue([]) };
    prismaMock.approvalCategory = approvalCategoryMock;
    prismaMock.ticketTag = ticketTagMock;
    prismaMock.categoryGroupLink = categoryGroupLinkMock;

    const meta = await ticketService.getMeta(1);

    expect(meta.statuses).toEqual([
      { name: 'Open', baseStatus: 'Open', color: null, sortOrder: 0, isSystem: true },
      { name: 'Pending', baseStatus: 'Pending', color: null, sortOrder: 1, isSystem: true },
      { name: 'Resolved', baseStatus: 'Resolved', color: null, sortOrder: 2, isSystem: true },
      { name: 'Closed', baseStatus: 'Closed', color: null, sortOrder: 3, isSystem: true },
      { name: 'Waiting on vendor', baseStatus: 'Pending', color: null, sortOrder: 4, isSystem: false },
      { name: 'Fixed', baseStatus: 'Resolved', color: null, sortOrder: 5, isSystem: false },
    ]);
  });
});
