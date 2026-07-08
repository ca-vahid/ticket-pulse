import { jest } from '@jest/globals';

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn() },
  notificationDelivery: { create: jest.fn() },
  ticketActivity: { findMany: jest.fn() },
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
