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
  notificationPreference: {
    findUnique: jest.fn(),
  },
  ticketActivity: {
    findFirst: jest.fn(),
    create: jest.fn(),
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
    expect(processQueuedDeliveriesMock).toHaveBeenCalledWith({
      limit: 2,
      dedupeKeys: [
        'urgent-escalation:44:501:17:email',
        'urgent-escalation:44:501:17:sms',
      ],
    });
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

  test('self-escalation still requests after-hours support when the ticket is already urgent', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue({
      id: 22,
      workspaceId: 5,
      ticketId: 503,
      token: 'token-3',
      tokenHash: 'hash:token-3',
      tokenPrefix: 'token-3',
      enabled: true,
      revokedAt: null,
      expiresAt: null,
      ticket: {
        id: 503,
        workspaceId: 5,
        freshserviceTicketId: 225384n,
        subject: 'Mail.Read Permissions Granted to Application involving one user',
        status: 'Closed',
        priority: 4,
        assessedPriority: 'Urgent',
        assessedPriorityId: 4,
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
    directPriorityWritebackMock.mockResolvedValue({ success: true });

    const result = await afterHoursUrgentEscalationService.submitPublicSelfEscalation('token-3', {
      ip: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(result.status).toBe('submitted');
    expect(result.alreadyUrgent).toBe(true);
    expect(result.alreadyEscalated).toBe(false);
    expect(result.reasons).not.toEqual(expect.arrayContaining([
      'already_escalated',
      'ticket_closed_or_resolved',
    ]));
    expect(prismaMock.urgentEscalationEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        ticketId: 503,
        source: 'self_service',
        triggeredBy: 'requester_public_link',
      }),
    }));
    expect(prismaMock.notificationDelivery.createMany).toHaveBeenCalled();
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

// 30 Sep 2026: two first reads raced on creating the default policy row and
// GET /settings/urgent-escalation answered 500 (P2002). The loser now reads.
describe('getPolicy — concurrent first read', () => {
  test('a P2002 from the upsert falls back to reading the row the other request created', async () => {
    const dup = Object.assign(new Error('Unique constraint failed on the fields: (`workspace_id`)'), { code: 'P2002' });
    prismaMock.urgentEscalationPolicy.upsert.mockRejectedValueOnce(dup);
    prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValueOnce({ id: 9, workspaceId: 1, enabled: false, recipients: [] });
    const policy = await afterHoursUrgentEscalationService.getPolicy(1);
    expect(prismaMock.urgentEscalationPolicy.findUnique).toHaveBeenCalledWith({ where: { workspaceId: 1 }, include: { recipients: true } });
    expect(policy).toBeTruthy();
  });

  test('any other error still throws', async () => {
    prismaMock.urgentEscalationPolicy.upsert.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'P1001' }));
    await expect(afterHoursUrgentEscalationService.getPolicy(1)).rejects.toThrow('db down');
  });
});

