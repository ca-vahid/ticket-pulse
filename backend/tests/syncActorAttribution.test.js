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
const requesterRepositoryMock = {
  findByFreshserviceId: jest.fn(),
  upsert: jest.fn(),
};
const ticketLifecycleNotificationServiceMock = {
  emitTicketLifecycleNotifications: jest.fn(),
};
const prismaMock = {
  ticket: {
    update: jest.fn(),
  },
};
const clearReadCacheMock = jest.fn();
// Live-queue SSE (FR 08-07 #13): syncService lazily imports the sse routes
// module for its broadcast manager — intercept it so ingest tests can assert
// (or rule out) the 'ticket-change' broadcast.
const sseManagerMock = {
  broadcast: jest.fn(),
};

jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  sseManager: sseManagerMock,
  default: {},
}));

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
  getStatusString: jest.fn((id) => ({ 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' }[id] || 'Open')),
  getPriorityNumber: jest.fn((id) => (id >= 1 && id <= 4 ? id : 3)),
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
  default: requesterRepositoryMock,
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

jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: ticketLifecycleNotificationServiceMock,
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

const { default: syncService, resolveFsActorFromActivities, fsActorLabel } = await import('../src/services/syncService.js');
const { analyzeTicketActivities } = await import('../src/integrations/freshserviceTransformer.js');

/**
 * MEGA 09-01 Phase RO-1 / RO-5 / TU-1 — sync-observed status + assignment
 * changes name the FreshService actor (never "System"), and a status Ticket
 * Pulse just wrote to FreshService is not reverted by a stale snapshot.
 */

const EXISTING = {
  id: 501,
  assignedTechId: 77,
  status: 'Open',
  isSelfPicked: false,
  assignedBy: null,
  firstAssignedAt: null,
  rejectionCount: 0,
  freshserviceUpdatedAt: new Date('2026-08-18T14:40:00Z'),
  lastRealActivityAt: new Date('2026-08-18T14:40:00Z'),
  resolvedAt: null,
  closedAt: null,
};

function prepared(over = {}) {
  return {
    freshserviceTicketId: 237051,
    subject: 'PMT-FC 19279',
    status: 'Closed',
    priority: 3,
    createdAt: new Date('2026-08-11T16:03:00Z'),
    assignedTechId: 77,
    workspaceId: 2,
    freshserviceUpdatedAt: new Date('2026-08-18T14:46:36Z'),
    ...over,
  };
}

const CLOSE_EVENT = {
  id: 2862790,
  actor: { id: 1000123, name: 'Dominic Bautista' },
  content: 'Dominic Bautista set Status as Closed',
  created_at: '2026-08-18T14:46:36Z',
};

describe('RO-1: sync-observed status changes are attributed to the FreshService actor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    analyzeTicketActivities.mockReset();
    syncService._pendingStatusWritebacks.clear();
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
    requesterRepositoryMock.findByFreshserviceId.mockResolvedValue(null);
    prismaMock.ticket.update.mockResolvedValue({ id: 501 });
    ticketLifecycleNotificationServiceMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
  });

  test('a known FS status_event in the same pass → "<name> (FreshService)", kind freshservice_sync, via freshservice', async () => {
    await syncService.syncFreshServiceTicketSnapshot(2, { id: 237051, updated_at: '2026-08-18T14:46:36Z' }, {
      client: {},
      preparedTicket: prepared(),
      existingTicket: EXISTING,
      analysisPayload: {
        analysis: null,
        activities: [
          { id: 1, actor: { id: 5, name: 'Someone Else' }, content: 'Someone Else set Status as Open', created_at: '2026-08-17T17:48:40Z' },
          CLOSE_EVENT,
        ],
        activityFetchSucceeded: true,
      },
    });

    const row = ticketActivityRepositoryMock.create.mock.calls
      .map(([arg]) => arg).find((a) => a.activityType === 'status_changed');
    expect(row).toBeDefined();
    expect(row.performedBy).toBe('Dominic Bautista (FreshService)');
    expect(row.details).toEqual(expect.objectContaining({
      oldStatus: 'Open',
      newStatus: 'Closed',
      via: 'freshservice',
      actorKind: 'freshservice_sync',
      actorName: 'Dominic Bautista',
      actorFsId: '1000123',
    }));
  });

  test('no FS actor known → "FreshService" (never "System"), still kind freshservice_sync', async () => {
    await syncService.syncFreshServiceTicketSnapshot(2, { id: 237051 }, {
      client: {},
      preparedTicket: prepared(),
      existingTicket: EXISTING,
    });

    const rows = ticketActivityRepositoryMock.create.mock.calls.map(([arg]) => arg);
    const row = rows.find((a) => a.activityType === 'status_changed');
    expect(row.performedBy).toBe('FreshService');
    expect(row.details.actorKind).toBe('freshservice_sync');
    expect(rows.some((a) => a.performedBy === 'System')).toBe(false);
  });

  test('assignment changes resolve the FS assignment_event actor the same way', async () => {
    await syncService.syncFreshServiceTicketSnapshot(2, { id: 237051 }, {
      client: {},
      preparedTicket: prepared({ status: 'Open', assignedTechId: 88 }),
      existingTicket: EXISTING,
      analysisPayload: {
        analysis: null,
        activities: [{ id: 9, actor: { id: 7, name: 'Kirsten Fanning' }, content: 'Kirsten Fanning set Agent as Kirsten Fanning', created_at: '2026-08-18T14:45:00Z' }],
        activityFetchSucceeded: true,
      },
    });

    const row = ticketActivityRepositoryMock.create.mock.calls
      .map(([arg]) => arg).find((a) => a.activityType === 'assigned');
    expect(row.performedBy).toBe('Kirsten Fanning (FreshService)');
    expect(row.details).toEqual(expect.objectContaining({ fromTechId: 77, toTechId: 88, actorKind: 'freshservice_sync', via: 'freshservice' }));
  });
});

