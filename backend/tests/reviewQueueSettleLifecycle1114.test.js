import { jest } from '@jest/globals';

/**
 * MEGA 11-14 Part B: the settle hangs on the one place every owner / status
 * writer reports to — emitTicketLifecycleNotifications (a person in Ticket
 * Pulse, the FreshService sync and webhook, the pipeline's own write-back,
 * the mirror-back). It runs before the workflow gate, so sync paths with
 * workflows off still settle, and only when the owner or status moved.
 */

const settleOnChange = jest.fn().mockResolvedValue({ settled: 1 });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/reviewQueueSettleService.js', () => ({
  default: { settleOnChange, settleForTicket: jest.fn() },
}));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({
  default: { executeForEvent: jest.fn(), workspaceHasSentimentReader: jest.fn() },
}));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    listStatuses: jest.fn().mockResolvedValue([
      { name: 'Open', baseStatus: 'Open' },
      { name: 'Pending', baseStatus: 'Pending' },
      { name: 'Resolved', baseStatus: 'Resolved' },
      { name: 'Closed', baseStatus: 'Closed' },
    ]),
    resolveBaseStatus: jest.fn().mockResolvedValue(null),
  },
  TERMINAL_BASE_STATUSES: ['Resolved', 'Closed'],
}));
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({
  default: { processTicketClosed: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/ticketReopenService.js', () => ({
  default: { observeStatusTransition: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/hrLifecycleService.js', () => ({
  default: { onTicketCreated: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { emitTicketLifecycleNotifications } = await import('../src/services/ticketLifecycleNotificationService.js');

const t = (over = {}) => ({ id: 700, workspaceId: 2, status: 'Open', assignedTechId: null, ...over });
const person = { name: 'Sam Ortiz', email: 'sam.ortiz@example.com', technicianId: 9 };

beforeEach(() => settleOnChange.mockClear());

test('assigned by hand in Ticket Pulse: settled, naming the person', async () => {
  await emitTicketLifecycleNotifications({
    existingTicket: t(), upsertedTicket: t({ assignedTechId: 5 }), source: 'ticketpulse_native', allowNotificationWorkflows: false, actor: person,
  });
  expect(settleOnChange).toHaveBeenCalledWith(t(), t({ assignedTechId: 5 }), { actor: person, source: 'ticketpulse_native' });
});

test('assigned or closed in FreshService (sync, workflows off): settled as the sync', async () => {
  await emitTicketLifecycleNotifications({ existingTicket: t(), upsertedTicket: t({ assignedTechId: 5 }), source: 'freshservice_sync' });
  await emitTicketLifecycleNotifications({ existingTicket: t({ assignedTechId: 5 }), upsertedTicket: t({ assignedTechId: 5, status: 'Closed' }), source: 'freshservice_webhook' });
  expect(settleOnChange).toHaveBeenCalledTimes(2);
  expect(settleOnChange.mock.calls[0][2]).toEqual({ actor: null, source: 'freshservice_sync' });
  expect(settleOnChange.mock.calls[1][2]).toEqual({ actor: null, source: 'freshservice_webhook' });
});

test('the pipeline\'s own write-back reports as assignment_pipeline', async () => {
  await emitTicketLifecycleNotifications({ existingTicket: t(), upsertedTicket: t({ assignedTechId: 5 }), source: 'assignment_pipeline', allowNotificationWorkflows: false });
  expect(settleOnChange.mock.calls[0][2].source).toBe('assignment_pipeline');
});

test('nothing moved (priority, re-sync of the same owner, a new ticket): no settle at all', async () => {
  await emitTicketLifecycleNotifications({ existingTicket: t({ assignedTechId: 5 }), upsertedTicket: t({ assignedTechId: 5, priority: 3 }) });
  await emitTicketLifecycleNotifications({ existingTicket: null, upsertedTicket: t({ assignedTechId: 5 }) });
  await emitTicketLifecycleNotifications({ existingTicket: t({ assignedTechId: 5 }), upsertedTicket: t({ assignedTechId: null }) });
  expect(settleOnChange).not.toHaveBeenCalled();
});

test('a settle failure never reaches the caller', async () => {
  settleOnChange.mockRejectedValueOnce(new Error('boom'));
  await expect(emitTicketLifecycleNotifications({ existingTicket: t(), upsertedTicket: t({ status: 'Closed' }) })).resolves.toBeDefined();
});
