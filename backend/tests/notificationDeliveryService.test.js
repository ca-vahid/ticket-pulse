import { jest } from '@jest/globals';

const prismaMock = {
  notificationDelivery: {
    update: jest.fn(),
    findMany: jest.fn(),
  },
  ticket: {
    findUnique: jest.fn(),
  },
};

// Mega 08-31 Phase MB-1a: the workflow/lifecycle engine no longer imports
// SendGrid directly — every email delivery rides the mailbox-aware
// transactional transport (workspace mailbox via Graph, SendGrid fallback).
const deliverTransactionalEmailMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({
  deliverTransactionalEmail: deliverTransactionalEmailMock,
  sendTransactionalEmail: jest.fn(),
  default: { deliverTransactionalEmail: deliverTransactionalEmailMock, sendTransactionalEmail: jest.fn() },
}));

jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({
  placeVoiceCall: jest.fn(),
  sendSms: jest.fn(),
  sendWhatsApp: jest.fn(),
}));

const resolveFromNameMock = jest.fn();
jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({
  resolveFromName: resolveFromNameMock,
  default: { resolveFromName: resolveFromNameMock },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { processDelivery, processQueuedDeliveries } = await import('../src/services/notificationDeliveryService.js');

const tpTicket = {
  id: 501, workspaceId: 5, origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null,
  ccEmails: ['boss@example.com'], requester: { email: 'requester@example.com' },
};

describe('notificationDeliveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.notificationDelivery.update.mockResolvedValue({});
    prismaMock.notificationDelivery.findMany.mockResolvedValue([]);
    prismaMock.ticket.findUnique.mockResolvedValue(null);
    resolveFromNameMock.mockResolvedValue('Ticket Pulse');
  });

  test('routes workflow email deliveries through the transactional transport and marks sent with the lane provider', async () => {
    deliverTransactionalEmailMock.mockResolvedValue({
      via: 'msgraph', provider: 'msgraph', providerMessageId: '<g1@bgc>', messageId: '<g1@bgc>',
      from: 'patickets@bgcengineering.ca', replyTo: null,
    });

    const result = await processDelivery({
      id: 1,
      workspaceId: 2,
      workflowRunId: 9,
      channel: 'email',
      recipient: 'requester@example.com',
      toRecipients: ['requester@example.com'],
      ccRecipients: [],
      bccRecipients: [],
      subject: 'Ticket received',
      htmlBody: '<p>Hello</p>',
      textBody: 'Hello',
      provider: 'sendgrid',
      payload: {},
    });

    expect(result.success).toBe(true);
    expect(resolveFromNameMock).toHaveBeenCalledWith(2);
    // Template/branding parity: the same subject/html/text/fromName/customArgs
    // the SendGrid call used to get.
    expect(deliverTransactionalEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 2,
      to: ['requester@example.com'],
      cc: [],
      bcc: [],
      subject: 'Ticket received',
      html: '<p>Hello</p>',
      text: 'Hello',
      fromName: 'Ticket Pulse',
      label: 'workflow',
      customArgs: { delivery_id: '1', workspace_id: '2', workflow_run_id: '9' },
    }));
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1 },
      data: expect.objectContaining({
        status: 'sent',
        provider: 'msgraph',
        providerMessageId: '<g1@bgc>',
        fromAddress: 'patickets@bgcengineering.ca',
      }),
    }));
  });

  test('a SendGrid-lane result keeps the SendGrid provider + x-message-id and does not invent a fromAddress', async () => {
    deliverTransactionalEmailMock.mockResolvedValue({
      via: 'sendgrid', provider: 'sendgrid', providerMessageId: 'msg-1', messageId: '<tp-501-abc@bgcengineering.ca>', from: null, replyTo: null,
    });
    const result = await processDelivery({
      id: 11, workspaceId: 2, channel: 'email', recipient: 'requester@example.com', toRecipients: ['requester@example.com'],
      ccRecipients: [], bccRecipients: [], subject: 'Ticket received', htmlBody: '<p>Hello</p>', provider: 'sendgrid', payload: {},
    });
    expect(result.success).toBe(true);
    const data = prismaMock.notificationDelivery.update.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({ status: 'sent', provider: 'sendgrid', providerMessageId: 'msg-1' }));
    expect(data).not.toHaveProperty('fromAddress');
  });

  test('passes the workspace sender name to simple assignment emails too (text-only lane)', async () => {
    resolveFromNameMock.mockResolvedValue('Ticket Pulse IT');
    deliverTransactionalEmailMock.mockResolvedValue({ via: 'sendgrid', provider: 'sendgrid', providerMessageId: null, messageId: null, from: null, replyTo: null });

    const result = await processDelivery({
      id: 5,
      workspaceId: 1,
      channel: 'email',
      recipient: 'tech@example.com',
      toRecipients: [],
      ccRecipients: [],
      bccRecipients: [],
      assessedPriority: 'Urgent',
      provider: 'sendgrid',
      payload: { message: 'You have a new urgent ticket' },
    });

    expect(result.success).toBe(true);
    expect(resolveFromNameMock).toHaveBeenCalledWith(1);
    expect(deliverTransactionalEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: ['tech@example.com'],
      text: 'You have a new urgent ticket',
      html: null,
      subject: 'Ticket Pulse: Urgent priority ticket',
      fromName: 'Ticket Pulse IT',
      label: 'assignment',
      customArgs: null,
      ticket: null,
    }));
  });

  test('requester-facing ticket emails hand the ticket to the transport (threading + plus-address Reply-To apply)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(tpTicket);
    deliverTransactionalEmailMock.mockResolvedValue({
      via: 'msgraph', provider: 'msgraph', providerMessageId: '<g2@bgc>', messageId: '<g2@bgc>',
      from: 'patickets@bgcengineering.ca', replyTo: 'patickets+tp1042@bgcengineering.ca',
    });

    await processDelivery({
      id: 21, workspaceId: 5, ticketId: 501, channel: 'email', recipient: 'Requester@Example.com',
      toRecipients: ['Requester@Example.com'], ccRecipients: [], bccRecipients: [],
      subject: 'We received your request [TP-1042]', htmlBody: '<p>Thanks</p>', provider: 'sendgrid', payload: {},
    });

    expect(prismaMock.ticket.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 501 } }));
    expect(deliverTransactionalEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      ticket: expect.objectContaining({ id: 501, origin: 'ticketpulse', nativeNumber: 1042 }),
    }));
  });

  test('a ticket Cc in the audience also counts as requester-facing', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(tpTicket);
    deliverTransactionalEmailMock.mockResolvedValue({ via: 'sendgrid', provider: 'sendgrid', providerMessageId: null, messageId: null, from: null, replyTo: null });
    await processDelivery({
      id: 22, workspaceId: 5, ticketId: 501, channel: 'email', recipient: 'agent@example.com',
      toRecipients: ['agent@example.com'], ccRecipients: ['BOSS@example.com'], bccRecipients: [],
      subject: 'S', htmlBody: '<p>B</p>', provider: 'sendgrid', payload: {},
    });
    expect(deliverTransactionalEmailMock).toHaveBeenCalledWith(expect.objectContaining({ ticket: expect.objectContaining({ id: 501 }) }));
  });

  test('agent-facing ticket emails (assignment alerts) get NO ticket — an agent answering a notification must not ingest as a requester reply', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(tpTicket);
    deliverTransactionalEmailMock.mockResolvedValue({ via: 'sendgrid', provider: 'sendgrid', providerMessageId: null, messageId: null, from: null, replyTo: null });

    await processDelivery({
      id: 23, workspaceId: 5, ticketId: 501, channel: 'email', recipient: 'tech@example.com',
      toRecipients: ['tech@example.com'], ccRecipients: [], bccRecipients: [],
      subject: 'New ticket assigned to you', htmlBody: '<p>Go</p>', provider: 'sendgrid', payload: {},
    });
    expect(deliverTransactionalEmailMock).toHaveBeenCalledWith(expect.objectContaining({ ticket: null }));
  });

  test('a failed ticket lookup never blocks the send (threading is best-effort)', async () => {
    prismaMock.ticket.findUnique.mockRejectedValue(new Error('db hiccup'));
    deliverTransactionalEmailMock.mockResolvedValue({ via: 'sendgrid', provider: 'sendgrid', providerMessageId: null, messageId: null, from: null, replyTo: null });
    const result = await processDelivery({
      id: 24, workspaceId: 5, ticketId: 501, channel: 'email', recipient: 'requester@example.com',
      toRecipients: ['requester@example.com'], ccRecipients: [], bccRecipients: [], subject: 'S', htmlBody: '<p>B</p>', payload: {},
    });
    expect(result.success).toBe(true);
    expect(deliverTransactionalEmailMock).toHaveBeenCalledWith(expect.objectContaining({ ticket: null }));
  });

  test('marks permanent provider failures distinctly for audit and retry decisions', async () => {
    const error = new Error('SendGrid API error: invalid email');
    error.retryable = false;
    error.errorClass = 'permanent_provider_error';
    deliverTransactionalEmailMock.mockRejectedValue(error);

    const result = await processDelivery({
      id: 2,
      workspaceId: 2,
      workflowRunId: 9,
      channel: 'email',
      recipient: 'bad-address',
      toRecipients: ['bad-address'],
      ccRecipients: [],
      bccRecipients: [],
      subject: 'Ticket received',
      textBody: 'Hello',
      provider: 'sendgrid',
      payload: { workflowId: 7 },
    });

    expect(result.success).toBe(false);
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 2 },
      data: expect.objectContaining({
        status: 'failed_permanent',
        retryCount: { increment: 1 },
        payload: expect.objectContaining({
          lastErrorClass: 'permanent_provider_error',
          lastErrorRetryable: false,
        }),
      }),
    }));
  });

  test('a transport error without a retryable flag stays retryable (failed, not failed_permanent)', async () => {
    deliverTransactionalEmailMock.mockRejectedValue(new Error('Graph 503 then SendGrid timeout'));
    const result = await processDelivery({
      id: 3, workspaceId: 2, channel: 'email', recipient: 'r@example.com', toRecipients: ['r@example.com'],
      ccRecipients: [], bccRecipients: [], subject: 'S', textBody: 'B', payload: {},
    });
    expect(result.success).toBe(false);
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'failed', payload: expect.objectContaining({ lastErrorRetryable: true }) }),
    }));
  });

  test('processes queued deliveries sequentially', async () => {
    prismaMock.notificationDelivery.findMany.mockResolvedValue([
      { id: 3, channel: 'email', recipient: 'a@example.com', subject: 'A', textBody: 'A', payload: {} },
      { id: 4, channel: 'email', recipient: 'b@example.com', subject: 'B', textBody: 'B', payload: {} },
    ]);
    deliverTransactionalEmailMock.mockResolvedValue({ via: 'sendgrid', provider: 'sendgrid', providerMessageId: null, messageId: null, from: null, replyTo: null });

    const result = await processQueuedDeliveries({ limit: 2 });

    expect(result.processed).toBe(2);
    expect(result.sent).toBe(2);
    expect(deliverTransactionalEmailMock).toHaveBeenCalledTimes(2);
  });

  test('scopes queued delivery processing to the provided dedupe keys', async () => {
    prismaMock.notificationDelivery.findMany.mockResolvedValue([
      { id: 5, channel: 'email', recipient: 'fresh@example.com', subject: 'Fresh', textBody: 'Fresh', payload: {} },
    ]);
    deliverTransactionalEmailMock.mockResolvedValue({ via: 'sendgrid', provider: 'sendgrid', providerMessageId: null, messageId: null, from: null, replyTo: null });

    const result = await processQueuedDeliveries({
      limit: 2,
      dedupeKeys: ['fresh-ticket:email', 'fresh-ticket:sms'],
    });

    expect(prismaMock.notificationDelivery.findMany).toHaveBeenCalledWith({
      where: {
        status: 'queued',
        OR: [
          { dedupeKey: { in: ['fresh-ticket:email', 'fresh-ticket:sms'] } },
        ],
      },
      orderBy: { queuedAt: 'asc' },
      take: 2,
    });
    expect(result.processed).toBe(1);
    expect(deliverTransactionalEmailMock).toHaveBeenCalledTimes(1);
  });
});
