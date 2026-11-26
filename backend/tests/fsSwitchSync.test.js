import { jest } from '@jest/globals';

/**
 * FreshService switch (FreshService exit A1, 25 Nov 2026), syncService: a
 * workspace switched OFF is never synced, never deleted-checked (a FreshService
 * "not found" must never mark tickets Deleted), never reconciled; an ADOPTED
 * ticket is never pulled back from its old FreshService ticket. Shadow runs as
 * today and is counted.
 */

const modes = new Map();
const gateCalls = [];
const modeOf = (ws) => modes.get(Number(ws)) || 'connected';
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  getModeRecord: jest.fn(async (ws) => ({ mode: modeOf(ws) })),
  isFreshServiceOff: jest.fn(async (ws) => modeOf(ws) === 'off'),
  fsGate: jest.fn(async (ws, purpose) => { gateCalls.push([Number(ws), purpose]); return modeOf(ws) !== 'off'; }),
  onModeChange: jest.fn(() => () => {}),
}));

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), create: jest.fn() },
  assignmentConfig: { findUnique: jest.fn() },
  assignmentPipelineRun: { updateMany: jest.fn() },
  backfillRun: { create: jest.fn(), findFirst: jest.fn() },
};
const settingsMock = { getFreshServiceConfig: jest.fn(), getFreshServiceConfigForWorkspace: jest.fn(), get: jest.fn() };
const syncLogMock = { createLog: jest.fn(), completeLog: jest.fn(), failLog: jest.fn(), getLatestSuccessful: jest.fn(), failStaleStarted: jest.fn() };
const assignmentRepoMock = { findOrphanedSyncRuns: jest.fn(), getConfig: jest.fn() };
const fsClient = { fetchTicketSafe: jest.fn(), fetchAgent: jest.fn(), fetchTickets: jest.fn(), limiter: { getStats: () => ({}) } };

jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ sseManager: { broadcast: jest.fn() }, default: {} }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn(() => fsClient), FORBIDDEN_TICKET: Symbol('forbidden-ticket') }));
jest.unstable_mockModule('../src/utils/fsBackgroundPace.js', () => ({ RECONCILE_MIN_GAP_MS: 0, reconcileShouldYield: () => false, reconcileSlot: async () => {} }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: { upsert: jest.fn(), deactivateNotInList: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({ default: syncLogMock }));
jest.unstable_mockModule('../src/services/csatService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: assignmentRepoMock }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({ default: { execute: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketPriorityEventService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/notificationPreferenceService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/groupSyncService.js', () => ({ default: { syncWorkspaceGroups: jest.fn() } }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));

const { default: syncService } = await import('../src/services/syncService.js');
const { FreshServiceOffError } = await import('../src/utils/workspaceFsBinding.js');

const OFF = 5;
const LIVE = 1;
const offRefusal = expect.objectContaining({ statusCode: 409, code: 'freshservice_off', message: 'FreshService is switched off for this workspace.' });

beforeEach(() => {
  jest.clearAllMocks();
  modes.clear();
  modes.set(OFF, 'off');
  gateCalls.length = 0;
  syncService.runningWorkspaces.clear();
  prismaMock.workspace.findUnique.mockResolvedValue({ freshserviceWorkspaceId: 1000208182n });
  syncService._initializeClient = jest.fn().mockResolvedValue(fsClient);
  syncService._touchReconciled = jest.fn().mockResolvedValue();
});

describe('a workspace switched off', () => {
  test('performFullSync: skipped, no lock, no sync-log row, no FreshService client', async () => {
    await expect(syncService.performFullSync({ workspaceId: OFF })).resolves.toEqual({ status: 'skipped', reason: 'freshservice_off' });
    expect(syncLogMock.createLog).not.toHaveBeenCalled();
    expect(syncService.runningWorkspaces.has(OFF)).toBe(false);
    expect(syncService._initializeClient).not.toHaveBeenCalled();
  });

  test('sync week, backfills and the technician sync answer 409 freshservice_off before any lock', async () => {
    await expect(syncService.syncWeek({ startDate: '2026-11-16', endDate: '2026-11-22', workspaceId: OFF })).rejects.toEqual(offRefusal);
    await expect(syncService.backfillDateRange({ startDate: '2026-01-01', endDate: '2026-01-31', workspaceId: OFF })).rejects.toEqual(offRefusal);
    await expect(syncService.syncTechnicians(OFF)).rejects.toEqual(offRefusal);
    expect(prismaMock.backfillRun.create).not.toHaveBeenCalled();
    expect(syncService.runningWorkspaces.size).toBe(0);
    expect(syncService._initializeClient).not.toHaveBeenCalled();
  });

  test('_getWorkspaceConfig: an off config gives freshservice_off, an unlinked one freshservice_not_linked', async () => {
    settingsMock.getFreshServiceConfigForWorkspace.mockResolvedValueOnce({ domain: 'd', apiKey: 'k', workspaceId: '1000208182', freshserviceLinked: false, freshserviceOff: true });
    await expect(syncService._getWorkspaceConfig(OFF)).rejects.toBeInstanceOf(FreshServiceOffError);
    settingsMock.getFreshServiceConfigForWorkspace.mockResolvedValueOnce({ domain: 'd', apiKey: 'k', workspaceId: null, freshserviceLinked: false, freshserviceOff: false });
    await expect(syncService._getWorkspaceConfig(12)).rejects.toMatchObject({ code: 'freshservice_not_linked' });
  });

  test('the deleted-ticket check never runs: no ticket read, no FreshService call, nothing marked Deleted', async () => {
    await syncService._reconcileTicketStatuses(OFF);
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
    expect(syncService._initializeClient).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('a deleted-ticket batch stops the moment the workspace is switched off', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 1, freshserviceTicketId: 11n, subject: 'a', status: 'Open', assignedTechId: null },
      { id: 2, freshserviceTicketId: 22n, subject: 'b', status: 'Open', assignedTechId: null },
    ]);
    fsClient.fetchTicketSafe.mockImplementation(async (id) => {
      if (id === 11) { modes.set(LIVE, 'off'); return { id: 11, responder_id: null }; }
      return null; // would read as "hard deleted" if it were ever asked
    });
    await syncService._reconcileTicketStatuses(LIVE);
    expect(fsClient.fetchTicketSafe).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticket.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'Deleted' }) }));
  });

  test('reconcileSingleTicket skips (no FreshService read)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 9, origin: 'freshservice', freshserviceTicketId: 99n, status: 'Open' });
    await expect(syncService.reconcileSingleTicket(9, OFF)).resolves.toEqual({ changed: false, skipped: 'freshservice_off' });
    expect(syncService._initializeClient).not.toHaveBeenCalled();
  });

  test('the fast lane, orphan recovery, failed-upsert retry, preheat and syncTickets do nothing', async () => {
    await expect(syncService.syncAssignmentCandidatesNow(OFF)).resolves.toMatchObject({ status: 'skipped', reason: 'freshservice_off' });
    await syncService._recoverOrphanedSyncs(OFF);
    expect(assignmentRepoMock.findOrphanedSyncRuns).not.toHaveBeenCalled();
    await expect(syncService._retryFailedUpserts(OFF)).resolves.toBeNull();
    prismaMock.workspace.findUnique.mockResolvedValue({ id: OFF, name: 'PA', defaultTimezone: 'America/Vancouver' });
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ dailyReviewPreheatEnabled: true });
    await expect(syncService._preheatTicketThreads(OFF)).resolves.toEqual({ skipped: true, reason: 'freshservice_off' });
    await expect(syncService.syncTickets({ workspaceId: OFF })).resolves.toBe(0);
    expect(settingsMock.getFreshServiceConfigForWorkspace).not.toHaveBeenCalled();
    expect(syncService._initializeClient).not.toHaveBeenCalled();
  });

  test('an unknown responder resolves from local rows only', async () => {
    prismaMock.technician.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(syncService._resolveResponderTech(4242, OFF, fsClient)).resolves.toBeNull();
    expect(fsClient.fetchAgent).not.toHaveBeenCalled();
    expect(prismaMock.technician.create).not.toHaveBeenCalled();

    prismaMock.technician.findFirst.mockResolvedValueOnce({ id: 3, name: 'Local Agent', workspaceId: OFF, isActive: true });
    await expect(syncService._resolveResponderTech(4243, OFF, fsClient)).resolves.toMatchObject({ techId: 3 });
  });
});

