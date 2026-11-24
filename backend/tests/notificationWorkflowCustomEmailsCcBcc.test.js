import { jest } from '@jest/globals';

/**
 * QA 11-18 #1 — "Allow custom emails to be added as BCC recipients or CC
 * recipients." A recipient_resolver keeps its To list in `customEmails` (gated
 * by the `custom_emails` token, exactly as before) and now also takes
 * `ccCustomEmails` / `bccCustomEmails`, added with no token. To wins over Cc,
 * Cc over Bcc. Invented names and example.com only.
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
  // "Everyone on the original e-mail" (24 Nov 2026) reads our mailbox list in
  // full before it reaches anyone: none connected here.
  mailboxConnection: { findMany: jest.fn().mockResolvedValue([]) },
  appSettings: { findUnique: jest.fn().mockResolvedValue(null) },
};

const alsoForMock = {
  additionalRequesterCc: jest.fn().mockResolvedValue([]),
  isAlsoForNotifyEnabled: jest.fn().mockResolvedValue(false),
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

const { executeDefinition, executePreview } = await import('../src/services/notificationWorkflowEngine.js');
const {
  validateWorkflowDefinition,
  normalizeRecipientCustomEmails,
  RECIPIENT_CUSTOM_EMAIL_KEYS,
} = await import('../src/services/notificationWorkflowDefinition.js');

const eventContext = (over = {}) => ({
  event: { type: 'ticket.status_changed', source: 'test', occurredAt: '2026-11-18T10:00:00.000Z', dedupeStamp: `t-${Math.random()}` },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 100, subject: 'Printer jam', status: 'Resolved', priorityLabel: 'Low', isNoise: false, ccEmails: [] },
  requester: { name: 'Dana Fox', email: 'dana.fox@example.com' },
  assignedAgent: { name: 'Eli Park', email: 'eli.park@example.com' },
  previousAgent: null,
  ...over,
});

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

// Step outputs are audit-redacted, so live recipients are read from the
// delivery row the send node writes (processDelivery is mocked).
async function resolve(recipientData, context = eventContext()) {
  await executeDefinition({ workflow, definition: definition(recipientData), eventContext: context, executionMode: 'live' });
  const created = prismaMock.notificationDelivery.create.mock.calls[0]?.[0]?.data;
  return created ? { to: created.toRecipients, cc: created.ccRecipients, bcc: created.bccRecipients } : null;
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
  alsoForMock.additionalRequesterCc.mockResolvedValue([]);
});

describe('the data keys', () => {
  test('To keeps customEmails; Cc and Bcc use their own keys', () => {
    expect(RECIPIENT_CUSTOM_EMAIL_KEYS).toEqual({ to: 'customEmails', cc: 'ccCustomEmails', bcc: 'bccCustomEmails' });
  });

  test('normalising: lower-case, valid only, no repeats, at most 25', () => {
    expect(normalizeRecipientCustomEmails([' Sam.Okafor@Example.com ', 'sam.okafor@example.com', 'not-an-address', '<priya@example.com>', null]))
      .toEqual(['sam.okafor@example.com', 'priya@example.com']);
    expect(normalizeRecipientCustomEmails('a@example.com')).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => `p${i}@example.com`);
    expect(normalizeRecipientCustomEmails(many)).toHaveLength(25);
  });
});

describe('resolving a live run', () => {
  test('old shape: customEmails with the custom_emails token still goes to To, Cc/Bcc untouched', async () => {
    const delivery = await resolve({ to: ['requester', 'custom_emails'], customEmails: ['ops@example.com'] });
    expect(delivery).toEqual({ to: ['dana.fox@example.com', 'ops@example.com'], cc: [], bcc: [] });
  });

  test('old shape: customEmails without the token sends nobody extra, as before', async () => {
    const delivery = await resolve({ to: ['requester'], customEmails: ['ops@example.com'] });
    expect(delivery.to).toEqual(['dana.fox@example.com']);
    expect(delivery.cc).toEqual([]);
  });

  test('ccCustomEmails and bccCustomEmails land on Cc and Bcc with no token', async () => {
    const delivery = await resolve({
      to: ['requester'],
      ccCustomEmails: ['Priya.Nair@Example.com', 'lead@example.com'],
      bccCustomEmails: ['audit@example.com'],
    });
    expect(delivery.to).toEqual(['dana.fox@example.com']);
    expect(delivery.cc).toEqual(['priya.nair@example.com', 'lead@example.com']);
    expect(delivery.bcc).toEqual(['audit@example.com']);
  });

  test('Cc custom addresses sit beside the Cc tokens (Original CCs)', async () => {
    const context = eventContext({ ticket: { ...eventContext().ticket, ccEmails: ['manager@example.com'] } });
    const delivery = await resolve({ to: ['requester'], cc: ['original_ccs'], ccCustomEmails: ['lead@example.com'] }, context);
    expect(delivery.cc).toEqual(['manager@example.com', 'lead@example.com']);
  });

  test('one address in several sections: To wins over Cc, Cc over Bcc', async () => {
    const delivery = await resolve({
      to: ['requester', 'custom_emails'],
      customEmails: ['ops@example.com'],
      ccCustomEmails: ['OPS@example.com', 'dana.fox@example.com', 'lead@example.com'],
      bccCustomEmails: ['lead@example.com', 'ops@example.com', 'audit@example.com'],
    });
    expect(delivery.to).toEqual(['dana.fox@example.com', 'ops@example.com']);
    expect(delivery.cc).toEqual(['lead@example.com']);
    expect(delivery.bcc).toEqual(['audit@example.com']);
  });

  test('empty Cc/Bcc lists add nobody', async () => {
    const delivery = await resolve({ to: ['requester'], ccCustomEmails: [], bccCustomEmails: [] });
    expect(delivery).toEqual({ to: ['dana.fox@example.com'], cc: [], bcc: [] });
  });
});

describe('Preview', () => {
  test('the preview run shows the Cc and Bcc custom addresses', async () => {
    const result = await executePreview({
      workflow,
      definition: definition({ to: ['requester'], ccCustomEmails: ['lead@example.com'], bccCustomEmails: ['audit@example.com'] }),
      eventContext: eventContext(),
    });
    expect(result.state.recipients).toEqual({ to: ['dana.fox@example.com'], cc: ['lead@example.com'], bcc: ['audit@example.com'] });
    const send = result.steps.find((s) => s.nodeId === 'send');
    expect(send.output).toMatchObject({ skipped: true, reason: 'Preview only' });
    expect(send.output.ccRecipients).toHaveLength(1);
    expect(send.output.bccRecipients).toHaveLength(1);
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  const check = (data) => validateWorkflowDefinition(definition(data), { triggerType: 'ticket.status_changed' });

  test('valid Cc/Bcc lists and the old shape pass', () => {
    expect(check({ to: ['custom_emails'], customEmails: ['ops@example.com'] }).success).toBe(true);
    expect(check({ to: ['requester'], ccCustomEmails: ['lead@example.com'], bccCustomEmails: [] }).success).toBe(true);
  });

  test('a list that is not a list, a bad address, or more than 25 is refused', () => {
    expect(check({ ccCustomEmails: 'lead@example.com' }).errors.join(' ')).toMatch(/Cc custom e-mails must be a list/);
    expect(check({ bccCustomEmails: ['nope'] }).errors.join(' ')).toMatch(/"nope" in Bcc custom e-mails is not an e-mail address/);
    const many = Array.from({ length: 26 }, (_, i) => `p${i}@example.com`);
    expect(check({ ccCustomEmails: many }).errors.join(' ')).toMatch(/has 26 custom e-mail addresses across To, Cc and Bcc; an e-mail can go to at most 25 people in all/);
  });

  test('review fix: the 25 is one budget across To (when ticked), Cc and Bcc', () => {
    const list = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}@example.com`);
    // 10 To + 10 Cc + 6 Bcc = 26 → refused, with the count.
    const over = check({ to: ['requester', 'custom_emails'], customEmails: list(10, 't'), ccCustomEmails: list(10, 'c'), bccCustomEmails: list(6, 'b') });
    expect(over.success).toBe(false);
    expect(over.errors.join(' ')).toMatch(/has 26 custom e-mail addresses/);
    // Exactly 25 passes.
    expect(check({ to: ['requester', 'custom_emails'], customEmails: list(10, 't'), ccCustomEmails: list(10, 'c'), bccCustomEmails: list(5, 'b') }).success).toBe(true);
    // An unticked To list is not sent, so it does not count.
    expect(check({ to: ['requester'], customEmails: list(10, 't'), ccCustomEmails: list(20, 'c') }).success).toBe(true);
    // One address in two sections counts once.
    expect(check({ ccCustomEmails: list(20, 'c'), bccCustomEmails: [...list(5, 'c'), ...list(5, 'b')] }).success).toBe(true);
  });

  test('review fix: an angle-bracketed address ("Dana Fox <dana@example.com>" pasted) saves and sends clean', async () => {
    expect(check({ to: ['requester'], ccCustomEmails: ['<dana.fox@example.com>'], bccCustomEmails: [' <Eli.Park@Example.com> '] }).success).toBe(true);
    const delivery = await resolve({ to: ['assigned_agent'], ccCustomEmails: ['<dana.fox@example.com>'], bccCustomEmails: ['<Sam.Okafor@Example.com>'] });
    expect(delivery.cc).toEqual(['dana.fox@example.com']);
    expect(delivery.bcc).toEqual(['sam.okafor@example.com']);
  });
});

describe('review fix: more than 25 recipients in all', () => {
  const list = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}@example.com`);

  test('Preview reports what a live run would hit instead of throwing', async () => {
    // Requester + 25 Cc custom addresses = 26 (passes the custom budget, over the send cap).
    const result = await executePreview({
      workflow,
      definition: definition({ to: ['requester'], ccCustomEmails: list(25, 'c') }),
      eventContext: eventContext(),
    });
    const send = result.steps.find((s) => s.nodeId === 'send');
    expect(send.status).not.toBe('failed');
    expect(send.output).toMatchObject({ skipped: true, recipientLimitExceeded: true });
    expect(send.output.reason).toMatch(/A live run would fail: 26 recipients across To, Cc and Bcc, and an e-mail can go to at most 25/);
  });

  test('a live run still refuses to send a partial list', async () => {
    await expect(executeDefinition({ workflow, definition: definition({ to: ['requester'], ccCustomEmails: list(25, 'c') }), eventContext: eventContext(), executionMode: 'live' }))
      .rejects.toThrow('Email recipient count exceeds the 25 recipient limit');
    expect(prismaMock.notificationDelivery.create).not.toHaveBeenCalled();
  });
});
