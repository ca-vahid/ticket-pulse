import { jest } from '@jest/globals';

const prismaMock = {
  technicianNotificationPreference: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
  },
  notificationDelivery: {
    createMany: jest.fn(),
  },
  ticket: {
    findUnique: jest.fn(),
  },
};

const resolveAgentTechnicianMock = jest.fn();
const graphMailClientMock = {
  getUserProfile: jest.fn(),
};
const settingsRepositoryMock = {
  getTwilioConfig: jest.fn(),
  getSendGridConfig: jest.fn(),
};
const notificationDeliveryServiceMock = {
  processQueuedDeliveries: jest.fn(),
};
const sendVerificationSmsMock = jest.fn();
const sendSmsMock = jest.fn();
const sendWhatsAppMock = jest.fn();
const placeVoiceCallMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/agentCompetencyService.js', () => ({
  resolveAgentTechnician: resolveAgentTechnicianMock,
}));

jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({
  default: graphMailClientMock,
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: settingsRepositoryMock,
}));

jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  default: notificationDeliveryServiceMock,
}));

jest.unstable_mockModule('../src/services/twilioNotificationService.js', () => ({
  sendVerificationSms: sendVerificationSmsMock,
  sendSms: sendSmsMock,
  sendWhatsApp: sendWhatsAppMock,
  placeVoiceCall: placeVoiceCallMock,
  default: {
    sendVerificationSms: sendVerificationSmsMock,
    sendSms: sendSmsMock,
    sendWhatsApp: sendWhatsAppMock,
    placeVoiceCall: placeVoiceCallMock,
  },
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  default: {
    freshservice: { domain: 'example.freshservice.com' },
    sendgrid: { apiKey: null, fromEmail: null },
    twilio: { accountSid: null, authToken: null, fromNumber: null, voiceFromNumber: null },
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

const {
  default: notificationPreferenceService,
  notificationPreferenceAllows,
  buildNotificationMessage,
  buildPriorityChangeNotificationMessage,
} = await import('../src/services/notificationPreferenceService.js');
const { getNotificationProviderStatus } = await import('../src/services/notificationProviders.js');

const technician = {
  id: 17,
  workspaceId: 1,
  name: 'Alex Chen',
  email: 'alex.chen@example.com',
};

describe('notificationPreferenceService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveAgentTechnicianMock.mockResolvedValue({
      technician,
      matches: [{ ...technician, workspace: { id: 1, name: 'IT' } }],
    });
    settingsRepositoryMock.getTwilioConfig.mockResolvedValue({
      accountSid: null,
      authToken: null,
      fromNumber: null,
      voiceFromNumber: null,
      whatsappSender: null,
      whatsappMessagingServiceSid: null,
      whatsappContentSid: null,
      whatsappContentVariables: '{"1":"{{message}}"}',
    });
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: null,
      fromEmail: null,
    });
    notificationDeliveryServiceMock.processQueuedDeliveries.mockResolvedValue({ processed: 0, sent: 0, failed: 0 });
    sendVerificationSmsMock.mockResolvedValue({ provider: 'twilio', providerMessageId: 'SM123', status: 'queued' });
    sendSmsMock.mockResolvedValue({ provider: 'twilio', providerMessageId: 'SM456', status: 'queued' });
    sendWhatsAppMock.mockResolvedValue({ provider: 'twilio', providerMessageId: 'SM789', status: 'queued' });
    placeVoiceCallMock.mockResolvedValue({ provider: 'twilio', providerMessageId: 'CA456', status: 'queued' });
  });

  test('matches High, Urgent, disabled, and channel-specific opt-ins', () => {
    const verified = {
      threshold: 'high_urgent',
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
      phoneCallEnabled: false,
      phoneVerifiedAt: new Date('2026-05-26T16:00:00.000Z'),
      phoneOverride: '+16045550101',
    };

    expect(notificationPreferenceAllows(verified, 'High', 'email')).toBe(true);
    expect(notificationPreferenceAllows(verified, 'Urgent', 'sms')).toBe(true);
    expect(notificationPreferenceAllows(verified, 'Urgent', 'whatsapp')).toBe(true);
    expect(notificationPreferenceAllows(verified, 'High', 'phone_call')).toBe(false);
    expect(notificationPreferenceAllows({ ...verified, threshold: 'urgent_only' }, 'High', 'email')).toBe(false);
    expect(notificationPreferenceAllows({ ...verified, threshold: 'disabled' }, 'Urgent', 'email')).toBe(false);
    expect(notificationPreferenceAllows({ ...verified, phoneVerifiedAt: null }, 'Urgent', 'sms')).toBe(false);
  });

  test('creates default preferences and uses Entra mobile phone as the effective fallback', async () => {
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(null);
    graphMailClientMock.getUserProfile.mockResolvedValue({
      businessPhones: ['+16045550100'],
      mobilePhone: '+16045550101',
    });
    prismaMock.technicianNotificationPreference.create.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      technicianId: 17,
      threshold: 'high_urgent',
      emailEnabled: false,
      smsEnabled: false,
      whatsappEnabled: false,
      phoneCallEnabled: false,
      entraPhone: '+16045550100',
      entraMobilePhone: '+16045550101',
      phoneOverride: null,
      phoneVerifiedAt: null,
    });

    const result = await notificationPreferenceService.getMyPreferences('alex.chen@example.com', 1);

    expect(prismaMock.technicianNotificationPreference.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 1,
        technicianId: 17,
        threshold: 'high_urgent',
        entraPhone: '+16045550100',
        entraMobilePhone: '+16045550101',
      }),
    });
    expect(result.preferences.threshold).toBe('high_urgent');
    expect(result.preferences.effectivePhone).toBe('+16045550101');
  });

  test('reports SMS and voice as configured from one global Twilio number', async () => {
    settingsRepositoryMock.getTwilioConfig.mockResolvedValue({
      accountSid: 'AC123',
      authToken: 'secret',
      fromNumber: '+16045550100',
      voiceFromNumber: '+16045550100',
      whatsappSender: '+16045550100',
      whatsappMessagingServiceSid: null,
      whatsappContentSid: null,
      whatsappContentVariables: '{"1":"{{message}}"}',
    });

    const status = await getNotificationProviderStatus();

    expect(status.sms).toEqual(expect.objectContaining({
      provider: 'twilio',
      configured: true,
      missing: [],
    }));
    expect(status.phone_call).toEqual(expect.objectContaining({
      provider: 'twilio',
      configured: true,
      missing: [],
    }));
    expect(status.whatsapp).toEqual(expect.objectContaining({
      provider: 'twilio',
      configured: false,
      missing: ['twilio_whatsapp_content_sid'],
    }));
  });

  test('reports WhatsApp as configured only when a template Content SID is present', async () => {
    settingsRepositoryMock.getTwilioConfig.mockResolvedValue({
      accountSid: 'AC123',
      authToken: 'secret',
      fromNumber: '+16045550100',
      voiceFromNumber: '+16045550100',
      whatsappSender: '+16045550100',
      whatsappMessagingServiceSid: null,
      whatsappContentSid: 'HX123',
      whatsappContentVariables: '{"1":"{{message}}"}',
    });

    const status = await getNotificationProviderStatus();

    expect(status.whatsapp).toEqual(expect.objectContaining({
      provider: 'twilio',
      configured: true,
      missing: [],
    }));
  });

  test('reports email as configured from global SendGrid settings', async () => {
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: 'SG.test',
      fromEmail: 'ticketpulse@example.com',
    });

    const status = await getNotificationProviderStatus();

    expect(status.email).toEqual(expect.objectContaining({
      provider: 'sendgrid',
      configured: true,
      missing: [],
    }));
  });

  test('sends phone verification through Twilio when SMS is configured', async () => {
    settingsRepositoryMock.getTwilioConfig.mockResolvedValue({
      accountSid: 'AC123',
      authToken: 'secret',
      fromNumber: '+16045550100',
      voiceFromNumber: '+16045550100',
      whatsappSender: '+16045550100',
      whatsappMessagingServiceSid: null,
      whatsappContentSid: null,
      whatsappContentVariables: '{"1":"{{message}}"}',
    });
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      technicianId: 17,
      threshold: 'high_urgent',
      entraPhone: null,
      entraMobilePhone: '+16045550101',
      phoneOverride: null,
    });
    prismaMock.technicianNotificationPreference.upsert.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      technicianId: 17,
    });

    const result = await notificationPreferenceService.requestPhoneVerification('alex.chen@example.com', { workspaceId: 1 });

    expect(result).toEqual({ sent: true, channel: 'sms', devCode: undefined });
    expect(sendVerificationSmsMock).toHaveBeenCalledWith({
      to: '+16045550101',
      code: expect.stringMatching(/^\d{6}$/),
    });
    expect(prismaMock.technicianNotificationPreference.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { technicianId: 17 },
      update: expect.objectContaining({
        phoneVerificationCode: expect.stringMatching(/^\d{6}$/),
      }),
    }));
  });

  test('keeps dev-code fallback for phone verification only when Twilio is not configured outside production', async () => {
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      technicianId: 17,
      threshold: 'high_urgent',
      entraPhone: '+16045550100',
      entraMobilePhone: null,
      phoneOverride: null,
    });
    prismaMock.technicianNotificationPreference.upsert.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      technicianId: 17,
    });

    const result = await notificationPreferenceService.requestPhoneVerification('alex.chen@example.com', { workspaceId: 1 });

    expect(result.sent).toBe(false);
    expect(result.channel).toBeNull();
    expect(result.devCode).toMatch(/^\d{6}$/);
    expect(sendVerificationSmsMock).not.toHaveBeenCalled();
  });

  test('requires phone verification before SMS, WhatsApp, or phone call channels can be enabled', async () => {
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      technicianId: 17,
      threshold: 'high_urgent',
      emailEnabled: true,
      smsEnabled: false,
      whatsappEnabled: false,
      phoneCallEnabled: false,
      entraPhone: '+16045550100',
      entraMobilePhone: null,
      phoneOverride: null,
      phoneVerifiedAt: null,
    });

    await expect(notificationPreferenceService.saveMyPreferences('alex.chen@example.com', {
      workspaceId: 1,
      channels: { sms: true },
    })).rejects.toThrow(/Verify a phone number/);

    expect(prismaMock.technicianNotificationPreference.upsert).not.toHaveBeenCalled();

    await expect(notificationPreferenceService.saveMyPreferences('alex.chen@example.com', {
      workspaceId: 1,
      channels: { whatsapp: true },
    })).rejects.toThrow(/Verify a phone number/);
  });

  test('queues notification delivery records after assignment when priority meets threshold', async () => {
    const verifiedAt = new Date('2026-05-26T16:00:00.000Z');
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      technicianId: 17,
      threshold: 'high_urgent',
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
      phoneCallEnabled: false,
      phoneVerifiedAt: verifiedAt,
      phoneOverride: '+16045550101',
      technician: { email: 'fallback@example.com' },
    });
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: 'SG.test',
      fromEmail: 'ticketpulse@example.com',
    });
    settingsRepositoryMock.getTwilioConfig.mockResolvedValue({
      accountSid: 'AC123',
      authToken: 'secret',
      fromNumber: '+16045550100',
      voiceFromNumber: '+16045550100',
      whatsappSender: '+16045550100',
      whatsappMessagingServiceSid: null,
      whatsappContentSid: 'HX123',
      whatsappContentVariables: '{"1":"{{message}}"}',
    });
    prismaMock.notificationDelivery.createMany.mockResolvedValue({ count: 3 });

    const run = {
      id: 3101,
      workspaceId: 1,
      ticketId: 501,
      ticket: {
        id: 501,
        workspaceId: 1,
        freshserviceTicketId: 222999,
        assessedPriority: 'High',
        assessedPriorityId: 3,
      },
    };

    const result = await notificationPreferenceService.queueNotificationsForAssignment(run, {
      techId: 17,
      techEmail: 'alex.chen@example.com',
    });

    expect(result).toEqual({ queued: 3, channels: ['email', 'sms', 'whatsapp'] });
    expect(prismaMock.notificationDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          channel: 'email',
          recipient: 'alex.chen@example.com',
          dedupeKey: '3101:501:17:email',
          payload: expect.objectContaining({
            message: expect.stringContaining('https://example.freshservice.com/a/tickets/222999'),
            whatsappVariables: expect.objectContaining({
              priority: 'High',
              ticketId: '222999',
              link: 'https://example.freshservice.com/a/tickets/222999',
            }),
          }),
        }),
        expect.objectContaining({
          channel: 'sms',
          recipient: '+16045550101',
          dedupeKey: '3101:501:17:sms',
        }),
        expect.objectContaining({
          channel: 'whatsapp',
          recipient: '+16045550101',
          dedupeKey: '3101:501:17:whatsapp',
        }),
      ],
      skipDuplicates: true,
    });
    expect(notificationDeliveryServiceMock.processQueuedDeliveries).toHaveBeenCalledWith({ limit: 3 });
  });

  test('hydrates assignment priority when the pipeline run has a partial ticket payload', async () => {
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      technicianId: 17,
      threshold: 'urgent_only',
      emailEnabled: true,
      smsEnabled: false,
      whatsappEnabled: false,
      phoneCallEnabled: false,
      phoneVerifiedAt: null,
      technician: { email: 'fallback@example.com' },
    });
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: 'SG.test',
      fromEmail: 'ticketpulse@example.com',
    });
    prismaMock.ticket.findUnique.mockResolvedValue({
      id: 503,
      workspaceId: 1,
      freshserviceTicketId: 223001,
      assessedPriority: 'Urgent',
      assessedPriorityId: 4,
      priority: 4,
      freshserviceUpdatedAt: new Date('2026-05-27T18:00:00.000Z'),
      updatedAt: new Date('2026-05-27T18:00:00.000Z'),
      assignedTechId: 17,
      assignedTech: { email: 'fallback@example.com' },
    });
    prismaMock.notificationDelivery.createMany.mockResolvedValue({ count: 1 });

    const result = await notificationPreferenceService.queueNotificationsForAssignment({
      id: 3103,
      workspaceId: 1,
      ticketId: 503,
      ticket: {
        id: 503,
        freshserviceTicketId: 223001,
      },
    }, {
      techId: 17,
      techEmail: 'alex.chen@example.com',
    });

    expect(result).toEqual({ queued: 1, channels: ['email'] });
    expect(prismaMock.ticket.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 503 },
    }));
    expect(prismaMock.notificationDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          channel: 'email',
          recipient: 'alex.chen@example.com',
          pipelineRunId: 3103,
          assessedPriority: 'Urgent',
          dedupeKey: '3103:503:17:email',
          payload: expect.objectContaining({
            notificationType: 'ticket_pulse_assignment',
          }),
        }),
      ],
      skipDuplicates: true,
    });
  });

  test('does not queue notifications for pending-review priority writeback without assignment', async () => {
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue({
      id: 1,
      threshold: 'urgent_only',
      emailEnabled: true,
      phoneVerifiedAt: null,
    });

    const result = await notificationPreferenceService.queueNotificationsForAssignment({
      id: 3102,
      workspaceId: 1,
      ticketId: 502,
      ticket: {
        id: 502,
        freshserviceTicketId: 223000,
        assessedPriority: 'High',
        assessedPriorityId: 3,
      },
    }, null);

    expect(result).toEqual({ queued: 0, skipped: 'missing_priority_or_technician' });
    expect(prismaMock.notificationDelivery.createMany).not.toHaveBeenCalled();
  });

  test('queues notification delivery records when FreshService raises an assigned ticket priority', async () => {
    const verifiedAt = new Date('2026-05-26T16:00:00.000Z');
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      technicianId: 17,
      threshold: 'high_urgent',
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: false,
      phoneCallEnabled: false,
      phoneVerifiedAt: verifiedAt,
      phoneOverride: '+16045550101',
      technician: { email: 'alex.chen@example.com' },
    });
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: 'SG.test',
      fromEmail: 'ticketpulse@example.com',
    });
    settingsRepositoryMock.getTwilioConfig.mockResolvedValue({
      accountSid: 'AC123',
      authToken: 'secret',
      fromNumber: '+16045550100',
      voiceFromNumber: '+16045550100',
      whatsappSender: null,
      whatsappMessagingServiceSid: null,
      whatsappContentSid: null,
      whatsappContentVariables: '{"1":"{{message}}"}',
    });
    prismaMock.notificationDelivery.createMany.mockResolvedValue({ count: 2 });

    const result = await notificationPreferenceService.queueNotificationsForPriorityChange({
      id: 44,
      workspaceId: 1,
      fromPriorityId: 2,
      fromPriorityLabel: 'Medium',
      toPriorityId: 3,
      toPriorityLabel: 'High',
      sourceUpdatedAt: new Date('2026-05-27T15:05:00.000Z'),
      ticket: {
        id: 501,
        workspaceId: 1,
        freshserviceTicketId: 222999,
        assignedTechId: 17,
        assignedTech: { email: 'assigned@example.com' },
      },
    });

    expect(result).toEqual({ queued: 2, channels: ['email', 'sms'] });
    expect(prismaMock.notificationDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          channel: 'email',
          recipient: 'alex.chen@example.com',
          pipelineRunId: null,
          priorityEventId: 44,
          assessedPriority: 'High',
          dedupeKey: 'priority-change:44:501:17:email',
          payload: expect.objectContaining({
            notificationType: 'freshservice_priority_change',
            priorityChange: expect.objectContaining({
              fromPriorityLabel: 'Medium',
              toPriorityLabel: 'High',
            }),
          }),
        }),
        expect.objectContaining({
          channel: 'sms',
          recipient: '+16045550101',
          pipelineRunId: null,
          priorityEventId: 44,
          dedupeKey: 'priority-change:44:501:17:sms',
        }),
      ],
      skipDuplicates: true,
    });
    expect(notificationDeliveryServiceMock.processQueuedDeliveries).toHaveBeenCalledWith({ limit: 2 });
  });

  test('queues notification delivery records when FreshService reassigns a High/Urgent ticket', async () => {
    prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue({
      id: 1,
      workspaceId: 1,
      technicianId: 17,
      threshold: 'high_urgent',
      emailEnabled: true,
      smsEnabled: false,
      whatsappEnabled: false,
      phoneCallEnabled: false,
      phoneVerifiedAt: null,
      technician: { email: 'alex.chen@example.com' },
    });
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({
      apiKey: 'SG.test',
      fromEmail: 'ticketpulse@example.com',
    });
    prismaMock.notificationDelivery.createMany.mockResolvedValue({ count: 1 });

    const result = await notificationPreferenceService.queueNotificationsForFreshServiceAssignment({
      id: 504,
      workspaceId: 1,
      freshserviceTicketId: 223002,
      assessedPriority: 'Medium',
      assessedPriorityId: 2,
      priority: 4,
      assignedTechId: 17,
      freshserviceUpdatedAt: new Date('2026-05-27T18:05:00.000Z'),
      assignedTech: { email: 'assigned@example.com' },
    }, {
      previousTechnicianId: 9,
      sourceUpdatedAt: new Date('2026-05-27T18:05:00.000Z'),
    });

    expect(result).toEqual({ queued: 1, channels: ['email'] });
    expect(prismaMock.notificationDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          channel: 'email',
          recipient: 'alex.chen@example.com',
          pipelineRunId: null,
          assessedPriority: 'Urgent',
          dedupeKey: 'fs-assignment:504:9:17:2026-05-27T18:05:00.000Z:email',
          payload: expect.objectContaining({
            notificationType: 'freshservice_assignment_change',
            assignment: expect.objectContaining({
              previousTechnicianId: 9,
              technicianId: 17,
              prioritySource: 'freshservice_priority',
            }),
          }),
        }),
      ],
      skipDuplicates: true,
    });
  });

  test('builds concise FreshService-linked messages', () => {
    expect(buildNotificationMessage({
      ticket: { freshserviceTicketId: 222999 },
      priority: 'Urgent',
    })).toContain('Ticket #222999 Urgent priority has been assigned to you.');
    expect(buildPriorityChangeNotificationMessage({
      ticket: { freshserviceTicketId: 222999 },
      priority: 'High',
    })).toContain('Ticket #222999 is now High priority. You are assigned in FreshService.');
  });
});
