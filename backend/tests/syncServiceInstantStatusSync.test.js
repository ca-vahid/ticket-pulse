import { jest } from '@jest/globals';

// FR 08-07 #13 — Phase 1 "instant status sync": on-open reconcile pulls plain
// FS status transitions, the fast lane's ticket budget is split so assigned
// tickets aren't starved, the stale sync lock breaks at 10min with a warn log,
// and the webhook lane broadcasts a live 'ticket-change' end-to-end.

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
  processPendingEvents: jest.fn(),
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
const settingsRepositoryMock = {
  getFreshServiceConfig: jest.fn(),
  getFreshServiceConfigForWorkspace: jest.fn(),
  get: jest.fn(),
};
const syncLogRepositoryMock = {
  createLog: jest.fn(),
  completeLog: jest.fn(),
  failLog: jest.fn(),
  getLatestSuccessful: jest.fn(),
  failStaleStarted: jest.fn(),
};
const assignmentRepositoryMock = {
  getConfig: jest.fn(),
};
const workspaceRepositoryMock = {
  getBySlug: jest.fn(),
};
const workspaceWebhookServiceMock = {
  getStoredConfig: jest.fn(),
  verifySecret: jest.fn(),
  recordReceived: jest.fn(),
  recordAccepted: jest.fn(),
  recordRejected: jest.fn(),
  recordError: jest.fn(),
};
const prismaMock = {
  ticket: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  technician: {
    findFirst: jest.fn(),
  },
  assignmentPipelineRun: {
    updateMany: jest.fn(),
  },
};
const sseManagerMock = {
  broadcast: jest.fn(),
};
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
const clearReadCacheMock = jest.fn();
const clientMock = {
  fetchTickets: jest.fn(),
  fetchTicketSafe: jest.fn(),
  fetchTicketSnapshot: jest.fn(),
};
const createFreshServiceClientMock = jest.fn(() => clientMock);

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: createFreshServiceClientMock,
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
  default: settingsRepositoryMock,
}));

jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({
  default: syncLogRepositoryMock,
}));

jest.unstable_mockModule('../src/services/csatService.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({
  default: noiseRuleServiceMock,
}));

jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({
  default: assignmentRepositoryMock,
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
  default: loggerMock,
}));

jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({
  clearReadCache: clearReadCacheMock,
}));

jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: workspaceRepositoryMock,
}));

jest.unstable_mockModule('../src/services/workspaceWebhookService.js', () => ({
  default: workspaceWebhookServiceMock,
}));

jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  sseManager: sseManagerMock,
  default: {},
}));

const { default: syncService } = await import('../src/services/syncService.js');
const { default: freshServiceWebhookIngestService } = await import('../src/services/freshServiceWebhookIngestService.js');

// Instance methods some tests stub — captured once so afterEach restores them.
const ORIGINALS = {
  syncFreshServiceTicketSnapshot: syncService.syncFreshServiceTicketSnapshot,
  _prepareTicketsForDatabase: syncService._prepareTicketsForDatabase,
  _pollForUnassignedTickets: syncService._pollForUnassignedTickets,
  _classifyAssignedTicketsMissingCategories: syncService._classifyAssignedTicketsMissingCategories,
  _recoverOpenNoiseTickets: syncService._recoverOpenNoiseTickets,
  _initializeClient: syncService._initializeClient,
  syncTechnicians: syncService.syncTechnicians,
  syncTickets: syncService.syncTickets,
  syncRequesters: syncService.syncRequesters,
  syncRecentCSAT: syncService.syncRecentCSAT,
  _syncTicketTypeRegistry: syncService._syncTicketTypeRegistry,
  _recoverOrphanedSyncs: syncService._recoverOrphanedSyncs,
  _reconcileTicketStatuses: syncService._reconcileTicketStatuses,
  _preheatTicketThreads: syncService._preheatTicketThreads,
  _resolveResponderTech: syncService._resolveResponderTech,
  _ensureNoiseTicketDismissed: syncService._ensureNoiseTicketDismissed,
  _ensureRequesterLinkedForNotification: syncService._ensureRequesterLinkedForNotification,
  _verifyAssignedToUnassignedSnapshot: syncService._verifyAssignedToUnassignedSnapshot,
};

afterEach(() => {
  Object.assign(syncService, ORIGINALS);
  syncService.runningWorkspaces.clear();
});

beforeEach(() => {
  jest.clearAllMocks();
  ticketPriorityEventServiceMock.processPendingEvents.mockResolvedValue({ processed: 0 });
  noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null, category: null });
  prismaMock.assignmentPipelineRun.updateMany.mockResolvedValue({ count: 0 });
});

