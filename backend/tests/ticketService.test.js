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
  // Per-user email signatures (Phase D): default = no signature row.
  userEmailSignature: { findUnique: jest.fn() },
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
  getTicket: jest.fn(),
  fetchRequester: jest.fn(),
};
const mirrorServiceMock = {
  enqueueTicketCreate: jest.fn().mockResolvedValue({ id: 1 }),
  enqueueFieldSync: jest.fn().mockResolvedValue({ id: 2 }),
  enqueueThreadEntry: jest.fn().mockResolvedValue({ id: 3 }),
  getClient: jest.fn().mockResolvedValue(fsClientMock),
  getInteractiveClient: jest.fn().mockResolvedValue(fsClientMock),
  resolveDepartmentId: jest.fn(),
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
const { ValidationError, ExternalAPIError } = await import('../src/utils/errors.js');

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

  test('reply bodyHtml is sanitized server-side: scripts/handlers stripped, pasted table kept (Phase C)', async () => {
    const dirty = '<table style="border-collapse:collapse"><tbody><tr>'
      + '<td colspan="2" style="border:1px solid #ccc">Amount</td></tr></tbody></table>'
      + '<script>alert(1)</script><img src="https://ok.example/a.png" onerror="alert(2)">'
      + '<a href="javascript:alert(3)">x</a>';
    const { entry } = await ticketService.addReply(501, 1, { bodyHtml: dirty, bodyText: 'Amount' }, actor);
    expect(entry.bodyHtml).toContain('<table');
    expect(entry.bodyHtml).toContain('colspan="2"');
    expect(entry.bodyHtml).toContain('border:1px solid #ccc');
    expect(entry.bodyHtml).not.toContain('<script');
    expect(entry.bodyHtml).not.toContain('onerror');
    expect(entry.bodyHtml).not.toContain('javascript:');
    // The requester email body is built from the SANITIZED html.
    expect(sendgridMock.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      html: expect.not.stringContaining('<script'),
    }));
  });

  test('note bodyHtml is sanitized on the note path too', async () => {
    await ticketService.addPrivateNote(501, 1, { bodyHtml: '<p>ok</p><script>boom()</script>', bodyText: 'ok' }, actor);
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ bodyHtml: expect.not.stringContaining('<script') }),
    }));
  });

  test('a body that sanitizes to nothing is rejected, not stored blank', async () => {
    await expect(ticketService.addReply(501, 1, { bodyHtml: '<script>alert(1)</script>' }, actor))
      .rejects.toThrow(/body is required/i);
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
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

// QA 08-05 #6 (Cambio #236253): FS demands a department_id on status changes
// but the interceptor-wrapped error hid the field-level detail, so the
// retry-with-department branch never fired ("Validation failed", no retry).
// These tests pin the error shape the axios interceptor actually produces
// (ExternalAPIError; raw axios error only under .originalError) and the
// three-step department ladder: FS ticket → FS requester → mirror resolver
// (TP department / Entra office location / workspace fallback).
describe('ticketService.updateFsTicket — required-department auto-resolution', () => {
  const fsBornTicket = {
    id: 601,
    workspaceId: 1,
    origin: 'freshservice',
    nativeNumber: null,
    freshserviceTicketId: BigInt(236253),
    subject: 'Cambio access',
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
    department: null,
    requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com', entraOfficeLocation: 'Toronto', entraDepartment: null },
    assignedTech: { id: 3, name: 'Ava Original' },
    internalCategory: null,
    internalSubcategory: null,
  };

  // The exact shape thrown by the freshservice.js response interceptor: an
  // ExternalAPIError whose `.response` is UNDEFINED — the axios error (with
  // response.data.errors[]) survives only under `.originalError`. With
  // `direct: true` the interceptor's own freshserviceDetail/Status stamps are
  // included too; `direct: false` simulates detail surviving ONLY via
  // originalError, which is what the old `error.response?.data` reads missed.
  function interceptorWrappedError({ direct = true, errors } = {}) {
    const detail = {
      description: 'Validation failed',
      errors: errors || [{ field: 'department_id', message: "It should be a/an Positive Integer,It should not be blank if 'Status' is 'Closed'", code: 'invalid_value' }],
    };
    const axiosError = new Error('Request failed with status code 400');
    axiosError.response = { status: 400, data: detail };
    axiosError.config = { url: '/tickets/236253' };
    const wrapped = new ExternalAPIError('FreshService', detail.description, axiosError);
    if (direct) {
      wrapped.freshserviceStatus = 400;
      wrapped.freshserviceDetail = detail;
    }
    return wrapped;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.workspace.findUnique.mockResolvedValue({
      id: 1, name: 'IT', isActive: true, tpSkillCustomField: 'tp_skill', tpSubskillCustomField: 'tp_subskill',
    });
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsBornTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...fsBornTicket, ...data }));
    ticketActivityRepositoryMock.create.mockResolvedValue({});
  });

  test('regression: interceptor-wrapped error (detail only under .originalError) still enters the department retry', async () => {
    fsClientMock.updateTicketFields
      .mockRejectedValueOnce(interceptorWrappedError({ direct: false }))
      .mockResolvedValueOnce({ priority: 2, updated_at: '2026-08-05T10:00:00Z' });
    fsClientMock.getTicket.mockResolvedValue({ id: 236253, department_id: 555 });

    const result = await ticketService.updateFsTicket(601, 1, { priority: 2 }, actor);

    expect(fsClientMock.updateTicketFields).toHaveBeenCalledTimes(2);
    expect(fsClientMock.updateTicketFields).toHaveBeenLastCalledWith(236253, expect.objectContaining({ priority: 2, department_id: 555 }));
    expect(fsClientMock.fetchRequester).not.toHaveBeenCalled();
    expect(mirrorServiceMock.resolveDepartmentId).not.toHaveBeenCalled();
    expect(result.synced).toEqual(['priority']);
  });

  test('ladder step 2: FS requester department fills in when the FS ticket has none', async () => {
    fsClientMock.updateTicketFields
      .mockRejectedValueOnce(interceptorWrappedError())
      .mockResolvedValueOnce({ priority: 2, updated_at: '2026-08-05T10:00:00Z' });
    fsClientMock.getTicket.mockResolvedValue({ id: 236253, department_id: null, requester_id: 9040 });
    fsClientMock.fetchRequester.mockResolvedValue({ id: 9040, department_ids: [777] });

    await ticketService.updateFsTicket(601, 1, { priority: 2 }, actor);

    expect(fsClientMock.fetchRequester).toHaveBeenCalledWith(9040);
    expect(fsClientMock.updateTicketFields).toHaveBeenLastCalledWith(236253, expect.objectContaining({ department_id: 777 }));
    expect(mirrorServiceMock.resolveDepartmentId).not.toHaveBeenCalled();
  });

  test('ladder step 3 (Cambio case): no FS department anywhere — Entra office-location resolution supplies it', async () => {
    fsClientMock.updateTicketFields
      .mockRejectedValueOnce(interceptorWrappedError())
      .mockResolvedValueOnce({ status: 4, updated_at: '2026-08-05T10:00:00Z' });
    fsClientMock.getTicket.mockResolvedValue({ id: 236253, department_id: null, requester_id: 9040 });
    fsClientMock.fetchRequester.mockResolvedValue({ id: 9040, department_ids: [] });
    mirrorServiceMock.resolveDepartmentId.mockResolvedValue(1000131297);

    const result = await ticketService.updateFsTicket(601, 1, { status: 'Resolved' }, actor);

    expect(fsClientMock.getTicket).toHaveBeenCalled();
    expect(fsClientMock.fetchRequester).toHaveBeenCalled();
    expect(mirrorServiceMock.resolveDepartmentId).toHaveBeenCalledWith(fsClientMock, expect.objectContaining({ id: 601 }));
    expect(fsClientMock.updateTicketFields).toHaveBeenLastCalledWith(236253, expect.objectContaining({ status: 4, department_id: 1000131297 }));
    expect(result.synced).toEqual(['status']);
  });

  test('genuinely unresolvable department fails with the full-ladder message', async () => {
    fsClientMock.updateTicketFields.mockRejectedValue(interceptorWrappedError());
    fsClientMock.getTicket.mockResolvedValue({ id: 236253, department_id: null, requester_id: null });
    mirrorServiceMock.resolveDepartmentId.mockResolvedValue(undefined);

    await expect(ticketService.updateFsTicket(601, 1, { priority: 2 }, actor))
      .rejects.toThrow(/no department on the FS ticket, its requester, or an Entra office-location match/);
    expect(fsClientMock.updateTicketFields).toHaveBeenCalledTimes(1); // no retry without a department
  });

  test('non-department validation errors render field labels via the wrapped detail', async () => {
    fsClientMock.updateTicketFields.mockRejectedValue(interceptorWrappedError({
      direct: false,
      errors: [{ field: 'group_id', message: 'incorrect group for this workspace' }],
    }));

    await expect(ticketService.updateFsTicket(601, 1, { priority: 2 }, actor))
      .rejects.toThrow(/FreshService rejected the change — Group: incorrect group for this workspace/);
    expect(fsClientMock.getTicket).not.toHaveBeenCalled(); // not a department problem → no retry ladder
  });

  test('department retry that fails again surfaces the friendly field-label error', async () => {
    fsClientMock.updateTicketFields
      .mockRejectedValueOnce(interceptorWrappedError({
        errors: [{ field: 'department_id', message: 'It should be of type Null', code: 'missing_field' }],
      }))
      .mockRejectedValueOnce(interceptorWrappedError({
        direct: false,
        errors: [{ field: 'department_id', message: 'It should be of type Null', code: 'missing_field' }],
      }));
    fsClientMock.getTicket.mockResolvedValue({ id: 236253, department_id: 555 });

    await expect(ticketService.updateFsTicket(601, 1, { priority: 2 }, actor))
      .rejects.toThrow(/Department is required but not set/);
    expect(fsClientMock.updateTicketFields).toHaveBeenCalledTimes(2);
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

  // Phase QC (Mega 08-23): the optional Source/Department queue columns sort
  // server-side — nullable columns, so blanks trail in BOTH directions like
  // dueBy. department orders by the ticket's own column (requester-profile
  // fallback rows deliberately sort with the nulls).
  test('sort=source joins the whitelist with nulls last', async () => {
    await ticketService.listTickets(1, { sort: 'source', dir: 'asc' });

    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ source: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }],
    }));
  });

  test('sort=department joins the whitelist with nulls last (desc too)', async () => {
    await ticketService.listTickets(1, { sort: 'department', dir: 'desc' });

    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ department: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
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

describe('ticketService queue consumers resolve the workspace registry (Phase 8b)', () => {
  // 'Needs Rework' is the QA acceptance case: a custom Pending-base status
  // must keep counting as open everywhere.
  const ROWS_8B = [
    { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
    { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
    { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
    { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    { id: 5, workspaceId: 1, name: 'Needs Rework', baseStatus: 'Pending', sortOrder: 4, isSystem: false, isActive: true },
    { id: 6, workspaceId: 1, name: 'In Triage', baseStatus: 'Open', sortOrder: 5, isSystem: false, isActive: true },
    { id: 7, workspaceId: 1, name: 'Fixed', baseStatus: 'Resolved', sortOrder: 6, isSystem: false, isActive: true },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateStatusCache();
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(ROWS_8B);
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, internalDomains: [] });
  });

  test('open segment scope includes every Open/Pending-BASE name (custom included)', async () => {
    const where = await ticketService.buildListWhere(1, { segment: 'open' });
    expect(where.status).toEqual({ in: ['Open', 'Pending', 'Needs Rework', 'In Triage'] });
  });

  test('resolved segment scope includes custom terminal-base names', async () => {
    const where = await ticketService.buildListWhere(1, { segment: 'resolved' });
    expect(where.status).toEqual({ in: ['Resolved', 'Closed', 'Fixed'] });
  });

  test('due/overdue segments stay Open-BASE only (Pending-base pauses the clock)', async () => {
    const where = await ticketService.buildListWhere(1, { segment: 'overdue' });
    expect(where.status).toEqual({ in: ['Open', 'In Triage'] });
  });

  test('due-bucket facet only nags Open-BASE names', async () => {
    const where = await ticketService.buildListWhere(1, { due: 'overdue' });
    const dueClause = where.AND.find((c) => Array.isArray(c.OR));
    expect(dueClause.OR[0]).toEqual({ dueBy: { lt: expect.any(Date) }, status: { in: ['Open', 'In Triage'] } });
  });

  test('getQueueStats counts custom statuses under their base (open/resolved/dueToday)', async () => {
    prismaMock.ticket.count.mockResolvedValue(0);
    prismaMock.ticket.groupBy.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);

    await ticketService.getQueueStats(1);

    const countWheres = prismaMock.ticket.count.mock.calls.map((c) => c[0].where);
    // open count: every Open/Pending-base name
    expect(countWheres).toContainEqual(expect.objectContaining({
      status: { in: ['Open', 'Pending', 'Needs Rework', 'In Triage'] }, isNoise: false, workspaceId: 1,
    }));
    // resolved count: terminal-base names incl. 'Fixed'
    expect(countWheres).toContainEqual(expect.objectContaining({
      status: { in: ['Resolved', 'Closed', 'Fixed'] },
    }));
    // dueToday/overdue: Open-base only
    const dueWheres = countWheres.filter((w) => Array.isArray(w?.OR));
    expect(dueWheres.length).toBeGreaterThanOrEqual(2);
    for (const w of dueWheres.slice(0, 2)) {
      expect(w.status).toEqual({ in: ['Open', 'In Triage'] });
    }
  });

  test('registry lookups are served from the statusService cache — one DB read per request burst', async () => {
    prismaMock.ticket.count.mockResolvedValue(0);
    prismaMock.ticket.groupBy.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);

    await ticketService.getQueueStats(1);
    await ticketService.buildListWhere(1, { segment: 'open' });
    await ticketService.buildListWhere(1, { due: 'overdue,today' });

    // getQueueStats alone resolves 3 base scopes + the awaiting SQL — the
    // registry must be read ONCE, not per lookup (hot-path contract).
    expect(prismaMock.ticketStatusDefinition.findMany).toHaveBeenCalledTimes(1);
  });
});

// Phase 8c: FS write-back accepts workspace custom statuses, mapping to an FS
// code via the label's BASE status; unmappable labels are rejected instead of
// the old silent Open(2) fallback; resolution stamps key on the base.
describe('ticketService.updateFsTicket (custom statuses via baseStatus)', () => {
  const REGISTRY_8C = [
    { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
    { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
    { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
    { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    { id: 5, workspaceId: 1, name: 'Needs Rework', baseStatus: 'Pending', sortOrder: 4, isSystem: false, isActive: true },
    { id: 6, workspaceId: 1, name: 'Fixed', baseStatus: 'Resolved', sortOrder: 5, isSystem: false, isActive: true },
  ];

  const fsBorn8c = {
    id: 701,
    workspaceId: 1,
    origin: 'freshservice',
    nativeNumber: null,
    freshserviceTicketId: BigInt(231500),
    subject: 'Custom status write-back',
    status: 'Open',
    priority: 3,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    assignedTechId: null,
    firstAssignedAt: null,
    resolvedAt: null,
    closedAt: null,
    internalCategoryId: null,
    internalSubcategoryId: null,
    tpSkill: null,
    tpSubskill: null,
    requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
    assignedTech: null,
    internalCategory: null,
    internalSubcategory: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateStatusCache();
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(REGISTRY_8C);
    prismaMock.workspace.findUnique.mockResolvedValue({
      id: 1, name: 'IT', isActive: true, tpSkillCustomField: 'tp_skill', tpSubskillCustomField: 'tp_subskill',
    });
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsBorn8c });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({
      ...fsBorn8c, ...data, assignedTech: null,
    }));
    ticketActivityRepositoryMock.create.mockResolvedValue({});
  });

  afterAll(() => {
    invalidateStatusCache();
  });

  test('custom Pending-base status ships its base FS code (3) and stores the label locally', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ status: 3, updated_at: '2026-08-05T10:00:00Z' });

    const result = await ticketService.updateFsTicket(701, 1, { status: 'Needs Rework' }, actor);

    expect(fsClientMock.updateTicketFields).toHaveBeenCalledWith(231500, expect.objectContaining({ status: 3 }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Needs Rework' }),
    }));
    // Pending-base: no resolution stamps.
    const patch = prismaMock.ticket.update.mock.calls[0][0].data;
    expect(patch.resolvedAt).toBeUndefined();
    expect(patch.closedAt).toBeUndefined();
    expect(result.synced).toEqual(['status']);
  });

  test('custom Resolved-base status maps to 4 and stamps resolvedAt (base-aware terminal)', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ status: 4, updated_at: '2026-08-05T10:00:00Z' });

    await ticketService.updateFsTicket(701, 1, { status: 'Fixed' }, actor);

    expect(fsClientMock.updateTicketFields).toHaveBeenCalledWith(231500, expect.objectContaining({ status: 4 }));
    const patch = prismaMock.ticket.update.mock.calls[0][0].data;
    expect(patch.status).toBe('Fixed');
    expect(patch.resolvedAt).toBeInstanceOf(Date);
    expect(patch.closedAt).toBeUndefined(); // Resolved base, not Closed
  });

  test('input is normalized case-insensitively against the registry', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ status: 3, updated_at: '2026-08-05T10:00:00Z' });

    await ticketService.updateFsTicket(701, 1, { status: 'needs rework' }, actor);

    const patch = prismaMock.ticket.update.mock.calls[0][0].data;
    expect(patch.status).toBe('Needs Rework');
  });

  test('unknown statuses are rejected naming the workspace vocabulary — nothing reaches FS', async () => {
    await expect(ticketService.updateFsTicket(701, 1, { status: 'Bogus' }, actor))
      .rejects.toThrow(/Status must be one of: .*Needs Rework/);
    expect(fsClientMock.updateTicketFields).not.toHaveBeenCalled();
  });

  test('re-applying the current label stays a no-op (idempotent retry, QA 231648)', async () => {
    const result = await ticketService.updateFsTicket(701, 1, { status: 'Open' }, actor);
    expect(result.noChanges).toBe(true);
    expect(fsClientMock.updateTicketFields).not.toHaveBeenCalled();
  });
});

