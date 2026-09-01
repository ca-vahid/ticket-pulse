import { jest } from '@jest/globals';

const prismaMock = {
  mailboxConnection: {
    findFirst: jest.fn(),
  },
  ticketThreadEntry: {
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
  },
};

const resolveFromNameMock = jest.fn();
const sendMailAsMailboxMock = jest.fn();
const isConfiguredMock = jest.fn();
const sendgridSendEmailMock = jest.fn();
const emailHealthMock = {
  recordSuccess: jest.fn().mockResolvedValue(undefined),
  recordFailure: jest.fn().mockResolvedValue(undefined),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({
  resolveFromName: resolveFromNameMock,
  default: { resolveFromName: resolveFromNameMock },
}));

jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({
  default: {
    isConfigured: isConfiguredMock,
    sendMailAsMailbox: sendMailAsMailboxMock,
  },
}));

jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({
  default: { sendEmail: sendgridSendEmailMock },
  sendEmail: sendgridSendEmailMock,
}));

jest.unstable_mockModule('../src/services/emailHealthService.js', () => ({
  default: emailHealthMock,
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { sendTransactionalEmail, deliverTransactionalEmail } = await import('../src/services/transactionalEmailService.js');

describe('transactionalEmailService sender identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emailHealthMock.recordSuccess.mockResolvedValue(undefined);
    emailHealthMock.recordFailure.mockResolvedValue(undefined);
  });

  test('passes the workspace-resolved fromName to the Graph path', async () => {
    resolveFromNameMock.mockResolvedValue('Ticket Pulse IT');
    prismaMock.mailboxConnection.findFirst.mockResolvedValue({ address: 'ticketpulse@bgcengineering.ca' });
    isConfiguredMock.mockReturnValue(true);
    sendMailAsMailboxMock.mockResolvedValue({});

    const result = await sendTransactionalEmail({
      workspaceId: 1,
      to: 'approver@example.com',
      subject: 'Approval requested',
      html: '<p>Approve?</p>',
      label: 'approval',
    });

    expect(result).toEqual({ sent: true, via: 'msgraph' });
    expect(resolveFromNameMock).toHaveBeenCalledWith(1);
    expect(sendMailAsMailboxMock).toHaveBeenCalledWith('ticketpulse@bgcengineering.ca', expect.objectContaining({
      fromName: 'Ticket Pulse IT',
    }));
  });

  test('passes the workspace-resolved fromName to the SendGrid fallback', async () => {
    resolveFromNameMock.mockResolvedValue('Ticket Pulse Accounting');
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    sendgridSendEmailMock.mockResolvedValue({});

    const result = await sendTransactionalEmail({
      workspaceId: 2,
      to: 'agent@example.com',
      subject: 'Task due',
      html: '<p>Due soon</p>',
      label: 'task_reminder',
    });

    expect(result).toEqual({ sent: true, via: 'sendgrid' });
    expect(sendgridSendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: ['agent@example.com'],
      fromName: 'Ticket Pulse Accounting',
      workspaceId: 2,
    }));
  });

  test('sends without a workspace resolve to the global default name', async () => {
    resolveFromNameMock.mockResolvedValue('Ticket Pulse');
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    sendgridSendEmailMock.mockResolvedValue({});

    await sendTransactionalEmail({
      workspaceId: null,
      to: 'admin@example.com',
      subject: 'Sync health alert',
      html: '<p>Stale workspace</p>',
      label: 'sync_health',
    });

    expect(resolveFromNameMock).toHaveBeenCalledWith(null);
    expect(sendgridSendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      fromName: 'Ticket Pulse',
    }));
  });
});