describe('reconcileSingleTicket — on-open heal (plain status transitions)', () => {
  const FS_TICKET_ROW = {
    id: 501,
    origin: 'freshservice',
    freshserviceTicketId: BigInt(224183),
    status: 'Open',
    priority: 2,
    resolvedAt: null,
    createdAt: new Date('2026-08-01T10:00:00Z'),
  };

  beforeEach(() => {
    syncService._initializeClient = jest.fn().mockResolvedValue(clientMock);
    prismaMock.ticket.findFirst.mockResolvedValue({ ...FS_TICKET_ROW });
    prismaMock.ticket.findUnique.mockResolvedValue({
      assignedTechId: 12,
      status: 'Open',
      priority: 2,
      resolvedAt: null,
      closedAt: null,
      createdAt: FS_TICKET_ROW.createdAt,
    });
    prismaMock.technician.findFirst.mockResolvedValue({ id: 12, name: 'Gaby Tonnova' });
    prismaMock.ticket.update.mockImplementation(({ data }) => Promise.resolve({
      id: 501,
      origin: 'freshservice',
      status: data.status || 'Open',
      assignedTechId: Object.prototype.hasOwnProperty.call(data, 'assignedTechId') ? data.assignedTechId : 12,
      updatedAt: data.updatedAt || new Date(),
    }));
  });

  test('pulls a plain Open→Resolved transition from FS truth and broadcasts it', async () => {
    clientMock.fetchTicketSafe.mockResolvedValue({ id: 224183, status: 4, priority: 2, responder_id: 9001 });

    const result = await syncService.reconcileSingleTicket(501, 2);

    expect(result).toEqual(expect.objectContaining({ changed: true, status: 'Resolved' }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 501 },
      data: expect.objectContaining({ status: 'Resolved', resolvedAt: expect.any(Date) }),
    }));
    expect(ticketActivityRepositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({
      activityType: 'status_changed',
      performedBy: 'FreshService',
      details: expect.objectContaining({ oldStatus: 'Open', newStatus: 'Resolved' }),
    }));
    // Terminal transition cancels queued pipeline runs.
    expect(prismaMock.assignmentPipelineRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketId: 501, status: 'queued' },
    }));
    expect(sseManagerMock.broadcast).toHaveBeenCalledWith(
      'ticket-change',
      expect.objectContaining({ action: 'sync', ticketId: 501, status: 'Resolved' }),
      2,
    );
  });

  test('no-op when FS agrees with the local row (no update, no activity, no broadcast)', async () => {
    clientMock.fetchTicketSafe.mockResolvedValue({ id: 224183, status: 2, priority: 2, responder_id: 9001 });

    const result = await syncService.reconcileSingleTicket(501, 2);

    expect(result).toEqual({ changed: false });
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    expect(ticketActivityRepositoryMock.create).not.toHaveBeenCalled();
    expect(sseManagerMock.broadcast).not.toHaveBeenCalled();
  });

  test('FS-born tickets in a terminal local status STILL fetch FS truth (reopen heals)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...FS_TICKET_ROW, status: 'Resolved' });
    prismaMock.ticket.findUnique.mockResolvedValue({
      assignedTechId: 12,
      status: 'Resolved',
      priority: 2,
      resolvedAt: new Date(),
      closedAt: null,
      createdAt: FS_TICKET_ROW.createdAt,
    });
    clientMock.fetchTicketSafe.mockResolvedValue({ id: 224183, status: 2, priority: 2, responder_id: 9001 });

    const result = await syncService.reconcileSingleTicket(501, 2);

    expect(clientMock.fetchTicketSafe).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ changed: true, status: 'Open' }));
  });

  test('TP-born tickets keep the terminal early-return (no FS fetch)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...FS_TICKET_ROW, origin: 'ticketpulse', status: 'Closed' });

    const result = await syncService.reconcileSingleTicket(501, 2);

    expect(result).toEqual({ changed: false });
    expect(clientMock.fetchTicketSafe).not.toHaveBeenCalled();
  });

  test('heals priority and assignee together with status in one update', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 44, name: 'Anton Neu' });
    clientMock.fetchTicketSafe.mockResolvedValue({ id: 224183, status: 3, priority: 4, responder_id: 7777 });

    const result = await syncService.reconcileSingleTicket(501, 2);

    expect(result).toEqual(expect.objectContaining({ changed: true, status: 'Pending', assignee: 'Anton Neu' }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'Pending', priority: 4, assignedTechId: 44 }),
    }));
  });

  test('an already-Deleted FS-born row does not re-log the deletion on every open', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...FS_TICKET_ROW, status: 'Deleted' });
    clientMock.fetchTicketSafe.mockResolvedValue(null); // hard-deleted in FS

    const result = await syncService.reconcileSingleTicket(501, 2);

    expect(result).toEqual({ changed: false });
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    expect(ticketActivityRepositoryMock.create).not.toHaveBeenCalled();
  });
});

