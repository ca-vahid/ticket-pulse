import { jest } from '@jest/globals';

// MEGA 09-01 Phase TU (TU-8/TU-9/TU-12) — engine side of ticket.fields_updated:
// the update_ticket node reports ONE event (actorKind workflow + producing
// workflowId), executeForEvent's gate (loop guard, FS opt-in, coalescing into
// a waiting run / parking a new one), the notifyActor recipient exclusion,
// the suppressRequesterAck requester drop, and the two DB-backed recipient
// tokens (last_replying_agent, watchers).

const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn(), findUnique: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  aiProviderAttempt: { updateMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketWatchSubscription: { findMany: jest.fn() },
  notificationEmailBlock: { findFirst: jest.fn(), findMany: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  groupMember: { findMany: jest.fn().mockResolvedValue([]) },
};
const processDeliveryMock = jest.fn();
const listEnabledForEventMock = jest.fn();
const emitFieldsUpdatedMock = jest.fn().mockResolvedValue({ status: 'completed' });
const setValuesMock = jest.fn();
const activityCreateMock = jest.fn().mockResolvedValue({ id: 1 });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({ processDelivery: processDeliveryMock }));
jest.unstable_mockModule('../src/services/notificationWorkflowRepository.js', () => ({
  default: { listEnabledForEvent: listEnabledForEventMock, recordSuppressionDecisions: jest.fn().mockResolvedValue({ updated: 0 }) },
}));
jest.unstable_mockModule('../src/services/notificationWorkflowPolicyService.js', () => ({
  enrichEventContextWithNotificationPolicy: jest.fn(async (context) => context),
  selectWorkflowsForNotificationTiming: jest.fn((workflows) => ({ selected: workflows, suppressed: [], mode: 'standard', reason: null })),
}));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: { sendJson: jest.fn(), runToolTurn: jest.fn() } }));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => ({
  enrichEventContextWithPublicStatusUrl: jest.fn(async (context) => ({ ...context, publicStatusUrl: 'https://tp.example/ticket-status/x' })),
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { _emitFieldsUpdated: emitFieldsUpdatedMock, updateFsTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/customFieldService.js', () => ({
  default: { setValues: setValuesMock, listDefinitions: jest.fn().mockResolvedValue([]) },
  prettifyKeyLabel: (key) => String(key),
  normalizeFieldKey: (key) => String(key),
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: activityCreateMock } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { enqueueFieldSync: jest.fn().mockResolvedValue({}), getInteractiveClient: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const {
  executeDefinition, executeForEvent, fieldsUpdatedGate, fieldsUpdatedTriggerOptions, recipientExclusions,
} = await import('../src/services/notificationWorkflowEngine.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');
const { buildFieldsUpdatedExtra } = await import('../src/services/ticketChangeRenderer.js');

function workflowFor(id, definition, overrides = {}) {
  return {
    id, workspaceId: 1, key: `wf_${id}`, name: `Workflow ${id}`, triggerType: definition.nodes[0].data.triggerType,
    routingMode: 'exclusive', routingPriority: 100, routingRule: null, isDefaultVariant: true, archivedAt: null,
    publishedVersion: 1, publishedDefinition: definition, versions: [{ id: id * 10, version: 1 }], mockModeEnabled: false,
    ...overrides,
  };
}

function fieldsDefinition({ coalesceMinutes = 0, includeFreshserviceChanges = false, notifyActor = false } = {}) {
  const definition = buildDefaultWorkflowDefinition('ticket.fields_updated');
  definition.nodes[0].data = { ...definition.nodes[0].data, coalesceMinutes, includeFreshserviceChanges, notifyActor };
  return definition;
}

const baseContext = {
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: {
    id: 501, workspaceId: 1, freshserviceTicketId: null, displayRef: 'TP-1042', subject: 'Laptop will not boot', status: 'Open',
    priorityLabel: 'High', isNoise: false, groupId: '1000210021', internalCategory: { id: 5, name: 'Hardware' }, internalSubcategory: null,
  },
  requester: { name: 'Rita', email: 'rita@example.com' },
  assignedAgent: { id: 17, name: 'Alex Agent', email: 'agent@example.com' },
  previousAgent: null,
};

async function fieldsEvent(changes, overrides = {}) {
  const extra = await buildFieldsUpdatedExtra({
    ticket: { id: 501, workspaceId: 1 }, changes, actor: { name: 'Alex Agent', email: 'agent@example.com', role: 'agent' }, resolveNames: false, auditRowId: 9001, ...overrides,
  });
  return {
    ...baseContext,
    event: { type: 'ticket.fields_updated', source: 'ticketpulse_native', occurredAt: '2026-09-02T10:00:00.000Z', dedupeStamp: `fields:501:${extra.auditRowId || Date.now()}`, extra },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  let runId = 900;
  prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: ++runId, ...data }));
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowRun.findFirst.mockResolvedValue(null);
  prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: Math.floor(Math.random() * 10000) + 1, ...data }));
  prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
  prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 1234, ...data }));
  prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
  prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
  prismaMock.aiProviderAttempt.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 501, workspaceId: 1, subject: 'Laptop will not boot', status: 'Open', requester: { email: 'rita@example.com' } });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketWatchSubscription.findMany.mockResolvedValue([]);
  prismaMock.notificationEmailBlock.findFirst.mockResolvedValue(null);
  prismaMock.notificationEmailBlock.findMany.mockResolvedValue([]);
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  processDeliveryMock.mockResolvedValue({ success: true, result: { provider: 'sendgrid' } });
  emitFieldsUpdatedMock.mockResolvedValue({ status: 'completed' });
});