describe('RO-5: pending write-back guard keeps a status Ticket Pulse just wrote to FreshService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    syncService._pendingStatusWritebacks.clear();
    syncService._resolveResponderTech = jest.fn().mockResolvedValue(null);
    syncService._ensureNoiseTicketDismissed = jest.fn().mockResolvedValue({ skipped: true });
    syncService._handleTicketRebound = jest.fn().mockResolvedValue();
    ticketRepositoryMock.upsert.mockImplementation((data) => Promise.resolve({
      id: 501, freshserviceTicketId: BigInt(data.freshserviceTicketId), assignedTechId: data.assignedTechId || null,
      status: data.status, priority: 3, createdAt: new Date(), freshserviceUpdatedAt: data.freshserviceUpdatedAt || null,
    }));
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null, category: null });
    ticketPriorityEventServiceMock.recordFreshServicePriorityChange.mockResolvedValue({ recorded: true });
    prismaMock.ticket.update.mockResolvedValue({ id: 501 });
    ticketLifecycleNotificationServiceMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
  });

  test('a snapshot older than the write-back keeps the local status and logs no status_changed row', async () => {
    // Workflow reopened the ticket in FS at 10:00:05 — FS echoed updated_at 10:00:05.
    syncService.notePendingStatusWriteback(501, { status: 'Open', fsUpdatedAt: '2026-09-01T10:00:05Z' });

    const result = await syncService.syncFreshServiceTicketSnapshot(2, { id: 237051, status: 5 }, {
      client: {},
      preparedTicket: prepared({ status: 'Closed', freshserviceUpdatedAt: new Date('2026-09-01T09:59:00Z'), closedAt: new Date('2026-09-01T09:58:00Z') }),
      existingTicket: { ...EXISTING, status: 'Open', freshserviceUpdatedAt: new Date('2026-09-01T09:59:00Z') },
    });

    expect(ticketRepositoryMock.upsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'Open', closedAt: null }));
    expect(ticketActivityRepositoryMock.create.mock.calls.map(([a]) => a).some((a) => a.activityType === 'status_changed')).toBe(false);
    expect(result.statusChanged).toBe(false);
    expect(result.ticket.statusHeldForWriteback).toBe(true);
  });

  test('once FreshService updated_at catches up, its status wins again and the marker is released', async () => {
    syncService.notePendingStatusWriteback(501, { status: 'Open', fsUpdatedAt: '2026-09-01T10:00:05Z' });

    await syncService.syncFreshServiceTicketSnapshot(2, { id: 237051, status: 5 }, {
      client: {},
      preparedTicket: prepared({ status: 'Closed', freshserviceUpdatedAt: new Date('2026-09-01T10:03:00Z') }),
      existingTicket: { ...EXISTING, status: 'Open', freshserviceUpdatedAt: new Date('2026-09-01T10:00:05Z') },
    });

    expect(ticketRepositoryMock.upsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'Closed' }));
    expect(syncService._pendingStatusWritebacks.has(501)).toBe(false);
  });

  test('the durable fs_write_back audit row backs the guard after a restart (empty in-process map)', async () => {
    prismaMock.ticketActivity = {
      findFirst: jest.fn().mockResolvedValue({
        performedAt: new Date(Date.now() - 60 * 1000),
        details: { changes: { status: { from: 'Closed', to: 'Open' } }, fsUpdatedAt: new Date(Date.now() - 60 * 1000).toISOString() },
      }),
    };
    try {
      const hold = await syncService._statusWritebackHold({ id: 501, status: 'Open' }, new Date(Date.now() - 5 * 60 * 1000));
      expect(hold).toEqual(expect.objectContaining({ status: 'Open' }));
      const released = await syncService._statusWritebackHold({ id: 501, status: 'Open' }, new Date());
      expect(released).toBeNull();
    } finally {
      delete prismaMock.ticketActivity;
    }
  });

  test('a marker older than 10 minutes no longer holds', async () => {
    syncService._pendingStatusWritebacks.set(501, { status: 'Open', at: Date.now() - 11 * 60 * 1000, fsUpdatedAt: null });
    const hold = await syncService._statusWritebackHold({ id: 501, status: 'Open' }, new Date(Date.now() - 20 * 60 * 1000));
    expect(hold).toBeNull();
  });
});