// QA 10-15 #5: requesters can open a Teams chat with the assigned agent from
// the urgency page — only when the agent opted in, the ticket is open and the
// requester is inside the company.
describe('urgency page — Teams chat with the assigned agent', () => {
  const AGENT_EMAIL = 'sam.okafor@bgc-example.com';

  function chatLink(ticketOverrides = {}, workspaceOverrides = {}) {
    return {
      id: 77,
      workspaceId: 5,
      ticketId: 610,
      tokenPrefix: 'tok-chat',
      enabled: true,
      revokedAt: null,
      expiresAt: null,
      ticket: {
        id: 610,
        workspaceId: 5,
        origin: 'ticketpulse',
        nativeNumber: 10018,
        freshserviceTicketId: 330333n,
        subject: 'design software licence',
        status: 'Open',
        priority: 2,
        assessedPriority: 'Medium',
        assessedPriorityId: 2,
        assignedTechId: 31,
        workspace: { id: 5, name: 'IT', slug: 'it', defaultTimezone: 'America/Vancouver', internalDomains: ['bgc-example.com'], ...workspaceOverrides },
        requester: { name: 'Priya Nair', email: 'priya.nair@bgc-example.com' },
        assignedTech: { id: 31, name: 'Sam Okafor', email: AGENT_EMAIL, photoUrl: null },
        ...ticketOverrides,
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    policyContextMock = {
      availability: { isAfterHours: false, isBusinessHours: true, isHoliday: false },
      notificationPolicy: { afterHoursEnabled: true, holidaysEnabled: true },
      afterHoursSupport: {},
    };
    prismaMock.urgentEscalationPolicy.upsert.mockResolvedValue(policyRow);
    prismaMock.publicTicketStatusSettings.findUnique.mockResolvedValue(null);
    prismaMock.urgentEscalationEvent.findFirst.mockResolvedValue(null);
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(chatLink());
    prismaMock.notificationPreference.findUnique.mockResolvedValue({ options: { requesterTeamsChat: true } });
    prismaMock.ticketActivity.findFirst.mockResolvedValue(null);
    prismaMock.ticketActivity.create.mockResolvedValue({ id: 1 });
  });

  test('all rules met: offered with the agent name, never the agent e-mail', async () => {
    const result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.teamsChat).toEqual({ available: true, agentName: 'Sam Okafor', agentFirstName: 'Sam' });
    expect(JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(AGENT_EMAIL);
    expect(prismaMock.notificationPreference.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_technicianId: { workspaceId: 5, technicianId: 31 } },
    }));
  });

  test('the page shows the TP number for a Ticket Pulse ticket and #id for a FreshService one', async () => {
    let result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.ticket.displayRef).toBe('TP-10018');
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(chatLink({ origin: 'freshservice', nativeNumber: null }));
    result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.ticket.displayRef).toBe('#330333');
  });

  test('agent has not opted in (no row, or switch off): not offered', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null);
    let result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.teamsChat).toEqual(expect.objectContaining({ available: false, agentName: null })); expect(result.teamsChat.reason).toBeUndefined();
    prismaMock.notificationPreference.findUnique.mockResolvedValue({ options: { requesterTeamsChat: false, dailyDigest: true } });
    result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.teamsChat.available).toBe(false);
  });

  test('a preferences read failure means not offered (never a 500)', async () => {
    prismaMock.notificationPreference.findUnique.mockRejectedValue(new Error('relation "notification_preferences" does not exist'));
    const result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.teamsChat).toEqual(expect.objectContaining({ available: false }));
  });

  test('closed or resolved ticket: not offered', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(chatLink({ status: 'Resolved' }));
    const result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.teamsChat).toEqual(expect.objectContaining({ available: false }));
  });

  test('no assigned agent: not offered', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(chatLink({ assignedTechId: null, assignedTech: null }));
    const result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.teamsChat).toEqual(expect.objectContaining({ available: false }));
  });

  test('outside requester: not offered', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(chatLink({ requester: { name: 'Dana Whitfield', email: 'dana@vendor-example.com' } }));
    const result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.teamsChat).toEqual(expect.objectContaining({ available: false }));
  });

  test('a subdomain of an internal domain counts as inside', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(chatLink({ requester: { name: 'Priya Nair', email: 'priya@ca.bgc-example.com' } }));
    const result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.teamsChat.available).toBe(true);
  });

  test('no internal domains set: requester must share the agent domain', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(chatLink({}, { internalDomains: [] }));
    let result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.teamsChat.available).toBe(true);
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(chatLink({ requester: { name: 'Dana Whitfield', email: 'dana@vendor-example.com' } }, { internalDomains: [] }));
    result = await afterHoursUrgentEscalationService.getPublicBusinessUrgency('tok-chat');
    expect(result.teamsChat).toEqual(expect.objectContaining({ available: false }));
  });

  test('POST writes a history line and returns the Teams deep link', async () => {
    const result = await afterHoursUrgentEscalationService.startRequesterTeamsChat('tok-chat', { ip: '10.0.0.1' });
    const message = 'About TP-10018 – design software licence: ';
    expect(result).toEqual({
      available: true,
      agentName: 'Sam Okafor',
      agentFirstName: 'Sam',
      url: `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(AGENT_EMAIL)}&message=${encodeURIComponent(message)}`,
    });
    expect(prismaMock.ticketActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ticketId: 610,
        activityType: 'requester_teams_chat',
        performedBy: 'Priya Nair',
        details: expect.objectContaining({ via: 'urgency_page', agentName: 'Sam Okafor', technicianId: 31 }),
      }),
    });
  });

  test('POST again within ten minutes opens the chat but adds no second history line', async () => {
    prismaMock.ticketActivity.findFirst.mockResolvedValue({ id: 9 });
    const result = await afterHoursUrgentEscalationService.startRequesterTeamsChat('tok-chat');
    expect(result.url).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/chat\/0\/0\?users=/);
    expect(prismaMock.ticketActivity.create).not.toHaveBeenCalled();
  });

  test('POST still returns the link if the history write fails', async () => {
    prismaMock.ticketActivity.create.mockRejectedValue(new Error('db blip'));
    const result = await afterHoursUrgentEscalationService.startRequesterTeamsChat('tok-chat');
    expect(result.available).toBe(true);
    expect(result.url).toContain('teams.microsoft.com');
  });

  test('POST refused when the chat is not available: no link, no history line', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue({ options: {} });
    const result = await afterHoursUrgentEscalationService.startRequesterTeamsChat('tok-chat');
    expect(result).toEqual({ available: false, url: null });
    expect(prismaMock.ticketActivity.create).not.toHaveBeenCalled();
  });

  test('POST refused for a closed ticket', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(chatLink({ status: 'Closed' }));
    const result = await afterHoursUrgentEscalationService.startRequesterTeamsChat('tok-chat');
    expect(result.url).toBeNull();
    expect(prismaMock.ticketActivity.create).not.toHaveBeenCalled();
  });
});