// Phase 8c: sort=status ranks by BASE rank then the workspace's sortOrder —
// custom statuses slot into their lifecycle stage instead of after Closed.
describe('ticketService sort=status with custom statuses (Phase 8c)', () => {
  const REGISTRY_SORT = [
    { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
    { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
    { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
    { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    { id: 5, workspaceId: 1, name: 'Needs Rework', baseStatus: 'Pending', sortOrder: 4, isSystem: false, isActive: true },
    { id: 6, workspaceId: 1, name: 'Fixed', baseStatus: 'Resolved', sortOrder: 5, isSystem: false, isActive: true },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateStatusCache();
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue(REGISTRY_SORT);
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, internalDomains: [] });
    prismaMock.ticket.count.mockResolvedValue(0);
    prismaMock.ticket.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);
  });

  afterAll(() => invalidateStatusCache());

  test('customs bucket into their base stage; unknown legacy labels trail their heuristic base; Deleted sorts last', async () => {
    prismaMock.ticket.groupBy.mockResolvedValue([
      { status: 'Deleted', _count: { _all: 1 } },
      { status: 'Fixed', _count: { _all: 1 } },
      { status: 'Closed', _count: { _all: 1 } },
      { status: 'Needs Rework', _count: { _all: 1 } },
      { status: 'Waiting on Customer', _count: { _all: 1 } }, // registry-unknown, heuristic Pending
      { status: 'Open', _count: { _all: 1 } },
      { status: 'Pending', _count: { _all: 1 } },
      { status: 'Resolved', _count: { _all: 1 } },
    ]);

    await ticketService.listTickets(1, { sort: 'status', dir: 'asc', pageSize: 25 });

    const sliceOrder = prismaMock.ticket.findMany.mock.calls
      .map(([args]) => args.where.AND[1].status);
    expect(sliceOrder).toEqual([
      'Open',
      'Pending', 'Needs Rework', 'Waiting on Customer',
      'Resolved', 'Fixed',
      'Closed',
      'Deleted',
    ]);
  });
});

