import { jest } from '@jest/globals';

// QA 09-15 #4 (TP-1516): an after-hours run queued for a fresh ticket was
// skipped at claim time because an agent had assigned the ticket meanwhile —
// and with the run went the categorisation. A workspace that auto-categorises
// now downgrades such a run to classification-only instead of discarding it.

const assignmentRepositoryMock = {
  getOpenPipelineRun: jest.fn(),
  getConfig: jest.fn(),
  createQueuedRun: jest.fn(),
  createPipelineStep: jest.fn(),
  markRunSkippedStale: jest.fn(),
  claimQueuedRun: jest.fn(),
};
const prismaMock = {
  ticket: { findUnique: jest.fn(), update: jest.fn() },
  workspace: { findUnique: jest.fn() },
  assignmentPipelineRun: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  assignmentPipelineStep: { aggregate: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({ default: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { anthropic: { apiKey: 'test-key' } } }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: assignmentRepositoryMock }));
jest.unstable_mockModule('../src/services/promptRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { isBusinessHours: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn().mockResolvedValue([]), baseStatusSets: jest.fn(), customTerminalNames: jest.fn().mockResolvedValue([]) },
}));
jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({
  TOOL_SCHEMAS: [], executeTool: jest.fn(), applyWorkspaceTicketTypes: jest.fn(async (tools) => ({ tools, autoType: null })),
}));
jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/afterHoursUrgentEscalationService.js', () => ({ default: { queueForPriorityRun: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: assignmentPipelineService } = await import('../src/services/assignmentPipelineService.js');

const assignedTicket = { id: 45011, workspaceId: 5, freshserviceTicketId: null, subject: 'A-Code Setup Template', status: 'Pending', assignedTechId: 4075679 };
const run = { id: 24906, ticketId: 45011, workspaceId: 5, triggerSource: 'app_native', createdAt: new Date('2026-09-15T15:54:47Z'), ticket: assignedTicket };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue(null);
  assignmentPipelineService._customTerminalNames = jest.fn().mockResolvedValue([]);
});

describe('validateQueuedRun — assigned-meanwhile is a downgrade, not a skip (QA 09-15 #4)', () => {
  test('workspace auto-categorises → valid, downgraded to classification_only', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({ autoCategorizeEnabled: true });
    const out = await assignmentPipelineService.validateQueuedRun(run, { liveCheck: false });
    expect(out).toMatchObject({ valid: true, downgradeTo: 'classification_only' });
  });

  test('workspace does not auto-categorise → skipped as before', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({ autoCategorizeEnabled: false });
    const out = await assignmentPipelineService.validateQueuedRun(run, { liveCheck: false });
    expect(out).toMatchObject({ valid: false, reason: 'Ticket already assigned to a technician' });
  });

  test('a run that is already classification-only is not re-downgraded (still blocked)', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({ autoCategorizeEnabled: true });
    const out = await assignmentPipelineService.validateQueuedRun({ ...run, triggerSource: 'classification_only' }, { liveCheck: false });
    expect(out.valid).toBe(false);
  });

  test('a closed ticket is still skipped — the downgrade is only for "already assigned"', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({ autoCategorizeEnabled: true });
    const out = await assignmentPipelineService.validateQueuedRun({ ...run, ticket: { ...assignedTicket, status: 'Closed' } }, { liveCheck: false });
    expect(out.valid).toBe(false);
    expect(out.reason).toMatch(/already Closed/);
  });
});
