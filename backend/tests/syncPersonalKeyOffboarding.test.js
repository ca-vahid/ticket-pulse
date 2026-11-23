import { jest } from '@jest/globals';

/**
 * 10 Nov 2026: syncTechnicians hands the agents FreshService reports as
 * deactivated (active: false) to technicianRepository.deactivateFsDeactivated,
 * and only those.
 */

const technicianRepositoryMock = {
  getAll: jest.fn(),
  upsert: jest.fn(),
  deactivateNotInList: jest.fn(),
  deactivateFsDeactivated: jest.fn(),
};
const transformAgentsMock = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ sseManager: { broadcast: jest.fn() }, default: {} }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(),
  FORBIDDEN_TICKET: Symbol('forbidden-ticket'),
}));
jest.unstable_mockModule('../src/integrations/freshserviceTransformer.js', () => ({
  transformTickets: jest.fn(() => []),
  transformAgents: transformAgentsMock,
  mapTechnicianIds: jest.fn((tickets) => tickets),
  analyzeTicketActivities: jest.fn(),
  transformTicketThreadEntries: jest.fn(() => []),
  transformTicketConversationEntries: jest.fn(() => []),
  getStatusString: jest.fn(() => 'Open'),
  getPriorityNumber: jest.fn(() => 3),
}));
jest.unstable_mockModule('../src/utils/parallelPool.js', () => ({ runJobsInPool: jest.fn() }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({ default: technicianRepositoryMock }));
jest.unstable_mockModule('../src/services/ticketRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getFreshServiceConfig: jest.fn(), getFreshServiceConfigForWorkspace: jest.fn(), get: jest.fn() },
}));
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
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
const personalKeysMock = { offboardTechnician: jest.fn().mockResolvedValue({}), offboardInactiveTechnicians: jest.fn().mockResolvedValue([]) };
jest.unstable_mockModule('../src/services/personalApiKeyService.js', () => personalKeysMock);
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));

const { default: syncService } = await import('../src/services/syncService.js');

const AGENTS = [
  { freshserviceId: 1001, name: 'Dana Fox', isActive: true },
  { freshserviceId: 1002, name: 'Sam Okafor', isActive: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  syncService._initializeClient = jest.fn().mockResolvedValue({ fetchAgents: jest.fn().mockResolvedValue([{}, {}]) });
  syncService._getWorkspaceConfig = jest.fn().mockResolvedValue({ workspaceId: 2 });
  syncService._enrichNewTechnicians = jest.fn().mockResolvedValue();
  transformAgentsMock.mockReturnValue(AGENTS.map((a) => ({ ...a })));
  technicianRepositoryMock.upsert.mockResolvedValue({});
  technicianRepositoryMock.deactivateNotInList.mockResolvedValue(0);
  technicianRepositoryMock.deactivateFsDeactivated.mockResolvedValue([]);
});

test('agents FreshService deactivated are offboarded from personal API keys (revoked + off the list)', async () => {
  technicianRepositoryMock.deactivateFsDeactivated.mockResolvedValue([{ id: 42, name: 'Sam Okafor' }]);
  await syncService.syncTechnicians(1);
  expect(personalKeysMock.offboardTechnician).toHaveBeenCalledWith(1, 42, { reason: 'offboarded' });
});

test('a bulk switch-off (deactivateNotInList, a count only) sweeps for inactive key owners', async () => {
  technicianRepositoryMock.deactivateNotInList.mockResolvedValue(2);
  await syncService.syncTechnicians(1);
  expect(personalKeysMock.offboardInactiveTechnicians).toHaveBeenCalledWith(1);
});

test('no sweep when nobody was switched off; a failing sweep never fails the agent sync', async () => {
  await syncService.syncTechnicians(1);
  expect(personalKeysMock.offboardInactiveTechnicians).not.toHaveBeenCalled();
  technicianRepositoryMock.deactivateNotInList.mockResolvedValue(1);
  personalKeysMock.offboardInactiveTechnicians.mockRejectedValueOnce(new Error('db down'));
  await expect(syncService.syncTechnicians(1)).resolves.toBe(2);
});