// QA 08-06 #5 — plain-text descriptions must survive intake with angle-bracket
// tokens intact (<Processed> was eaten by the bare tag-stripping regex).
describe('ticketService plain-text descriptions (QA 08-06 #5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    armCreateDefaults();
  });

  // Fraser's exact shape: a Power Automate plain-text body with a bracketed
  // status token.
  const FRASER_DESCRIPTION = 'Approval request update from Power Automate\nStatus changed to <Processed>\nRecord ID: 1260';

  test("createTicket keeps <Processed> in descriptionText and escapes it into the HTML rendering", async () => {
    await ticketService.createTicket(1, {
      subject: 'Approval request update',
      description: FRASER_DESCRIPTION,
      requesterEmail: 'rita@example.com',
    }, actor);

    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    // Raw text (brackets intact) is the workflow-variable / API source.
    expect(data.descriptionText).toBe(FRASER_DESCRIPTION);
    expect(data.descriptionText).toContain('<Processed>');
    // The stored HTML rendering escapes the token and converts newlines.
    expect(data.description).toContain('&lt;Processed&gt;');
    expect(data.description).toContain('<br>');
    expect(data.description).not.toContain('<Processed>');
  });

  test('real HTML keeps the historical behavior (html stored, text stripped)', async () => {
    await ticketService.createTicket(1, {
      subject: 'Laptop will not boot',
      description: '<p>Screen stays <strong>black</strong></p>',
      requesterEmail: 'rita@example.com',
    }, actor);

    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.description).toBe('<p>Screen stays <strong>black</strong></p>');
    expect(data.descriptionText).toBe('Screen stays black');
  });

  test('updateTicketFields applies the same detector on edits', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042,
      freshserviceTicketId: null, subject: 'Approval request update', status: 'Open',
      priority: 2, description: null, descriptionText: null,
      internalCategoryId: null, internalSubcategoryId: null, groupId: null, internalGroupId: null,
      requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
      assignedTech: null, internalCategory: null, internalSubcategory: null,
    });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ id: 501, ...data }));
    ticketActivityRepositoryMock.create.mockResolvedValue({});

    await ticketService.updateTicketFields(501, 1, { description: FRASER_DESCRIPTION }, actor);

    const { data } = prismaMock.ticket.update.mock.calls[0][0];
    expect(data.descriptionText).toBe(FRASER_DESCRIPTION);
    expect(data.description).toContain('&lt;Processed&gt;');
  });
});

