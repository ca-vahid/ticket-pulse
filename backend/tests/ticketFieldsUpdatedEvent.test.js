import { jest } from '@jest/globals';

// MEGA 09-01 Phase TU (TU-5/TU-12) — the `ticket.fields_updated` choke point
// at the ticketService level: ONE event per PATCH (field + due + cc + custom
// field diff merged), a standalone custom-field edit reports through the
// registered emitter, an aggregating caller can silence the per-call event,
// and the FS write-back fires for FIELD keys only (status/assignee have
// their own triggers). The lifecycle service is mocked — we pin the CONTRACT
// of what reaches emitTicketEvent, not the engine.

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  ticketThreadEntry: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  notificationDelivery: { create: jest.fn() },
  ticketActivity: { findMany: jest.fn().mockResolvedValue([]) },
  customFieldDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, key: 'client_location', label: 'Client location', type: 'text', options: [], isActive: true, sortOrder: 0 },
      { id: 2, workspaceId: 1, key: 'budget', label: 'Budget', type: 'number', options: [], isActive: true, sortOrder: 1 },
    ]),
  },
  ticketTypeDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Incident', aliases: ['incident'], isActive: true, aiAssignable: true, isDefault: true, fsTypeValue: 'Incident', sortOrder: 0 },
    ]),
  },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  assignmentPipelineRun: { findFirst: jest.fn().mockResolvedValue(null) },
  userEmailSignature: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};
const ticketActivityRepositoryMock = { create: jest.fn() };
const lifecycleMock = {
  emitTicketLifecycleNotifications: jest.fn().mockResolvedValue({ status: 'completed' }),
  emitTicketEvent: jest.fn().mockResolvedValue({ status: 'completed' }),
};
const fsClientMock = { updateTicketFields: jest.fn(), getTicket: jest.fn(), fetchRequester: jest.fn(), createReply: jest.fn(), addNote: jest.fn() };
const mirrorServiceMock = {
  enqueueTicketCreate: jest.fn().mockResolvedValue({ id: 1 }),
  enqueueFieldSync: jest.fn().mockResolvedValue({ id: 2 }),
  enqueueThreadEntry: jest.fn().mockResolvedValue({ id: 3 }),
  getClient: jest.fn().mockResolvedValue(fsClientMock),
  getInteractiveClient: jest.fn().mockResolvedValue(fsClientMock),
  resolveDepartmentId: jest.fn(),
};
const dispatchWebhookEventMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: ticketActivityRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn().mockResolvedValue([]) } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: jest.fn(() => false), sendMailAsMailbox: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorServiceMock }));
jest.unstable_mockModule('../src/services/webhookDispatchService.js', () => ({
  default: { dispatchWebhookEvent: dispatchWebhookEventMock },
  dispatchWebhookEvent: dispatchWebhookEventMock,
  WEBHOOK_EVENTS: ['ticket.custom_fields_changed', 'ticket.fields_updated'],
}));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: { isConfigured: jest.fn(() => false), validateUpload: jest.fn(), upload: jest.fn(), ingestForFsTicket: jest.fn(async () => ({ ingested: 0 })) },
  MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
  MAX_ATTACHMENTS_PER_TICKET: 20,
}));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { default: customFieldService } = await import('../src/services/customFieldService.js');

const human = { email: 'cora@example.com', name: 'Cora Coordinator', role: 'admin', technicianId: null };
const apiActor = { email: 'apikey:tp_live_x', name: 'Coreshack intake', role: 'api', technicianId: null };

const nativeTicket = {
  id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null,
  subject: 'Laptop will not boot', status: 'Open', priority: 2, createdAt: new Date('2026-08-01T10:00:00Z'),
  assignedTechId: null, dueBy: null, dueBySetBy: null, frDueBy: null,
  internalCategoryId: null, internalSubcategoryId: null, groupId: null, internalGroupId: null,
  ccEmails: [], customFields: { client_location: 'Quebec' },
  requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
  assignedTech: null, internalCategory: null, internalSubcategory: null,
};

const fieldsEvents = () => lifecycleMock.emitTicketEvent.mock.calls.filter(([type]) => type === 'ticket.fields_updated');

beforeEach(() => {
  jest.clearAllMocks();
  let auditId = 9000;
  ticketActivityRepositoryMock.create.mockImplementation(async (data) => ({ id: ++auditId, ...data }));
  prismaMock.ticket.findFirst.mockResolvedValue({ ...nativeTicket });
  prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...nativeTicket, ...data }));
});

