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
  workspaceAccess: {
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

// 16 Nov 2026: the on-call person is paged too. Nobody on call by default, so
// the older tests below see exactly the recipients they always did.
const onCallCurrentMock = jest.fn();
jest.unstable_mockModule('../src/services/urgentResponse/onCallService.js', () => ({
  default: { current: onCallCurrentMock },
}));
prismaMock.technician.findFirst = jest.fn();

const { default: afterHoursUrgentEscalationService, workspacePeople, __testing } = await import('../src/services/afterHoursUrgentEscalationService.js');

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
    onCallCurrentMock.mockResolvedValue({ configured: false });
    prismaMock.technician.findFirst.mockResolvedValue(null);
  });

  const urgentRun = () => ({
    id: 77,
    workspaceId: 5,
    ticketId: 501,
    recommendation: { assessedPriority: 'Urgent' },
    ticket: { id: 501, workspaceId: 5, freshserviceTicketId: 219999n, status: 'Open', assessedPriority: 'Urgent' },
  });
  const onCallPerson = (pref = {}) => ({
    id: 42,
    name: 'Kim Oncall',
    email: 'kim@example.com',
    isActive: true,
    notificationPreference: {
      technicianId: 42, emailEnabled: false, smsEnabled: false, whatsappEnabled: false, phoneCallEnabled: false,
      phoneOverride: '+16045550042', entraMobilePhone: null, entraPhone: null, phoneVerifiedAt: new Date('2026-10-01T18:00:00.000Z'), ...pref,
    },
  });

  test('the person on call is paged too, and texted even with their own SMS switch off (16 Nov 2026)', async () => {
    onCallCurrentMock.mockResolvedValue({ configured: true, technician: { id: 42, name: 'Kim Oncall' } });
    prismaMock.technician.findFirst.mockResolvedValue(onCallPerson());
    const result = await afterHoursUrgentEscalationService.queueForPriorityRun(urgentRun());
    const data = prismaMock.notificationDelivery.createMany.mock.calls[0][0].data;
    expect(data).toEqual(expect.arrayContaining([
      expect.objectContaining({ technicianId: 42, channel: 'sms', recipient: '+16045550042' }),
      expect.objectContaining({ technicianId: 17, channel: 'email' }),
      expect.objectContaining({ technicianId: 17, channel: 'sms' }),
    ]));
    // Their e-mail switch is off and e-mail is not forced: no e-mail to them.
    expect(data.some((d) => d.technicianId === 42 && d.channel === 'email')).toBe(false);
    expect(data).toHaveLength(3);
    expect(result.channels).toEqual(expect.arrayContaining(['email', 'sms']));
  });

  test('the text links to the ticket in Ticket Pulse with its own reference, not the FreshService copy (16 Nov 2026)', async () => {
    prismaMock.ticket.findUnique = jest.fn().mockResolvedValue({ id: 501, workspaceId: 5, origin: 'ticketpulse', nativeNumber: 12591, freshserviceTicketId: 252303n });
    await afterHoursUrgentEscalationService.queueForPriorityRun(urgentRun());
    const sms = prismaMock.notificationDelivery.createMany.mock.calls[0][0].data.find((d) => d.channel === 'sms');
    expect(sms.payload.message).toContain('ticket TP-12591');
    // The app's own address (production sets PUBLIC_APP_URL; a test run falls back to the local one).
    expect(sms.payload.message).toMatch(/Open: https?:\/\/\S+\/(tickets\/501|[a-z0-9-]+\/TP-12591)$/);
    expect(sms.payload.message).not.toContain('freshservice.com');
    expect(sms.payload.message).not.toContain('252303');
    expect(sms.payload.voiceMessage).toContain('Ticket T P 12591');
    expect(sms.payload.whatsappVariables).toMatchObject({ ticketId: 'TP-12591' });
    delete prismaMock.ticket.findUnique;
  });

  test('a FreshService-born ticket keeps its FreshService number, and still links into Ticket Pulse', async () => {
    prismaMock.ticket.findUnique = jest.fn().mockResolvedValue({ id: 501, workspaceId: 5, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 219999n });
    await afterHoursUrgentEscalationService.queueForPriorityRun(urgentRun());
    const sms = prismaMock.notificationDelivery.createMany.mock.calls[0][0].data.find((d) => d.channel === 'sms');
    expect(sms.payload.message).toContain('ticket #219999');
    expect(sms.payload.message).not.toContain('freshservice.com');
    delete prismaMock.ticket.findUnique;
  });

  test('on call but away with nobody covering: not paged (nothing changes)', async () => {
    onCallCurrentMock.mockResolvedValue({ configured: true, technician: { id: 42 }, onLeaveNoCover: true });
    prismaMock.technician.findFirst.mockResolvedValue(onCallPerson());
    await afterHoursUrgentEscalationService.queueForPriorityRun(urgentRun());
    const data = prismaMock.notificationDelivery.createMany.mock.calls[0][0].data;
    expect(data.some((d) => d.technicianId === 42)).toBe(false);
  });

  test('a phone that is not verified never gets the forced text', async () => {
    onCallCurrentMock.mockResolvedValue({ configured: true, technician: { id: 42 } });
    prismaMock.technician.findFirst.mockResolvedValue(onCallPerson({ phoneVerifiedAt: null }));
    await afterHoursUrgentEscalationService.queueForPriorityRun(urgentRun());
    const data = prismaMock.notificationDelivery.createMany.mock.calls[0][0].data;
    expect(data.some((d) => d.technicianId === 42)).toBe(false);
  });

  test('one incident pages once: a second urgent run on the same ticket inside the cooldown pages nobody (API Dev a/b/c)', async () => {
    onCallCurrentMock.mockResolvedValue({ configured: true, technician: { id: 42 } });
    prismaMock.technician.findFirst.mockResolvedValue(onCallPerson());
    prismaMock.urgentEscalationEvent.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 44 });
    const first = await afterHoursUrgentEscalationService.queueForPriorityRun(urgentRun());
    const second = await afterHoursUrgentEscalationService.queueForPriorityRun({ ...urgentRun(), id: 78 });
    expect(first.eventId).toBe(44);
    expect(second).toMatchObject({ queued: 0, skipped: 'cooldown', previousEventId: 44 });
    expect(prismaMock.urgentEscalationEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.notificationDelivery.createMany).toHaveBeenCalledTimes(1);
    const window = prismaMock.urgentEscalationEvent.findFirst.mock.calls[1][0].where;
    expect(window.ticketId).toBe(501);
    expect(Date.now() - window.createdAt.gte.getTime()).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
  });

  test('the on-call lookup failing changes nothing (the listed people are still paged)', async () => {
    onCallCurrentMock.mockRejectedValue(new Error('db down'));
    const result = await afterHoursUrgentEscalationService.queueForPriorityRun(urgentRun());
    expect(result.queued).toBe(2);
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

  test('lists only people in the workspace, once per e-mail, with readable names', async () => {
    prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'Mona.Member@x.io' }]);
    prismaMock.technician.findMany.mockResolvedValue([
      { id: 17, name: 'Alex Agent', email: 'alex@x.io', isActive: true, origin: 'freshservice', notificationPreference: null },
      // Same person as a local agent and as a former FreshService agent.
      { id: 30, name: 'Dana Double', email: 'dana@x.io', isActive: false, origin: 'freshservice', notificationPreference: null },
      { id: 31, name: 'Dana Double', email: 'DANA@x.io', isActive: true, origin: 'local', notificationPreference: null },
      // Vendor agent, no longer active and not an app member.
      { id: 40, name: 'Vera Vendor', email: 'vera@vendor.example', isActive: false, origin: 'freshservice', notificationPreference: null },
      // App member who is not an agent; name stored as UTF-8 read as CP437.
      { id: 50, name: 'Mona-H├⌐l├¿ne Member', email: 'mona.member@x.io', isActive: false, origin: 'freshservice', notificationPreference: null },
      { id: 60, name: 'Ari Assignable', email: 'ari@x.io', isActive: false, assignableOnly: true, origin: 'freshservice', notificationPreference: null },
    ]);

    const result = await afterHoursUrgentEscalationService.listCandidates(5);
    const byId = Object.fromEntries(result.candidates.map((candidate) => [candidate.id, candidate]));

    expect(Object.keys(byId).map(Number).sort((a, b) => a - b)).toEqual([17, 31, 50, 60]);
    expect(byId[31].membership).toBe('agent');
    expect(byId[50]).toEqual(expect.objectContaining({ membership: 'member', name: 'Mona-Hélène Member' }));
    expect(byId[60].membership).toBe('assignable');
  });

  test('keeps a picked person listed even when they left the workspace', () => {
    const people = workspacePeople([
      { id: 1, name: 'Old Owner', email: 'old@x.io', isActive: false, origin: 'freshservice' },
      { id: 2, name: 'Pat Pair', email: 'pat@x.io', isActive: true, origin: 'freshservice' },
      { id: 3, name: 'Pat Pair', email: 'pat@x.io', isActive: false, origin: 'local' },
    ], { selectedIds: new Set([1, 3]) });

    // The picked row of Pat stays (its settings are the ones alerts use);
    // Pat still counts as an agent of the workspace through the other row.
    expect(people.map(({ technician, membership }) => [technician.id, membership])).toEqual([
      [1, 'outside'],
      [3, 'agent'],
    ]);
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
    // The public response carries counts only (QA 11-16 review: it used to name skipped staff);
    // the full summary is kept on the escalation event for the team.
    expect(result.notificationSummary).toEqual({ queued: 1, channels: ['email'] });
    expect(result.writeback).not.toHaveProperty('error');
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

// QA 11-16: the redesigned after-hours page (/ticket-escalation/:token).
describe('public after-hours page payload', () => {
  const { publicSupportPhase, shortNextBusinessLabel } = __testing;
  const table = {
    rows: [
      { label: 'Monday to Friday', businessHours: '5am - 5pm PT', afterHours: '5pm - 10pm PT', lateNight: 'After 10pm PT' },
      { label: 'Weekends', businessHours: 'N/A', afterHours: '10am - 5pm PT', lateNight: 'After 5pm PT' },
      { label: 'Holidays', businessHours: 'N/A', afterHours: '10am - 5pm PT', lateNight: 'After 5pm PT' },
    ],
  };
  const off = { isBusinessHours: false, isAfterHours: true, isHoliday: false };
  // UTC keeps these independent of the machine's tzdata for BC.
  const phaseAt = (iso, availability = off) => publicSupportPhase({
    availability, responseTable: table, timezone: 'UTC', at: new Date(iso),
  });

  const tpLink = (ticket = {}) => ({
    id: 30,
    workspaceId: 1,
    ticketId: 66260,
    tokenHash: 'hash:tok-page',
    tokenPrefix: 'tok-page',
    enabled: true,
    revokedAt: null,
    expiresAt: null,
    ticket: {
      id: 66260,
      workspaceId: 1,
      origin: 'ticketpulse',
      nativeNumber: 12591,
      freshserviceTicketId: 252303n,
      subject: "Laptop won't connect to VPN",
      status: 'Open',
      priority: 2,
      assessedPriority: 'Medium',
      workspace: { id: 1, name: 'IT', slug: 'it', defaultTimezone: 'America/Vancouver' },
      requester: { name: 'Robin Requester', email: 'robin@example.com' },
      assignedTech: { id: 3, name: 'Alex Agent', email: 'alex@example.com', photoUrl: 'data:image/png;base64,AAAA' },
      ...ticket,
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.urgentEscalationPolicy.upsert.mockResolvedValue({ ...policyRow, workspaceId: 1 });
    prismaMock.publicTicketStatusSettings.findUnique.mockResolvedValue({ brandName: 'IT Helpdesk' });
    prismaMock.urgentEscalationEvent.findFirst.mockResolvedValue(null);
    policyContextMock = {
      availability: {
        ...off,
        checkedAt: '2026-11-17T05:41:00.000Z',
        nextBusinessTime: '2026-11-17T12:00:00.000Z',
        nextBusinessTimeLocal: 'Tue, Nov 17, 5:00 AM PT',
      },
      notificationPolicy: { afterHoursEnabled: true, holidaysEnabled: true },
      afterHoursSupport: { enabled: true, message: 'We are out.', activeContact: { name: 'Kim Oncall', phone: '+16045550042' } },
    };
  });

  test('carries the ticket\'s own reference and no person', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(tpLink());
    const result = await afterHoursUrgentEscalationService.getPublicSelfEscalation('tok-page');
    expect(result.ticket.ref).toBe('TP-12591');
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/Alex Agent|Robin Requester|Kim Oncall|6045550042|base64/);
    expect(result.afterHours.support).toEqual({ enabled: true, message: 'We are out.' });
    expect(result.afterHours.phase).toMatch(/^(after_hours|late_night)$/);
    expect(typeof result.afterHours.localHour).toBe('number');
    expect(result.afterHours.nextBusinessShort).toMatch(/^\d{1,2}(:\d{2})? (AM|PM)$/);
    expect(result.afterHours.expect.afterHours).toBe('For high-priority issues. We reply within about 2 hours.');
    expect(result.escalation).toEqual({ sentAt: null, sentAtLocal: null });
  });

  test('an FS-born ticket keeps its FreshService number as its reference', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(tpLink({ origin: 'freshservice', nativeNumber: null }));
    const result = await afterHoursUrgentEscalationService.getPublicSelfEscalation('tok-page');
    expect(result.ticket.ref).toBe('#252303');
  });

  test('custom response copy from Settings replaces the short lines', async () => {
    prismaMock.urgentEscalationPolicy.upsert.mockResolvedValue({
      ...policyRow,
      workspaceId: 1,
      afterHoursResponseCopy: { afterHours: 'Text the after-hours line; we answer within an hour.' },
    });
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(tpLink());
    const result = await afterHoursUrgentEscalationService.getPublicSelfEscalation('tok-page');
    expect(result.afterHours.expect.afterHours).toBe('Text the after-hours line; we answer within an hour.');
    expect(result.afterHours.expect.lateNight).toBe("We'll still try, but it can take longer than 2 hours.");
  });

  test('a submitted request says when it was sent', async () => {
    prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(tpLink());
    prismaMock.ticket.update.mockResolvedValue({});
    prismaMock.urgentEscalationEvent.create.mockResolvedValue({
      id: 46, workspaceId: 1, ticketId: 66260, createdAt: new Date('2026-11-17T05:41:00.000Z'),
    });
    directPriorityWritebackMock.mockResolvedValue({ success: true });
    const result = await afterHoursUrgentEscalationService.submitPublicSelfEscalation('tok-page', { ip: '127.0.0.1' });
    expect(result.status).toBe('submitted');
    expect(result.escalation.sentAt).toBe('2026-11-17T05:41:00.000Z');
    expect(result.escalation.sentAtLocal).toMatch(/\d{1,2}:41 (AM|PM)$/);
  });

  test('business hours, after-hours and late night from the policy table', () => {
    expect(phaseAt('2026-11-17T10:00:00Z', { isBusinessHours: true, isAfterHours: false })).toBe('business');
    // Tuesday (UTC): 9 PM inside 5pm–10pm, 11 PM and 2 AM after it.
    expect(phaseAt('2026-11-17T21:00:00Z')).toBe('after_hours');
    expect(phaseAt('2026-11-17T23:00:00Z')).toBe('late_night');
    expect(phaseAt('2026-11-18T02:00:00Z')).toBe('late_night');
    // Saturday: 11 AM inside 10am–5pm, 8 AM and 6 PM outside.
    expect(phaseAt('2026-11-21T11:00:00Z')).toBe('after_hours');
    expect(phaseAt('2026-11-21T08:00:00Z')).toBe('late_night');
    expect(phaseAt('2026-11-21T18:00:00Z')).toBe('late_night');
    // A holiday on a weekday uses the Holidays row.
    expect(phaseAt('2026-11-17T21:00:00Z', { ...off, isHoliday: true })).toBe('late_night');
    // An after-hours cell we cannot read never claims late night.
    expect(publicSupportPhase({
      availability: off, responseTable: { rows: [{ label: 'Monday to Friday', afterHours: 'Evenings' }] }, timezone: 'UTC', at: new Date('2026-11-17T23:00:00Z'),
    })).toBe('after_hours');
  });

  test('the headline time: time only today or tomorrow, weekday within a week', () => {
    const now = new Date('2026-11-17T21:41:00Z'); // Tuesday 9:41 PM UTC
    expect(shortNextBusinessLabel('2026-11-18T05:00:00Z', 'UTC', now)).toBe('5 AM');
    expect(shortNextBusinessLabel('2026-11-18T05:30:00Z', 'UTC', now)).toBe('5:30 AM');
    expect(shortNextBusinessLabel('2026-11-20T05:00:00Z', 'UTC', now)).toBe('Friday 5 AM');
    expect(shortNextBusinessLabel('2026-11-30T05:00:00Z', 'UTC', now)).toBe('Mon, Nov 30, 5 AM');
    expect(shortNextBusinessLabel(null, 'UTC', now)).toBeNull();
  });
});
