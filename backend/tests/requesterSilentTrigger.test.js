import { jest } from '@jest/globals';

/**
 * QA 09-18 #5 — `ticket.requester_silent_for`: FreshService's "Pending
 * Response" supervisor rule as a stateless time trigger. The scan asks the
 * conversation who spoke last; the dedupe stamp is the agent message's id.
 */

const prismaMock = {
  notificationWorkflow: { findMany: jest.fn() },
  ticket: { findMany: jest.fn(), count: jest.fn() },
  ticketTask: { findMany: jest.fn() },
  workspace: { findMany: jest.fn() },
  ticketStatusDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketActivity: { groupBy: jest.fn().mockResolvedValue([]) },
};
const emitMock = jest.fn().mockResolvedValue({ status: 'completed', workflowCount: 1 });
const candidatesMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketTaskService.js', () => ({ default: { sendDueReminder: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: emitMock },
  emitTicketEvent: emitMock,
}));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({
  default: { executeForEvent: jest.fn() },
  executeForEvent: jest.fn(),
}));
jest.unstable_mockModule('../src/services/ticketReplyClockService.js', () => ({
  default: { requesterSilentCandidates: candidatesMock },
  requesterSilentCandidates: candidatesMock,
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const calendarMock = { loadCalendar: jest.fn(), addBusinessMinutes: jest.fn(), addBusinessDayMinutes: jest.fn() };
jest.unstable_mockModule('../src/services/businessCalendarService.js', () => ({ default: calendarMock }));
const { default: timeTriggerService } = await import('../src/services/notificationTimeTriggerService.js');
const { invalidateStatusCache } = await import('../src/services/statusService.js');
const { TIME_TRIGGER_EVENT_TYPES, NOTIFICATION_EVENT_TYPES, WORKFLOW_TEMPLATES } = await import('../src/services/notificationWorkflowDefinition.js');

const workflow = (data = {}, id = 21) => ({
  id,
  workspaceId: 1,
  triggerType: 'ticket.requester_silent_for',
  publishedDefinition: { nodes: [{ id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.requester_silent_for', ...data } }] },
});
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

beforeEach(() => {
  jest.clearAllMocks();
  invalidateStatusCache?.();
  prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([]);
  candidatesMock.mockResolvedValue([]);
});

describe('ticket.requester_silent_for', () => {
  test('is a registered time trigger with two installable templates (reminder + close)', () => {
    expect(TIME_TRIGGER_EVENT_TYPES).toContain('ticket.requester_silent_for');
    expect(NOTIFICATION_EVENT_TYPES).toContain('ticket.requester_silent_for');
    const reminder = WORKFLOW_TEMPLATES.find((t) => t.key === 'pending_response_reminder');
    const close = WORKFLOW_TEMPLATES.find((t) => t.key === 'pending_response_autoclose');
    expect(reminder.triggerType).toBe('ticket.requester_silent_for');
    expect(reminder.build().nodes.find((n) => n.type === 'trigger').data).toMatchObject({ silentHours: 72, statusBase: 'Pending' });
    expect(reminder.build().nodes.map((n) => n.type)).toEqual(['trigger', 'recipient_resolver', 'template_render', 'send_email']);
    expect(close.build().nodes.find((n) => n.type === 'trigger').data).toMatchObject({ silentHours: 96, statusBase: 'Pending' });
    expect(close.build().nodes.find((n) => n.type === 'update_ticket').data.setStatus).toBe('Closed');
  });

  test('scans Pending-base statuses by default (custom names included) with a cutoff N hours back, capped', async () => {
    prismaMock.ticketStatusDefinition.findMany.mockResolvedValue([
      { name: 'Pending', baseStatus: 'Pending', isActive: true, isSystem: true },
      { name: 'Pending Response', baseStatus: 'Pending', isActive: true, isSystem: false },
      { name: 'Open', baseStatus: 'Open', isActive: true, isSystem: true },
    ]);
    invalidateStatusCache?.();
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([workflow({ silentHours: 72 })]);
    await timeTriggerService.tick();
    expect(candidatesMock).toHaveBeenCalledTimes(1);
    const [workspaceId, opts] = candidatesMock.mock.calls[0];
    expect(workspaceId).toBe(1);
    expect(opts.statuses.sort()).toEqual(['Pending', 'Pending Response']);
    expect(opts.limit).toBe(200);
    expect(Math.abs(Date.now() - 72 * 3600 * 1000 - opts.cutoff.getTime())).toBeLessThan(5000);
  });

  test('explicit statuses win over the base; "any" means Open + Pending', async () => {
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([workflow({ statuses: ['Pending Response'] }, 22), workflow({ statusBase: 'any' }, 23)]);
    await timeTriggerService.tick();
    expect(candidatesMock.mock.calls[0][1].statuses).toEqual(['Pending Response']);
    expect(candidatesMock.mock.calls[1][1].statuses.sort()).toEqual(['Open', 'Pending']);
  });

  test('dispatches once per agent reply: the stamp is the agent message id, the context carries the clock', async () => {
    const lastAgentReplyAt = hoursAgo(80);
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([workflow({ silentHours: 72 })]);
    candidatesMock.mockResolvedValue([{ ticketId: 601, lastAgentEntryId: 9009, lastAgentReplyAt }]);
    const result = await timeTriggerService.tick();
    expect(result.dispatched).toBe(1);
    expect(emitMock).toHaveBeenCalledWith('ticket.requester_silent_for', 601, expect.objectContaining({
      source: 'time_trigger',
      dedupeStamp: 'silent:72h:9009',
      onlyWorkflowId: 21,
      extra: expect.objectContaining({ thresholdHours: 72, lastAgentReplyAt: lastAgentReplyAt.toISOString() }),
    }));
    expect(emitMock.mock.calls[0][2].extra.silentForMs).toBeGreaterThan(79 * 3600 * 1000);
  });

  test('clock = business_days: 96 h of silence over a weekend does not fire until the business-day deadline passes (QA 09-21 #8)', async () => {
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([workflow({ silentHours: 96, clock: 'business_days' })]);
    candidatesMock.mockResolvedValue([{ ticketId: 77, lastAgentEntryId: 9001, lastAgentReplyAt: hoursAgo(100) }]);
    calendarMock.loadCalendar.mockResolvedValue({ timezone: 'America/Vancouver', byDay: new Map(), isHolidayDate: () => false });
    calendarMock.addBusinessDayMinutes.mockResolvedValue(new Date(Date.now() + 30 * 3600 * 1000));
    await timeTriggerService.tick();
    expect(calendarMock.addBusinessDayMinutes).toHaveBeenCalledWith(expect.any(Date), 96 * 60, expect.objectContaining({ workspaceId: 1 }));
    expect(emitMock).not.toHaveBeenCalled();
    calendarMock.addBusinessDayMinutes.mockResolvedValue(new Date(Date.now() - 1000));
    await timeTriggerService.tick();
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  test('a threshold below one hour is clamped and a missing value defaults to 72', async () => {
    prismaMock.notificationWorkflow.findMany.mockResolvedValue([workflow({ silentHours: 0 }, 24), workflow({}, 25)]);
    candidatesMock.mockResolvedValue([{ ticketId: 7, lastAgentEntryId: 1, lastAgentReplyAt: hoursAgo(100) }]);
    await timeTriggerService.tick();
    expect(emitMock.mock.calls[0][2].dedupeStamp).toBe('silent:72h:1');
    expect(emitMock.mock.calls[1][2].dedupeStamp).toBe('silent:72h:1');
  });
});
