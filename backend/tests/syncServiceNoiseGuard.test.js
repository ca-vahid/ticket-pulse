import { jest } from '@jest/globals';

/**
 * NT-10 — isNoise durability during FS sync.
 *
 * The deterministic noise rules re-run on every sync and used to overwrite
 * ticket.isNoise unconditionally, clobbering the AI pipeline's noise verdict
 * (noise_dismissed → isNoise=true) or a veto on the next sync. New rule: once
 * ANY pipeline run has recorded a decision for the ticket (decidedAt set),
 * routine sync no longer flips isNoise in either direction.
 */

const ticketRepositoryMock = {
  getByFreshserviceIds: jest.fn(),
  upsert: jest.fn(),
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
  assignmentPipelineRun: {
    findFirst: jest.fn(),
  },
};

jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  sseManager: { broadcast: jest.fn() },
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
  default: { create: jest.fn() },
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
  clearReadCache: jest.fn(),
}));

const { default: syncService } = await import('../src/services/syncService.js');

function snapshotOptions(existingTicket, overrides = {}) {
  return {
    client: {},
    preparedTicket: {
      freshserviceTicketId: 239931,
      subject: 'Package waiting in shipping room',
      status: 'Open',
      priority: 3,
      createdAt: new Date(),
      assignedFreshserviceId: null,
      assignedTechId: null,
      ticketCategory: null,
      workspaceId: 1,
    },
    existingTicket,
    source: 'freshservice_sync',
    ...overrides,
  };
}