describe('syncAssignmentCandidatesNow — fast-lane budget split', () => {
  const fsTicket = (id, { unassigned = false, minutesAgo = 0 } = {}) => ({
    id,
    status: 2,
    responder_id: unassigned ? null : 9000 + id,
    updated_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    subject: `Ticket ${id}`,
  });

  beforeEach(() => {
    settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue({
      domain: 'example', apiKey: 'key', workspaceId: 10,
    });
    ticketRepositoryMock.getByFreshserviceIds.mockResolvedValue([]);
    syncService._prepareTicketsForDatabase = jest.fn(async (tickets) => tickets.map((t) => ({
      freshserviceTicketId: t.id,
      subject: t.subject,
      status: 'Open',
      workspaceId: 2,
    })));
    syncService.syncFreshServiceTicketSnapshot = jest.fn(async (_ws, fs) => ({ ticket: { id: fs.id } }));
    syncService._pollForUnassignedTickets = jest.fn().mockResolvedValue({ skipped: true, triggered: 0, candidates: 0 });
    syncService._classifyAssignedTicketsMissingCategories = jest.fn().mockResolvedValue({ skipped: true });
    syncService._recoverOpenNoiseTickets = jest.fn().mockResolvedValue({ skipped: true });
  });

  const syncedIds = () => syncService.syncFreshServiceTicketSnapshot.mock.calls.map(([, fs]) => fs.id);

  test('unassigned keep first claim on half the budget; assigned get the reserved remainder', async () => {
    // 12 unassigned (newest) + 8 assigned (older), budget 10 → 5 + 5.
    const unassigned = Array.from({ length: 12 }, (_, i) => fsTicket(100 + i, { unassigned: true, minutesAgo: i }));
    const assigned = Array.from({ length: 8 }, (_, i) => fsTicket(200 + i, { minutesAgo: 20 + i }));
    clientMock.fetchTickets.mockResolvedValue([...unassigned, ...assigned]);

    await syncService.syncAssignmentCandidatesNow(2, { maxTickets: 10 });

    const ids = syncedIds();
    expect(ids).toHaveLength(10);
    expect(ids.filter((id) => id >= 200)).toHaveLength(5); // assigned share survives
    expect(ids.filter((id) => id < 200)).toEqual([100, 101, 102, 103, 104]); // newest unassigned first
    expect(ids.filter((id) => id >= 200)).toEqual([200, 201, 202, 203, 204]); // newest assigned
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('unassigned candidates exceed their reserved share'),
      expect.objectContaining({ unassignedBudget: 5, maxTickets: 10 }),
    );
  });

  test('leftover budget falls back to overall recency when assigned are few', async () => {
    const unassigned = Array.from({ length: 12 }, (_, i) => fsTicket(100 + i, { unassigned: true, minutesAgo: i }));
    const assigned = [fsTicket(200, { minutesAgo: 20 }), fsTicket(201, { minutesAgo: 21 })];
    clientMock.fetchTickets.mockResolvedValue([...unassigned, ...assigned]);

    await syncService.syncAssignmentCandidatesNow(2, { maxTickets: 10 });

    const ids = syncedIds();
    expect(ids).toHaveLength(10); // nothing wasted
    expect(ids.filter((id) => id >= 200)).toHaveLength(2);
    expect(ids.filter((id) => id < 200)).toHaveLength(8); // 5 reserved + 3 leftover
  });

  test('skips quietly when the workspace has no FreshService credentials', async () => {
    settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue(null);

    const result = await syncService.syncAssignmentCandidatesNow(2, { maxTickets: 10 });

    expect(result).toEqual(expect.objectContaining({ status: 'skipped', reason: 'freshservice_not_configured' }));
    expect(clientMock.fetchTickets).not.toHaveBeenCalled();
  });
});