// QA 08-06 #1 — workspace default internal group for new tickets.
describe('ticketService workspace default group (QA 08-06 #1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    armCreateDefaults();
  });

  function armWorkspaceDefault(defaultInternalGroupId) {
    prismaMock.workspace.findUnique.mockResolvedValue({
      id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true, defaultInternalGroupId,
    });
  }

  test('applied when the caller sends neither groupId nor internalGroupId', async () => {
    armWorkspaceDefault(9);
    prismaMock.group.findFirst.mockResolvedValue({ id: 9, isActive: true });

    await ticketService.createTicket(1, {
      subject: 'Printer out of toner',
      requesterEmail: 'rita@example.com',
    }, actor);

    expect(prismaMock.group.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 9, workspaceId: 1, origin: 'local' }),
    }));
    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.internalGroupId).toBe(9);
  });

  test('NOT applied when the caller sends an internal group (override wins)', async () => {
    armWorkspaceDefault(9);
    prismaMock.group.findFirst.mockResolvedValue({ id: 5, isActive: true });

    await ticketService.createTicket(1, {
      subject: 'Printer out of toner',
      requesterEmail: 'rita@example.com',
      internalGroupId: 5,
    }, actor);

    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.internalGroupId).toBe(5);
    // The default id was never validated — only the explicit one.
    const validatedIds = prismaMock.group.findFirst.mock.calls.map(([args]) => args.where.id);
    expect(validatedIds).toEqual([5]);
  });

  test('NOT applied when the caller sends a FreshService group', async () => {
    armWorkspaceDefault(9);
    prismaMock.group.findFirst.mockImplementation(({ where }) => Promise.resolve(
      where.freshserviceId !== undefined
        ? { id: 3, name: 'Service Desk', isActive: true }
        : null,
    ));

    await ticketService.createTicket(1, {
      subject: 'Printer out of toner',
      requesterEmail: 'rita@example.com',
      groupId: 1000210021,
    }, actor);

    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.groupId).toBe(BigInt(1000210021));
    expect(data.internalGroupId).toBeNull();
  });

  test('an invalid default is ignored with a log — creation still succeeds', async () => {
    armWorkspaceDefault(999);
    prismaMock.group.findFirst.mockResolvedValue(null); // deleted / wrong workspace

    const result = await ticketService.createTicket(1, {
      subject: 'Printer out of toner',
      requesterEmail: 'rita@example.com',
    }, actor);

    expect(result.displayRef).toBe('TP-1042');
    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.internalGroupId).toBeNull();
  });

  test('no default configured — behavior unchanged (null group)', async () => {
    await ticketService.createTicket(1, {
      subject: 'Printer out of toner',
      requesterEmail: 'rita@example.com',
    }, actor);

    expect(prismaMock.group.findFirst).not.toHaveBeenCalled();
    const { data } = prismaMock.ticket.create.mock.calls[0][0];
    expect(data.internalGroupId).toBeNull();
  });
});