describe('trigger options + gate', () => {
  test('defaults: coalesce 3 min, FS changes off, notifyActor off; stored values win', () => {
    expect(fieldsUpdatedTriggerOptions(workflowFor(1, buildDefaultWorkflowDefinition('ticket.fields_updated'))))
      .toEqual({ coalesceMinutes: 3, includeFreshserviceChanges: false, notifyActor: false });
    expect(fieldsUpdatedTriggerOptions(workflowFor(1, fieldsDefinition({ coalesceMinutes: 0, includeFreshserviceChanges: true, notifyActor: true }))))
      .toEqual({ coalesceMinutes: 0, includeFreshserviceChanges: true, notifyActor: true });
  });

  test('loop guard: the workflow that produced the change is skipped, a sibling is not', async () => {
    const ctx = await fieldsEvent({ priority: { from: 2, to: 3 } }, { actorKind: 'workflow', workflowId: 7, actorName: 'Notification workflow' });
    expect(await fieldsUpdatedGate(workflowFor(7, fieldsDefinition({ coalesceMinutes: 0 })), ctx))
      .toEqual(expect.objectContaining({ skip: true, reason: expect.stringContaining('Loop guard') }));
    expect(await fieldsUpdatedGate(workflowFor(8, fieldsDefinition({ coalesceMinutes: 0 })), ctx))
      .toEqual(expect.objectContaining({ parkMinutes: 0 }));

    listEnabledForEventMock.mockResolvedValue([workflowFor(7, fieldsDefinition({ coalesceMinutes: 0 }))]);
    const result = await executeForEvent(ctx, { triggerSource: 'test' });
    expect(result.results[0]).toEqual(expect.objectContaining({ workflowId: 7, status: 'skipped', reason: expect.stringContaining('Loop guard') }));
    expect(prismaMock.notificationWorkflowRun.create).not.toHaveBeenCalled();
  });

  test('FS-side changes are skipped unless the trigger opts in', async () => {
    const ctx = await fieldsEvent({ priority: { from: 2, to: 3 } }, { actorKind: 'freshservice', actorName: 'Sam FS', source: 'freshservice_sync' });
    expect(await fieldsUpdatedGate(workflowFor(7, fieldsDefinition({ coalesceMinutes: 0 })), ctx))
      .toEqual(expect.objectContaining({ skip: true, reason: expect.stringContaining('includeFreshserviceChanges') }));
    expect(await fieldsUpdatedGate(workflowFor(7, fieldsDefinition({ coalesceMinutes: 0, includeFreshserviceChanges: true })), ctx))
      .toEqual(expect.objectContaining({ parkMinutes: 0 }));
  });
});

