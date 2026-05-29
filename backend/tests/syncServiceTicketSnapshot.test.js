import { jest } from '@jest/globals';

const ticketRepositoryMock = {
  getByFreshserviceIds: jest.fn(),
  upsert: jest.fn(),
};
const ticketActivityRepositoryMock = {
  create: jest.fn(),
};
const noiseRuleServiceMock = {
  evaluate: jest.fn(),
};
const ticketPriorityEventServiceMock = {
  recordFreshServicePriorityChange: jest.fn(),
};
const notificationPreferenceServiceMock = {
  queueNotificationsForFreshServiceAssignment: jest.fn(),
};
const prismaMock = {
  ticket: {
    update: jest.fn(),
  },
};
const clearReadCacheMock = jest.fn();

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(),
  FORBIDDEN_TICKET: Symbol('forbidden-ticket'),
}));

jest.unstable_mockModule('../src/integrations/freshserviceTransformer.js', () => ({
  transformTickets: jest.fn(() => []),
  transformAgents: jest.fn(() => []),
  mapTechnicianIds: jest.fn((tickets) => tickets),
  analyzeTicketActivities: jest.fn(),
  transformTicketThreadEntries: jest.fn(() => []),
  transformTicketConversationEntries: jest.fn(() => []),
}));

jest.unstable_mockModule('../src/utils/parallelPool.js', () => ({
  runJobsInPool: jest.fn(),
}));

jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({
  default: { getAll: jest.fn(), upsert: jest.fn(), deactivateNotInList: jest.fn() },
}));

jest.unstable_mockModule('../src/services/ticketRepository.js', () => ({
  default: ticketRepositoryMock,
}));

jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: ticketActivityRepositoryMock,
}));

jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {
    getFreshServiceConfig: jest.fn(),
    getFreshServiceConfigForWorkspace: jest.fn(),
    get: jest.fn(),
  },
}));

jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/csatService.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({
  default: noiseRuleServiceMock,
}));

jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/ticketPriorityEventService.js', () => ({
  default: ticketPriorityEventServiceMock,
}));

jest.unstable_mockModule('../src/services/notificationPreferenceService.js', () => ({
  default: notificationPreferenceServiceMock,
}));

jest.unstable_mockModule('../src/services/assignmentFlowGuards.js', () => ({
  shouldTriggerAssignmentForLatestRun: jest.fn(),
  shouldTriggerClassificationForLatestRun: jest.fn(),
}));

jest.unstable_mockModule('../src/services/activitySyncFreshness.js', () => ({
  getActivityRefreshReason: jest.fn(),
}));

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({
  clearReadCache: clearReadCacheMock,
}));

const { default: syncService } = await import('../src/services/syncService.js');
const { analyzeTicketActivities } = await import('../src/integrations/freshserviceTransformer.js');

describe('syncService.syncFreshServiceTicketSnapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    analyzeTicketActivities.mockReset();
    syncService._resolveResponderTech = jest.fn().mockResolvedValue(null);
    syncService._ensureNoiseTicketDismissed = jest.fn().mockResolvedValue({ skipped: true });
    syncService._reconcileEpisodes = jest.fn().mockResolvedValue();
    syncService._writeEventActivities = jest.fn().mockResolvedValue();
    syncService._writeThreadEntries = jest.fn().mockResolvedValue();
    syncService._handleTicketRebound = jest.fn().mockResolvedValue();

    ticketRepositoryMock.getByFreshserviceIds.mockResolvedValue([]);
    ticketRepositoryMock.upsert.mockImplementation((data) => Promise.resolve({
      id: 501,
      freshserviceTicketId: BigInt(data.freshserviceTicketId),
      assignedTechId: data.assignedTechId || null,
      isNoise: data.isNoise || false,
      status: data.status || 'Open',
      priority: data.priority || 3,
      createdAt: data.createdAt || new Date(),
      freshserviceUpdatedAt: data.freshserviceUpdatedAt || null,
    }));
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null, category: null });
    ticketPriorityEventServiceMock.recordFreshServicePriorityChange.mockResolvedValue({ recorded: true });
    notificationPreferenceServiceMock.queueNotificationsForFreshServiceAssignment.mockResolvedValue({ queued: 1 });
  });

  test('resolves unknown responders, evaluates noise, records priority, and dismisses noise through shared ingest', async () => {
    syncService._resolveResponderTech.mockResolvedValue({ techId: 77 });
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: true, ruleId: 'auto-spam', category: 'spam_noise' });

    const result = await syncService.syncFreshServiceTicketSnapshot(2, { id: 224183 }, {
      client: {},
      preparedTicket: {
        freshserviceTicketId: 224183,
        subject: 'Auto spam',
        status: 'Open',
        priority: 2,
        createdAt: new Date(),
        assignedFreshserviceId: 9001,
        assignedTechId: null,
        ticketCategory: null,
        workspaceId: 2,
      },
      existingTicket: null,
      source: 'freshservice_webhook',
      waitForNoiseSync: true,
    });

    expect(syncService._resolveResponderTech).toHaveBeenCalledWith(9001, 2, {});
    expect(ticketRepositoryMock.upsert).toHaveBeenCalledWith(expect.objectContaining({
      assignedTechId: 77,
      isNoise: true,
      noiseRuleMatched: 'auto-spam',
      ticketCategory: 'Spam Noise',
      workspaceId: 2,
      lastIngestSource: 'freshservice_webhook',
      lastIngestedAt: expect.any(Date),
      lastWebhookIngestedAt: expect.any(Date),
      incrementWebhookIngestCount: true,
    }));
    expect(ticketPriorityEventServiceMock.recordFreshServicePriorityChange).toHaveBeenCalledWith(expect.objectContaining({
      source: 'freshservice_webhook',
    }));
    expect(syncService._ensureNoiseTicketDismissed).toHaveBeenCalledWith(result.ticket, 2, expect.objectContaining({
      noiseRuleCategory: 'Spam Noise',
      waitForSync: true,
    }));
  });

  test('queues FreshService assignment notifications for recent newly assigned tickets', async () => {
    const now = new Date();

    await syncService.syncFreshServiceTicketSnapshot(2, { id: 224184 }, {
      client: {},
      preparedTicket: {
        freshserviceTicketId: 224184,
        subject: 'Assigned in FreshService',
        status: 'Open',
        priority: 3,
        createdAt: now,
        freshserviceUpdatedAt: now,
        assignedTechId: 77,
        workspaceId: 2,
      },
      existingTicket: null,
      initialAssignmentNotificationSource: 'freshservice_webhook_initial_assignment',
    });

    expect(notificationPreferenceServiceMock.queueNotificationsForFreshServiceAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTechId: 77 }),
      expect.objectContaining({
        technicianId: 77,
        previousTechnicianId: null,
        source: 'freshservice_webhook_initial_assignment',
      }),
    );
  });

  test('records assignment-change activity for existing ticket updates', async () => {
    await syncService.syncFreshServiceTicketSnapshot(2, { id: 224185 }, {
      client: {},
      preparedTicket: {
        freshserviceTicketId: 224185,
        subject: 'Reassigned in FreshService',
        status: 'Pending',
        priority: 3,
        createdAt: new Date(),
        assignedTechId: 77,
        workspaceId: 2,
      },
      existingTicket: {
        id: 501,
        assignedTechId: 12,
        status: 'Open',
        isSelfPicked: false,
        assignedBy: null,
        firstAssignedAt: null,
        rejectionCount: 0,
      },
    });

    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 501,
      activityType: 'assigned',
      details: expect.objectContaining({
        fromTechId: 12,
        toTechId: 77,
        source: 'freshservice_sync',
      }),
    }));
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 501,
      activityType: 'status_changed',
      details: expect.objectContaining({
        oldStatus: 'Open',
        newStatus: 'Pending',
      }),
    }));
  });

  test('ignores stale unassigned snapshots when current FreshService ticket still has an assignee', async () => {
    syncService._resolveResponderTech.mockResolvedValue({ techId: 20 });
    const client = {
      fetchTicketSnapshot: jest.fn().mockResolvedValue({ id: 224582, responder_id: 1000008456 }),
    };
    const existingTicket = {
      id: 27186,
      freshserviceTicketId: BigInt(224582),
      assignedTechId: 20,
      assignedAt: new Date(),
      updatedAt: new Date(),
      status: 'Open',
      isSelfPicked: false,
      assignedBy: 'Ticket Pulse',
      firstAssignedAt: new Date(),
      rejectionCount: 0,
    };

    const result = await syncService.syncFreshServiceTicketSnapshot(1, { id: 224582 }, {
      client,
      preparedTicket: {
        freshserviceTicketId: 224582,
        subject: 'Cracked Phone Screen',
        status: 'Open',
        priority: 2,
        createdAt: new Date(),
        assignedFreshserviceId: null,
        assignedTechId: null,
        workspaceId: 1,
      },
      existingTicket,
      source: 'freshservice_sync',
      analysisPayload: {
        activityFetchSucceeded: true,
        analysis: {
          currentIsSelfPicked: false,
          assignedBy: 'Ticket Pulse',
          firstAssignedAt: existingTicket.firstAssignedAt,
          rejectionCount: 0,
          currentEpisode: {
            endMethod: 'still_active',
            startedAt: existingTicket.firstAssignedAt,
          },
          events: [],
          episodes: [],
        },
        activities: [],
      },
    });

    expect(client.fetchTicketSnapshot).toHaveBeenCalledWith(224582);
    expect(syncService._resolveResponderTech).toHaveBeenCalledWith(1000008456, 1, client);
    expect(ticketRepositoryMock.upsert).toHaveBeenCalledWith(expect.objectContaining({
      assignedTechId: 20,
      assignedFreshserviceId: 1000008456,
    }));
    expect(ticketActivityRepositoryMock.create).not.toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'assigned',
      details: expect.objectContaining({
        fromTechId: 20,
        toTechId: null,
      }),
    }));
    expect(syncService._handleTicketRebound).not.toHaveBeenCalled();
    expect(result.assignmentChanged).toBe(false);
    expect(result.assignmentClearVerification).toEqual(expect.objectContaining({
      reason: 'current_snapshot_has_responder',
      preservedTechId: 20,
    }));
  });

  test('clears assignment without rebound when FreshService is unassigned but activities do not show rejection', async () => {
    const client = {
      fetchTicketSnapshot: jest.fn().mockResolvedValue({ id: 224582, responder_id: null }),
      fetchTicketActivities: jest.fn().mockResolvedValue([]),
    };
    analyzeTicketActivities.mockReturnValue({
      currentIsSelfPicked: false,
      assignedBy: 'Ticket Pulse',
      firstAssignedAt: new Date('2026-05-29T17:50:09.000Z'),
      rejectionCount: 0,
      currentEpisode: {
        endMethod: 'still_active',
        startedAt: new Date('2026-05-29T17:50:09.000Z'),
      },
      events: [],
      episodes: [],
    });
    const existingTicket = {
      id: 27186,
      freshserviceTicketId: BigInt(224582),
      assignedTechId: 20,
      assignedAt: new Date('2026-05-29T17:50:09.000Z'),
      updatedAt: new Date('2026-05-29T17:50:09.000Z'),
      status: 'Open',
      isSelfPicked: false,
      assignedBy: 'Ticket Pulse',
      firstAssignedAt: new Date('2026-05-29T17:50:09.000Z'),
      rejectionCount: 0,
    };

    const result = await syncService.syncFreshServiceTicketSnapshot(1, { id: 224582 }, {
      client,
      preparedTicket: {
        freshserviceTicketId: 224582,
        subject: 'Cracked Phone Screen',
        status: 'Open',
        priority: 2,
        createdAt: new Date(),
        assignedFreshserviceId: null,
        assignedTechId: null,
        workspaceId: 1,
      },
      existingTicket,
      source: 'freshservice_sync',
    });

    expect(client.fetchTicketSnapshot).toHaveBeenCalledWith(224582);
    expect(client.fetchTicketActivities).toHaveBeenCalledWith(224582);
    expect(ticketRepositoryMock.upsert).toHaveBeenCalledWith(expect.objectContaining({
      assignedTechId: null,
    }));
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'assigned',
      details: expect.objectContaining({
        fromTechId: 20,
        toTechId: null,
        source: 'freshservice_current_snapshot',
        verifiedByFreshserviceActivity: false,
        verificationReason: 'current_snapshot_unassigned_without_rejection_activity',
      }),
    }));
    expect(syncService._handleTicketRebound).not.toHaveBeenCalled();
    expect(result.assignmentChanged).toBe(true);
  });

  test('creates rebound only when FreshService activity analysis confirms rejection', async () => {
    const rejectedAt = new Date('2026-05-29T17:55:00.000Z');
    const existingTicket = {
      id: 27186,
      freshserviceTicketId: BigInt(224582),
      assignedTechId: 20,
      assignedAt: new Date('2026-05-29T17:50:09.000Z'),
      updatedAt: new Date('2026-05-29T17:50:09.000Z'),
      status: 'Open',
      isSelfPicked: false,
      assignedBy: 'Ticket Pulse',
      firstAssignedAt: new Date('2026-05-29T17:50:09.000Z'),
      rejectionCount: 0,
    };
    const analysis = {
      currentIsSelfPicked: false,
      assignedBy: 'Ticket Pulse',
      firstAssignedAt: existingTicket.firstAssignedAt,
      rejectionCount: 1,
      currentEpisode: {
        agentName: 'Gaby Tonnova',
        startedAt: existingTicket.firstAssignedAt,
        endedAt: rejectedAt,
        endMethod: 'rejected',
        endActorName: 'Gaby Tonnova',
      },
      events: [{ type: 'rejected', timestamp: rejectedAt, actorName: 'Gaby Tonnova' }],
      episodes: [],
    };

    await syncService.syncFreshServiceTicketSnapshot(1, { id: 224582 }, {
      client: {},
      preparedTicket: {
        freshserviceTicketId: 224582,
        subject: 'Cracked Phone Screen',
        status: 'Open',
        priority: 2,
        createdAt: new Date(),
        assignedFreshserviceId: null,
        assignedTechId: null,
        workspaceId: 1,
      },
      existingTicket,
      source: 'freshservice_sync',
      analysisPayload: {
        activityFetchSucceeded: true,
        analysis,
        activities: [],
      },
    });

    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'assigned',
      details: expect.objectContaining({
        fromTechId: 20,
        toTechId: null,
        source: 'freshservice_activity',
        verifiedByFreshserviceActivity: true,
        verificationReason: 'activity_rejected_episode',
      }),
    }));
    expect(syncService._handleTicketRebound).toHaveBeenCalledWith(
      expect.objectContaining({ id: 501, assignedTechId: null }),
      existingTicket,
      analysis,
      1,
    );
  });
});
