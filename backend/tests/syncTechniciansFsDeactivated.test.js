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
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));

const { default: syncService } = await import('../src/services/syncService.js');

const AGENTS = [
  { freshserviceId: 1001, name: 'Dana Whitfield', isActive: true },
  { freshserviceId: 1002, name: 'Sam Okafor', isActive: false },
  { freshserviceId: 1003, name: 'Priya Nair' }, // no flag: treated as active
];

beforeEach(() => {
  jest.clearAllMocks();
  syncService._initializeClient = jest.fn().mockResolvedValue({ fetchAgents: jest.fn().mockResolvedValue([{}, {}, {}]) });
  syncService._getWorkspaceConfig = jest.fn().mockResolvedValue({ workspaceId: 2 });
  syncService._enrichNewTechnicians = jest.fn().mockResolvedValue();
  transformAgentsMock.mockReturnValue(AGENTS.map((a) => ({ ...a })));
  technicianRepositoryMock.upsert.mockResolvedValue({});
  technicianRepositoryMock.deactivateNotInList.mockResolvedValue(0);
});

test('disables the agents FreshService reports as deactivated, and logs each by name', async () => {
  technicianRepositoryMock.deactivateFsDeactivated.mockResolvedValue([{ id: 42, name: 'Sam Okafor' }]);

  await syncService.syncTechnicians(1);

  expect(technicianRepositoryMock.deactivateFsDeactivated).toHaveBeenCalledWith(1, [1002]);
  expect(loggerMock.info.mock.calls.map((c) => c[0])).toContain('Technician Sam Okafor (42) disabled: deactivated in FreshService (workspace 1)');
});

test('warns with what the switched-off person still holds', async () => {
  technicianRepositoryMock.deactivateFsDeactivated.mockResolvedValue([{ id: 42, name: 'Sam Okafor', email: 'sam@example.com' }]);
  technicianRepositoryMock.looseEnds = jest.fn().mockResolvedValue({ openTickets: 1, categoryManager: 0, availabilityApprover: 2, pendingApprovals: 3 });

  await syncService.syncTechnicians(1);

  expect(technicianRepositoryMock.looseEnds).toHaveBeenCalledWith({ id: 42, name: 'Sam Okafor', email: 'sam@example.com' }, 1);
  expect(loggerMock.warn).toHaveBeenCalledWith('Technician Sam Okafor (42) is switched off but still has: 1 open ticket still assigned; approver in 2 Availability approval groups; 3 pending ticket approvals waiting on them. Reassign these.');
  delete technicianRepositoryMock.looseEnds;
});

test('no warning when nothing is left, or when the lookup fails', async () => {
  technicianRepositoryMock.deactivateFsDeactivated.mockResolvedValue([{ id: 42, name: 'Sam Okafor' }]);
  technicianRepositoryMock.looseEnds = jest.fn().mockResolvedValue({ openTickets: 0, categoryManager: 0, availabilityApprover: 0, pendingApprovals: 0 });
  await syncService.syncTechnicians(1);
  technicianRepositoryMock.looseEnds = jest.fn().mockRejectedValue(new Error('db down'));
  await expect(syncService.syncTechnicians(1)).resolves.toBe(3);
  expect(loggerMock.warn.mock.calls.filter((c) => String(c[0]).includes('switched off but still has'))).toHaveLength(0);
  delete technicianRepositoryMock.looseEnds;
});

test('no call when every agent is active', async () => {
  transformAgentsMock.mockReturnValue([{ freshserviceId: 1001, name: 'Dana Whitfield', isActive: true }]);
  await syncService.syncTechnicians(1);
  expect(technicianRepositoryMock.deactivateFsDeactivated).not.toHaveBeenCalled();
});

test('a failure here never fails the agent sync', async () => {
  technicianRepositoryMock.deactivateFsDeactivated.mockRejectedValue(new Error('db down'));
  await expect(syncService.syncTechnicians(1)).resolves.toBe(3);
  expect(loggerMock.error).toHaveBeenCalledWith('Failed to disable FreshService-deactivated technicians:', expect.any(Error));
});