describe('performFullSync — stale sync lock (10min) break', () => {
  beforeEach(() => {
    syncLogRepositoryMock.createLog.mockResolvedValue({ id: 9 });
    syncLogRepositoryMock.completeLog.mockResolvedValue({});
    syncLogRepositoryMock.getLatestSuccessful.mockResolvedValue(null);
    syncLogRepositoryMock.failStaleStarted.mockResolvedValue({});
    settingsRepositoryMock.get.mockResolvedValue(null);
    syncService.syncTechnicians = jest.fn().mockResolvedValue(1);
    syncService.syncTickets = jest.fn().mockResolvedValue(2);
    syncService.syncRequesters = jest.fn().mockResolvedValue(0);
    syncService.syncRecentCSAT = jest.fn().mockResolvedValue({ csatFound: 0 });
    syncService._syncTicketTypeRegistry = jest.fn().mockResolvedValue({ registered: 0 });
    syncService._pollForUnassignedTickets = jest.fn().mockResolvedValue({ skipped: true });
    syncService._classifyAssignedTicketsMissingCategories = jest.fn().mockResolvedValue({ skipped: true });
    syncService._recoverOrphanedSyncs = jest.fn().mockResolvedValue();
    syncService._reconcileTicketStatuses = jest.fn().mockResolvedValue();
    syncService._preheatTicketThreads = jest.fn().mockResolvedValue();
  });

  test('a lock held >20min is broken with a warn log and the sync proceeds', async () => {
    syncService.runningWorkspaces.set(7, Date.now() - 21 * 60 * 1000);

    const result = await syncService.performFullSync({ workspaceId: 7 });

    expect(result.status).toBe('completed');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('Breaking stale sync lock for workspace 7'),
      expect.objectContaining({ workspaceId: 7 }),
    );
    expect(syncLogRepositoryMock.failStaleStarted).toHaveBeenCalledWith(7, 20 * 60 * 1000);
  });

  test('a lock held <20min still skips the run (no premature takeover)', async () => {
    // Phase SH raised the threshold 10m → 20m: Accounting's HEALTHY full
    // cycles run ~13 min, and the 10-min watchdog was stealing the lock
    // mid-run (concurrent duplicates + out-of-order completions).
    syncService.runningWorkspaces.set(7, Date.now() - 13 * 60 * 1000);

    const result = await syncService.performFullSync({ workspaceId: 7 });

    expect(result.status).toBe('skipped');
    expect(syncService.syncTechnicians).not.toHaveBeenCalled();
  });
});

describe('webhook ingest → shared snapshot → SSE broadcast (end-to-end)', () => {
  beforeEach(() => {
    workspaceRepositoryMock.getBySlug.mockResolvedValue({
      id: 2,
      slug: 'it',
      isActive: true,
      freshserviceWorkspaceId: BigInt(10),
    });
    workspaceWebhookServiceMock.getStoredConfig.mockResolvedValue({ workspaceId: 2, enabled: true, secretHash: 'h' });
    workspaceWebhookServiceMock.verifySecret.mockResolvedValue(true);
    settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue({ domain: 'example', apiKey: 'key' });
    assignmentRepositoryMock.getConfig.mockResolvedValue(null); // polling self-gates off

    clientMock.fetchTicketSnapshot.mockResolvedValue({ id: 224183, workspace_id: 10, status: 4, subject: 'Now resolved' });
    syncService._prepareTicketsForDatabase = jest.fn().mockResolvedValue([{
      freshserviceTicketId: 224183,
      subject: 'Now resolved',
      status: 'Resolved',
      priority: 3,
      createdAt: new Date(),
      assignedTechId: 12,
      workspaceId: 2,
    }]);
    ticketRepositoryMock.getByFreshserviceIds.mockResolvedValue([{
      id: 501,
      freshserviceTicketId: BigInt(224183),
      origin: 'freshservice',
      assignedTechId: 12,
      status: 'Open',
      isSelfPicked: false,
      assignedBy: null,
      firstAssignedAt: null,
      rejectionCount: 0,
    }]);
    ticketRepositoryMock.upsert.mockImplementation((data) => Promise.resolve({
      id: 501,
      freshserviceTicketId: BigInt(data.freshserviceTicketId),
      origin: 'freshservice',
      assignedTechId: data.assignedTechId ?? null,
      isNoise: false,
      status: data.status,
      priority: data.priority,
      createdAt: data.createdAt,
      updatedAt: new Date(),
    }));
    ticketPriorityEventServiceMock.recordFreshServicePriorityChange.mockResolvedValue({ recorded: true });
    ticketLifecycleNotificationServiceMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
    syncService._ensureNoiseTicketDismissed = jest.fn().mockResolvedValue({ skipped: true });
    syncService._ensureRequesterLinkedForNotification = jest.fn(async (t) => t);
    syncService._verifyAssignedToUnassignedSnapshot = jest.fn(async ({ ticket, analysisPayload }) => ({
      ticket,
      analysisPayload,
      assignmentClearVerification: null,
      confirmedRebound: false,
    }));
  });

  test('an FS status-change delivery lands as a workspace-scoped ticket-change broadcast', async () => {
    const result = await freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: 'it',
      freshserviceTicketId: '224183',
      suppliedSecret: 'secret',
    });

    expect(result.accepted).toBe(true);
    expect(result.synced).toBe(true);
    expect(sseManagerMock.broadcast).toHaveBeenCalledWith(
      'ticket-change',
      expect.objectContaining({
        action: 'sync',
        workspaceId: 2,
        ticketId: 501,
        status: 'Resolved',
        assignedTechId: 12,
        updatedAt: expect.any(Date),
      }),
      2,
    );
    expect(workspaceWebhookServiceMock.recordAccepted).toHaveBeenCalledWith(2);
  });
});
