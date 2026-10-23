import { jest } from '@jest/globals';

// QA 10-22 #1: Field Equipment logs most tickets already closed, and the
// classification sweep only looked at open ones, so 737 of 752 tickets had no
// category. Closed tickets in a listed workspace now get the light,
// Ticket Pulse-only reclassification, once each.

const prismaMock = { ticket: { findMany: jest.fn() } };
const assignmentRepositoryMock = { getConfig: jest.fn() };
const reclassRun = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: assignmentRepositoryMock }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketReclassificationService.js', () => ({
  default: { run: reclassRun },
  classifyClosedWorkspaceIds: () => new Set(String(process.env.CLASSIFY_CLOSED_WORKSPACE_IDS ?? '4').split(',').map(Number)),
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ sseManager: { broadcast: jest.fn() }, default: {} }));

const { default: syncService } = await import('../src/services/syncService.js');

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CLASSIFY_CLOSED_WORKSPACE_IDS;
  syncService._closedClassifyTried = new Map();
  assignmentRepositoryMock.getConfig.mockResolvedValue({ isEnabled: true, pollMaxPerCycle: 5 });
  reclassRun.mockResolvedValue({ id: 77, scanned: 2, classified: 2, failed: 0 });
});

test('a closed ticket with no category gets the Ticket Pulse-only reclassification', async () => {
  // First call: the open sweep's candidates (none); second: the closed ones.
  prismaMock.ticket.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 11 }, { id: 12 }]);
  const out = await syncService._classifyAssignedTicketsMissingCategories(4, {});
  expect(reclassRun).toHaveBeenCalledWith(4, expect.objectContaining({ apply: true, ticketIds: [11, 12], unclassifiedOnly: true, onlyNeedsReview: false }), { allowNonCanonical: true });
  expect(out.closed).toEqual({ runId: 77, scanned: 2, classified: 2, failed: 0 });
  const closedWhere = prismaMock.ticket.findMany.mock.calls[1][0].where;
  expect(closedWhere).toEqual(expect.objectContaining({ workspaceId: 4, internalCategoryId: null, isNoise: false, status: { in: ['Closed', 'Resolved'] } }));
});

test('each ticket is tried once, so one the model cannot place is not paid for every cycle', async () => {
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 11 }]);
  await syncService._classifyAssignedTicketsMissingCategories(4, {});
  prismaMock.ticket.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 11 }]);
  await syncService._classifyAssignedTicketsMissingCategories(4, {});
  expect(reclassRun).toHaveBeenCalledTimes(1);
});

test('other workspaces, and a disabled pipeline, are left alone', async () => {
  prismaMock.ticket.findMany.mockResolvedValue([]);
  await syncService._classifyAssignedTicketsMissingCategories(1, {});
  expect(reclassRun).not.toHaveBeenCalled();
  assignmentRepositoryMock.getConfig.mockResolvedValue({ isEnabled: false });
  const out = await syncService._classifyAssignedTicketsMissingCategories(4, {});
  expect(out).toEqual(expect.objectContaining({ skipped: true, reason: 'assignment_pipeline_disabled' }));
  expect(reclassRun).not.toHaveBeenCalled();
});

test('a failure is logged and the open sweep result still comes back', async () => {
  prismaMock.ticket.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 13 }]);
  reclassRun.mockRejectedValue(new Error('model down'));
  const out = await syncService._classifyAssignedTicketsMissingCategories(4, {});
  expect(out).toEqual(expect.objectContaining({ triggered: 0 }));
  expect(loggerMock.warn).toHaveBeenCalledWith('Closed-ticket classification sweep failed', expect.objectContaining({ workspaceId: 4 }));
});