// Phase MR6: `cc` for "Also for" additional requesters — both transports,
// deduped against `to` (SendGrid rejects an address present in both).
describe('transactionalEmailService cc (Phase MR6)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Graph path receives cc minus anything already in to (case-insensitive) and deduped', async () => {
    resolveFromNameMock.mockResolvedValue('Ticket Pulse IT');
    prismaMock.mailboxConnection.findFirst.mockResolvedValue({ address: 'ticketpulse@bgcengineering.ca' });
    isConfiguredMock.mockReturnValue(true);
    sendMailAsMailboxMock.mockResolvedValue({});

    await sendTransactionalEmail({
      workspaceId: 1,
      to: 'rita@example.com',
      cc: ['Manager@example.com', 'RITA@example.com', 'manager@example.com', 'assistant@example.com'],
      subject: 'Resolved',
      html: '<p>Done</p>',
      label: 'lifecycle',
    });
    expect(sendMailAsMailboxMock).toHaveBeenCalledWith('ticketpulse@bgcengineering.ca', expect.objectContaining({
      to: ['rita@example.com'],
      cc: ['Manager@example.com', 'assistant@example.com'],
    }));
    expect(emailHealthMock.recordSuccess).toHaveBeenCalledWith(expect.objectContaining({
      recipients: ['rita@example.com', 'Manager@example.com', 'assistant@example.com'],
    }));
  });

  test('SendGrid fallback receives the same cc; no cc → empty array (unchanged behaviour)', async () => {
    resolveFromNameMock.mockResolvedValue('Ticket Pulse');
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    sendgridSendEmailMock.mockResolvedValue({});

    await sendTransactionalEmail({ workspaceId: 2, to: ['rita@example.com'], cc: ['boss@example.com'], subject: 'S', html: '<p>B</p>' });
    expect(sendgridSendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: ['rita@example.com'], cc: ['boss@example.com'] }));

    await sendTransactionalEmail({ workspaceId: 2, to: 'agent@example.com', subject: 'S', html: '<p>B</p>' });
    expect(sendgridSendEmailMock).toHaveBeenLastCalledWith(expect.objectContaining({ to: ['agent@example.com'], cc: [] }));
  });
});

