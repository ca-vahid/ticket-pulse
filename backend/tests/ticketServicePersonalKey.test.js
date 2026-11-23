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
const lifecycleMock = { emitTicketLifecycleNotifications: jest.fn(), emitTicketEvent: jest.fn().mockResolvedValue({ status: 'completed' }) };
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
// Graph mailbox lane (Phase MB-1): off by default so the legacy SendGrid
// assertions hold; individual tests arm isConfigured + a mailbox connection.
const graphMailClientMock = { isConfigured: jest.fn(() => false), sendMailAsMailbox: jest.fn() };
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMailClientMock }));
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
// Attachment storage (Phase CC attachment tests): "configured", accepts any
// upload, returns a stored row so the reply path can build mailable copies.
const attachmentServiceMock = {
  isConfigured: jest.fn(() => true),
  validateUpload: jest.fn(),
  upload: jest.fn(async ({ fileName, contentType }) => ({ id: 77, fileName, contentType })),
  ingestForFsTicket: jest.fn(async () => ({ ingested: 0 })),
};
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: attachmentServiceMock,
  MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
  MAX_ATTACHMENTS_PER_TICKET: 20,
}));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { invalidateStatusCache } = await import('../src/services/statusService.js');

/**
 * Personal API keys (4.4.05): a v1 reply made with a personal key reaches
 * ticketService.addReply with the person's actor + `via`. The thread entry is
 * the person's (actorEmail, name), it remembers which key sent it
 * (rawPayload.sentWithApiKey), the mail carries THEIR signature, and history
 * rows say actorKind 'personal_key'. The same calls with an integration actor
 * are pinned unchanged.
 */
const personalActor = {
  email: 'dana.fox@example.com', name: 'Dana Fox', role: 'agent', workspaceRole: null, technicianId: 12, kind: 'agent',
  trustedIntake: false, defaultSource: null, via: { kind: 'personal_key', keyId: 31, keyName: 'Laptop script' },
};
const integrationActor = { email: 'apikey:tp_live_integrat', name: 'Power App', role: 'api', technicianId: null, trustedIntake: false, defaultSource: null };
const nativeTicket = {
  id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null,
  subject: 'Printer offline', status: 'Open', priority: 3, createdAt: new Date('2026-11-20T10:00:00Z'),
  assignedTechId: null, firstAssignedAt: null, firstPublicAgentReplyAt: null, resolutionTimeSeconds: null, resolvedAt: null,
  internalCategoryId: null, internalSubcategoryId: null, groupId: null,
  requester: { id: 40, name: 'Sam Okafor', email: 'sam.okafor@example.com' },
  assignedTech: null, internalCategory: null, internalSubcategory: null,
};
const danaSignature = { id: 7, workspaceId: 1, ownerEmail: 'dana.fox@example.com', enabled: true, html: '<p><strong>Dana Fox</strong><br>IT Service Desk</p>', text: 'Dana Fox\nIT Service Desk' };

