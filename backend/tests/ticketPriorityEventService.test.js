import { jest } from '@jest/globals';

const prismaMock = {
  ticketPriorityEvent: {
    findUnique: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
};

const runPipelineMock = jest.fn();
const queueNotificationsForPriorityChangeMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: {
    runPipeline: runPipelineMock,
  },
}));

jest.unstable_mockModule('../src/services/notificationPreferenceService.js', () => ({
  default: {
    queueNotificationsForPriorityChange: queueNotificationsForPriorityChangeMock,
  },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { default: ticketPriorityEventService } = await import('../src/services/ticketPriorityEventService.js');

describe('ticketPriorityEventService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runPipelineMock.mockResolvedValue({ id: 9001 });
    queueNotificationsForPriorityChangeMock.mockResolvedValue({ queued: 1, channels: ['email'] });
    prismaMock.ticketPriorityEvent.findUnique.mockResolvedValue(null);
    prismaMock.ticketPriorityEvent.create.mockImplementation(({ data }) => Promise.resolve({
      id: 41,
      status: 'recorded',
      ...data,
    }));
    prismaMock.ticketPriorityEvent.update.mockImplementation(({ data }) => Promise.resolve({
      id: 41,
      ...data,
    }));
  });

  test('records FreshService priority changes with stable labels and dedupe', async () => {
    const result = await ticketPriorityEventService.recordFreshServicePriorityChange({
      processAsync: false,
      existingTicket: {
        id: 501,
        workspaceId: 1,
        priority: 2,
        freshserviceUpdatedAt: new Date('2026-05-27T15:00:00.000Z'),
      },
      upsertedTicket: {
        id: 501,
        workspaceId: 1,
        priority: 3,
        freshserviceUpdatedAt: new Date('2026-05-27T15:05:00.000Z'),
      },
      source: 'freshservice_sync',
    });

    expect(result).toEqual(expect.objectContaining({ recorded: true }));
    expect(prismaMock.ticketPriorityEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 1,
        ticketId: 501,
        fromPriorityId: 2,
        fromPriorityLabel: 'Medium',
        toPriorityId: 3,
        toPriorityLabel: 'High',
        direction: 'raised',
        dedupeKey: 'fs-priority:501:2:3:2026-05-27T15:05:00.000Z',
      }),
    });
  });

  test('processes raised High and Urgent events through agent preferences and reassessment', async () => {
    prismaMock.ticketPriorityEvent.findUnique.mockResolvedValue({
      id: 42,
      workspaceId: 7,
      ticketId: 502,
      fromPriorityId: 2,
      fromPriorityLabel: 'Medium',
      toPriorityId: 4,
      toPriorityLabel: 'Urgent',
      direction: 'raised',
      reassessmentRunId: null,
      ticket: {
        id: 502,
        workspaceId: 7,
        freshserviceTicketId: 224184n,
        assignedTechId: 17,
        assignedTech: { id: 17, name: 'Alex Chen', email: 'alex@example.com' },
      },
    });

    const result = await ticketPriorityEventService.processEvent(42);

    expect(queueNotificationsForPriorityChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 42,
      toPriorityLabel: 'Urgent',
    }));
    expect(runPipelineMock).toHaveBeenCalledWith(502, 7, 'priority_changed', expect.any(Function), null, { priorityEventId: 42 });
    expect(prismaMock.ticketPriorityEvent.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({
        status: 'processed',
        skipReason: null,
        notificationSummary: expect.objectContaining({
          notificationStatus: 'queued',
          queued: 1,
        }),
      }),
    });
    expect(result).toEqual(expect.objectContaining({
      processed: true,
      queued: 1,
      notificationStatus: 'queued',
    }));
  });

  test('does not notify for lower priority changes but still starts reassessment', async () => {
    prismaMock.ticketPriorityEvent.findUnique.mockResolvedValue({
      id: 43,
      workspaceId: 7,
      ticketId: 503,
      fromPriorityId: 4,
      fromPriorityLabel: 'Urgent',
      toPriorityId: 3,
      toPriorityLabel: 'High',
      direction: 'lowered',
      reassessmentRunId: null,
      ticket: { id: 503, workspaceId: 7, freshserviceTicketId: 224185n, assignedTechId: 17 },
    });

    const result = await ticketPriorityEventService.processEvent(43);

    expect(queueNotificationsForPriorityChangeMock).not.toHaveBeenCalled();
    expect(runPipelineMock).toHaveBeenCalledWith(503, 7, 'priority_changed', expect.any(Function), null, { priorityEventId: 43 });
    expect(result).toEqual(expect.objectContaining({
      processed: true,
      queued: 0,
      skipped: 'not_notification_eligible',
    }));
  });
});