// Mega 08-31 Phase MB-1: the transport every requester-facing lane now rides —
// centralized picker, Graph→SendGrid fallback on FAILURE too, threading
// anchors + plus-address Reply-To on Graph, our own Message-ID on SendGrid.
describe('transactionalEmailService (Phase MB-1 mailbox reply loop)', () => {
  const tpTicket = { id: 501, workspaceId: 5, origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: null };
  const connection = { id: 3, address: 'patickets@bgcengineering.ca', isPrimary: true, mode: 'both', isEnabled: true };

  beforeEach(() => {
    jest.clearAllMocks();
    resolveFromNameMock.mockResolvedValue('Project Accounting');
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    prismaMock.ticketThreadEntry.update.mockResolvedValue({});
    emailHealthMock.recordSuccess.mockResolvedValue(undefined);
    emailHealthMock.recordFailure.mockResolvedValue(undefined);
  });

  test('uses the centralized picker (primary first, then oldest id)', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    sendgridSendEmailMock.mockResolvedValue({ provider: 'sendgrid' });
    await sendTransactionalEmail({ workspaceId: 5, to: 'a@example.com', subject: 'S', html: '<p>B</p>' });
    expect(prismaMock.mailboxConnection.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 5, isEnabled: true, mode: { in: ['send', 'both'] } },
      orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
    });
  });

  test('Graph lane: plus-address Reply-To + In-Reply-To/References from the stored ids; Message-ID stored on the entry', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(connection);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ emailMessageId: '<newest@x>' }, { emailMessageId: '<older@x>' }]);
    isConfiguredMock.mockReturnValue(true);
    sendMailAsMailboxMock.mockResolvedValue({ internetMessageId: '<graph-1@bgcengineering.ca>' });

    const result = await deliverTransactionalEmail({
      workspaceId: 5, to: 'rita@example.com', subject: 'We received your request', html: '<p>Thanks</p>',
      label: 'workflow', ticket: tpTicket, threadEntryId: 9001,
    });

    expect(sendMailAsMailboxMock).toHaveBeenCalledWith('patickets@bgcengineering.ca', expect.objectContaining({
      to: ['rita@example.com'],
      fromName: 'Project Accounting',
      replyTo: 'patickets+tp1042@bgcengineering.ca',
      inReplyTo: '<newest@x>',
      references: ['<older@x>', '<newest@x>'],
    }));
    expect(prismaMock.ticketThreadEntry.update).toHaveBeenCalledWith({ where: { id: 9001 }, data: { emailMessageId: '<graph-1@bgcengineering.ca>' } });
    expect(emailHealthMock.recordSuccess).toHaveBeenCalledWith(expect.objectContaining({ provider: 'msgraph', context: 'workflow', workspaceId: 5 }));
    expect(result).toEqual({
      via: 'msgraph', provider: 'msgraph', providerMessageId: '<graph-1@bgcengineering.ca>', messageId: '<graph-1@bgcengineering.ca>',
      from: 'patickets@bgcengineering.ca', replyTo: 'patickets+tp1042@bgcengineering.ca',
    });
  });

  test('Graph lane: FS-born ticket gets no plus-address Reply-To (FreshService owns that thread); no ticket → no threading at all', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(connection);
    isConfiguredMock.mockReturnValue(true);
    sendMailAsMailboxMock.mockResolvedValue({ internetMessageId: '<g@x>' });

    await deliverTransactionalEmail({
      workspaceId: 5, to: 'rita@example.com', subject: 'S', html: '<p>B</p>',
      ticket: { id: 77, origin: 'freshservice', freshserviceTicketId: 225001, nativeNumber: null },
    });
    expect(sendMailAsMailboxMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ replyTo: null }));

    await deliverTransactionalEmail({ workspaceId: 5, to: 'admin@example.com', subject: 'Sync health', html: '<p>B</p>' });
    expect(sendMailAsMailboxMock).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
      replyTo: null, inReplyTo: null, references: [],
    }));
    expect(prismaMock.ticketThreadEntry.findMany).toHaveBeenCalledTimes(1);
  });

  test('Graph lane FAILURE falls back to SendGrid (health records both lanes) instead of swallowing the acknowledgement', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(connection);
    isConfiguredMock.mockReturnValue(true);
    sendMailAsMailboxMock.mockRejectedValue(new Error('Graph 503'));
    sendgridSendEmailMock.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'sg-9', messageId: '<tp-501-abc@bgcengineering.ca>' });

    const result = await deliverTransactionalEmail({
      workspaceId: 5, to: 'rita@example.com', subject: 'S', html: '<p>B</p>', label: 'workflow', ticket: tpTicket, threadEntryId: 9001,
    });

    expect(emailHealthMock.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ provider: 'msgraph', context: 'workflow' }));
    expect(sendgridSendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: ['rita@example.com'], context: 'workflow', workspaceId: 5, ticketIdForMessageId: 501,
    }));
    // The fallback still carries the plus-address Reply-To: the same 'both' mailbox is ingest-capable.
    expect(result).toEqual(expect.objectContaining({ via: 'sendgrid', provider: 'sendgrid', providerMessageId: 'sg-9', messageId: '<tp-501-abc@bgcengineering.ca>', replyTo: 'patickets+tp1042@bgcengineering.ca' }));
    // MB-1h: the SendGrid-minted Message-ID lands on the entry exactly like Graph's.
    expect(prismaMock.ticketThreadEntry.update).toHaveBeenCalledWith({ where: { id: 9001 }, data: { emailMessageId: '<tp-501-abc@bgcengineering.ca>' } });
  });

  test('SendGrid fallback with an INGEST-capable mailbox sets the plus-address Reply-To on the SendGrid send (loop survives a Graph outage)', async () => {
    // Send picker (mode send|both) finds nothing → SendGrid lane; ingest
    // picker (mode ingest|both) finds the monitored mailbox.
    prismaMock.mailboxConnection.findFirst.mockImplementation(async ({ where }) => (
      where.mode.in.includes('ingest') ? { id: 4, address: 'patickets@bgcengineering.ca', mode: 'ingest' } : null
    ));
    sendgridSendEmailMock.mockResolvedValue({ provider: 'sendgrid', messageId: '<tp-501-r@bgcengineering.ca>' });

    const result = await deliverTransactionalEmail({ workspaceId: 5, to: 'rita@example.com', subject: 'S', html: '<p>B</p>', ticket: tpTicket });

    expect(prismaMock.mailboxConnection.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 5, isEnabled: true, mode: { in: ['ingest', 'both'] } },
      orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
    });
    expect(sendgridSendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'patickets+tp1042@bgcengineering.ca' }));
    expect(result).toEqual(expect.objectContaining({ via: 'sendgrid', replyTo: 'patickets+tp1042@bgcengineering.ca' }));
  });

  test('SendGrid fallback Reply-To stays null with no ingest mailbox, for FS-born tickets, and for non-ticket mail', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    sendgridSendEmailMock.mockResolvedValue({ provider: 'sendgrid' });
    await deliverTransactionalEmail({ workspaceId: 5, to: 'rita@example.com', subject: 'S', html: '<p>B</p>', ticket: tpTicket });
    expect(sendgridSendEmailMock).toHaveBeenLastCalledWith(expect.objectContaining({ replyTo: null }));

    prismaMock.mailboxConnection.findFirst.mockImplementation(async ({ where }) => (
      where.mode.in.includes('ingest') ? { id: 4, address: 'patickets@bgcengineering.ca', mode: 'ingest' } : null
    ));
    await deliverTransactionalEmail({
      workspaceId: 5, to: 'rita@example.com', subject: 'S', html: '<p>B</p>',
      ticket: { id: 77, origin: 'freshservice', freshserviceTicketId: 225001, nativeNumber: null },
    });
    expect(sendgridSendEmailMock).toHaveBeenLastCalledWith(expect.objectContaining({ replyTo: null }));

    jest.clearAllMocks();
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    await deliverTransactionalEmail({ workspaceId: 5, to: 'admin@example.com', subject: 'Sync health', html: '<p>B</p>' });
    expect(sendgridSendEmailMock).toHaveBeenLastCalledWith(expect.objectContaining({ replyTo: null }));
    // No ticket → the ingest picker is never consulted (only the send picker ran).
    expect(prismaMock.mailboxConnection.findFirst).toHaveBeenCalledTimes(1);
  });

  test('SendGrid lane (no mailbox): asks SendGrid to mint a Message-ID for the ticket, carries threading, Reply-To null', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ emailMessageId: '<in@requester>' }]);
    sendgridSendEmailMock.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'sg-1', messageId: '<tp-501-zzz@bgcengineering.ca>' });

    const result = await deliverTransactionalEmail({
      workspaceId: 5, to: 'rita@example.com', cc: ['boss@example.com'], bcc: ['audit@example.com', 'BOSS@example.com'],
      subject: 'S', html: '<p>B</p>', text: 'B', from: 'ap@bgcengineering.ca', customArgs: { delivery_id: '1' }, ticket: tpTicket,
    });

    expect(sendgridSendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: ['rita@example.com'], cc: ['boss@example.com'], bcc: ['audit@example.com'], from: 'ap@bgcengineering.ca',
      customArgs: { delivery_id: '1' }, ticketIdForMessageId: 501, inReplyTo: '<in@requester>', references: ['<in@requester>'],
    }));
    expect(sendgridSendEmailMock.mock.calls[0][0]).toEqual(expect.objectContaining({ replyTo: null }));
    expect(result).toEqual(expect.objectContaining({ via: 'sendgrid', messageId: '<tp-501-zzz@bgcengineering.ca>', from: 'ap@bgcengineering.ca', replyTo: null }));
  });

  test('text-only sends get an HTML body on Graph (Graph drafts are HTML) and keep text for SendGrid', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(connection);
    isConfiguredMock.mockReturnValue(true);
    sendMailAsMailboxMock.mockResolvedValue({});
    await deliverTransactionalEmail({ workspaceId: 5, to: 'tech@example.com', subject: 'S', text: 'Line 1\n<b>Line 2</b>' });
    expect(sendMailAsMailboxMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      html: '<p>Line 1<br/>&lt;b&gt;Line 2&lt;/b&gt;</p>',
    }));
  });

  test('deliverTransactionalEmail throws (with the SendGrid error) when both lanes fail; sendTransactionalEmail stays non-fatal', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(connection);
    isConfiguredMock.mockReturnValue(true);
    sendMailAsMailboxMock.mockRejectedValue(new Error('Graph down'));
    const sgErr = new Error('SendGrid 400');
    sgErr.retryable = false;
    sendgridSendEmailMock.mockRejectedValue(sgErr);

    await expect(deliverTransactionalEmail({ workspaceId: 5, to: 'a@example.com', subject: 'S', html: '<p>B</p>' }))
      .rejects.toMatchObject({ message: 'SendGrid 400', retryable: false, graphError: 'Graph down' });
    await expect(sendTransactionalEmail({ workspaceId: 5, to: 'a@example.com', subject: 'S', html: '<p>B</p>' }))
      .resolves.toEqual({ sent: false, error: 'SendGrid 400' });
  });

  test('an explicit fromName (reply-as-agent) bypasses the workspace resolve', async () => {
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    sendgridSendEmailMock.mockResolvedValue({ provider: 'sendgrid' });
    await deliverTransactionalEmail({ workspaceId: 5, to: 'a@example.com', subject: 'S', html: '<p>B</p>', fromName: 'Susan Xu' });
    expect(resolveFromNameMock).not.toHaveBeenCalled();
    expect(sendgridSendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ fromName: 'Susan Xu' }));
  });
});