describe('syncService isNoise durability guard (NT-10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    syncService._resolveResponderTech = jest.fn().mockResolvedValue(null);
    syncService._ensureNoiseTicketDismissed = jest.fn().mockResolvedValue({ skipped: true });
    syncService._reconcileEpisodes = jest.fn().mockResolvedValue();
    syncService._writeEventActivities = jest.fn().mockResolvedValue();
    syncService._writeThreadEntries = jest.fn().mockResolvedValue();
    syncService._handleTicketRebound = jest.fn().mockResolvedValue();
    syncService._verifyAssignedToUnassignedSnapshot = jest.fn().mockImplementation(({ analysisPayload }) => Promise.resolve({
      analysisPayload,
      assignmentClearVerification: null,
      confirmedRebound: false,
    }));

    ticketRepositoryMock.getByFreshserviceIds.mockResolvedValue([]);
    ticketRepositoryMock.upsert.mockImplementation((data) => Promise.resolve({
      id: 42501,
      freshserviceTicketId: BigInt(data.freshserviceTicketId),
      assignedTechId: data.assignedTechId || null,
      isNoise: data.isNoise ?? true,
      status: data.status || 'Open',
      priority: data.priority || 3,
      createdAt: data.createdAt || new Date(),
      freshserviceUpdatedAt: null,
    }));
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null, category: null });
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue(null);
    ticketPriorityEventServiceMock.recordFreshServicePriorityChange.mockResolvedValue({ recorded: true });
    notificationPreferenceServiceMock.queueNotificationsForFreshServiceAssignment.mockResolvedValue({ queued: 0 });
    requesterRepositoryMock.findByFreshserviceId.mockResolvedValue(null);
    ticketLifecycleNotificationServiceMock.emitTicketLifecycleNotifications.mockResolvedValue({ status: 'completed' });
  });

  test('does not flip isNoise true→false when a pipeline run decided noise for the ticket', async () => {
    // Prod scenario: the AI closed the ticket as noise (isNoise=true, no rule
    // matched); the next routine sync re-evaluates rules (verdict false) and
    // used to clobber the verdict back to false.
    const existingTicket = {
      id: 42501,
      freshserviceTicketId: BigInt(239931),
      isNoise: true,
      noiseRuleMatched: null,
      assignedTechId: null,
      status: 'Closed',
    };
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue({ id: 22386, decision: 'noise_dismissed' });

    const result = await syncService.syncFreshServiceTicketSnapshot(1, { id: 239931 }, snapshotOptions(existingTicket));

    expect(prismaMock.assignmentPipelineRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketId: 42501, decidedAt: { not: null } },
    }));
    // undefined = "leave the stored value alone" in ticketRepository.upsert.
    const upsertArg = ticketRepositoryMock.upsert.mock.calls[0][0];
    expect(upsertArg.isNoise).toBeUndefined();
    expect(upsertArg.noiseRuleMatched).toBeUndefined();
    expect(result.noiseVerdictPreserved).toBe(true);
    expect(result.isNoise).toBe(true);
  });

  test('does not flip isNoise false→true when a decided run exists (veto durability)', async () => {
    // A never-noise veto / admin decision left the ticket at isNoise=false;
    // a matching subject rule on a later sync must not re-flag it.
    const existingTicket = {
      id: 42502,
      freshserviceTicketId: BigInt(239931),
      isNoise: false,
      noiseRuleMatched: null,
      assignedTechId: 7,
      status: 'Open',
    };
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: true, ruleId: 'rule-9', category: 'spam_noise' });
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue({ id: 30001, decision: 'approved' });

    const result = await syncService.syncFreshServiceTicketSnapshot(1, { id: 239931 }, snapshotOptions(existingTicket));

    const upsertArg = ticketRepositoryMock.upsert.mock.calls[0][0];
    expect(upsertArg.isNoise).toBeUndefined();
    expect(upsertArg.noiseRuleMatched).toBeUndefined();
    // The suppressed rule verdict must not stamp its noise category either.
    expect(upsertArg.ticketCategory).toBeNull();
    expect(result.noiseVerdictPreserved).toBe(true);
    expect(result.isNoise).toBe(false);
    expect(result.noiseRuleCategory).toBeNull();
  });

  test('still applies the rule verdict when no pipeline run has decided the ticket', async () => {
    const existingTicket = {
      id: 42503,
      freshserviceTicketId: BigInt(239931),
      isNoise: false,
      noiseRuleMatched: null,
      assignedTechId: null,
      status: 'Open',
    };
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: true, ruleId: 'rule-9', category: 'spam_noise' });
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue(null);

    const result = await syncService.syncFreshServiceTicketSnapshot(1, { id: 239931 }, snapshotOptions(existingTicket));

    const upsertArg = ticketRepositoryMock.upsert.mock.calls[0][0];
    expect(upsertArg.isNoise).toBe(true);
    expect(upsertArg.noiseRuleMatched).toBe('rule-9');
    expect(result.noiseVerdictPreserved).toBe(false);
    expect(result.isNoise).toBe(true);
  });

  test('skips the run lookup entirely when the rule verdict matches the stored flag', async () => {
    const existingTicket = {
      id: 42504,
      freshserviceTicketId: BigInt(239931),
      isNoise: false,
      noiseRuleMatched: null,
      assignedTechId: null,
      status: 'Open',
    };
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null, category: null });

    await syncService.syncFreshServiceTicketSnapshot(1, { id: 239931 }, snapshotOptions(existingTicket));

    expect(prismaMock.assignmentPipelineRun.findFirst).not.toHaveBeenCalled();
    expect(ticketRepositoryMock.upsert.mock.calls[0][0].isNoise).toBe(false);
  });

  test('new tickets keep today’s behavior — rule verdict applies, no run lookup', async () => {
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: true, ruleId: 'auto-spam', category: 'spam_noise' });

    const result = await syncService.syncFreshServiceTicketSnapshot(1, { id: 239931 }, snapshotOptions(null));

    expect(prismaMock.assignmentPipelineRun.findFirst).not.toHaveBeenCalled();
    const upsertArg = ticketRepositoryMock.upsert.mock.calls[0][0];
    expect(upsertArg.isNoise).toBe(true);
    expect(upsertArg.noiseRuleMatched).toBe('auto-spam');
    expect(result.noiseVerdictPreserved).toBe(false);
  });
});