describe('updateTicketFields → ONE ticket.fields_updated per PATCH', () => {
  test('priority + due date + custom field in one PATCH → one event with the merged diff, stamped by the first audit row', async () => {
    await ticketService.updateTicketFields(501, 1, {
      priority: 3, dueBy: '2026-08-08T23:59:00.000Z', customFields: { client_location: 'Montreal' },
    }, human);

    const events = fieldsEvents();
    expect(events).toHaveLength(1);
    const [, ticketId, options] = events[0];
    expect(ticketId).toBe(501);
    expect(options.dedupeStamp).toMatch(/^fields:501:\d+$/);
    const { extra } = options;
    expect(extra.actorKind).toBe('human');
    expect(extra.actorName).toBe('Cora Coordinator');
    expect(extra.actorEmail).toBe('cora@example.com');
    expect(extra.source).toBe('app');
    expect(extra.reopened).toBe(false);
    expect(extra.changedFields.sort()).toEqual(['customFields.client_location', 'dueBy', 'priority']);
    expect(extra.changedCount).toBe(3);
    expect(extra.changes.priority).toEqual(expect.objectContaining({ from: 2, to: 3, label: 'Priority', fromLabel: 'Medium (2)', toLabel: 'High (3)' }));
    expect(extra.changes['customFields.client_location']).toEqual(expect.objectContaining({ from: 'Quebec', to: 'Montreal', label: 'Custom field: client_location' }));
    expect(extra.changesTableHtml).toContain('<td><strong>Priority</strong></td><td>Medium (2)</td><td>High (3)</td>');
    expect(extra.changesText).toContain('Priority: Medium (2) → High (3)');
    expect(extra.changesList).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'dueBy', label: 'Due by' })]));
    // The audit rows still land (fields_updated + due_changed + custom_fields_changed) — one EVENT.
    const auditTypes = ticketActivityRepositoryMock.create.mock.calls.map(([a]) => a.activityType);
    expect(auditTypes).toEqual(expect.arrayContaining(['fields_updated', 'due_changed', 'custom_fields_changed']));
  });

  test('custom-fields-only PATCH → one event (setValues does not double-fire)', async () => {
    await ticketService.updateTicketFields(501, 1, { customFields: { client_location: 'Montreal' } }, human);
    expect(fieldsEvents()).toHaveLength(1);
    expect(fieldsEvents()[0][2].extra.changedFields).toEqual(['customFields.client_location']);
  });

  test('description change renders as "changed" only — never the body', async () => {
    await ticketService.updateTicketFields(501, 1, { description: '<p>secret requester text</p>' }, human);
    const { extra } = fieldsEvents()[0][2];
    expect(extra.changes.description).toEqual(expect.objectContaining({ toLabel: 'changed', changed: true }));
    expect(JSON.stringify(extra)).not.toContain('secret requester text');
  });

  test('a no-op PATCH (same value) emits nothing', async () => {
    await ticketService.updateTicketFields(501, 1, { priority: 2 }, human);
    expect(fieldsEvents()).toHaveLength(0);
  });

  test('emitEvent:false silences the per-call event (aggregating callers fire their own)', async () => {
    await ticketService.updateTicketFields(501, 1, { priority: 4, customFields: { budget: 1500 } }, apiActor, { emitEvent: false });
    expect(fieldsEvents()).toHaveLength(0);
  });

  test('API principal → actorKind api, source api:<key name>, no actorEmail leak of the key pseudo-address', async () => {
    await ticketService.updateTicketFields(501, 1, { priority: 4 }, apiActor);
    const { extra } = fieldsEvents()[0][2];
    expect(extra.actorKind).toBe('api');
    expect(extra.source).toBe('api:Coreshack intake');
    expect(extra.actorEmail).toBeNull();
  });
});

describe('customFieldService.setValues standalone → the registered emitter', () => {
  test('fires one fields_updated keyed customFields.<key> (only real changes)', async () => {
    await customFieldService.setValues(501, 1, { client_location: 'Montreal', budget: null }, human);
    const events = fieldsEvents();
    expect(events).toHaveLength(1);
    expect(events[0][2].extra.changedFields).toEqual(['customFields.client_location']);
    expect(events[0][2].dedupeStamp).toMatch(/^fields:501:\d+$/);
  });

  test('emitEvent:false → nothing (updateTicketFields / the workflow node own the event)', async () => {
    await customFieldService.setValues(501, 1, { client_location: 'Montreal' }, human, { emitEvent: false });
    expect(fieldsEvents()).toHaveLength(0);
  });
});

