import { jest } from '@jest/globals';

// QA 09-29 #5 (TP-1649): ten seconds after a Power Apps ticket was created,
// a queued run looked its FreshService fallback copy up, got a 404 and marked
// the Ticket Pulse ticket Deleted. The FreshService live check is for
// FreshService-born tickets only; a Ticket Pulse-born ticket is owned here.

const assignmentRepositoryMock = { getConfig: jest.fn(), claimQueuedRun: jest.fn() };
const prismaMock = {
  ticket: { findUnique: jest.fn(), update: jest.fn() },
  workspace: { findUnique: jest.fn() },
  assignmentPipelineRun: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  assignmentPipelineStep: { aggregate: jest.fn() },
};
const activityCreate = jest.fn();
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({ default: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { anthropic: { apiKey: 'test-key' } } }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: assignmentRepositoryMock }));
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
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: pipeline } = await import('../src/services/assignmentPipelineService.js');

const tpTicket = { id: 46466, workspaceId: 5, freshserviceTicketId: 243907, origin: 'ticketpulse', subject: 'Request for PGE', status: 'Open', assignedTechId: null };
const fsTicket = { ...tpTicket, id: 60748, freshserviceTicketId: 244573, origin: 'freshservice' };
const client = { fetchTicketSafe: jest.fn(async () => null) }; // FreshService says 404
const runFor = (ticket) => ({ id: 26463, ticketId: ticket.id, workspaceId: ticket.workspaceId, triggerSource: 'poll', createdAt: new Date(), ticket });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue(null);
  pipeline._customTerminalNames = jest.fn().mockResolvedValue([]);
});

describe('queued-run check never deletes a Ticket Pulse-born ticket (QA 09-29 #5)', () => {
  test('TP-born + FreshService 404 → still valid, nothing marked Deleted, FreshService not even asked', async () => {
    const out = await pipeline.validateQueuedRun(runFor(tpTicket), { client });
    expect(out).toEqual({ valid: true });
    expect(client.fetchTicketSafe).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  test('the run carries a ticket without its origin → origin is read before deciding', async () => {
    const { origin, ...bare } = tpTicket;
    expect(origin).toBe('ticketpulse');
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ origin: 'ticketpulse' });
    const out = await pipeline.validateQueuedRun(runFor(bare), { client });
    expect(out).toEqual({ valid: true });
    expect(client.fetchTicketSafe).not.toHaveBeenCalled();
  });

  test('FreshService-born + 404 → still marked Deleted as before', async () => {
    const out = await pipeline.validateQueuedRun(runFor(fsTicket), { client });
    expect(out).toMatchObject({ valid: false, localStatus: 'Deleted' });
    expect(prismaMock.ticket.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'Deleted' }) }));
  });
});
