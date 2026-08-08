import { jest } from '@jest/globals';

/**
 * Bounce-detection dedupe (the #230490 review-queue loop): one pipeline run
 * per rejection EVENT, truthful counts from episodes, and a single parked
 * "needs manual review" row once auto-rerouting is exhausted.
 */

const prismaMock = {
  ticket: { update: jest.fn() },
  assignmentPipelineRun: {
    findFirst: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 999 }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  },
  ticketAssignmentEpisode: {
    count: jest.fn().mockResolvedValue(1),
  },
  technician: {
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue({ id: 42, name: 'Isabella Jimenez' }),
  },
};

const assignmentRepositoryMock = {
  getConfig: jest.fn().mockResolvedValue({ isEnabled: true }),
  getOpenPipelineRun: jest.fn().mockResolvedValue(null),
};
const runPipelineMock = jest.fn().mockResolvedValue({});

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
jest.unstable_mockModule('../src/utils/parallelPool.js', () => ({ runJobsInPool: jest.fn() }));
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({
  default: { getAll: jest.fn(), upsert: jest.fn(), deactivateNotInList: jest.fn() },
}));
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
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: assignmentRepositoryMock }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: { runPipeline: runPipelineMock },
}));
jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketPriorityEventService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/notificationPreferenceService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/assignmentFlowGuards.js', () => ({
  shouldTriggerAssignmentForLatestRun: jest.fn(),
  shouldTriggerClassificationForLatestRun: jest.fn(),
}));
jest.unstable_mockModule('../src/services/activitySyncFreshness.js', () => ({ getActivityRefreshReason: jest.fn() }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({ clearReadCache: jest.fn() }));

const { default: syncService } = await import('../src/services/syncService.js');

const TICKET = { id: 33094, freshserviceTicketId: 230490n, status: 'Open', assignedTechId: null, isNoise: false };
const REJECTED_AT = '2026-07-06T17:55:52.000Z';

function rejectionAnalysis() {
  return {
    currentEpisode: {
      agentName: 'Isabella Jimenez',
      startMethod: 'self_picked',
      startedAt: '2026-06-29T17:51:53.000Z',
      endedAt: REJECTED_AT,
      endMethod: 'rejected',
      endActorName: 'Isabella Jimenez',
    },
    events: [{ type: 'rejected', timestamp: REJECTED_AT, actorName: 'Isabella Jimenez' }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue(null);
  prismaMock.assignmentPipelineRun.create.mockResolvedValue({ id: 999 });
  prismaMock.assignmentPipelineRun.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.ticketAssignmentEpisode.count.mockResolvedValue(1);
  prismaMock.technician.findFirst.mockResolvedValue({ id: 42, name: 'Isabella Jimenez' });
  assignmentRepositoryMock.getConfig.mockResolvedValue({ isEnabled: true });
  assignmentRepositoryMock.getOpenPipelineRun.mockResolvedValue(null);
});

describe('_handleTicketRebound event dedupe', () => {
  test('a fresh rejection queues ONE rebound run with truthful episode-based context', async () => {
    await syncService._handleTicketRebound(TICKET, null, rejectionAnalysis(), 2);

    expect(runPipelineMock).toHaveBeenCalledTimes(1);
    const opts = runPipelineMock.mock.calls[0][5];
    expect(opts.reboundFrom).toEqual(expect.objectContaining({
      previousTechId: 42,
      previousTechName: 'Isabella Jimenez',
      unassignedAt: REJECTED_AT,
      unassignedByName: 'Isabella Jimenez',
      reboundCount: 1, // ONE rejection episode — not "run count + 1"
    }));
  });

  test('a re-detection of the SAME rejection creates nothing (the #230490 loop)', async () => {
    // Any prior run already carrying this event timestamp — superseded,
    // approved or exhausted — means this pass is a re-detection.
    prismaMock.assignmentPipelineRun.findFirst.mockResolvedValueOnce({ id: 12905, status: 'superseded', triggerSource: 'rebound' });

    await syncService._handleTicketRebound(TICKET, null, rejectionAnalysis(), 2);

    expect(runPipelineMock).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.create).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.updateMany).not.toHaveBeenCalled();
    // dedupe queried by the exact event timestamp
    expect(prismaMock.assignmentPipelineRun.findFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ reboundFrom: { path: ['unassignedAt'], equals: REJECTED_AT } }),
    );
  });

  test('past the rebound limit: ONE parked review run with an honest story, then no more', async () => {
    prismaMock.ticketAssignmentEpisode.count.mockResolvedValue(4);
    // First findFirst = event dedupe (miss), second = existing exhausted (miss)
    prismaMock.assignmentPipelineRun.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await syncService._handleTicketRebound(TICKET, null, rejectionAnalysis(), 2);

    expect(runPipelineMock).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.assignmentPipelineRun.create.mock.calls[0][0].data;
    expect(data.triggerSource).toBe('rebound_exhausted');
    expect(data.errorMessage).toContain('Returned to the queue 4 times');
    // Honest narrative: self-picked, named, dated — not "auto-assigned technicians"
    expect(data.recommendation.overallReasoning).toContain('Isabella Jimenez picked this ticket up themselves');
    expect(data.recommendation.overallReasoning).toContain('2026-07-06');
    expect(data.recommendation.overallReasoning).not.toMatch(/auto-assigned technician/i);
    expect(data.reboundFrom.reboundCount).toBe(4);
    expect(data.reboundFrom.previousTechId).toBe(42);

    // Second detection: an exhausted run now awaits review → nothing new.
    jest.clearAllMocks();
    prismaMock.ticketAssignmentEpisode.count.mockResolvedValue(4);
    prismaMock.assignmentPipelineRun.findFirst
      .mockResolvedValueOnce(null) // (different event key wouldn't match)
      .mockResolvedValueOnce({ id: 999 }); // existing exhausted run
    await syncService._handleTicketRebound(TICKET, null, rejectionAnalysis(), 2);
    expect(prismaMock.assignmentPipelineRun.create).not.toHaveBeenCalled();
  });

  test('a rejection without any timestamp is skipped (nothing safe to dedupe on)', async () => {
    const analysis = rejectionAnalysis();
    analysis.currentEpisode.endedAt = null;
    analysis.events = [];

    await syncService._handleTicketRebound(TICKET, null, analysis, 2);

    expect(runPipelineMock).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.create).not.toHaveBeenCalled();
  });

  test('rebound count comes from rejected EPISODES, not run rows', async () => {
    prismaMock.ticketAssignmentEpisode.count.mockResolvedValue(2);

    await syncService._handleTicketRebound(TICKET, null, rejectionAnalysis(), 2);

    expect(prismaMock.ticketAssignmentEpisode.count).toHaveBeenCalledWith({
      where: { ticketId: TICKET.id, endMethod: 'rejected' },
    });
    expect(runPipelineMock.mock.calls[0][5].reboundFrom.reboundCount).toBe(2);
  });
});