describe('_emitFieldsUpdated contract', () => {
  test('empty change set → no event; resubmission source + reopened ride through', async () => {
    expect(await ticketService._emitFieldsUpdated({ ticket: nativeTicket, changes: {}, actor: apiActor })).toBeNull();
    await ticketService._emitFieldsUpdated({
      ticket: nativeTicket, changes: { priority: { from: 2, to: 3 }, category: { from: 'Project Setup › Quebec', to: 'Proposal Setup' } },
      actor: apiActor, source: 'api:resubmission', reopened: true, auditRowId: 77,
    });
    const [, , options] = fieldsEvents()[0];
    expect(options.dedupeStamp).toBe('fields:501:77');
    expect(options.extra).toEqual(expect.objectContaining({ actorKind: 'api', source: 'api:resubmission', reopened: true, changedCount: 2, auditRowId: 77 }));
    expect(options.extra.changes.category.label).toBe('Category');
  });

  test('event-level actor kinds collapse the audit vocabulary (freshservice_sync → freshservice, ai → system)', async () => {
    await ticketService._emitFieldsUpdated({ ticket: nativeTicket, changes: { priority: { from: 1, to: 2 } }, actorKind: 'freshservice_sync', actorName: 'Sam FS' });
    await ticketService._emitFieldsUpdated({ ticket: nativeTicket, changes: { priority: { from: 2, to: 3 } }, actorKind: 'ai' });
    expect(fieldsEvents()[0][2].extra).toEqual(expect.objectContaining({ actorKind: 'freshservice', actorName: 'Sam FS', source: 'freshservice_sync' }));
    expect(fieldsEvents()[1][2].extra.actorKind).toBe('system');
  });

  test('the engine dispatch is fire-and-forget: a lifecycle failure never throws out of the write path', async () => {
    lifecycleMock.emitTicketEvent.mockRejectedValueOnce(new Error('engine down'));
    await expect(ticketService._emitFieldsUpdated({ ticket: nativeTicket, changes: { priority: { from: 1, to: 2 } }, actor: human }))
      .resolves.toEqual(expect.objectContaining({ dispatched: true, changedFields: ['priority'] }));
    lifecycleMock.emitTicketEvent.mockImplementationOnce(() => { throw new Error('sync throw'); });
    await expect(ticketService._emitFieldsUpdated({ ticket: nativeTicket, changes: { priority: { from: 1, to: 2 } }, actor: human })).resolves.toBeNull();
  });
});

describe('updateFsTicket → fields_updated for FIELD keys only', () => {
  const fsBornTicket = {
    ...nativeTicket,
    id: 601, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: BigInt(231309), priority: 3,
    assignedTechId: 3, firstAssignedAt: new Date('2026-08-01T11:00:00Z'), resolvedAt: null, closedAt: null,
    tpSkill: null, tpSubskill: null, assignedTech: { id: 3, name: 'Ava Original' }, customFields: {},
  };

  beforeEach(() => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true, tpSkillCustomField: 'tp_skill', tpSubskillCustomField: 'tp_subskill' });
    prismaMock.ticket.findFirst.mockResolvedValue({ ...fsBornTicket });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({ ...fsBornTicket, ...data }));
  });

  test('priority write-back → one event with changes.priority (actorKind human)', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ priority: 2, updated_at: '2026-08-04T10:00:00Z' });
    await ticketService.updateFsTicket(601, 1, { priority: 2 }, human);
    const events = fieldsEvents();
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBe(601);
    expect(events[0][2].extra.changedFields).toEqual(['priority']);
    expect(events[0][2].extra.changes.priority).toEqual(expect.objectContaining({ from: 3, to: 2 }));
  });

  test('status-only write-back → NO fields_updated (status_changed owns it)', async () => {
    fsClientMock.updateTicketFields.mockResolvedValue({ status: 5, updated_at: '2026-08-04T10:00:00Z' });
    await ticketService.updateFsTicket(601, 1, { status: 'Closed' }, human);
    expect(fieldsEvents()).toHaveLength(0);
  });
});

describe('createTicket suppressRequesterAck (mail-in agent-Cc intake)', () => {
  test('ticket.created still fires, with the ack-suppression flag plumbed to the lifecycle emit', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true });
    const { default: requesterRepository } = await import('../src/services/requesterRepository.js');
    requesterRepository.findByEmail.mockResolvedValue({ id: 40, name: 'Rita Requester', email: 'rita@example.com', department: null, freshserviceId: null });
    const { default: noiseRuleService } = await import('../src/services/noiseRuleService.js');
    noiseRuleService.evaluate.mockResolvedValue({ isNoise: false, ruleId: null });
    prismaMock.$queryRaw.mockResolvedValue([{ nextval: 1042 }]);
    prismaMock.ticket.create.mockImplementation(({ data }) => Promise.resolve({
      id: 777, ...data, requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' }, assignedTech: null, internalCategory: null, internalSubcategory: null,
    }));
    prismaMock.ticket.findUnique.mockResolvedValue(null);

    await ticketService.createTicket(1, {
      subject: 'Cc intake', description: 'agent replied already', requesterEmail: 'rita@example.com', runAiTriage: false, notifyRequester: true,
    }, human, { createdVia: 'agent_cc', suppressRequesterAck: true });

    expect(lifecycleMock.emitTicketLifecycleNotifications).toHaveBeenCalledTimes(1);
    const [args] = lifecycleMock.emitTicketLifecycleNotifications.mock.calls[0];
    expect(args.allowNotificationWorkflows).toBe(true);
    expect(args.suppressRequesterAck).toBe(true);
    expect(args.upsertedTicket.suppressRequesterAck).toBe(true);
    expect(args.upsertedTicket.createdVia).toBe('agent_cc');
    // Existing notifyRequester:false semantics untouched: default create path carries no flag.
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'created', details: expect.objectContaining({ requesterAckSuppressed: true }),
    }));
  });
});