describe('adopted tickets', () => {
  test('reconcileSingleTicket never reads the old FreshService ticket, even when connected', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 9, origin: 'ticketpulse', mirrorState: 'adopted', freshserviceTicketId: 99n, status: 'Open' });
    await expect(syncService.reconcileSingleTicket(9, LIVE)).resolves.toEqual({ changed: false, skipped: 'adopted' });
    expect(syncService._initializeClient).not.toHaveBeenCalled();
    expect(fsClient.fetchTicketSafe).not.toHaveBeenCalled();
  });
});

describe('the deleted check only marks rows that are still FreshService-born', () => {
  test('the Deleted write is conditional on origin; a row adopted meanwhile is skipped with no audit row', async () => {
    const { default: activityRepo } = await import('../src/services/ticketActivityRepository.js');
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 7, freshserviceTicketId: 77n, subject: 'x', status: 'Open', assignedTechId: null }]);
    fsClient.fetchTicketSafe.mockResolvedValue(null); // "404": would read as hard-deleted
    prismaMock.ticket.update.mockRejectedValueOnce(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }));
    await syncService._reconcileTicketStatuses(LIVE);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 7, origin: 'freshservice' },
      data: expect.objectContaining({ status: 'Deleted' }),
    });
    expect(activityRepo.create).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.updateMany).not.toHaveBeenCalled();
  });
});

describe('Shadow runs as today and is counted', () => {
  test('the technician step counts "sync"; the deleted check counts "deleted_check"; reconcile counts "reconcile"', async () => {
    modes.set(LIVE, 'shadow');
    settingsMock.getFreshServiceConfigForWorkspace.mockResolvedValue({ domain: 'd', apiKey: 'k', workspaceId: '1000208182', freshserviceLinked: true });
    fsClient.fetchAgents = jest.fn().mockResolvedValue([]);
    syncService._enrichNewTechnicians = jest.fn().mockResolvedValue();
    await expect(syncService.syncTechnicians(LIVE)).resolves.toBe(0);
    prismaMock.ticket.findMany.mockResolvedValue([]);
    await syncService._reconcileTicketStatuses(LIVE);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 9, origin: 'freshservice', freshserviceTicketId: 99n, status: 'Open' });
    fsClient.fetchTicketSafe.mockResolvedValue(Symbol('x'));
    await syncService.reconcileSingleTicket(9, LIVE);
    expect(gateCalls).toEqual(expect.arrayContaining([[LIVE, 'sync'], [LIVE, 'deleted_check'], [LIVE, 'reconcile']]));
  });

  test('Connected: performFullSync is not refused by the gate', async () => {
    syncLogMock.createLog.mockRejectedValue(new Error('stop here'));
    await expect(syncService.performFullSync({ workspaceId: LIVE })).rejects.toThrow('stop here');
    expect(syncLogMock.createLog).toHaveBeenCalled();
  });
});
