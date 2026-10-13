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
    findUnique: jest.fn(),
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
  default: actionMock,
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

const ticketServiceMock = { changeStatus: jest.fn() };
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
const actionMock = { execute: jest.fn() };

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

  test('keeps the Grouped reason on a copy closed into another ticket when a noise rule matches the same subject', async () => {
    // Prod, 12 Oct 2026: IT's grouped backup copies showed "Veeam / Hyper-V Backup Errors". The rule agrees
    // the ticket is noise, so the flip guard never ran and the rule's name replaced "Grouped: repeat of #246525".
    const existingTicket = {
      id: 42510,
      freshserviceTicketId: BigInt(239931),
      isNoise: true,
      noiseRuleMatched: 'Grouped: repeat of #246525',
      assignedTechId: null,
      status: 'Closed',
    };
    noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: true, ruleId: 'Veeam / Hyper-V Backup Errors', category: 'backup' });

    const result = await syncService.syncFreshServiceTicketSnapshot(1, { id: 239931 }, snapshotOptions(existingTicket));

    const upsertArg = ticketRepositoryMock.upsert.mock.calls[0][0];
    expect(upsertArg.isNoise).toBeUndefined();
    expect(upsertArg.noiseRuleMatched).toBeUndefined();
    expect(prismaMock.assignmentPipelineRun.findFirst).not.toHaveBeenCalled();
    expect(result.noiseVerdictPreserved).toBe(true);
    expect(result.noiseRuleMatched).toBe('Grouped: repeat of #246525');
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

  // IT intake plan (12 Oct 2026): FreshService calls back about a copy the mirror is still creating.
  test('never becomes a second, FreshService-born ticket (#241182, #246727)', async () => {
    const { markCreating, _resetMirrorInFlight } = await import('../src/utils/mirrorInFlight.js');
    _resetMirrorInFlight();
    markCreating(62000, { workspaceId: 1, subject: 'Package waiting in shipping room', email: 'rita@example.com' });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 62000, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1900, isNoise: false });

    const result = await syncService.syncFreshServiceTicketSnapshot(1, { id: 239931 }, snapshotOptions(null, { source: 'freshservice_webhook' }));

    expect(result).toMatchObject({ skippedTicketPulseOrigin: true, skippedInFlightCopy: true, isNew: false, ticket: { id: 62000 } });
    expect(ticketRepositoryMock.upsert).not.toHaveBeenCalled();
    expect(noiseRuleServiceMock.evaluate).not.toHaveBeenCalled();

    // An unrelated FreshService ticket in the same minute is ingested as always.
    _resetMirrorInFlight();
    markCreating(62000, { workspaceId: 1, subject: 'A different subject', email: 'rita@example.com' });
    const other = await syncService.syncFreshServiceTicketSnapshot(1, { id: 239931 }, snapshotOptions(null));
    expect(other.skippedInFlightCopy).toBeUndefined();
    expect(ticketRepositoryMock.upsert).toHaveBeenCalledTimes(1);
    _resetMirrorInFlight();
  });
});

// IT intake (12 Oct 2026): a machine notice caught by a noise rule, on a ticket born in Ticket Pulse.
describe('a noise ticket that was born in Ticket Pulse', () => {
  const proto = Object.getPrototypeOf(syncService);
  const tx = { $executeRaw: jest.fn(), assignmentPipelineRun: { findFirst: jest.fn(), create: jest.fn() } };
  const noisy = (over = {}) => ({ id: 63000, workspaceId: 1, origin: 'ticketpulse', source: 1, isNoise: true, status: 'Open', assignedTechId: null, noiseRuleMatched: 'Azure budget alerts', ticketCategory: 'Notifications', ...over });

  beforeEach(async () => {
    jest.clearAllMocks();
    const { default: statusService } = await import('../src/services/statusService.js');
    jest.spyOn(statusService, 'baseStatusOf').mockResolvedValue('Open');
    jest.spyOn(statusService, 'statusNamesForBase').mockResolvedValue(['Open', 'Pending']);
    syncService._noiseAutoCloseGuard = jest.fn().mockResolvedValue({ allowed: true, reason: null, ruleName: 'Azure budget alerts' });
    prismaMock.$transaction = jest.fn((fn) => fn(tx));
    prismaMock.noiseRule = { findFirst: jest.fn().mockResolvedValue({ category: 'notifications' }) };
    prismaMock.assignmentPipelineRun.update = jest.fn().mockResolvedValue({});
    prismaMock.ticket.update.mockResolvedValue({});
    tx.assignmentPipelineRun.findFirst.mockResolvedValue(null);
    tx.assignmentPipelineRun.create.mockResolvedValue({ id: 30900 });
    ticketServiceMock.changeStatus.mockResolvedValue({ changed: true });
    actionMock.execute.mockResolvedValue({ success: true });
  });

  test('is closed in Ticket Pulse itself, with the run marked so the morning e-mail lists it', async () => {
    const out = await proto._ensureNoiseTicketDismissed.call(syncService, noisy(), 1, { config: { isEnabled: true, autoCloseNoise: true, dryRunMode: false }, waitForSync: true });
    expect(out).toMatchObject({ created: true, runId: 30900 });
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(63000, 1, 'Closed', expect.objectContaining({ role: 'system' }),
      { resolutionReason: 'no_action_required', resolutionNote: expect.stringContaining('Azure budget alerts') });
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({ where: { id: 30900 }, data: expect.objectContaining({ syncStatus: 'synced' }) });
    expect(actionMock.execute).not.toHaveBeenCalled();
  });

  test('dry-run mode closes nothing; a FreshService-born ticket still goes through FreshService', async () => {
    await proto._ensureNoiseTicketDismissed.call(syncService, noisy(), 1, { config: { isEnabled: true, autoCloseNoise: true, dryRunMode: true }, waitForSync: true });
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.update).toHaveBeenCalledWith({ where: { id: 30900 }, data: expect.objectContaining({ syncStatus: 'dry_run' }) });
    await proto._ensureNoiseTicketDismissed.call(syncService, noisy({ origin: 'freshservice', freshserviceTicketId: 246800n }), 1, { config: { isEnabled: true, autoCloseNoise: true, dryRunMode: false }, waitForSync: true });
    expect(actionMock.execute).toHaveBeenCalledWith(30900, 1, false);
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
  });

  test('the sweep looks at mail-born Ticket Pulse tickets only where a helpdesk mailbox exists', async () => {
    const { default: assignmentRepository } = await import('../src/services/assignmentRepository.js');
    assignmentRepository.getConfig = jest.fn().mockResolvedValue({ isEnabled: true, autoCloseNoise: true });
    prismaMock.ticket.findMany = jest.fn().mockResolvedValue([]);
    prismaMock.mailboxConnection = { findFirst: jest.fn().mockResolvedValue({ id: 4 }) };
    await proto._recoverOpenNoiseTickets.call(syncService, 1, {});
    expect(prismaMock.ticket.findMany.mock.calls[0][0].where.OR).toEqual([{ origin: 'freshservice' }, { origin: 'ticketpulse', source: 1 }]);
    prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
    await proto._recoverOpenNoiseTickets.call(syncService, 1, {});
    expect(prismaMock.ticket.findMany.mock.calls[1][0].where.origin).toBe('freshservice');
    expect(prismaMock.ticket.findMany.mock.calls[1][0].where.OR).toBeUndefined();
    delete prismaMock.mailboxConnection;
  });
});