describe('coalescing (park / merge)', () => {
  test('no waiting run → the new run is parked at the trigger for coalesceMinutes before any node runs', async () => {
    listEnabledForEventMock.mockResolvedValue([workflowFor(7, fieldsDefinition({ coalesceMinutes: 3 }))]);
    const result = await executeForEvent(await fieldsEvent({ priority: { from: 2, to: 3 } }), { triggerSource: 'test' });
    expect(result.results[0]).toEqual(expect.objectContaining({ status: 'waiting', coalescing: true, workflowId: 7, runId: 901 }));
    expect(prismaMock.notificationWorkflowRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workflowId: 7, ticketId: 501, eventType: 'ticket.fields_updated', status: 'waiting', resumeAt: { gt: expect.any(Date) } }),
    }));
    expect(prismaMock.notificationWorkflowRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 901 },
      data: expect.objectContaining({ status: 'waiting', resumeNodeId: 'trigger', resumeAt: expect.any(Date) }),
    }));
    expect(prismaMock.notificationWorkflowStepRun.create).not.toHaveBeenCalled();
    expect(processDeliveryMock).not.toHaveBeenCalled();
  });

  test('a waiting run absorbs the new diff: from = earliest, to = latest, changedFields union, no second run', async () => {
    const earlier = await fieldsEvent({ priority: { from: 1, to: 2 } });
    prismaMock.notificationWorkflowRun.findFirst.mockResolvedValue({ id: 555, eventContext: earlier, resumeAt: new Date(Date.now() + 120000) });
    listEnabledForEventMock.mockResolvedValue([workflowFor(7, fieldsDefinition({ coalesceMinutes: 3 }))]);

    const later = await fieldsEvent({ priority: { from: 2, to: 3 }, dueBy: { from: null, to: '2026-09-05T17:00:00.000Z' } });
    const result = await executeForEvent(later, { triggerSource: 'test' });

    expect(result.results[0]).toEqual(expect.objectContaining({ status: 'coalesced', workflowId: 7, runId: 555 }));
    expect(prismaMock.notificationWorkflowRun.create).not.toHaveBeenCalled();
    const { data } = prismaMock.notificationWorkflowRun.update.mock.calls.find(([args]) => args.where.id === 555)[0];
    const extra = data.eventContext.event.extra;
    expect(extra.changes.priority).toEqual(expect.objectContaining({ from: 1, to: 3, fromLabel: 'Low (1)', toLabel: 'High (3)' }));
    expect(extra.changedFields.sort()).toEqual(['dueBy', 'priority']);
    expect(extra.changedCount).toBe(2);
    expect(extra.coalescedEvents).toBe(2);
    expect(extra.changesText).toContain('Priority: Low (1) → High (3)');
  });

  test('an edit reverted within the window nets out (no phantom "changed" row)', async () => {
    const earlier = await fieldsEvent({ priority: { from: 2, to: 3 } });
    prismaMock.notificationWorkflowRun.findFirst.mockResolvedValue({ id: 556, eventContext: earlier, resumeAt: new Date(Date.now() + 120000) });
    listEnabledForEventMock.mockResolvedValue([workflowFor(7, fieldsDefinition({ coalesceMinutes: 3 }))]);
    await executeForEvent(await fieldsEvent({ priority: { from: 3, to: 2 } }), { triggerSource: 'test' });
    const { data } = prismaMock.notificationWorkflowRun.update.mock.calls.find(([args]) => args.where.id === 556)[0];
    expect(data.eventContext.event.extra.changedFields).toEqual([]);
  });

  test('coalesceMinutes 0 runs straight through (no park, delivery created)', async () => {
    listEnabledForEventMock.mockResolvedValue([workflowFor(7, fieldsDefinition({ coalesceMinutes: 0 }))]);
    const result = await executeForEvent(await fieldsEvent({ priority: { from: 2, to: 3 } }), { triggerSource: 'test' });
    expect(result.results[0].status).toBe('completed');
    expect(prismaMock.notificationWorkflowRun.findFirst).not.toHaveBeenCalled();
  });
});

