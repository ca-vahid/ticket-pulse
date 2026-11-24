import { jest } from '@jest/globals';

/**
 * 24 Nov 2026 — "Everyone on the original e-mail" (recipient token
 * `original_ccs`). A requester wrote to four colleagues and the IT mailbox,
 * everyone on To, and the "Ticket arrived" acknowledgement reached the
 * requester only: the token read the Cc lists and never the To line.
 * Invented names and example.com only.
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
  ticketActivity: { create: jest.fn(), findMany: jest.fn() },
  mirrorJob: { findFirst: jest.fn(), create: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  notificationDelivery: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  mailboxConnection: { findMany: jest.fn() },
  requester: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
};

const aliases = new Map();
const settings = new Map();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/alsoForNotifyService.js', () => ({
  additionalRequesterCc: jest.fn().mockResolvedValue([]),
  isAlsoForNotifyEnabled: jest.fn().mockResolvedValue(false),
}));
jest.unstable_mockModule('../src/services/mailboxAliasService.js', () => ({
  getMailboxAliases: jest.fn(async (id) => aliases.get(id) || []),
}));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn(async (key) => settings.get(key) ?? null), set: jest.fn(), delete: jest.fn() },
}));
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

const { executeDefinition, executePreview } = await import('../src/services/notificationWorkflowEngine.js');
const svc = await import('../src/services/originalRecipientsService.js');
const { invalidateMachineSenderCache } = await import('../src/services/machineSenderService.js');

const REQUESTER = 'dana.fox@example.com';

const eventContext = (ticket = {}, over = {}) => ({
  event: { type: 'ticket.created', source: 'test', occurredAt: '2026-11-24T10:00:00.000Z', dedupeStamp: `t-${Math.random()}` },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 100, subject: 'Shared drive access', status: 'Open', priorityLabel: 'Low', isNoise: false, toEmails: [], ccEmails: [], replyCcEmails: [], ...ticket },
  requester: { name: 'Dana Fox', email: REQUESTER },
  assignedAgent: { name: 'Eli Park', email: 'eli.park@example.com' },
  previousAgent: null,
  ...over,
});

function definition(recipientData) {
  return {
    version: 2,
    metadata: {},
    nodes: [
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
      { id: 'recipients', type: 'recipient_resolver', data: { to: ['requester'], cc: ['original_ccs'], bcc: [], ...recipientData } },
      { id: 'template', type: 'template_render', data: { contentSource: 'template_only', subject: 'We have your request', html: '<p>Thanks</p>', text: 'Thanks' } },
      { id: 'send', type: 'send_email', data: { provider: 'sendgrid', includeFooter: false, includeHeader: false } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'recipients' },
      { id: 'e2', source: 'recipients', target: 'template' },
      { id: 'e3', source: 'template', target: 'send' },
    ],
  };
}

const workflow = { id: 77, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };

async function resolve(ticket, recipientData = {}, mode = 'live') {
  await executeDefinition({ workflow, definition: definition(recipientData), eventContext: eventContext(ticket), executionMode: mode });
  const created = prismaMock.notificationDelivery.create.mock.calls[0]?.[0]?.data;
  return created ? { to: created.toRecipients, cc: created.ccRecipients, bcc: created.bccRecipients } : null;
}

let replies = [];
let ccChanges = [];

beforeEach(() => {
  jest.clearAllMocks();
  svc.invalidateOwnMailboxCache();
  invalidateMachineSenderCache();
  aliases.clear();
  settings.clear();
  replies = [];
  ccChanges = [];
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
  prismaMock.ticketActivity.findMany.mockImplementation(async () => ccChanges);
  prismaMock.mirrorJob.findFirst.mockResolvedValue({ id: 1 });
  prismaMock.ticketThreadEntry.findMany.mockImplementation(async ({ where } = {}) => (where?.eventType === 'reply' ? replies : []));
  prismaMock.notificationEmailSignature.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.findUnique.mockResolvedValue(null);
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.notificationDelivery.create.mockImplementation(({ data }) => Promise.resolve({ id: 700, ...data }));
  prismaMock.customFieldDefinition.findMany.mockResolvedValue([]);
  // Our mailboxes: IT's (with a public alias) and another workspace's.
  prismaMock.mailboxConnection.findMany.mockResolvedValue([
    { id: 1, address: 'it-tickets@example.com' },
    { id: 2, address: 'accounts@example.com' },
  ]);
  aliases.set(1, ['it@example.com']);
  prismaMock.requester.findMany.mockResolvedValue([]);
  prismaMock.technician.findMany.mockResolvedValue([]);
});

describe('the To line counts', () => {
  test('the reported case: four colleagues and the IT mailbox on To, nobody on Cc', async () => {
    const delivery = await resolve({
      toEmails: ['IT@example.com', 'priya.nair@example.com', 'sam.okafor@example.com', 'lee.chen@example.com', 'ada.ruiz@example.com'],
    });
    expect(delivery.to).toEqual([REQUESTER]);
    expect(delivery.cc).toEqual(['priya.nair@example.com', 'sam.okafor@example.com', 'lee.chen@example.com', 'ada.ruiz@example.com']);
  });

  test('Cc and reply Cc still count, To joins them', async () => {
    const delivery = await resolve({
      ccEmails: ['manager@example.com'],
      replyCcEmails: ['lead@example.com'],
      toEmails: ['priya.nair@example.com'],
    });
    expect(delivery.cc).toEqual(['manager@example.com', 'lead@example.com', 'priya.nair@example.com']);
  });
});

describe('who is left off', () => {
  test('our own mailboxes in any workspace, their aliases, +tag variants and the FreshService relay', async () => {
    const delivery = await resolve({
      toEmails: ['it-tickets@example.com', 'it@example.com', 'accounts@example.com', 'it-tickets+tp42@example.com', 'help@acme.freshservice.com', 'priya.nair@example.com'],
      ccEmails: ['Accounts@Example.com'],
    });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('the global sender address', async () => {
    const before = process.env.SENDGRID_FROM_EMAIL;
    process.env.SENDGRID_FROM_EMAIL = 'ticketpulse@example.com';
    try {
      const delivery = await resolve({ toEmails: ['ticketpulse@example.com', 'priya.nair@example.com'] });
      expect(delivery.cc).toEqual(['priya.nair@example.com']);
    } finally {
      if (before === undefined) delete process.env.SENDGRID_FROM_EMAIL;
      else process.env.SENDGRID_FROM_EMAIL = before;
    }
  });

  test('the requester, in any case', async () => {
    const delivery = await resolve({ toEmails: ['Dana.Fox@Example.com', 'priya.nair@example.com'], ccEmails: [REQUESTER] });
    expect(delivery.to).toEqual([REQUESTER]);
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('no-reply and the workspace machine senders', async () => {
    settings.set('machine_senders_ws1', JSON.stringify({ entries: [{ value: 'alerts.example.net' }] }));
    const delivery = await resolve({
      toEmails: ['no-reply@example.com', 'noreply.billing@example.com', 'mailer-daemon@example.com', 'watch@alerts.example.net', 'priya.nair@example.com'],
    });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('active agents of the ticket\'s workspace (they see the ticket in the app)', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'Eli.Park@example.com' }]);
    const delivery = await resolve({ toEmails: ['eli.park@example.com', 'priya.nair@example.com'], ccEmails: ['ELI.PARK@example.com'] });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
    const query = prismaMock.technician.findMany.mock.calls[0][0];
    expect(query.where).toMatchObject({ workspaceId: 1, isActive: true });
  });

  test('unattended requesters (an automation mailbox on the To line)', async () => {
    prismaMock.requester.findMany.mockResolvedValue([{ email: 'scanner@example.com' }]);
    const delivery = await resolve({ toEmails: ['scanner@example.com', 'priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('repeats across To, Cc and reply Cc, compared case-insensitively', async () => {
    const delivery = await resolve({
      ccEmails: ['Priya.Nair@example.com'],
      replyCcEmails: ['priya.nair@EXAMPLE.com', 'sam.okafor@example.com'],
      toEmails: ['PRIYA.NAIR@example.com', 'Sam Okafor <Sam.Okafor@example.com>'],
    });
    expect(delivery.cc).toEqual(['priya.nair@example.com', 'sam.okafor@example.com']);
  });

  test('when our mailboxes cannot be read, the To line is left out (never risk mailing ourselves)', async () => {
    prismaMock.mailboxConnection.findMany.mockRejectedValue(new Error('db down'));
    const delivery = await resolve({ ccEmails: ['manager@example.com'], toEmails: ['it@example.com', 'priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['manager@example.com']);
  });
});

describe('people an agent took off the Cc', () => {
  test('a reply that took someone off the Cc keeps them off later workflow mail', async () => {
    replies = [{ occurredAt: new Date('2026-11-24T11:00:00Z'), rawPayload: { to_emails: [REQUESTER], cc_emails: ['lead@example.com'], cc_removed: ['priya.nair@example.com'] } }];
    const delivery = await resolve({ ccEmails: ['priya.nair@example.com', 'lead@example.com'], toEmails: ['priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['lead@example.com']);
  });

  test('an "Also for" removal keeps them off even though they were on To', async () => {
    ccChanges = [{ performedAt: new Date('2026-11-24T11:00:00Z'), details: { from: ['priya.nair@example.com', 'lead@example.com'], to: ['lead@example.com'] } }];
    const delivery = await resolve({ ccEmails: ['lead@example.com'], toEmails: ['priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['lead@example.com']);
  });

  test('added back later by an agent, they are reached again', async () => {
    replies = [
      { occurredAt: new Date('2026-11-24T11:00:00Z'), rawPayload: { cc_removed: ['priya.nair@example.com'] } },
      { occurredAt: new Date('2026-11-24T12:00:00Z'), rawPayload: { cc_emails: ['priya.nair@example.com'] } },
    ];
    const delivery = await resolve({ toEmails: ['priya.nair@example.com'] });
    expect(delivery.cc).toEqual(['priya.nair@example.com']);
  });

  test('history is read oldest first across replies and "Also for" edits', () => {
    const removed = svc.agentRemovedFromHistory(
      [{ occurredAt: '2026-11-24T13:00:00Z', rawPayload: { cc_removed: ['sam.okafor@example.com'] } }],
      [
        { performedAt: '2026-11-24T11:00:00Z', details: { from: ['lee.chen@example.com'], to: [] } },
        { performedAt: '2026-11-24T12:00:00Z', details: { from: [], to: ['lee.chen@example.com'] } },
      ],
    );
    expect([...removed]).toEqual(['sam.okafor@example.com']);
  });
});

describe('the 25-recipient cap', () => {
  const list = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}@example.com`);

  test('a long To line is trimmed so the requester still gets the e-mail', async () => {
    const delivery = await resolve({ toEmails: list(30, 'colleague') });
    expect(delivery.to).toEqual([REQUESTER]);
    expect(delivery.cc).toHaveLength(24);
    expect(delivery.to.length + delivery.cc.length + delivery.bcc.length).toBe(25);
    expect(delivery.cc[0]).toBe('colleague0@example.com');
  });

  test('typed addresses are never trimmed; only original-e-mail people make room', async () => {
    const delivery = await resolve({ toEmails: list(30, 'colleague') }, { ccCustomEmails: ['audit@example.com'] });
    expect(delivery.cc).toContain('audit@example.com');
    expect(delivery.to.length + delivery.cc.length + delivery.bcc.length).toBe(25);
  });

  test('trimOriginalToCap leaves off the last original people first, Cc before Bcc before To', () => {
    const out = svc.trimOriginalToCap({ to: ['r@example.com', 'o1@example.com'], cc: ['x@example.com', 'o2@example.com'], bcc: ['o3@example.com'] }, ['o1@example.com', 'o2@example.com', 'o3@example.com'], 3);
    expect(out).toEqual({ to: ['r@example.com', 'o1@example.com'], cc: ['x@example.com'], bcc: [], trimmed: 2 });
  });
});

describe('Preview and Shadow list the widened recipients', () => {
  const ticket = {
    toEmails: ['it@example.com', 'priya.nair@example.com', 'no-reply@example.com', REQUESTER],
    ccEmails: ['sam.okafor@example.com'],
  };

  test('Preview shows the widened list and why people were left off', async () => {
    const result = await executePreview({ workflow, definition: definition({}), eventContext: eventContext(ticket) });
    expect(result.state.recipients).toEqual({ to: [REQUESTER], cc: ['sam.okafor@example.com', 'priya.nair@example.com'], bcc: [] });
    const step = result.steps.find((s) => s.nodeId === 'recipients');
    expect(step.output.originalRecipients).toEqual({
      count: 2,
      leftOff: { ownMailbox: 1, agent: 0, requester: 1, automated: 1, unattended: 0, removedByAgent: 0 },
    });
  });

  test('a Shadow run records the widened list on its delivery row', async () => {
    const delivery = await resolve(ticket, {}, 'mock');
    expect(delivery).toEqual({ to: [REQUESTER], cc: ['sam.okafor@example.com', 'priya.nair@example.com'], bcc: [] });
    expect(prismaMock.notificationDelivery.create.mock.calls[0][0].data.status).toBe('mocked');
  });
});
