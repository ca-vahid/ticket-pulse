import { jest } from '@jest/globals';

const policyRow = {
  id: 9,
  workspaceId: 5,
  automaticEnabled: true,
  selfServiceEnabled: true,
  cooldownMinutes: 60,
  confirmationTitle: 'Request urgent after-hours assistance',
  confirmationBody: 'Confirm urgent help.',
  legacyChannels: [],
  legacyEmails: [],
  legacyPhones: [],
  recipients: [
    { workspaceId: 5, technicianId: 17, scope: 'base' },
  ],
};

const prismaMock = {
  urgentEscalationPolicy: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
  },
  urgentEscalationRecipient: {
    findMany: jest.fn(),
  },
  urgentEscalationEvent: {
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
  },
  assignmentPipelineRun: {
    findUnique: jest.fn(),
  },
  assignmentConfig: {
    findUnique: jest.fn(),
  },
  notificationDelivery: {
    createMany: jest.fn(),
  },
  publicTicketStatusLink: {
    findUnique: jest.fn(),
  },
  publicTicketStatusSettings: {
    findUnique: jest.fn(),
  },
  technician: {
    findMany: jest.fn(),
  },
  ticket: {
    update: jest.fn(),
  },
  ticketPriorityEvent: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const providerStatusMock = jest.fn();
const processQueuedDeliveriesMock = jest.fn();
const directPriorityWritebackMock = jest.fn();
const queuePriorityChangeMock = jest.fn();
let policyContextMock = {
  availability: { isAfterHours: true, isBusinessHours: false, isHoliday: false },
  notificationPolicy: { afterHoursEnabled: true, holidaysEnabled: true },
  afterHoursSupport: {},
};

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

jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({
  default: {
    executeDirectPriorityWriteback: directPriorityWritebackMock,
  },
}));

jest.unstable_mockModule('../src/services/notificationWorkflowPolicyService.js', () => ({
  getNotificationWorkflowPolicy: jest.fn(),
  getNotificationWorkflowSchedulePreview: jest.fn(),
  enrichEventContextWithNotificationPolicy: jest.fn(async (context) => ({
    ...context,
    ...policyContextMock,
  })),
  isOffHoursPolicyActive: jest.fn(() => true),
}));

jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => ({
  buildPublicTicketStatusUrl: (token) => `https://ticketpulse.example/ticket-status/${token}`,
  buildTicketEscalationUrl: (token) => `https://ticketpulse.example/ticket-escalation/${token}`,
  buildTicketUrgencyUrl: (token) => `https://ticketpulse.example/ticket-urgency/${token}`,
  hashPublicStatusToken: (token) => `hash:${token}`,
}));

