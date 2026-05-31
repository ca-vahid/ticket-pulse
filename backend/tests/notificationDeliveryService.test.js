import { jest } from '@jest/globals';

const prismaMock = {
  notificationDelivery: {
    update: jest.fn(),
    findMany: jest.fn(),
  },
};

const sendEmailMock = jest.fn();
const sendAssignmentEmailMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({
  sendEmail: sendEmailMock,
  sendAssignmentEmail: sendAssignmentEmailMock,
}));

jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({
  placeVoiceCall: jest.fn(),
  sendSms: jest.fn(),
  sendWhatsApp: jest.fn(),
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

describe('notificationDeliveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.notificationDelivery.update.mockResolvedValue({});
    prismaMock.notificationDelivery.findMany.mockResolvedValue([]);
  });

  test('sends generic workflow email deliveries through SendGrid and marks sent', async () => {
    sendEmailMock.mockResolvedValue({
      provider: 'sendgrid',
      providerMessageId: 'msg-1',
      status: 'accepted',
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
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: ['requester@example.com'],
      subject: 'Ticket received',
      html: '<p>Hello</p>',
      text: 'Hello',
    }));
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1 },
      data: expect.objectContaining({
        status: 'sent',
        providerMessageId: 'msg-1',
      }),
    }));
  });

  test('marks permanent provider failures distinctly for audit and retry decisions', async () => {
    const error = new Error('SendGrid API error: invalid email');
    error.retryable = false;
    error.errorClass = 'permanent_provider_error';
    sendEmailMock.mockRejectedValue(error);

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

  test('processes queued deliveries sequentially', async () => {
    prismaMock.notificationDelivery.findMany.mockResolvedValue([
      { id: 3, channel: 'email', recipient: 'a@example.com', subject: 'A', textBody: 'A', payload: {} },
      { id: 4, channel: 'email', recipient: 'b@example.com', subject: 'B', textBody: 'B', payload: {} },
    ]);
    sendEmailMock.mockResolvedValue({ provider: 'sendgrid', providerMessageId: null });

    const result = await processQueuedDeliveries({ limit: 2 });

    expect(result.processed).toBe(2);
    expect(result.sent).toBe(2);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });
});
