import { jest } from '@jest/globals';

/**
 * Phase MR6 (QA 08-26 #3) — recipient_resolver + "Also notify additional
 * requesters": requester-facing sends (the requester is in To) cc the
 * ticket's "Also for" list when the workspace toggle is ON; nothing changes
 * when it is OFF, and agent-facing sends never pick the list up.
 */

const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflow: { findUnique: jest.fn(), findFirst: jest.fn() },
  notificationWorkflowVersion: { findUnique: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  customFieldDefinition: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketActivity: { create: jest.fn() },
  mirrorJob: { findFirst: jest.fn(), create: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  notificationDelivery: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
};

const alsoForMock = {
  additionalRequesterCc: jest.fn(),
  isAlsoForNotifyEnabled: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/alsoForNotifyService.js', () => ({ default: alsoForMock, ...alsoForMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: jest.fn().mockResolvedValue({ success: true, status: 'sent' }),
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: { create: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueFieldSync: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { executeDefinition } = await import('../src/services/notificationWorkflowEngine.js');

const eventContext = (over = {}) => ({
  event: { type: 'ticket.status_changed', source: 'test', occurredAt: '2026-08-26T10:00:00.000Z', dedupeStamp: `t-${Math.random()}` },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: {
    id: 100, subject: 'VPN access problem', status: 'Resolved', priorityLabel: 'Urgent', isNoise: false,
    ccEmails: ['manager@example.com', 'assistant@example.com'],
  },
  requester: { name: 'Rita', email: 'rita@example.com' },
  assignedAgent: { name: 'Terry', email: 'terry@example.com' },
  previousAgent: null,
  ...over,
});

// The canonical lifecycle-mail graph (recipients → template → send). The
// validator demands an action node; preview mode keeps the send off the wire.
function definition(recipientData) {
  return {
    version: 2,
    metadata: {},
    nodes: [
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.status_changed' } },
      { id: 'recipients', type: 'recipient_resolver', data: { cc: [], bcc: [], ...recipientData } },
      { id: 'template', type: 'template_render', data: { contentSource: 'template_only', subject: 'Resolved: {{ ticket.subject }}', html: '<p>Done</p>', text: 'Done' } },
      { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, includeHeader: false } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'recipients' },
      { id: 'e2', source: 'recipients', target: 'template' },
      { id: 'e3', source: 'template', target: 'send' },
    ],
  };
}

const workflow = { id: 77, workspaceId: 1, triggerType: 'ticket.status_changed', publishedVersion: 1, versions: [] };

// Step outputs are audit-sanitized (emails redacted), so the recipients are
// asserted on the delivery row the send node persists (processDelivery is
// mocked — nothing leaves the box).
async function resolve(recipientData, context = eventContext()) {
  const result = await executeDefinition({ workflow, definition: definition(recipientData), eventContext: context, executionMode: 'live' });
  const step = result.steps.find((s) => s.nodeId === 'recipients');
  const created = prismaMock.notificationDelivery.create.mock.calls[0]?.[0]?.data;
  const delivery = created ? { to: created.toRecipients, cc: created.ccRecipients, bcc: created.bccRecipients } : null;
  return { result, step, delivery };
}

beforeEach(() => {
  jest.clearAllMocks();
  let stepId = 100;
  prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: stepId += 1, ...data }));
  prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
  prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
  prismaMock.publicTicketStatusSettings.upsert.mockResolvedValue({ enabled: false });
  prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(null);
  prismaMock.ticket.findFirst.mockResolvedValue({ id: 100, workspaceId: 1 });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticketActivity.create.mockResolvedValue({});
  prismaMock.mirrorJob.findFirst.mockResolvedValue({ id: 1 });
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.upsert.mockImplementation(({ create }) => Promise.resolve({ id: 700, ...create }));
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 700, ...data }));
  prismaMock.customFieldDefinition.findMany.mockResolvedValue([]);
  // Real helper semantics, gated by the mocked toggle.
  alsoForMock.additionalRequesterCc.mockImplementation(async (workspaceId, ticket, to) => {
    if (!(await alsoForMock.isAlsoForNotifyEnabled(workspaceId))) return [];
    const taken = new Set(to.map((a) => a.toLowerCase()));
    return (ticket?.ccEmails || []).map((a) => a.toLowerCase()).filter((a) => !taken.has(a));
  });
});

describe('recipient_resolver — "Also notify additional requesters" (Phase MR6)', () => {
  test('toggle OFF: a requester-facing send keeps exactly the configured recipients', async () => {
    alsoForMock.isAlsoForNotifyEnabled.mockResolvedValue(false);
    const { result, step, delivery } = await resolve({ to: ['requester'] });
    expect(result.status).toBe('completed');
    expect(delivery).toEqual({ to: ['rita@example.com'], cc: [], bcc: [] });
    expect(step.output.additionalRequesters).toBeUndefined();
    expect(alsoForMock.additionalRequesterCc).toHaveBeenCalledWith(1, expect.objectContaining({ ccEmails: ['manager@example.com', 'assistant@example.com'] }), ['rita@example.com']);
  });

  test('toggle ON: the "Also for" list joins the cc of a requester-facing send (deduped against node cc + To)', async () => {
    alsoForMock.isAlsoForNotifyEnabled.mockResolvedValue(true);
    const { step, delivery } = await resolve({ to: ['requester'], cc: ['manager@example.com', 'assigned_agent'] });
    expect(delivery.to).toEqual(['rita@example.com']);
    expect(delivery.cc).toEqual(['manager@example.com', 'terry@example.com', 'assistant@example.com']);
    // Audit output is email-redacted; the count still proves the join happened.
    expect(step.output.additionalRequesters).toHaveLength(1);
  });

  test('toggle ON: an agent-facing send (requester NOT in To) never picks the list up', async () => {
    alsoForMock.isAlsoForNotifyEnabled.mockResolvedValue(true);
    const { delivery } = await resolve({ to: ['assigned_agent'] });
    expect(delivery).toEqual({ to: ['terry@example.com'], cc: [], bcc: [] });
    expect(alsoForMock.additionalRequesterCc).not.toHaveBeenCalled();
  });

  test('toggle ON: an "Also for" address that is the requester is never duplicated; bcc excludes the cc', async () => {
    alsoForMock.isAlsoForNotifyEnabled.mockResolvedValue(true);
    const { delivery } = await resolve(
      { to: ['requester'], bcc: ['assistant@example.com', 'audit@example.com'] },
      eventContext({ ticket: { id: 100, subject: 'VPN', ccEmails: ['RITA@example.com', 'assistant@example.com'] } }),
    );
    expect(delivery).toEqual({
      to: ['rita@example.com'],
      cc: ['assistant@example.com'],
      bcc: ['audit@example.com'],
    });
  });

  test('a lookup failure is treated as OFF (the send still goes out to the configured recipients)', async () => {
    alsoForMock.additionalRequesterCc.mockRejectedValue(new Error('settings down'));
    const { result, delivery } = await resolve({ to: ['requester'] });
    expect(result.status).toBe('completed');
    expect(delivery).toEqual({ to: ['rita@example.com'], cc: [], bcc: [] });
  });
});
