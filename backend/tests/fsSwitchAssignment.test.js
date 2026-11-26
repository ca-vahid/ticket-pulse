import { jest } from '@jest/globals';

// FreshService switch (25 Nov 2026) — assignment.
//  - the queued-run live check in FreshService is skipped when Off or adopted;
//  - an admin's assignment correction is applied in Ticket Pulse only.

const fsMode = { mode: 'connected' };
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  default: {},
  fsGate: jest.fn(async () => fsMode.mode !== 'off'),
  isFreshServiceOff: jest.fn(async () => fsMode.mode === 'off'),
  onModeChange: jest.fn(() => () => {}),
  getMode: jest.fn(async () => fsMode.mode),
  getModeRecord: jest.fn(async () => ({ mode: fsMode.mode })),
  setMode: jest.fn(),
  getShadowReport: jest.fn(async () => ({ since: null, counts: {}, total: 0 })),
  flushShadow: jest.fn(),
  FS_MODES: ['connected', 'shadow', 'off'],
  FS_PURPOSES: [],
  modeSettingKey: (ws) => `freshservice_mode_ws${ws}`,
  shadowSettingKey: (ws) => `freshservice_shadow_ws${ws}`,
  _resetFsModeCache: jest.fn(),
}));
const adoptionMock = { adoptForWrite: jest.fn(async () => ({ adopted: true })) };
jest.unstable_mockModule('../src/services/fsAdoptionService.js', () => ({ default: adoptionMock }));
const ticketServiceMock = { assignTicket: jest.fn(async () => ({ changed: true })) };
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));

const assignmentRepositoryMock = {
  getConfig: jest.fn(), claimQueuedRun: jest.fn(), getPipelineRun: jest.fn(), appendFeedback: jest.fn(async () => ({})),
};
const prismaMock = {
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  workspace: { findUnique: jest.fn(async () => ({ defaultTimezone: 'America/Vancouver' })) },
  assignmentPipelineRun: { findUnique: jest.fn(), findFirst: jest.fn(async () => null), update: jest.fn() },
  assignmentPipelineStep: { aggregate: jest.fn() },
  technician: { findFirst: jest.fn(), findUnique: jest.fn() },
  assignmentCorrection: { create: jest.fn(), update: jest.fn() },
};
const activityCreate = jest.fn();
const createFreshServiceClient = jest.fn();
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({ default: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { anthropic: { apiKey: 'test-key' } } }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: assignmentRepositoryMock }));
jest.unstable_mockModule('../src/services/promptRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { isBusinessHours: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getFreshServiceConfigForWorkspace: jest.fn(async () => ({ domain: 'example.freshservice.com', apiKey: 'k' })) },
}));
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
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: pipeline } = await import('../src/services/assignmentPipelineService.js');
const { default: correctionService } = await import('../src/services/assignmentCorrectionService.js');

const fsTicket = { id: 60748, workspaceId: 5, freshserviceTicketId: 244573, origin: 'freshservice', mirrorState: null, subject: 'Laptop', status: 'Open', assignedTechId: null };
const client = { fetchTicketSafe: jest.fn(async () => null) }; // FreshService says 404
const runFor = (ticket) => ({ id: 26463, ticketId: ticket.id, workspaceId: ticket.workspaceId, triggerSource: 'poll', createdAt: new Date(), ticket });

beforeEach(() => {
  jest.clearAllMocks();
  fsMode.mode = 'connected';
  pipeline._customTerminalNames = jest.fn().mockResolvedValue([]);
});

describe('queued-run FreshService live check', () => {
  test('Off: FreshService is not asked, the run stays valid on its local checks', async () => {
    fsMode.mode = 'off';
    expect(await pipeline.validateQueuedRun(runFor(fsTicket), { client })).toEqual({ valid: true });
    expect(client.fetchTicketSafe).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('adopted: the tombstone FS id is never looked up', async () => {
    const adopted = { ...fsTicket, origin: 'freshservice', mirrorState: 'adopted' };
    expect(await pipeline._validateQueuedRunAgainstFreshService(adopted, { client })).toBeNull();
    expect(client.fetchTicketSafe).not.toHaveBeenCalled();
  });

  test('Connected FS-born: unchanged (a 404 still marks it Deleted)', async () => {
    const out = await pipeline.validateQueuedRun(runFor(fsTicket), { client });
    expect(out).toMatchObject({ valid: false, localStatus: 'Deleted' });
  });
});

describe('assignment correction', () => {
  const run = {
    id: 900, workspaceId: 5, ticketId: 60748, status: 'completed', decision: 'approved', assignedTechId: 8,
    recommendation: { recommendations: [] }, ticket: { ...fsTicket, assignedTechId: 8 },
  };
  const input = { assignedTechId: 9, selectionSource: 'manual', reason: 'Requester sits with this technician every day.' };

  function arm() {
    assignmentRepositoryMock.getPipelineRun.mockResolvedValueOnce(run);
    prismaMock.technician.findFirst.mockResolvedValueOnce({ id: 9, name: 'Terry Tech', email: 'terry@example.com', freshserviceId: null });
    prismaMock.technician.findUnique.mockResolvedValueOnce({ id: 8, name: 'Pat Previous', email: 'pat@example.com' });
    prismaMock.assignmentCorrection.create.mockResolvedValueOnce({ id: 31, selectionSource: 'manual', recommendationRank: null, freshservicePayload: {} });
    prismaMock.assignmentCorrection.update.mockResolvedValueOnce({ id: 31, freshserviceSyncStatus: 'skipped' });
  }

  test('Off: adopts imported history, assigns in Ticket Pulse, records skipped freshservice_off; no FreshService client', async () => {
    fsMode.mode = 'off';
    arm();
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ mirrorState: null });
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 60748, origin: 'freshservice' });

    const out = await correctionService.reassignRun(900, 5, input, 'ada@example.com');

    expect(out.success).toBe(true);
    expect(createFreshServiceClient).not.toHaveBeenCalled();
    expect(adoptionMock.adoptForWrite).toHaveBeenCalledWith(60748, 5, expect.objectContaining({ email: 'ada@example.com' }));
    expect(ticketServiceMock.assignTicket).toHaveBeenCalledWith(60748, 5, 9, expect.objectContaining({ email: 'ada@example.com' }), { allowAssignableOnly: true });
    expect(prismaMock.assignmentCorrection.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ freshserviceSyncStatus: 'skipped', freshserviceSyncError: 'freshservice_off' }),
    }));
  });

  test('adopted (connected): local only, recorded skipped adopted', async () => {
    arm();
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ mirrorState: 'adopted' });
    prismaMock.ticket.findFirst.mockResolvedValueOnce({ id: 60748, origin: 'ticketpulse' });
    const out = await correctionService.reassignRun(900, 5, input, 'ada@example.com');
    expect(out.success).toBe(true);
    expect(createFreshServiceClient).not.toHaveBeenCalled();
    expect(adoptionMock.adoptForWrite).not.toHaveBeenCalled();
    expect(prismaMock.assignmentCorrection.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ freshserviceSyncError: 'adopted' }),
    }));
  });

  test('Connected FS-born: unchanged — a technician without a FreshService id is refused', async () => {
    arm();
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ mirrorState: null });
    const out = await correctionService.reassignRun(900, 5, input, 'ada@example.com');
    expect(out).toMatchObject({ success: false, status: 400, message: 'Target technician has no FreshService agent ID' });
  });
});