describe('resolveFsActorFromActivities (pure)', () => {
  test('prefers the line naming the new status, latest wins on ties, honours the window', () => {
    const hit = resolveFsActorFromActivities([
      { actor: { id: 5, name: 'Old Closer' }, content: 'Old Closer set Status as Closed', created_at: '2026-08-14T17:55:06Z' },
      { actor: { id: 6, name: 'Reopener' }, content: 'Reopener set Status as Open', created_at: '2026-08-17T17:48:40Z' },
      CLOSE_EVENT,
    ], { kind: 'status', sinceMs: Date.parse('2026-08-17T00:00:00Z'), statusName: 'Closed' });
    expect(hit).toEqual(expect.objectContaining({ name: 'Dominic Bautista', fsId: '1000123' }));
  });

  test('reads cached thread-entry shapes too and ignores unrelated lines', () => {
    const hit = resolveFsActorFromActivities([
      { actorName: 'Ticket Workflow', actorFreshserviceId: null, content: 'Ticket Workflow executed Update department', occurredAt: '2026-08-18T14:46:00Z' },
      { actorName: 'Kirsten Fanning', actorFreshserviceId: BigInt(42), content: 'Kirsten Fanning set Agent as Kirsten Fanning', occurredAt: '2026-08-18T14:46:10Z' },
    ], { kind: 'assignment' });
    expect(hit).toEqual(expect.objectContaining({ name: 'Kirsten Fanning', fsId: '42' }));
    expect(resolveFsActorFromActivities([], { kind: 'status' })).toBeNull();
    expect(resolveFsActorFromActivities(null)).toBeNull();
  });

  test('fsActorLabel never yields "System"', () => {
    expect(fsActorLabel('Dominic Bautista')).toBe('Dominic Bautista (FreshService)');
    expect(fsActorLabel('')).toBe('FreshService');
    expect(fsActorLabel(null)).toBe('FreshService');
  });
});
