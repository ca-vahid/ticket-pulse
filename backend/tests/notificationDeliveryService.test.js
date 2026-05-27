import { jest } from '@jest/globals';

const prismaMock = {
  notificationDelivery: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
};

const sendAssignmentEmailMock = jest.fn();
const sendSmsMock = jest.fn();
const sendWhatsAppMock = jest.fn();
const placeVoiceCallMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({
  sendAssignmentEmail: sendAssignmentEmailMock,
  default: { sendAssignmentEmail: sendAssignmentEmailMock },
}));

jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({
  sendSms: sendSmsMock,
  sendWhatsApp: sendWhatsAppMock,
  placeVoiceCall: placeVoiceCallMock,
  default: {
    sendSms: sendSmsMock,
    sendWhatsApp: sendWhatsAppMock,
    placeVoiceCall: placeVoiceCallMock,
  },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { default: notificationDeliveryService } = await import('../src/services/notificationDeliveryService.js');

describe('notificationDeliveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.notificationDelivery.update.mockResolvedValue({});
    sendAssignmentEmailMock.mockResolvedValue({ provider: 'sendgrid', providerMessageId: 'email-1', status: 'accepted' });
    sendSmsMock.mockResolvedValue({ provider: 'twilio', providerMessageId: 'SM123', status: 'queued' });
    sendWhatsAppMock.mockResolvedValue({ provider: 'twilio', providerMessageId: 'SM789', status: 'queued' });
    placeVoiceCallMock.mockResolvedValue({ provider: 'twilio', providerMessageId: 'CA123', status: 'queued' });
  });

  test('sends queued email, SMS, WhatsApp, and voice deliveries and records provider ids', async () => {
    prismaMock.notificationDelivery.findMany.mockResolvedValue([
      {
        id: 1,
        channel: 'email',
        recipient: 'alex.chen@example.com',
        assessedPriority: 'High',
        provider: 'sendgrid',
        payload: { message: 'Email message', freshserviceTicketId: 123 },
      },
      {
        id: 2,
        channel: 'sms',
        recipient: '+16045550101',
        assessedPriority: 'Urgent',
        provider: 'twilio',
        payload: { message: 'SMS message' },
      },
      {
        id: 3,
        channel: 'whatsapp',
        recipient: '+16045550101',
        assessedPriority: 'Urgent',
        provider: 'twilio',
        payload: { message: 'WhatsApp message' },
      },
      {
        id: 4,
        channel: 'phone_call',
        recipient: '+16045550101',
        assessedPriority: 'Urgent',
        provider: 'twilio',
        payload: { message: 'SMS message', voiceMessage: 'Voice message' },
      },
    ]);

    const result = await notificationDeliveryService.processQueuedDeliveries({ limit: 4 });

    expect(result).toEqual(expect.objectContaining({ processed: 4, sent: 4, failed: 0 }));
    expect(sendAssignmentEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'alex.chen@example.com',
      subject: expect.stringContaining('ticket #123'),
      body: 'Email message',
    }));
    expect(sendSmsMock).toHaveBeenCalledWith({ to: '+16045550101', body: 'SMS message' });
    expect(sendWhatsAppMock).toHaveBeenCalledWith({ to: '+16045550101', body: 'WhatsApp message' });
    expect(placeVoiceCallMock).toHaveBeenCalledWith({ to: '+16045550101', message: 'Voice message' });
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1 },
      data: expect.objectContaining({ status: 'sent', providerMessageId: 'email-1' }),
    }));
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 2 },
      data: expect.objectContaining({ status: 'sent', providerMessageId: 'SM123' }),
    }));
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 3 },
      data: expect.objectContaining({ status: 'sent', providerMessageId: 'SM789' }),
    }));
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 4 },
      data: expect.objectContaining({ status: 'sent', providerMessageId: 'CA123' }),
    }));
  });

  test('marks failed deliveries with retry count and error', async () => {
    sendSmsMock.mockRejectedValue(new Error('Twilio rejected the message'));
    prismaMock.notificationDelivery.findMany.mockResolvedValue([
      {
        id: 7,
        channel: 'sms',
        recipient: '+16045550101',
        assessedPriority: 'High',
        provider: 'twilio',
        payload: { message: 'SMS message' },
      },
    ]);

    const result = await notificationDeliveryService.processQueuedDeliveries({ limit: 1 });

    expect(result).toEqual(expect.objectContaining({ processed: 1, sent: 0, failed: 1 }));
    expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        status: 'failed',
        retryCount: { increment: 1 },
        error: 'Twilio rejected the message',
      },
    });
  });
});
