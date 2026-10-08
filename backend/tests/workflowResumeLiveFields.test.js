import { jest } from '@jest/globals';

/**
 * A workflow resumed after a delay continues on the ticket AS IT IS NOW
 * (Vahid, 26 Sep 2026): status (+ base), priority, assignee, group, noise,
 * park, resolver and internal category are re-read from the database; the
 * rest of the stored (audit) context is kept. The seeded "Follow-up nudge"
 * (wait a day → status in Open/Pending → e-mail) must NOT mail a ticket that
 * was resolved during the wait, and must mail one that is still open.
 * Harness from notificationWorkflowOrchestration.test.js.
 */
const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflow: { findUnique: jest.fn(), findFirst: jest.fn() },
  notificationWorkflowVersion: { findUnique: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  notificationEmailBlock: { findFirst: jest.fn(), findMany: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  technician: { findUnique: jest.fn() },
  ticketActivity: { create: jest.fn(), findUnique: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  notificationDelivery: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
};
const processDelivery = jest.fn().mockResolvedValue({ success: true, status: 'sent' });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({ processDelivery }));
const realStatus = await import('../src/services/statusService.js');
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  ...realStatus,
  default: { ...realStatus.default, resolveBaseStatus: jest.fn(async (_ws, s) => ({ 'Waiting on Vendor': 'Pending', Resolved: 'Resolved', Closed: 'Closed', Pending: 'Pending' }[s] || 'Open')) },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { resumeWaitingRuns, refreshLiveTicketFields } = await import('../src/services/notificationWorkflowEngine.js');
const { WORKFLOW_TEMPLATES } = await import('../src/services/notificationWorkflowDefinition.js');

const nudge = WORKFLOW_TEMPLATES.find((t) => t.key === 'follow_up_nudge').build();
// Trigger-time context (the audit copy the run row holds): the ticket was Open.
const stored = {
  event: { type: 'ticket.public_reply_added', source: 'test', occurredAt: '2026-09-25T10:00:00.000Z', dedupeStamp: 'reply:1' },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: {
    id: 100, freshserviceTicketId: 225010, displayRef: '#225010', subject: 'VPN access problem', status: 'Open', statusBase: 'Open',
    priority: 2, priorityLabel: 'Medium', isNoise: false, parkKind: null, resolvedByKind: null, tags: ['vpn'], customFields: { site: 'VAN' },
  },
  requester: { name: 'Rita', email: 'rita@example.com' },
  assignedAgent: null,
  previousAgent: null,
};
const dbTicket = (over = {}) => ({
  id: 100, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: BigInt(225010), subject: 'VPN access problem',
  status: 'Open', priority: 2, assessedPriority: null, groupId: null, isNoise: false, parkedUntil: null, parkKind: null, resolvedByKind: null,
  assignedTechId: null, assignedTech: null, internalCategory: null, internalSubcategory: null, createdAt: new Date(),
  workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' }, requester: { id: 4, name: 'Rita', email: 'rita@example.com' },
  toEmails: [], ccEmails: [], replyCcEmails: [], fwdEmails: [],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
  prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
  prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 77, ...data }));
  prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.notificationEmailBlock.findFirst.mockResolvedValue(null);
  prismaMock.notificationEmailBlock.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.notificationWorkflow.findFirst.mockResolvedValue(null);
  prismaMock.notificationWorkflow.findUnique.mockResolvedValue({
    id: 40, workspaceId: 1, triggerType: 'ticket.public_reply_added', publishedVersion: 1, publishedDefinition: nudge, versions: [],
  });
  prismaMock.notificationWorkflowRun.findMany.mockImplementation(async (args) => (args?.where?.status === 'waiting' ? [{
    id: 950, workflowId: 40, workflowVersionId: null, workspaceId: 1, ticketId: 100, eventContext: stored, dryRun: false,
    executionMode: 'live', triggerSource: 'test', status: 'waiting', resumeAt: new Date(Date.now() - 1000), resumeNodeId: 'still-open',
    resumeState: { state: {}, hints: { ticketId: 100 } },
  }] : []));
});

