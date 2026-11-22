import { jest } from '@jest/globals';

/**
 * 22 Nov 2026: Preview and Shadow name the address a workflow e-mail would
 * leave from — the ticket's team mailbox in a workspace with one mailbox per
 * team (Accounting: AP and AR). Preview shows it on the e-mail; a Shadow row
 * records it as its from address. A live run records what really happened, as
 * before. Invented names and example.com only.
 */
const AP = { id: 1, workspaceId: 1, address: 'ap@example.com', isPrimary: true, isEnabled: true, mode: 'both', defaultGroupId: 1001n, defaultInternalGroupId: null };
const AR = { id: 2, workspaceId: 1, address: 'ar@example.com', isPrimary: false, isEnabled: true, mode: 'both', defaultGroupId: 1002n, defaultInternalGroupId: null };
const ordered = (list) => [...list].sort((a, b) => (Number(b.isPrimary) - Number(a.isPrimary)) || (a.id - b.id));
const inWs = (where) => (r) => r.workspaceId === where.workspaceId && (!where.mode || where.mode.in.includes(r.mode));

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
  mailboxConnection: {
    findFirst: jest.fn(async ({ where }) => ordered([AP, AR].filter(inWs(where)))[0] || null),
    findMany: jest.fn(async ({ where }) => ordered([AP, AR].filter(inWs(where)))),
  },
};
const isConfigured = jest.fn(() => true);

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured, sendMailAsMailbox: jest.fn() } }));
jest.unstable_mockModule('../src/services/alsoForNotifyService.js', () => ({
  default: { additionalRequesterCc: jest.fn(async () => []), isAlsoForNotifyEnabled: jest.fn(async () => false) },
  additionalRequesterCc: jest.fn(async () => []),
  isAlsoForNotifyEnabled: jest.fn(async () => false),
}));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: jest.fn().mockResolvedValue({ success: true, status: 'sent' }),
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { enqueueFieldSync: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { executeDefinition, executePreview } = await import('../src/services/notificationWorkflowEngine.js');

const eventContext = () => ({
  event: { type: 'ticket.status_changed', source: 'test', occurredAt: '2026-11-22T10:00:00.000Z', dedupeStamp: `t-${Math.random()}` },
  workspace: { id: 1, name: 'Accounting', timezone: 'America/Vancouver' },
  ticket: { id: 100, subject: 'Invoice question', status: 'Resolved', priorityLabel: 'Low', isNoise: false, ccEmails: [] },
  requester: { name: 'Dana Fox', email: 'dana.fox@example.com' },
  assignedAgent: { name: 'Eli Park', email: 'eli.park@example.com' },
  previousAgent: null,
});
const definition = (sendData = {}) => ({
  version: 2,
  metadata: {},
  nodes: [
    { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.status_changed' } },
    { id: 'recipients', type: 'recipient_resolver', data: { to: ['requester'], cc: [], bcc: [] } },
    { id: 'template', type: 'template_render', data: { contentSource: 'template_only', subject: 'Resolved: {{ ticket.subject }}', html: '<p>Done</p>', text: 'Done' } },
    { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, includeHeader: false, ...sendData } },
  ],
  edges: [
    { id: 'e1', source: 'trigger', target: 'recipients' },
    { id: 'e2', source: 'recipients', target: 'template' },
    { id: 'e3', source: 'template', target: 'send' },
  ],
});
const workflow = { id: 77, workspaceId: 1, triggerType: 'ticket.status_changed', publishedVersion: 1, versions: [] };

let ticketGroup = 1002n;
beforeEach(() => {
  jest.clearAllMocks();
  ticketGroup = 1002n;
  isConfigured.mockReturnValue(true);
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
  prismaMock.ticket.findUnique.mockImplementation(async () => ({ id: 100, workspaceId: 1, groupId: ticketGroup, internalGroupId: null }));
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticketActivity.create.mockResolvedValue({});
  prismaMock.mirrorJob.findFirst.mockResolvedValue({ id: 1 });
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 700, ...data }));
  prismaMock.customFieldDefinition.findMany.mockResolvedValue([]);
});

describe('the from address in Preview and Shadow', () => {
  test('Preview: an AR ticket would leave from the AR mailbox', async () => {
    const result = await executePreview({ workflow, definition: definition(), eventContext: eventContext() });
    expect(result.steps.find((s) => s.nodeId === 'send').output).toMatchObject({ skipped: true, reason: 'Preview only' });
    expect(result.state.email.fromAddress).toBe('ar@example.com');
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
  });

  test('Preview: an AP ticket shows the primary', async () => {
    ticketGroup = 1001n;
    const result = await executePreview({ workflow, definition: definition(), eventContext: eventContext() });
    expect(result.state.email.fromAddress).toBe('ap@example.com');
  });

  test('Shadow: the row records the address it would have left from', async () => {
    await executeDefinition({ workflow, definition: definition(), eventContext: eventContext(), executionMode: 'mock' });
    const data = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(data.status).toBe('mocked');
    expect(data.fromAddress).toBe('ar@example.com');
  });

  test('Shadow on SendGrid: a from address pinned on the step is what it shows', async () => {
    isConfigured.mockReturnValue(false);
    await executeDefinition({ workflow, definition: definition({ fromAddress: 'billing@example.com' }), eventContext: eventContext(), executionMode: 'mock' });
    expect(prismaMock.notificationDelivery.create.mock.calls[0][0].data.fromAddress).toBe('billing@example.com');
  });

  test('live: the row keeps only a pinned address, as before (the send records the real one)', async () => {
    await executeDefinition({ workflow, definition: definition(), eventContext: eventContext(), executionMode: 'live' });
    const data = prismaMock.notificationDelivery.create.mock.calls[0][0].data;
    expect(data.status).toBe('queued');
    expect(data.fromAddress).toBeNull();
    expect(prismaMock.mailboxConnection.findMany).not.toHaveBeenCalled();
  });
});
