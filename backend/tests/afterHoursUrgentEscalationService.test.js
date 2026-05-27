import { jest } from '@jest/globals';

const prismaMock = {
  assignmentPipelineRun: {
    findUnique: jest.fn(),
  },
  assignmentConfig: {
    findUnique: jest.fn(),
  },
  notificationDelivery: {
    createMany: jest.fn(),
  },
};

const providerStatusMock = jest.fn();
const processQueuedDeliveriesMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/notificationProviders.js', () => ({
  getNotificationProviderStatus: providerStatusMock,
}));

jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  default: {
    processQueuedDeliveries: processQueuedDeliveriesMock,
  },
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  default: {
    freshservice: { domain: 'example.freshservice.com' },
  },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    warn: jest.fn(),
  },
}));

const { default: afterHoursUrgentEscalationService } = await import('../src/services/afterHoursUrgentEscalationService.js');

describe('afterHoursUrgentEscalationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    processQueuedDeliveriesMock.mockResolvedValue({ processed: 0 });
    providerStatusMock.mockResolvedValue({
      email: { provider: 'sendgrid', configured: true, missing: [] },
      sms: { provider: 'twilio', configured: true, missing: [] },
      whatsapp: { provider: 'twilio', configured: false, missing: ['twilio_whatsapp_content_sid'] },
      phone_call: { provider: 'twilio', configured: true, missing: [] },
    });
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({
      afterHoursUrgentEscalationEnabled: true,
      afterHoursUrgentEscalationChannels: ['email', 'sms', 'whatsapp'],
      afterHoursUrgentEscalationEmails: ['lead@example.com'],
      afterHoursUrgentEscalationPhones: ['+16045551234'],
    });
    prismaMock.notificationDelivery.createMany.mockResolvedValue({ count: 2 });
  });

  test('queues configured workspace recipients for urgent after-hours priority runs', async () => {
    const result = await afterHoursUrgentEscalationService.queueForPriorityRun({
      id: 77,
      workspaceId: 5,
      ticketId: 501,
      recommendation: { assessedPriority: 'Urgent' },
      ticket: {
        id: 501,
        workspaceId: 5,
        freshserviceTicketId: 219999n,
        assessedPriority: 'Urgent',
      },
    });

    expect(result).toEqual({ queued: 2, channels: ['email', 'sms'] });
    expect(prismaMock.notificationDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          workspaceId: 5,
          technicianId: null,
          ticketId: 501,
          pipelineRunId: 77,
          channel: 'email',
          recipient: 'lead@example.com',
          assessedPriority: 'Urgent',
          dedupeKey: 'after-hours-urgent:77:501:email:lead@example.com',
        }),
        expect.objectContaining({
          workspaceId: 5,
          technicianId: null,
          ticketId: 501,
          pipelineRunId: 77,
          channel: 'sms',
          recipient: '+16045551234',
          assessedPriority: 'Urgent',
          dedupeKey: 'after-hours-urgent:77:501:sms:+16045551234',
        }),
      ],
      skipDuplicates: true,
    });
    expect(processQueuedDeliveriesMock).toHaveBeenCalledWith({ limit: 2 });
  });

  test('does not queue escalation for non-urgent priority runs', async () => {
    const result = await afterHoursUrgentEscalationService.queueForPriorityRun({
      id: 78,
      workspaceId: 5,
      recommendation: { assessedPriority: 'High' },
      ticket: { id: 502, freshserviceTicketId: 220000n, assessedPriority: 'High' },
    });

    expect(result).toEqual({ queued: 0, skipped: 'not_urgent' });
    expect(prismaMock.notificationDelivery.createMany).not.toHaveBeenCalled();
  });

  test('does not queue escalation when workspace policy is disabled', async () => {
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({
      afterHoursUrgentEscalationEnabled: false,
      afterHoursUrgentEscalationChannels: ['email'],
      afterHoursUrgentEscalationEmails: ['lead@example.com'],
      afterHoursUrgentEscalationPhones: [],
    });

    const result = await afterHoursUrgentEscalationService.queueForPriorityRun({
      id: 79,
      workspaceId: 5,
      recommendation: { assessedPriority: 'Urgent' },
      ticket: { id: 503, freshserviceTicketId: 220001n, assessedPriority: 'Urgent' },
    });

    expect(result).toEqual({ queued: 0, skipped: 'disabled' });
    expect(prismaMock.notificationDelivery.createMany).not.toHaveBeenCalled();
  });
});