async function resumeWithTicket(over) {
  prismaMock.ticket.findUnique.mockResolvedValue(dbTicket(over));
  const summary = await resumeWaitingRuns();
  expect(summary).toEqual({ due: 1, resumed: 1 });
}

describe('delay resume reads the live ticket', () => {
  test('resolved during the wait → the nudge is NOT sent', async () => {
    await resumeWithTicket({ status: 'Resolved' });
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
    expect(processDelivery).not.toHaveBeenCalled();
  });

  test('still open after the wait → the nudge IS sent', async () => {
    await resumeWithTicket({ status: 'Pending' });
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledTimes(1);
    expect(processDelivery).toHaveBeenCalledTimes(1);
  });

  test('Auto-help took the ticket over during the wait (park auto_help) → no second nudge', async () => {
    await resumeWithTicket({ status: 'Pending', parkedUntil: new Date(Date.now() + 86400e3), parkKind: 'auto_help' });
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
  });
});

describe('refreshLiveTicketFields', () => {
  test('refreshes status, base, priority, assignee, group, noise, park, resolver, category — keeps the rest of the audit copy', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(dbTicket({
      status: 'Waiting on Vendor', priority: 4, assessedPriority: 'Urgent', groupId: BigInt(900040), isNoise: true,
      parkedUntil: new Date('2026-10-01T16:00:00Z'), parkKind: 'waiting_on', resolvedByKind: null,
      assignedTechId: 9, assignedTech: { id: 9, name: 'Susan Xu', email: 'susan@example.com' },
      internalCategory: { id: 10, name: 'Network' }, internalSubcategory: { id: 11, name: 'VPN' },
    }));
    const next = await refreshLiveTicketFields(stored, nudge);
    expect(next.ticket).toMatchObject({
      status: 'Waiting on Vendor', statusBase: 'Pending', priority: 4, priorityLabel: 'Urgent', groupId: '900040', isNoise: true,
      isParked: true, parkKind: 'waiting_on', parkedUntil: '2026-10-01T16:00:00.000Z', resolvedByKind: null,
      internalCategory: { id: 10, name: 'Network' }, internalSubcategory: { id: 11, name: 'VPN' },
    });
    expect(next.assignedAgent).toEqual({ id: 9, name: 'Susan Xu', email: 'susan@example.com' });
    // Untouched: the trigger-time event, tags, custom fields, requester.
    expect(next.event).toBe(stored.event);
    expect(next.ticket.tags).toEqual(['vpn']);
    expect(next.ticket.customFields).toEqual({ site: 'VAN' });
    expect(next.requester).toBe(stored.requester);
    expect(stored.ticket.status).toBe('Open'); // the stored copy is not mutated
  });

  // QA 10-07 #4: Power Automate sends bst_number seconds after an agent closes
  // the ticket by hand. A Wait step now lets it reach the e-mail.
  test('custom fields are read live, so a field that arrived during the wait is there', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(dbTicket({ customFields: { site: 'VAN', bst_number: 'P26667', project_accountant: 'Gisalie Galanos' } }));
    const next = await refreshLiveTicketFields(stored, nudge);
    expect(next.ticket.customFields).toEqual({ site: 'VAN', bst_number: 'P26667', project_accountant: 'Gisalie Galanos' });
    expect(prismaMock.ticket.findUnique.mock.calls[0][0].select.customFields).toBe(true);
    expect(stored.ticket.customFields).toEqual({ site: 'VAN' });
  });

  test('an unreadable ticket keeps the stored copy', async () => {
    prismaMock.ticket.findUnique.mockRejectedValue(new Error('db blip'));
    const next = await refreshLiveTicketFields(stored, nudge);
    expect(next.ticket.status).toBe('Open');
  });
});

