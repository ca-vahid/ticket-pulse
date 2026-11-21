import { jest } from '@jest/globals';

// 20 Nov 2026: the assignment pipeline's queued-run check writes a status it
// saw in FreshService straight to the database (bypassing the lifecycle
// service), so a close seen there must end the ticket's open approvals too.

const prismaMock = {
  ticket: { findUnique: jest.fn(), update: jest.fn() },
  workspace: { findUnique: jest.fn() },
  assignmentPipelineRun: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  assignmentPipelineStep: { aggregate: jest.fn() },
};
const activityCreate = jest.fn();
const closeApprovalsAfterStatusChange = jest.fn(async () => ({ closed: 1, approvals: [] }));
const observeStatusTransition = jest.fn(async () => null);
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({ default: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { anthropic: { apiKey: 'test-key' } } }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: { getConfig: jest.fn(), claimQueuedRun: jest.fn() } }));
jest.unstable_mockModule('../src/services/promptRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { isBusinessHours: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: activityCreate } }));
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
jest.unstable_mockModule('../src/services/ticketReopenService.js', () => ({ default: { observeStatusTransition } }));
jest.unstable_mockModule('../src/services/approvalTicketCloseService.js', () => ({ closeApprovalsAfterStatusChange }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: pipeline } = await import('../src/services/assignmentPipelineService.js');

const ticket = { id: 70001, workspaceId: 1, status: 'Open', origin: 'freshservice', freshserviceTicketId: 250001 };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.update.mockResolvedValue({});
  activityCreate.mockResolvedValue({});
});

test('a status written from FreshService runs the approval-close hook with before and after', async () => {
  await pipeline._markTicketStatusFromFreshService(ticket, 'Closed', 'Closed in FreshService');
  expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 70001 }, data: expect.objectContaining({ status: 'Closed' }) }));
  expect(closeApprovalsAfterStatusChange).toHaveBeenCalledWith(ticket, { ...ticket, status: 'Closed' }, { source: 'assignment_pipeline' });
  expect(observeStatusTransition).toHaveBeenCalled();
});

test('no status change, no hook', async () => {
  await pipeline._markTicketStatusFromFreshService(ticket, 'Open', 'same');
  expect(closeApprovalsAfterStatusChange).not.toHaveBeenCalled();
});

test('a hook failure never breaks the pipeline', async () => {
  closeApprovalsAfterStatusChange.mockRejectedValueOnce(new Error('boom'));
  await expect(pipeline._markTicketStatusFromFreshService(ticket, 'Closed', 'x')).resolves.toBeUndefined();
});