describe('ticketService per-user signatures on reply sends (Mega 08-15 Phase D)', () => {
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
  const signatureRow = {
    id: 7,
    workspaceId: 1,
    ownerEmail: 'coord@example.com',
    enabled: true,
    html: '<p><strong>Cora Coordinator</strong><br>IT Service Desk</p>',
    text: 'Cora Coordinator\nIT Service Desk',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...nativeTicket, ...data }));
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
    prismaMock.notificationDelivery.create.mockResolvedValue({});
    ticketActivityRepositoryMock.create.mockResolvedValue({});
    lifecycleMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
    sendgridMock.sendEmail.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'sg-1' });
  });

  test('TP-born reply: signature appends to the OUTBOUND email only — the stored thread entry stays clean', async () => {
    prismaMock.userEmailSignature.findUnique.mockResolvedValue(signatureRow);

    const { entry } = await ticketService.addReply(501, 1, { bodyHtml: '<p>Fixed it!</p>', bodyText: 'Fixed it!' }, actor);

    // The signature lookup keys on the ACTING agent's email in this workspace.
    expect(prismaMock.userEmailSignature.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_ownerEmail: { workspaceId: 1, ownerEmail: 'coord@example.com' } },
    });
    // Outbound email carries body + separator + signature…
    expect(sendgridMock.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      html: '<p>Fixed it!</p><br><br><p><strong>Cora Coordinator</strong><br>IT Service Desk</p>',
      text: expect.stringContaining('Fixed it!\n\n-- \nCora Coordinator'),
    }));
    // …while the persisted entry does NOT (decision: thread stays clean).
    expect(entry.bodyHtml).toBe('<p>Fixed it!</p>');
    expect(entry.bodyHtml).not.toContain('Cora Coordinator');
  });

  test('FS-born reply: signature rides the createReply body (FS emails the requester with it)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9) });
    prismaMock.userEmailSignature.findUnique.mockResolvedValue(signatureRow);
    fsClientMock.createReply.mockResolvedValue({ conversation: { id: 42010 } });

    const { entry } = await ticketService.addReply(501, 1, { bodyHtml: '<p>Fixed it!</p>', bodyText: 'Fixed it!' }, actor);

    expect(fsClientMock.createReply).toHaveBeenCalledWith(
      9,
      '<p>Fixed it!</p><br><br><p><strong>Cora Coordinator</strong><br>IT Service Desk</p>',
      { ccEmails: [], attachments: [] },
    );
    expect(entry.bodyHtml).toBe('<p>Fixed it!</p>');
  });

  test('internal notes never append the signature — either origin', async () => {
    prismaMock.userEmailSignature.findUnique.mockResolvedValue(signatureRow);
    await ticketService.addPrivateNote(501, 1, { bodyText: 'internal context' }, actor);
    // Notes skip the lookup entirely (replies-only decision).
    expect(prismaMock.userEmailSignature.findUnique).not.toHaveBeenCalled();

    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket, origin: 'freshservice', freshserviceTicketId: BigInt(9) });
    fsClientMock.addNote.mockResolvedValue({ conversation: { id: 42011 } });
    await ticketService.addPrivateNote(501, 1, { bodyText: 'fs-born internal' }, actor);
    // The TP note marker carries the actor NAME — assert on the signature's
    // distinctive content instead.
    expect(fsClientMock.addNote).toHaveBeenCalledWith(9, expect.not.stringContaining('IT Service Desk'), expect.anything());
  });

  test('no append when the signature is disabled or absent', async () => {
    prismaMock.userEmailSignature.findUnique.mockResolvedValue({ ...signatureRow, enabled: false });
    await ticketService.addReply(501, 1, { bodyHtml: '<p>Fixed it!</p>', bodyText: 'Fixed it!' }, actor);
    expect(sendgridMock.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ html: '<p>Fixed it!</p>' }));

    jest.clearAllMocks();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...nativeTicket, ...data }));
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9002, ...data }));
    prismaMock.notificationDelivery.create.mockResolvedValue({});
    sendgridMock.sendEmail.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'sg-2' });
    prismaMock.userEmailSignature.findUnique.mockResolvedValue(null);
    await ticketService.addReply(501, 1, { bodyHtml: '<p>Second try</p>', bodyText: 'Second try' }, actor);
    expect(sendgridMock.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ html: '<p>Second try</p>' }));
  });

  test('a signature lookup failure never blocks the reply (sends unsigned)', async () => {
    prismaMock.userEmailSignature.findUnique.mockRejectedValue(new Error('db hiccup'));
    const { entry, email } = await ticketService.addReply(501, 1, { bodyText: 'still goes out' }, actor);
    expect(email.sent).toBe(true);
    expect(entry.eventType).toBe('reply');
  });
});
