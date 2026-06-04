import { jest } from '@jest/globals';

const prismaMock = {
  notificationWorkflowRun: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  notificationWorkflowStepRun: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  aiProviderAttempt: {
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

const { NotificationWorkflowRunWatchdogService } = await import('../src/services/notificationWorkflowRunWatchdogService.js');

describe('notification workflow run watchdog service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation((operations) => Promise.all(operations));
    prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
    prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
    prismaMock.aiProviderAttempt.updateMany.mockResolvedValue({ count: 1 });
  });

  test('marks stale active workflow runs and active steps as failed', async () => {
    const completedAt = new Date('2026-06-04T18:00:00.000Z');
    prismaMock.notificationWorkflowRun.findMany.mockResolvedValueOnce([
      {
        id: 259,
        workspaceId: 1,
        startedAt: new Date('2026-06-04T17:40:00.000Z'),
        status: 'running',
      },
    ]);
    prismaMock.notificationWorkflowStepRun.findMany.mockResolvedValueOnce([
      {
        id: 1531,
        startedAt: new Date('2026-06-04T17:45:00.000Z'),
      },
    ]);

    const service = new NotificationWorkflowRunWatchdogService();
    const result = await service.reconcileStaleRuns({
      timeoutMs: 15 * 60 * 1000,
      completedAt,
    });

    expect(result).toEqual({
      runCount: 1,
      stepCount: 1,
      runIds: [259],
    });
    expect(prismaMock.notificationWorkflowStepRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1531 },
      data: expect.objectContaining({
        status: 'failed',
        durationMs: 15 * 60 * 1000,
        error: expect.stringContaining('notification_workflow_stale_timeout'),
      }),
    }));
    expect(prismaMock.notificationWorkflowRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 259 },
      data: expect.objectContaining({
        status: 'failed',
        durationMs: 20 * 60 * 1000,
        error: expect.stringContaining('notification_workflow_stale_timeout'),
      }),
    }));
    expect(prismaMock.aiProviderAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        notificationWorkflowRunId: { in: [259] },
        status: 'running',
      },
      data: expect.objectContaining({
        status: 'failed',
        errorClass: 'api_timeout',
        errorMessage: expect.stringContaining('notification_workflow_stale_timeout'),
      }),
    }));
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  test('does nothing when no stale active runs exist', async () => {
    prismaMock.notificationWorkflowRun.findMany.mockResolvedValueOnce([]);

    const service = new NotificationWorkflowRunWatchdogService();
    const result = await service.reconcileStaleRuns();

    expect(result).toEqual({ runCount: 0, stepCount: 0, runIds: [] });
    expect(prismaMock.notificationWorkflowStepRun.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