describe('recipients', () => {
  test('notifyActor off drops the editing agent from To/Cc (and says so on the step); on keeps them', async () => {
    const ctx = await fieldsEvent({ priority: { from: 2, to: 3 } });
    ctx.event.triggerOptions = { notifyActor: false, coalesceMinutes: 0, includeFreshserviceChanges: false };
    const off = await executeDefinition({ workflow: workflowFor(7, fieldsDefinition()), definition: fieldsDefinition(), eventContext: ctx, dryRun: false, triggerSource: 'test' });
    const offStep = off.steps.find((s) => s.nodeType === 'recipient_resolver');
    expect(offStep.output.recipients.to).toEqual([]);
    expect(offStep.output.actorExcluded).toBe('agent@example.com');

    ctx.event.triggerOptions = { notifyActor: true, coalesceMinutes: 0, includeFreshserviceChanges: false };
    const on = await executeDefinition({ workflow: workflowFor(7, fieldsDefinition()), definition: fieldsDefinition(), eventContext: ctx, dryRun: false, triggerSource: 'test' });
    expect(on.steps.find((s) => s.nodeType === 'recipient_resolver').output.recipients.to).toEqual(['agent@example.com']);
  });

  test('the seeded default only reacts to human/API actors (visible condition)', async () => {
    const ctx = await fieldsEvent({ priority: { from: 2, to: 3 } }, { actorKind: 'workflow', actorName: 'Notification workflow', workflowId: 99 });
    const result = await executeDefinition({ workflow: workflowFor(7, fieldsDefinition()), definition: fieldsDefinition(), eventContext: ctx, dryRun: false, triggerSource: 'test' });
    const guard = result.steps.find((s) => s.nodeId === 'human-or-api');
    expect(guard.output.passed).toBe(false);
    expect(processDeliveryMock).not.toHaveBeenCalled();
  });

  test('suppressRequesterAck drops the requester (other recipients kept) and notes it on the step', async () => {
    const definition = buildDefaultWorkflowDefinition('ticket.created');
    const recipients = definition.nodes.find((n) => n.type === 'recipient_resolver');
    recipients.data = { ...recipients.data, to: ['requester', 'custom_emails'], customEmails: ['ops@example.com'] };
    const ctx = {
      ...baseContext,
      event: { type: 'ticket.created', source: 'ticketpulse_native', occurredAt: '2026-09-02T10:00:00.000Z', dedupeStamp: 'c1', extra: { suppressRequesterAck: true, actorKind: 'human', source: 'ticketpulse_native' } },
    };
    const result = await executeDefinition({ workflow: workflowFor(3, definition), definition, eventContext: ctx, dryRun: false, triggerSource: 'test' });
    const step = result.steps.find((s) => s.nodeType === 'recipient_resolver');
    expect(step.output.recipients.to).toEqual(['ops@example.com']);
    expect(step.output.requesterAckSuppressed).toBe('requester ack suppressed: agent already replied');
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ toRecipients: ['ops@example.com'] }),
    }));
    // Without the flag the requester stays.
    expect(recipientExclusions({ event: { type: 'ticket.created', extra: {} }, requester: { email: 'rita@example.com' } })).toEqual({ emails: [], output: {} });
  });

  test('last_replying_agent + watchers resolve from the DB (non-fatal when empty)', async () => {
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ actorEmail: 'last@example.com' });
    prismaMock.ticketWatchSubscription.findMany.mockResolvedValue([{ userEmail: 'watcher@example.com' }, { userEmail: 'watcher@example.com' }]);
    const definition = fieldsDefinition({ coalesceMinutes: 0, notifyActor: true });
    definition.nodes.find((n) => n.type === 'recipient_resolver').data.to = ['last_replying_agent', 'watchers'];
    const ctx = await fieldsEvent({ priority: { from: 2, to: 3 } });
    ctx.event.triggerOptions = { notifyActor: true };
    const result = await executeDefinition({ workflow: workflowFor(7, definition), definition, eventContext: ctx, dryRun: false, triggerSource: 'test' });
    const step = result.steps.find((s) => s.nodeType === 'recipient_resolver');
    expect(step.output.recipients.to).toEqual(['last@example.com', 'watcher@example.com']);
    expect(prismaMock.ticketThreadEntry.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketId: 501, authorType: 'agent', actorEmail: { not: null } }, orderBy: { occurredAt: 'desc' },
    }));
    expect(prismaMock.ticketWatchSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 1, OR: [{ scopeType: 'category', categoryId: { in: [5] } }, { scopeType: 'group', groupId: BigInt('1000210021') }] },
    }));
  });
});

describe('update_ticket node → ONE fields_updated (actorKind workflow, loop-guard id)', () => {
  test('priority + custom field from the node emit once with the producing workflowId; status excluded', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({
      id: 501, workspaceId: 1, origin: 'ticketpulse', status: 'Open', priority: 2, internalCategoryId: null, internalSubcategoryId: null, internalGroupId: null, createdAt: new Date('2026-09-01T00:00:00Z'),
    });
    setValuesMock.mockResolvedValue({ customFields: { client_location: 'X' }, changes: { client_location: { from: 'Quebec', to: 'X' } }, auditRowId: 55 });
    const definition = {
      version: 1,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggerType: 'ticket.created' } },
        { id: 'update', type: 'update_ticket', position: { x: 200, y: 0 }, data: { setPriority: 4, setCustomFields: { client_location: 'X' } } },
        { id: 'done', type: 'stop', position: { x: 400, y: 0 }, data: {} },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'update' }, { id: 'e2', source: 'update', target: 'done' }],
    };
    const ctx = {
      ...baseContext,
      event: { type: 'ticket.created', source: 'ticketpulse_native', occurredAt: '2026-09-02T10:00:00.000Z', dedupeStamp: 'c2' },
    };
    const result = await executeDefinition({ workflow: workflowFor(42, definition), definition, eventContext: ctx, dryRun: false, triggerSource: 'test' });
    expect(result.status).toBe('completed');
    expect(setValuesMock).toHaveBeenCalledWith(501, 1, { client_location: 'X' }, expect.objectContaining({ role: 'workflow' }), { emitEvent: false });
    expect(emitFieldsUpdatedMock).toHaveBeenCalledTimes(1);
    const [args] = emitFieldsUpdatedMock.mock.calls[0];
    expect(args).toEqual(expect.objectContaining({ actorKind: 'workflow', workflowId: 42, source: 'workflow:42', auditRowId: 55 }));
    expect(Object.keys(args.changes).sort()).toEqual(['customFields.client_location', 'priority']);
    expect(args.changes.priority).toEqual({ from: 2, to: 4 });
    expect(args.changes).not.toHaveProperty('status');
  });
});
