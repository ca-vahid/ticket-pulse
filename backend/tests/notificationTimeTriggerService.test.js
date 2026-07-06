import { jest } from '@jest/globals';

const prismaMock = {
  notificationWorkflow: { findMany: jest.fn() },
  ticket: { findMany: jest.fn(), count: jest.fn() },
  workspace: { findMany: jest.fn() },
};
const emitMock = jest.fn().mockResolvedValue({ status: 'completed', workflowCount: 1 });
const executeForEventMock = jest.fn().mockResolvedValue({ status: 'completed', workflowCount: 1 });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: emitMock },
  emitTicketEvent: emitMock,
}));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({
  default: { executeForEvent: executeForEventMock },
  executeForEvent: executeForEventMock,
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: timeTriggerService } = await import('../src/services/notificationTimeTriggerService.js');

const agingWorkflow = {
  id: 7,
  workspaceId: 1,
  triggerType: 'ticket.aging',
  publishedDefinition: {
    nodes: [{ id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.aging', agingHours: 4 } }],
  },
};
const slaWorkflow = {
  id: 8,
  workspaceId: 1,
  triggerType: 'ticket.sla_breach',
  publishedDefinition: {
    nodes: [{ id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.sla_breach' } }],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NOTIFICATION_TIME_TRIGGERS_ENABLED = 'true';
  emitMock.mockResolvedValue({ status: 'completed', workflowCount: 1 });
});

describe('notificationTimeTriggerService.tick', () => {
  test('aging workflow scans old open tickets and dispatches scoped to itself with a stable stamp', async () => {
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([agingWorkflow]);
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 501, createdAt: new Date(Date.now() - 6 * 3600 * 1000), dueBy: null },
    ]);

    const result = await timeTriggerService.tick();

    expect(result.dispatched).toBe(1);
    // Candidate query respects the workflow's threshold + open statuses.
    const query = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(query.where.workspaceId).toBe(1);
    expect(query.where.status).toEqual({ in: ['Open', 'Pending'] });
    expect(query.where.isNoise).toBe(false);
    expect(query.where.createdAt.lte).toBeInstanceOf(Date);
    // Dispatch is scoped to THIS workflow with a stable per-threshold stamp.
    expect(emitMock).toHaveBeenCalledWith('ticket.aging', 501, expect.objectContaining({
      source: 'time_trigger',
      dedupeStamp: 'aging:4h:501',
      onlyWorkflowId: 7,
      extra: expect.objectContaining({ thresholdHours: 4 }),
    }));
  });

  test('sla_breach stamps carry the dueBy so a moved deadline re-arms the trigger', async () => {
    const dueBy = new Date('2026-07-06T10:00:00.000Z');
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([slaWorkflow]);
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 502, createdAt: new Date(), dueBy }]);

    await timeTriggerService.tick();

    expect(emitMock).toHaveBeenCalledWith('ticket.sla_breach', 502, expect.objectContaining({
      dedupeStamp: `sla_breach:${dueBy.toISOString()}`,
      onlyWorkflowId: 8,
    }));
  });

  test('no time-trigger workflows → quiet no-op', async () => {
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([]);
    const result = await timeTriggerService.tick();
    expect(result).toEqual({ workflows: 0, dispatched: 0 });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });

  test('one broken workflow does not block the others', async () => {
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([
      { ...agingWorkflow, publishedDefinition: null }, // no trigger node → default config, still scans
      slaWorkflow,
    ]);
    prismaMock.ticket.findMany
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce([{ id: 503, createdAt: new Date(), dueBy: new Date('2026-07-06T09:00:00.000Z') }]);

    const result = await timeTriggerService.tick();

    expect(result.workflows).toBe(2);
    expect(result.dispatched).toBe(1); // sla workflow still dispatched
  });

  test('kill switch: NOTIFICATION_TIME_TRIGGERS_ENABLED=false skips ticks', async () => {
    process.env.NOTIFICATION_TIME_TRIGGERS_ENABLED = 'false';
    const result = await timeTriggerService.tick();
    expect(result).toEqual({ skipped: true });
    expect(prismaMock.notificationWorkflow.findMany).not.toHaveBeenCalled();
  });
});

describe('scheduled (ticketless) workflows', () => {
  // A slot "now" in UTC so the test is deterministic regardless of host tz.
  const nowUtc = () => {
    const now = new Date();
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  };

  function scheduleWorkflow(time) {
    return {
      id: 9,
      workspaceId: 1,
      triggerType: 'schedule.time',
      publishedDefinition: {
        nodes: [{ id: 'trigger', type: 'trigger', data: { triggerType: 'schedule.time', frequency: 'daily', time } }],
      },
    };
  }

  beforeEach(() => {
    prismaMock.workspace.findMany.mockResolvedValue([{ id: 1, name: 'IT', defaultTimezone: 'UTC' }]);
    prismaMock.ticket.count.mockResolvedValue(3);
    prismaMock.ticket.findMany.mockResolvedValue([{
      id: 501, subject: 'Old one', status: 'Open', createdAt: new Date(Date.now() - 3 * 86400000),
      nativeNumber: 42, freshserviceTicketId: null, origin: 'ticketpulse', assignedTech: { name: 'Alice' },
    }]);
  });

  test('fires a due slot once with a stable per-slot stamp and a digest context', async () => {
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([scheduleWorkflow(nowUtc())]);

    const result = await timeTriggerService.processScheduled();

    expect(result.fired).toBe(1);
    const [context, options] = executeForEventMock.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({ onlyWorkflowId: 9 }));
    expect(context.event.type).toBe('schedule.time');
    expect(context.event.dedupeStamp).toMatch(/^schedule:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(context.ticket).toBeNull();
    expect(context.digest).toEqual(expect.objectContaining({
      openCount: 3,
      oldestOpen: [expect.objectContaining({ ref: 'TP-42', assignee: 'Alice', ageDays: 3 })],
    }));
  });

  test('a slot outside the catch-up window does not fire', async () => {
    // A slot ~3 hours in the future today (or wrapped) — never within 60 min past.
    const future = new Date(Date.now() + 3 * 3600000);
    const time = `${String(future.getUTCHours()).padStart(2, '0')}:${String(future.getUTCMinutes()).padStart(2, '0')}`;
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([scheduleWorkflow(time)]);

    const result = await timeTriggerService.processScheduled();

    expect(result.fired).toBe(0);
    expect(executeForEventMock).not.toHaveBeenCalled();
  });
});
