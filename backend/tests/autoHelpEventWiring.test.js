import { jest } from '@jest/globals';

/**
 * Auto-help integration W1 + W3 wiring in the ONE event door
 * (ticketLifecycleNotificationService.emitTicketEvent):
 *  - ticket.intake_settled reaches workflows AND queues the Auto-help job
 *    (unless the pipeline already queued it: extra.enqueued);
 *  - ticket.categorized no longer starts Auto-help;
 *  - a reply to a ticket Auto-help closed is read first, and the verdict rides
 *    on the event for the seeded reopen workflow's guard.
 */
const prismaMock = { ticket: { findUnique: jest.fn() }, technician: { findUnique: jest.fn() } };
const engineMock = { executeForEvent: jest.fn().mockResolvedValue({ status: 'completed' }) };
const intakeMock = { onIntakeSettled: jest.fn(async () => ({ id: 1 })) };
const followUpMock = { classifyPostCloseReply: jest.fn(async () => null), onAgentReply: jest.fn() };
const runnerMock = { runForTicket: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({ default: engineMock }));
jest.unstable_mockModule('../src/services/autoHelpIntakeService.js', () => ({ default: intakeMock }));
jest.unstable_mockModule('../src/services/autoHelpFollowUpService.js', () => ({ default: followUpMock }));
jest.unstable_mockModule('../src/services/autoHelpRunner.js', () => ({ default: runnerMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// The event door's fire-and-forget side trips (webhook outbox, sentiment
// refresh, reopen bookkeeping, park wake) are stubbed: left real, their
// dynamic imports landed after the test environment was torn down (audit
// nice-to-have 8: "You are trying to import a file after the Jest
// environment has been torn down").
const sideTrips = {
  dispatchWebhookEvent: jest.fn(),
  sentiment: { scheduleRefresh: jest.fn() },
  reopen: { observeStatusTransition: jest.fn(async () => ({})) },
  park: { afterRequesterReply: jest.fn(async () => ({})) },
};
jest.unstable_mockModule('../src/services/webhookDispatchService.js', () => ({ dispatchWebhookEvent: sideTrips.dispatchWebhookEvent, default: { dispatchWebhookEvent: sideTrips.dispatchWebhookEvent } }));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({ default: sideTrips.sentiment }));
jest.unstable_mockModule('../src/services/ticketReopenService.js', () => ({ default: sideTrips.reopen }));
jest.unstable_mockModule('../src/services/ticketParkService.js', () => ({ default: sideTrips.park }));

const { emitTicketEvent } = await import('../src/services/ticketLifecycleNotificationService.js');
const { NOTIFICATION_EVENT_TYPES } = await import('../src/services/notificationWorkflowDefinition.js');

const TICKET = {
  id: 501, workspaceId: 1, subject: 'Install Bluebeam', status: 'Open', priority: 2, origin: 'ticketpulse', nativeNumber: 12,
  toEmails: [], ccEmails: [], replyCcEmails: [], fwdEmails: [], createdAt: new Date('2026-09-25T09:00:00Z'),
  workspace: { name: 'IT', defaultTimezone: 'America/Vancouver' }, requester: { id: 40, name: 'Rita', email: 'rita@example.com' },
  assignedTech: null, internalCategory: { id: 10, name: 'Software' }, internalSubcategory: null, resolvedByKind: null,
};
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findUnique.mockResolvedValue({ ...TICKET });
});

test('ticket.intake_settled and the five auto_help.* events are registered workflow triggers', () => {
  expect(NOTIFICATION_EVENT_TYPES).toEqual(expect.arrayContaining([
    'ticket.intake_settled', 'auto_help.staged', 'auto_help.answered', 'auto_help.nudged', 'auto_help.help_requested', 'auto_help.resolved',
  ]));
});

test('a manual intake settle reaches workflows and queues the Auto-help job with its stamp', async () => {
  const extra = { source: 'manual', provisional: false, categoryId: 10, category: 'Software' };
  await emitTicketEvent('ticket.intake_settled', 501, { dedupeStamp: 'intake_settled:501:manual:fields:501:7', extra });
  await flush();
  expect(engineMock.executeForEvent).toHaveBeenCalledTimes(1);
  expect(engineMock.executeForEvent.mock.calls[0][0].event).toMatchObject({ type: 'ticket.intake_settled', extra: { source: 'manual', category: 'Software' } });
  expect(intakeMock.onIntakeSettled).toHaveBeenCalledWith(501, 1, expect.objectContaining({ source: 'manual', stamp: 'intake_settled:501:manual:fields:501:7' }));
});

test('a pipeline settle the pipeline already queued is not queued twice', async () => {
  await emitTicketEvent('ticket.intake_settled', 501, { dedupeStamp: 'intake_settled:501:final', extra: { source: 'pipeline', provisional: false, enqueued: true } });
  await flush();
  expect(engineMock.executeForEvent).toHaveBeenCalledTimes(1);
  expect(intakeMock.onIntakeSettled).not.toHaveBeenCalled();
});

test('ticket.categorized (first) no longer starts Auto-help', async () => {
  await emitTicketEvent('ticket.categorized', 501, { dedupeStamp: 'categorized:501:10:0', extra: { first: true, toCategoryId: 10 } });
  await flush();
  expect(intakeMock.onIntakeSettled).not.toHaveBeenCalled();
  expect(runnerMock.runForTicket).not.toHaveBeenCalled();
  expect(engineMock.executeForEvent).toHaveBeenCalledTimes(1);
});

describe('reopen-on-reply guard: the reply after an Auto-help close is read first', () => {
  test('thanks after an Auto-help close → autoHelpReplyVerdict confirmed on the event', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...TICKET, status: 'Resolved', resolvedByKind: 'auto_help' });
    followUpMock.classifyPostCloseReply.mockResolvedValue({ verdict: 'confirmed', via: 'keywords', runId: 901 });
    await emitTicketEvent('ticket.reply_received', 501, { dedupeStamp: 'reply:77', extra: { entryId: 77 } });
    expect(followUpMock.classifyPostCloseReply).toHaveBeenCalledWith(expect.objectContaining({ id: 501, resolvedByKind: 'auto_help' }), { entryId: 77 });
    expect(engineMock.executeForEvent.mock.calls[0][0].event.extra).toEqual({ entryId: 77, autoHelpReplyVerdict: 'confirmed' });
  });

  test('tickets a person closed are not read (no extra model call)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...TICKET, status: 'Resolved', resolvedByKind: 'agent' });
    await emitTicketEvent('ticket.reply_received', 501, { dedupeStamp: 'reply:78', extra: { entryId: 78 } });
    expect(followUpMock.classifyPostCloseReply).not.toHaveBeenCalled();
    expect(engineMock.executeForEvent.mock.calls[0][0].event.extra).toEqual({ entryId: 78 });
  });

  test('a failed read never blocks the reply event (reopen as usual)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ ...TICKET, status: 'Resolved', resolvedByKind: 'auto_help' });
    followUpMock.classifyPostCloseReply.mockRejectedValue(new Error('model down'));
    await emitTicketEvent('ticket.reply_received', 501, { dedupeStamp: 'reply:79', extra: { entryId: 79 } });
    expect(engineMock.executeForEvent).toHaveBeenCalledTimes(1);
    expect(engineMock.executeForEvent.mock.calls[0][0].event.extra).toEqual({ entryId: 79 });
  });
});
