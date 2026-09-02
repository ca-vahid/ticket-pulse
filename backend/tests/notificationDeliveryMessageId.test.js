import { jest } from '@jest/globals';

/**
 * Phase RL (RL-5) — processDelivery persists the RFC Message-ID the mail
 * left with into notification_deliveries.message_id on BOTH lanes (Graph
 * internetMessageId; the SendGrid lane's minted `<tp-…>` id), so ingest
 * rung 1b can thread a reply to a SendGrid-lane ack.
 */

const prismaMock = {
  notificationDelivery: { update: jest.fn(), findMany: jest.fn() },
  ticket: { findUnique: jest.fn() },
};
const deliverTransactionalEmailMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({
  deliverTransactionalEmail: deliverTransactionalEmailMock,
  sendTransactionalEmail: jest.fn(),
  default: { deliverTransactionalEmail: deliverTransactionalEmailMock, sendTransactionalEmail: jest.fn() },
}));
jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({ placeVoiceCall: jest.fn(), sendSms: jest.fn(), sendWhatsApp: jest.fn() }));
const resolveFromNameMock = jest.fn().mockResolvedValue('Ticket Pulse');
jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({ resolveFromName: resolveFromNameMock, default: { resolveFromName: resolveFromNameMock } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { processDelivery } = await import('../src/services/notificationDeliveryService.js');

const delivery = {
  id: 1, workspaceId: 5, workflowRunId: 9, channel: 'email', recipient: 'requester@example.com',
  toRecipients: ['requester@example.com'], ccRecipients: [], bccRecipients: [],
  subject: 'Ticket received', htmlBody: '<p>Hello</p>', textBody: 'Hello', provider: 'sendgrid', payload: {},
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.notificationDelivery.update.mockResolvedValue({});
  prismaMock.ticket.findUnique.mockResolvedValue(null);
});

test('SendGrid lane: message_id = the minted RFC Message-ID, provider_message_id = SendGrid x-message-id', async () => {
  deliverTransactionalEmailMock.mockResolvedValue({
    via: 'sendgrid', provider: 'sendgrid', providerMessageId: 'sg-x-message-id-123',
    messageId: '<tp-501-abc@bgcengineering.ca>', from: null, replyTo: 'patickets+tp1204@bgcengineering.ca',
  });
  const result = await processDelivery(delivery);
  expect(result.success).toBe(true);
  expect(prismaMock.notificationDelivery.update).toHaveBeenCalledWith({
    where: { id: 1 },
    data: expect.objectContaining({
      status: 'sent', provider: 'sendgrid', providerMessageId: 'sg-x-message-id-123', messageId: '<tp-501-abc@bgcengineering.ca>',
    }),
  });
});

test('Graph lane: message_id = internetMessageId (same value as provider_message_id)', async () => {
  deliverTransactionalEmailMock.mockResolvedValue({
    via: 'msgraph', provider: 'msgraph', providerMessageId: '<g1@bgc>', messageId: '<g1@bgc>', from: 'patickets@bgcengineering.ca', replyTo: null,
  });
  await processDelivery(delivery);
  expect(prismaMock.notificationDelivery.update.mock.calls[0][0].data).toMatchObject({ provider: 'msgraph', messageId: '<g1@bgc>', fromAddress: 'patickets@bgcengineering.ca' });
});

test('no Message-ID from the transport → the column is left untouched (no null overwrite)', async () => {
  deliverTransactionalEmailMock.mockResolvedValue({ via: 'sendgrid', provider: 'sendgrid', providerMessageId: 'x', messageId: null, from: null, replyTo: null });
  await processDelivery(delivery);
  expect(prismaMock.notificationDelivery.update.mock.calls[0][0].data).not.toHaveProperty('messageId');
});
