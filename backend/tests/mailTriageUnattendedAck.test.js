import { jest } from '@jest/globals';

/**
 * Mail triage, rule 4: a ticket made from held mail for an UNATTENDED requester
 * (an alert or integration mailbox nobody reads) gets no acknowledgment e-mail.
 *
 * End to end through the notification engine: one real `ticket.created` event,
 * as the held-mail create path raises it (createdVia held_reply), runs the
 * "new ticket" acknowledgment workflow live. The send itself is mocked at the
 * delivery service, so nothing leaves the box. The control proves the same
 * workflow does mail an ordinary requester. Every name is invented.
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
const deliveryMock = { processDelivery: jest.fn() };
const alsoForMock = { additionalRequesterCc: jest.fn(async () => []), isAlsoForNotifyEnabled: jest.fn(async () => false) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/alsoForNotifyService.js', () => ({ default: alsoForMock, ...alsoForMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => deliveryMock);
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { enqueueFieldSync: jest.fn().mockResolvedValue({}) } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { executeDefinition } = await import('../src/services/notificationWorkflowEngine.js');

// The acknowledgment workflow: new ticket -> the requester -> template -> send.
const ackDefinition = {
  version: 2,
  metadata: {},
  nodes: [
    { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
    { id: 'recipients', type: 'recipient_resolver', data: { to: ['requester'], cc: [], bcc: [] } },
    { id: 'template', type: 'template_render', data: { contentSource: 'template_only', subject: 'We received your request: {{ ticket.subject }}', html: '<p>Thank you, we have it.</p>', text: 'Thank you, we have it.' } },
    { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, includeHeader: false } },
  ],
  edges: [
    { id: 'e1', source: 'trigger', target: 'recipients' },
    { id: 'e2', source: 'recipients', target: 'template' },
    { id: 'e3', source: 'template', target: 'send' },
  ],
};
const workflow = { id: 77, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };

/** `ticket.created` as the held-mail create path raises it, with the requester the lifecycle service puts on the context. */
const created = (requester, ticketOver = {}) => ({
  event: { type: 'ticket.created', source: 'email_inbound', occurredAt: '2026-11-11T18:00:00.000Z', dedupeStamp: `created-${Math.random()}`, extra: { createdVia: 'held_reply', heldMessageId: 501 } },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 100, subject: 'Backup job failed on HOST-B', status: 'Open', priorityLabel: 'Medium', isNoise: false, ccEmails: [], ...ticketOver },
  requester,
  assignedAgent: null,
  previousAgent: null,
});

/** The requester row as the engine re-reads it before resolving recipients (the production path). */
function requesterInDatabase(row) {
  prismaMock.requester = { findUnique: jest.fn(async () => ({ ...row })) };
}

async function run(context) {
  const result = await executeDefinition({ workflow, definition: ackDefinition, eventContext: context, executionMode: 'live' });
  const sent = prismaMock.notificationDelivery.create.mock.calls.map((c) => c[0].data);
  return { result, sent };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete prismaMock.requester;
  let stepId = 100;
  deliveryMock.processDelivery.mockResolvedValue({ success: true, status: 'sent' });
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
});

describe('a new ticket from held mail: the acknowledgment', () => {
  test('control: an ordinary requester is sent the acknowledgment', async () => {
    const { sent } = await run(created({ id: 5, name: 'Robin Vale', email: 'robin.vale@client.example', unattended: false }, { subject: 'Invoice question' }));
    expect(sent).toHaveLength(1);
    expect(sent[0].toRecipients).toEqual(['robin.vale@client.example']);
    expect(deliveryMock.processDelivery).toHaveBeenCalledTimes(1);
  });

  test('an unattended requester is sent nothing: no delivery row is written and nothing is handed to the mail service', async () => {
    // 11 Nov 2026: this failed before the fix in requesterProfileService. The engine re-read the requester
    // and rebuilt the context without `unattended`, so the guard never fired and the mail was addressed
    // to the mailbox.
    requesterInDatabase({ id: 7, name: 'Backup watch', email: 'backup-watch@example.org', unattended: true });
    const { sent } = await run(created({ id: 7, name: 'Backup watch', email: 'backup-watch@example.org', unattended: true }));
    expect(prismaMock.requester.findUnique).toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(deliveryMock.processDelivery).not.toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
  });

  test('an unattended requester with people in Cc: the Cc list stands in, and the mailbox itself is still never mailed', async () => {
    requesterInDatabase({ id: 7, name: 'Office relay', email: 'relay@example.org', unattended: true });
    const { sent } = await run(created({ id: 7, name: 'Office relay', email: 'relay@example.org', unattended: true }, { ccEmails: ['office.contact@example.org'] }));
    const everyone = sent.flatMap((d) => [...(d.toRecipients || []), ...(d.ccRecipients || []), ...(d.bccRecipients || [])]);
    expect(everyone).toEqual(['office.contact@example.org']);
    expect(everyone).not.toContain('relay@example.org');
  });

  test('the flag also survives when the requester row cannot be re-read', async () => {
    const { sent } = await run(created({ id: 7, name: 'Backup watch', email: 'backup-watch@example.org', unattended: true }));
    expect(sent).toEqual([]);
    expect(deliveryMock.processDelivery).not.toHaveBeenCalled();
  });
});
