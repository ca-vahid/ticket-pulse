import { jest } from '@jest/globals';

/**
 * QA 11-24 #4 review (must-fix): a workspace made with "New workspace" has no
 * FreshService link (id 0). Its FS config then carries no workspace filter, so
 * "Sync week", the backfills and the technician sync would read EVERY
 * FreshService workspace and the upsert would re-home other workspaces'
 * tickets and agents into it. Each entry point refuses it with a 409 before
 * any lock, run row or FreshService call; a real FS id is never refused.
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  backfillRun: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
};
const settingsMock = { getFreshServiceConfig: jest.fn(), getFreshServiceConfigForWorkspace: jest.fn(), get: jest.fn() };

jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ sseManager: { broadcast: jest.fn() }, default: {} }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn(), FORBIDDEN_TICKET: Symbol('forbidden-ticket') }));
jest.unstable_mockModule('../src/integrations/freshserviceTransformer.js', () => ({
  transformTickets: jest.fn(() => []),
  transformAgents: jest.fn(() => []),
  mapTechnicianIds: jest.fn((t) => t),
  analyzeTicketActivities: jest.fn(),
  transformTicketThreadEntries: jest.fn(() => []),
  transformTicketConversationEntries: jest.fn(() => []),
  getStatusString: jest.fn(() => 'Open'),
  getPriorityNumber: jest.fn(() => 3),
}));
jest.unstable_mockModule('../src/utils/parallelPool.js', () => ({ runJobsInPool: jest.fn() }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({
  default: { getAll: jest.fn().mockResolvedValue([]), upsert: jest.fn(), deactivateNotInList: jest.fn().mockResolvedValue(0), deactivateFsDeactivated: jest.fn().mockResolvedValue([]) },
}));
jest.unstable_mockModule('../src/services/ticketRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/csatService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketPriorityEventService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/notificationPreferenceService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/assignmentFlowGuards.js', () => ({
  shouldTriggerAssignmentForLatestRun: jest.fn(),
  shouldTriggerClassificationForLatestRun: jest.fn(),
}));
jest.unstable_mockModule('../src/services/activitySyncFreshness.js', () => ({ getActivityRefreshReason: jest.fn() }));
jest.unstable_mockModule('../src/services/groupSyncService.js', () => ({ default: { syncWorkspaceGroups: jest.fn() } }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));

const { default: syncService } = await import('../src/services/syncService.js');
const { FreshServiceNotLinkedError } = await import('../src/utils/workspaceFsBinding.js');

const NATIVE = 12;
const LINKED = 2;
const realGetWorkspaceConfig = syncService._getWorkspaceConfig.bind(syncService);

beforeEach(() => {
  jest.clearAllMocks();
  syncService.runningWorkspaces.clear();
  prismaMock.workspace.findUnique.mockImplementation(async ({ where }) => (
    where.id === NATIVE ? { freshserviceWorkspaceId: 0n } : { freshserviceWorkspaceId: 1000208182n }
  ));
  syncService._initializeClient = jest.fn().mockResolvedValue({ fetchAgents: jest.fn().mockResolvedValue([]) });
  syncService._getWorkspaceConfig = realGetWorkspaceConfig;
  syncService._enrichNewTechnicians = jest.fn().mockResolvedValue();
});

const refused = expect.objectContaining({ statusCode: 409, code: 'freshservice_not_linked' });

describe('_getWorkspaceConfig (the backstop every sync path reads)', () => {
  test('refuses a config that says the workspace has no FreshService link', async () => {
    settingsMock.getFreshServiceConfigForWorkspace.mockResolvedValue({ domain: 'd', apiKey: 'k', workspaceId: null, freshserviceLinked: false });
    await expect(syncService._getWorkspaceConfig(NATIVE)).rejects.toBeInstanceOf(FreshServiceNotLinkedError);
  });

  test('a linked config, or one without the flag, passes', async () => {
    settingsMock.getFreshServiceConfigForWorkspace.mockResolvedValueOnce({ domain: 'd', apiKey: 'k', workspaceId: '1000208182', freshserviceLinked: true });
    await expect(syncService._getWorkspaceConfig(LINKED)).resolves.toMatchObject({ workspaceId: '1000208182' });
    settingsMock.getFreshServiceConfigForWorkspace.mockResolvedValueOnce({ domain: 'd', apiKey: 'k' });
    await expect(syncService._getWorkspaceConfig(LINKED)).resolves.toMatchObject({ domain: 'd' });
  });
});

describe('entry points refuse an unlinked workspace before touching FreshService', () => {
  test('syncWeek', async () => {
    await expect(syncService.syncWeek({ startDate: '2026-11-16', endDate: '2026-11-22', workspaceId: NATIVE })).rejects.toEqual(refused);
    expect(syncService._initializeClient).not.toHaveBeenCalled();
    expect(syncService.runningWorkspaces.has(NATIVE)).toBe(false);
  });

  test('backfillDateRange: no run row, no lock left behind', async () => {
    await expect(syncService.backfillDateRange({ startDate: '2026-01-01', endDate: '2026-01-31', workspaceId: NATIVE })).rejects.toEqual(refused);
    expect(prismaMock.backfillRun.create).not.toHaveBeenCalled();
    expect(syncService.runningWorkspaces.has(`backfill:${NATIVE}`)).toBe(false);
    expect(syncService._initializeClient).not.toHaveBeenCalled();
  });

  test('syncTechnicians', async () => {
    await expect(syncService.syncTechnicians(NATIVE)).rejects.toEqual(refused);
    expect(syncService._initializeClient).not.toHaveBeenCalled();
  });

  test('backfillPickupTimes, backfillThreadEntries, backfillEpisodes', async () => {
    await expect(syncService.backfillPickupTimes({ workspaceId: NATIVE })).rejects.toEqual(refused);
    await expect(syncService.backfillThreadEntries({ workspaceId: NATIVE })).rejects.toEqual(refused);
    await expect(syncService.backfillEpisodes({ workspaceId: NATIVE })).rejects.toEqual(refused);
    expect(syncService._initializeClient).not.toHaveBeenCalled();
  });
});

describe('a linked workspace is never treated as unlinked', () => {
  test('syncTechnicians runs for a real FreshService id', async () => {
    settingsMock.getFreshServiceConfigForWorkspace.mockResolvedValue({ domain: 'd', apiKey: 'k', workspaceId: '1000208182', freshserviceLinked: true });
    await expect(syncService.syncTechnicians(LINKED)).resolves.toBe(0);
    expect(syncService._initializeClient).toHaveBeenCalled();
  });

  test('a workspace lookup failure does not block the run (the config check is the backstop)', async () => {
    prismaMock.workspace.findUnique.mockRejectedValue(new Error('pool timeout'));
    settingsMock.getFreshServiceConfigForWorkspace.mockResolvedValue({ domain: 'd', apiKey: 'k', workspaceId: '1000208182', freshserviceLinked: true });
    await expect(syncService.syncTechnicians(LINKED)).resolves.toBe(0);
  });
});
