import { jest } from '@jest/globals';

const prismaMock = {
  ticket: {
    findMany: jest.fn(),
  },
};

const assignmentPipelineServiceMock = {
  runPipeline: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: assignmentPipelineServiceMock,
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  default: priorityBackfillService,
  normalizePriorityBackfillOptions,
} = await import('../src/services/priorityBackfillService.js');

describe('priorityBackfillService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('normalizes backfill windows and limits defensively', () => {
    expect(normalizePriorityBackfillOptions({ days: 0, limit: 0 })).toEqual({ days: 14, limit: 25 });
    expect(normalizePriorityBackfillOptions({ days: 200, limit: 500 })).toEqual({ days: 90, limit: 100 });
    expect(normalizePriorityBackfillOptions({ days: 7, limit: 10 })).toEqual({ days: 7, limit: 10 });
  });

  test('finds active IT tickets missing assessed priority without starting runs in dry-run mode', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 501, freshserviceTicketId: 222999, subject: 'VPN down', status: 'Open', priority: 3 },
    ]);

    const result = await priorityBackfillService.planOrStart(1, { days: 7, limit: 10, run: false });

    expect(result).toEqual(expect.objectContaining({
      skipped: false,
      workspaceId: 1,
      days: 7,
      limit: 10,
      count: 1,
      started: [],
    }));
    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: 1,
        assessedPriority: null,
        isNoise: false,
        status: { in: ['Open', 'open', '2', 'Pending', 'pending', '3'] },
        createdAt: { gte: expect.any(Date) },
      }),
      take: 10,
    }));
    expect(assignmentPipelineServiceMock.runPipeline).not.toHaveBeenCalled();
  });

  test('starts priority-assessment-only runs when explicitly requested', async () => {
    const candidates = [
      { id: 501, freshserviceTicketId: 222999, subject: 'VPN down', status: 'Open', priority: 3 },
      { id: 502, freshserviceTicketId: 223000, subject: 'Laptop setup', status: 'Pending', priority: 2 },
    ];
    prismaMock.ticket.findMany.mockResolvedValue(candidates);
    assignmentPipelineServiceMock.runPipeline
      .mockResolvedValueOnce({ id: 3101 })
      .mockResolvedValueOnce({ skipped: true, reason: 'open_run_exists', existingRunId: 3102 });

    const result = await priorityBackfillService.planOrStart(1, { days: 14, limit: 25, run: true });

    expect(result.started).toEqual([
      { ticketId: 501, freshserviceTicketId: 222999, runId: 3101, skipped: false, reason: null },
      { ticketId: 502, freshserviceTicketId: 223000, runId: null, skipped: true, reason: 'open_run_exists' },
    ]);
    expect(assignmentPipelineServiceMock.runPipeline).toHaveBeenNthCalledWith(
      1,
      501,
      1,
      'priority_assessment_only',
      null,
      null,
      { priorityBackfill: true },
    );
  });

  test('skips non-IT workspaces', async () => {
    const result = await priorityBackfillService.planOrStart(2, { run: true });

    expect(result).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'workspace_not_in_scope',
      candidates: [],
      started: [],
    }));
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});