describe('ticketService with a personal-key actor (4.4.05)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...nativeTicket, ...data }));
    prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
    prismaMock.notificationDelivery.create.mockResolvedValue({});
    ticketActivityRepositoryMock.create.mockResolvedValue({});
    lifecycleMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
    sendgridMock.sendEmail.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'sg-1' });
    prismaMock.userEmailSignature.findUnique.mockImplementation(({ where }) => Promise.resolve(where.workspaceId_ownerEmail.ownerEmail === 'dana.fox@example.com' ? danaSignature : null));
  });

  test('the reply entry is the person\'s, remembers the key, and the mail carries their signature', async () => {
    const { entry } = await ticketService.addReply(501, 1, { bodyHtml: '<p>Fixed it.</p>', bodyText: 'Fixed it.' }, personalActor);
    expect(prismaMock.userEmailSignature.findUnique).toHaveBeenCalledWith({ where: { workspaceId_ownerEmail: { workspaceId: 1, ownerEmail: 'dana.fox@example.com' } } });
    expect(entry).toEqual(expect.objectContaining({ actorEmail: 'dana.fox@example.com', actorName: 'Dana Fox', authorType: 'agent', source: 'ticketpulse_user', eventType: 'reply' }));
    expect(entry.rawPayload.sentWithApiKey).toEqual({ id: 31, name: 'Laptop script' });
    expect(entry.rawPayload.sentSignature).toEqual(expect.objectContaining({ text: 'Dana Fox\nIT Service Desk' }));
    const mailed = sendgridMock.sendEmail.mock.calls[0][0].html;
    expect(mailed.split('Dana Fox').length - 1).toBe(1);
  });

  test('a note through a personal key remembers the key too (and carries no signature)', async () => {
    const { entry } = await ticketService.addPrivateNote(501, 1, { bodyText: 'Queue resumed.' }, personalActor);
    expect(entry.rawPayload).toEqual({ sentWithApiKey: { id: 31, name: 'Laptop script' } });
    expect(entry.actorEmail).toBe('dana.fox@example.com');
  });

  test('integration-key entries are unchanged: no sentWithApiKey, the apikey: actor, no signature', async () => {
    const { entry } = await ticketService.addReply(501, 1, { bodyHtml: '<p>Fixed it.</p>', bodyText: 'Fixed it.' }, integrationActor);
    expect(entry.actorEmail).toBe('apikey:tp_live_integrat');
    expect(entry.actorName).toBe('Power App');
    expect(entry.rawPayload?.sentWithApiKey).toBeUndefined();
    expect(entry.rawPayload?.sentSignature).toBeUndefined();
    const note = await ticketService.addPrivateNote(501, 1, { bodyText: 'x' }, integrationActor);
    expect(note.entry.rawPayload).toBeUndefined();
  });

  test('history rows say actorKind personal_key with via; other actors keep their kinds', async () => {
    await ticketService._audit(501, 'fields_updated', personalActor, { changes: { priority: { from: 2, to: 3 } } });
    expect(ticketActivityRepositoryMock.create).toHaveBeenLastCalledWith(expect.objectContaining({
      performedBy: 'Dana Fox',
      details: expect.objectContaining({ actorEmail: 'dana.fox@example.com', actorKind: 'personal_key', via: { kind: 'personal_key', keyId: 31, keyName: 'Laptop script' } }),
    }));
    await ticketService._audit(501, 'fields_updated', integrationActor, {});
    const apiDetails = ticketActivityRepositoryMock.create.mock.calls.at(-1)[0].details;
    expect(apiDetails.actorKind).toBe('api');
    expect(apiDetails).not.toHaveProperty('via');
    await ticketService._audit(501, 'fields_updated', { email: 'eli.park@example.com', name: 'Eli Park', role: 'viewer' }, {});
    expect(ticketActivityRepositoryMock.create.mock.calls.at(-1)[0].details.actorKind).toBe('human');
  });
});

describe('status changes through a personal key (review #10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateStatusCache();
    prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...nativeTicket, ...data }));
    prismaMock.ticketAssignmentEpisode.updateMany.mockResolvedValue({ count: 0 });
    ticketActivityRepositoryMock.create.mockResolvedValue({});
    lifecycleMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
  });

  test('the lifecycle (and so the status webhook) is told resolvedVia personal_key; resolvedByKind stays human', async () => {
    await ticketService.changeStatus(501, 1, 'Resolved', personalActor);
    expect(prismaMock.ticket.update.mock.calls[0][0].data.resolvedByKind).toBe('human');
    expect(lifecycleMock.emitTicketLifecycleNotifications).toHaveBeenCalledWith(expect.objectContaining({
      resolvedVia: 'personal_key',
      actor: { name: 'Dana Fox', email: 'dana.fox@example.com', technicianId: 12 },
    }));
  });

  test('integration-key and in-app status changes carry no resolvedVia', async () => {
    await ticketService.changeStatus(501, 1, 'Resolved', integrationActor);
    expect(lifecycleMock.emitTicketLifecycleNotifications.mock.calls[0][0]).not.toHaveProperty('resolvedVia');
  });
});

describe('actorKind for personal keys', () => {
  test('stored personal_key rows read back as personal_key, a person (not machine); actorKindOf never returns it', async () => {
    const { deriveActorKind, actorKindOf, isMachineActorKind } = await import('../src/utils/actorKind.js');
    expect(deriveActorKind({ performedBy: 'Dana Fox', details: { actorKind: 'personal_key' } })).toBe('personal_key');
    expect(isMachineActorKind('personal_key')).toBe(false);
    // Workflows (event.actorKind) see the person as human, exactly as in the app.
    expect(actorKindOf(personalActor)).toBe('human');
  });
});
