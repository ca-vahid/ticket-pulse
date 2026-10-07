import { jest } from '@jest/globals';

/**
 * QA 10-01 #7 — recipient_resolver reads addresses from ticket custom fields
 * (`custom_field:<key>` tokens): to_recipients / cc_recipients /
 * bcc_recipients or any field added later, comma-separated, at send time.
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

const { executeDefinition, emailsFromCustomField } = await import('../src/services/notificationWorkflowEngine.js');

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

describe('recipients from custom fields (QA 10-01 #7)', () => {
  beforeEach(() => alsoForMock.isAlsoForNotifyEnabled.mockResolvedValue(false));

  test('emailsFromCustomField splits on commas, semicolons, spaces and new lines and drops non-addresses', () => {
    const ctx = { ticket: { customFields: { to_recipients: 'a@x.com, b@x.com;c@x.com\n<d@x.com>  not-an-address  e@', list: ['f@x.com', 'nope'] } } };
    expect(emailsFromCustomField(ctx, 'to_recipients')).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
    expect(emailsFromCustomField(ctx, 'list')).toEqual(['f@x.com']);
    expect(emailsFromCustomField(ctx, 'missing')).toEqual([]);
    expect(emailsFromCustomField({}, 'to_recipients')).toEqual([]);
    // QA 10-06 #5: the exact cc list Power Automate sends — spaces, a blank
    // entry between two semicolons and a trailing semicolon.
    const qa = { ticket: { customFields: { cc_recipients: 'EMatos@bgcengineering.ca; ECarey@bgcengineering.ca; SDickinson@bgcengineering.ca; ;VNuanmanee@bgcengineering.ca;' } } };
    expect(emailsFromCustomField(qa, 'cc_recipients').map((e) => e.toLowerCase())).toEqual([
      'ematos@bgcengineering.ca', 'ecarey@bgcengineering.ca', 'sdickinson@bgcengineering.ca', 'vnuanmanee@bgcengineering.ca',
    ]);
  });

  test('To / Cc / Bcc each read their own field; duplicates across lists are dropped', async () => {
    const context = eventContext({
      ticket: {
        ...eventContext().ticket,
        customFields: { to_recipients: 'pm@x.com, lead@x.com', cc_recipients: 'lead@x.com; finance@x.com', bcc_recipients: 'audit@x.com' },
      },
    });
    const { delivery } = await resolve({
      to: ['requester', 'custom_field:to_recipients'],
      cc: ['custom_field:cc_recipients'],
      bcc: ['custom_field:bcc_recipients'],
    }, context);
    expect(delivery.to).toEqual(['rita@example.com', 'pm@x.com', 'lead@x.com']);
    expect(delivery.cc).toEqual(['finance@x.com']);
    expect(delivery.bcc).toEqual(['audit@x.com']);
  });

  test('an empty field adds nobody and the rest of the list still sends', async () => {
    const context = eventContext({ ticket: { ...eventContext().ticket, customFields: { to_recipients: '' } } });
    const { delivery } = await resolve({ to: ['requester', 'custom_field:to_recipients'] }, context);
    expect(delivery.to).toEqual(['rita@example.com']);
  });
});
