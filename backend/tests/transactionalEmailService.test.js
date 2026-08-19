import { jest } from '@jest/globals';

const prismaMock = {
  mailboxConnection: {
    findFirst: jest.fn(),
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

const { sendTransactionalEmail } = await import('../src/services/transactionalEmailService.js');

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