describe('audit S4: dates refresh with the status; event.* stays the trigger-time record', () => {
  test('resolvedAt, closedAt, dueBy and frDueBy are read live alongside status', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(dbTicket({
      status: 'Resolved', resolvedAt: new Date('2026-09-26T15:00:00Z'), closedAt: null,
      dueBy: new Date('2026-09-29T16:00:00Z'), frDueBy: new Date('2026-09-26T17:00:00Z'),
    }));
    const next = await refreshLiveTicketFields({ ...stored, ticket: { ...stored.ticket, resolvedAt: null, closedAt: '2026-09-01T00:00:00.000Z', dueBy: '2026-09-27T00:00:00.000Z', frDueBy: null } }, nudge);
    expect(next.ticket).toMatchObject({
      status: 'Resolved', resolvedAt: '2026-09-26T15:00:00.000Z', closedAt: null, dueBy: '2026-09-29T16:00:00.000Z', frDueBy: '2026-09-26T17:00:00.000Z',
    });
  });

  // Prod inventory 26 Sep: #12874 (ws5 "Ticket updated (fields)", coalesced)
  // conditions on the change set AND ticket.isNoise. The change set is the
  // trigger-time (merged) record; ticket.* is read when the run wakes.
  const fieldsUpdated = {
    version: 2,
    nodes: [
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.fields_updated', coalesceMinutes: 3 }, position: { x: 0, y: 0 } },
      {
        id: 'changed', type: 'condition', position: { x: 240, y: 0 },
        data: { conditionGroup: { logic: 'all', conditions: [
          { field: 'event.changedFields', operator: 'has_any', value: ['priority'] },
          { field: 'ticket.isNoise', operator: 'is_false' },
        ] } },
      },
      { id: 'recipients', type: 'recipient_resolver', data: { to: ['requester'], cc: [], bcc: [] }, position: { x: 480, y: 0 } },
      {
        id: 'template', type: 'template_render', position: { x: 720, y: 0 },
        data: { contentSource: 'template_only', subject: 'Updated: {{ event.extra.changedFields | join: ", " }}', html: '<p>{{ ticket.status }}</p>', text: '{{ ticket.status }}', plainTextMode: 'auto' },
      },
      { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, includeHeader: false }, position: { x: 960, y: 0 } },
      { id: 'end', type: 'stop', data: {}, position: { x: 480, y: 200 } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'changed' },
      { id: 'e2', source: 'changed', sourceHandle: 'true', target: 'recipients' },
      { id: 'e3', source: 'changed', sourceHandle: 'false', target: 'end' },
      { id: 'e4', source: 'recipients', target: 'template' },
      { id: 'e5', source: 'template', target: 'send' },
    ],
  };
  const coalescedStored = {
    ...stored,
    event: {
      type: 'ticket.fields_updated', source: 'test', occurredAt: '2026-09-26T10:00:00.000Z', dedupeStamp: 'fields:1',
      extra: { changes: { priority: { from: 2, to: 4 }, dueBy: { from: null, to: '2026-09-29T16:00:00.000Z' } }, changedFields: ['priority', 'dueBy'], coalescedEvents: 2, actorKind: 'human' },
    },
    ticket: { ...stored.ticket, isNoise: false },
  };
  function waitingFieldsRun() {
    prismaMock.notificationWorkflow.findUnique.mockResolvedValue({
      id: 41, workspaceId: 1, triggerType: 'ticket.fields_updated', publishedVersion: 1, publishedDefinition: fieldsUpdated, versions: [],
    });
    prismaMock.notificationWorkflowRun.findMany.mockImplementation(async (args) => (args?.where?.status === 'waiting' ? [{
      id: 951, workflowId: 41, workflowVersionId: null, workspaceId: 1, ticketId: 100, eventContext: coalescedStored, dryRun: false,
      executionMode: 'live', triggerSource: 'test', status: 'waiting', resumeAt: new Date(Date.now() - 1000), resumeNodeId: 'changed',
      resumeState: { state: {}, hints: { ticketId: 100 } },
    }] : []));
  }

  test('coalesced fields_updated resume: the condition on event.extra.changes (changedFields) reads the stored, merged change set', async () => {
    waitingFieldsRun();
    await resumeWithTicket({ status: 'Open', isNoise: false });
    expect(prismaMock.notificationDelivery.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(JSON.stringify(data)).toContain('Updated: priority, dueBy');
  });

  test('coalesced fields_updated resume: ticket.isNoise is the value at send time (marked noise during the window → not sent)', async () => {
    waitingFieldsRun();
    await resumeWithTicket({ status: 'Open', isNoise: true });
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
    expect(processDelivery).not.toHaveBeenCalled();
  });
});