jest.unstable_mockModule('../src/services/notificationPreferenceService.js', () => ({
  default: {
    queueNotificationsForPriorityChange: queuePriorityChangeMock,
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
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const { default: afterHoursUrgentEscalationService } = await import('../src/services/afterHoursUrgentEscalationService.js');

describe('afterHoursUrgentEscalationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    policyContextMock = {
      availability: { isAfterHours: true, isBusinessHours: false, isHoliday: false },
      notificationPolicy: { afterHoursEnabled: true, holidaysEnabled: true },
      afterHoursSupport: {},
    };
    processQueuedDeliveriesMock.mockResolvedValue({ processed: 0 });
    queuePriorityChangeMock.mockResolvedValue({ queued: 0, skipped: 'not_exercised' });
    providerStatusMock.mockResolvedValue({
      email: { provider: 'sendgrid', configured: true, missing: [] },
      sms: { provider: 'twilio', configured: true, missing: [] },
      whatsapp: { provider: 'twilio', configured: false, missing: ['twilio_whatsapp_content_sid'] },
      phone_call: { provider: 'twilio', configured: true, missing: [] },
    });
    prismaMock.urgentEscalationPolicy.upsert.mockResolvedValue(policyRow);
    prismaMock.urgentEscalationRecipient.findMany.mockResolvedValue([
      {
        workspaceId: 5,
        technicianId: 17,
        scope: 'base',
        technician: {
          id: 17,
          name: 'Alex Agent',
          email: 'alex@example.com',
          notificationPreference: {
            technicianId: 17,
            emailEnabled: true,
            smsEnabled: true,
            whatsappEnabled: true,
            phoneCallEnabled: false,
            phoneOverride: '+16045551234',
            entraMobilePhone: null,
            entraPhone: null,
            phoneVerifiedAt: new Date('2026-05-29T18:00:00.000Z'),
          },
        },
      },
    ]);
    prismaMock.urgentEscalationEvent.create.mockResolvedValue({
      id: 44,
      workspaceId: 5,
      ticketId: 501,
    });
    prismaMock.urgentEscalationEvent.update.mockResolvedValue({});
    prismaMock.notificationDelivery.createMany.mockResolvedValue({ count: 2 });
    prismaMock.technician.findMany.mockResolvedValue([]);
    prismaMock.ticketPriorityEvent.create.mockResolvedValue({ id: 70 });
    prismaMock.ticketPriorityEvent.findUnique.mockResolvedValue({ id: 70 });
    prismaMock.ticketPriorityEvent.update.mockResolvedValue({});
    directPriorityWritebackMock.mockResolvedValue({ success: true });
  });

  test('queues selected user channels for urgent after-hours priority runs', async () => {
    const result = await afterHoursUrgentEscalationService.queueForPriorityRun({
      id: 77,
      workspaceId: 5,
      ticketId: 501,
      recommendation: { assessedPriority: 'Urgent' },
      ticket: {
        id: 501,
        workspaceId: 5,
        freshserviceTicketId: 219999n,
        status: 'Open',
        assessedPriority: 'Urgent',
      },
    });

    expect(result.queued).toBe(2);
    expect(result.channels).toEqual(['email', 'sms']);
    expect(prismaMock.notificationDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          workspaceId: 5,
          technicianId: 17,
          ticketId: 501,
          pipelineRunId: 77,
          urgentEscalationEventId: 44,
          channel: 'email',
          recipient: 'alex@example.com',
          assessedPriority: 'Urgent',
          dedupeKey: 'urgent-escalation:44:501:17:email',
        }),
        expect.objectContaining({
          workspaceId: 5,
          technicianId: 17,
          ticketId: 501,
          pipelineRunId: 77,
          urgentEscalationEventId: 44,
          channel: 'sms',
          recipient: '+16045551234',
          assessedPriority: 'Urgent',
          dedupeKey: 'urgent-escalation:44:501:17:sms',
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
    prismaMock.urgentEscalationPolicy.upsert.mockResolvedValue({
      ...policyRow,
      automaticEnabled: false,
      recipients: [],
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

  test('lists candidate users even when notification preferences are missing', async () => {
    prismaMock.technician.findMany.mockResolvedValue([
      {
        id: 17,
        name: 'Alex Agent',
        email: 'alex@example.com',
        photoUrl: null,
        isActive: true,
        notificationPreference: null,
      },
    ]);

    const result = await afterHoursUrgentEscalationService.listCandidates(5);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual(expect.objectContaining({
      id: 17,
      selectedBase: true,
      selectedSelfExtra: false,
      hasPreferences: false,
      readyChannelCount: 0,
    }));
    expect(result.candidates[0].channels.sms).toEqual(expect.objectContaining({
      recipient: null,
      ready: false,
      warnings: expect.arrayContaining(['not_enabled_by_user', 'missing_phone', 'phone_not_verified']),
    }));
  });

  test('self-escalation updates local priority and queues alerts even if FreshService writeback fails', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue({
      id: 20,
      workspaceId: 5,
      ticketId: 501,
      token: 'token-1',
      tokenHash: 'hash:token-1',
      tokenPrefix: 'token-1',
      enabled: true,
      revokedAt: null,
      expiresAt: null,
      ticket: {
        id: 501,
        workspaceId: 5,
        freshserviceTicketId: 219999n,
        subject: 'VPN is down',
        status: 'Open',
        priority: 2,
        assessedPriority: 'High',
        assessedPriorityId: 3,
        workspace: { id: 5, name: 'IT', slug: 'it', defaultTimezone: 'America/Vancouver' },
        requester: { name: 'Requester', email: 'requester@example.com' },
        assignedTech: null,
      },
    });
    prismaMock.publicTicketStatusSettings.findUnique.mockResolvedValue({
      brandName: 'IT Helpdesk',
      accentColor: '#2563eb',
    });
    prismaMock.urgentEscalationEvent.findFirst.mockResolvedValue(null);
    prismaMock.ticket.update.mockResolvedValue({});
    prismaMock.urgentEscalationEvent.create.mockResolvedValue({
      id: 45,
      workspaceId: 5,
      ticketId: 501,
    });
    directPriorityWritebackMock.mockResolvedValue({ success: false, error: 'FreshService unavailable' });

    const result = await afterHoursUrgentEscalationService.submitPublicSelfEscalation('token-1', {
      ip: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(result.status).toBe('submitted');
    expect(result.writeback.success).toBe(false);
    expect(result.notificationSummary.queued).toBe(2);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 501 },
      data: expect.objectContaining({
        assessedPriority: 'Urgent',
        assessedPriorityId: 4,
        priority: 4,
      }),
    }));
    expect(prismaMock.urgentEscalationEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 45 },
      data: expect.objectContaining({
        status: 'completed_with_writeback_error',
        priorityWritebackStatus: 'failed',
        priorityWritebackError: 'FreshService unavailable',
      }),
    }));
  });

  test('business-hours public urgency updates priority and notifies only assigned-agent preferences by default', async () => {
    policyContextMock = {
      availability: { isAfterHours: false, isBusinessHours: true, isHoliday: false },
      notificationPolicy: { afterHoursEnabled: true, holidaysEnabled: true },
      afterHoursSupport: {},
    };
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue({
      id: 21,
      workspaceId: 5,
      ticketId: 502,
      token: 'token-2',
      tokenHash: 'hash:token-2',
      tokenPrefix: 'token-2',
      enabled: true,
      revokedAt: null,
      expiresAt: null,
      ticket: {
        id: 502,
        workspaceId: 5,
        freshserviceTicketId: 220222n,
        subject: 'Bluebeam access',
        status: 'Open',
        priority: 3,
        assessedPriority: 'High',
        assessedPriorityId: 3,
        assignedTechId: 17,
        workspace: { id: 5, name: 'IT', slug: 'it', defaultTimezone: 'America/Vancouver' },
        requester: { name: 'Requester', email: 'requester@example.com' },
        assignedTech: { id: 17, name: 'Alex Agent', email: 'alex@example.com' },
      },
    });
    prismaMock.publicTicketStatusSettings.findUnique.mockResolvedValue({
      brandName: 'IT Helpdesk',
      accentColor: '#2563eb',
    });
    prismaMock.urgentEscalationEvent.findFirst.mockResolvedValue(null);
    prismaMock.urgentEscalationEvent.create.mockResolvedValue({
      id: 46,
      workspaceId: 5,
      ticketId: 502,
      createdAt: new Date('2026-05-30T18:00:00.000Z'),
    });
    prismaMock.ticket.update.mockResolvedValue({
      id: 502,
      workspaceId: 5,
      freshserviceTicketId: 220222n,
      subject: 'Bluebeam access',
      status: 'Open',
      priority: 4,
      assessedPriority: 'Urgent',
      assessedPriorityId: 4,
      assignedTechId: 17,
      assignedTech: { id: 17, name: 'Alex Agent', email: 'alex@example.com' },
    });
    queuePriorityChangeMock.mockResolvedValue({ queued: 1, channels: ['email'] });

    const result = await afterHoursUrgentEscalationService.submitPublicBusinessUrgency('token-2', {
      ip: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(result.status).toBe('submitted');
    expect(result.notificationSummary).toEqual(expect.objectContaining({
      queued: 1,
      assignedAgent: expect.objectContaining({ queued: 1, channels: ['email'] }),
      supervisors: expect.objectContaining({ queued: 0, skipped: 'supervisor_notification_disabled' }),
    }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 502 },
      data: expect.objectContaining({
        assessedPriority: 'Urgent',
        assessedPriorityId: 4,
        priority: 4,
      }),
    }));
    expect(directPriorityWritebackMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'public-urgency-raise',
      priorityId: 4,
    }));
    expect(queuePriorityChangeMock).toHaveBeenCalled();
    expect(prismaMock.notificationDelivery.createMany).not.toHaveBeenCalled();
  });
});
