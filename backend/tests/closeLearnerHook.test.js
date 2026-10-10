import { jest } from '@jest/globals';

/**
 * QA 10-09 item 12 — the skills learner hangs on the ONE place every status
 * writer reports to (native edits, FS sync, mirror-back):
 * emitTicketLifecycleNotifications. It fires on an observed move from a
 * non-terminal to a terminal status, before the workflow gate, and on nothing
 * else.
 */

const processTicketClosed = jest.fn().mockResolvedValue({ learned: true });
const observeStatusTransition = jest.fn().mockResolvedValue(null);

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
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
      { name: 'Done', baseStatus: 'Resolved' },
      { name: 'Needs Rework', baseStatus: 'Pending' },
    ]),
    resolveBaseStatus: jest.fn().mockResolvedValue(null),
  },
  TERMINAL_BASE_STATUSES: ['Resolved', 'Closed'],
}));
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({
  default: { processTicketClosed },
}));
jest.unstable_mockModule('../src/services/ticketReopenService.js', () => ({
  default: { observeStatusTransition },
}));
jest.unstable_mockModule('../src/services/hrLifecycleService.js', () => ({
  default: { onTicketCreated: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { emitTicketLifecycleNotifications } = await import('../src/services/ticketLifecycleNotificationService.js');

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const emit = async (existingTicket, upsertedTicket, extra = {}) => {
  const out = await emitTicketLifecycleNotifications({ existingTicket, upsertedTicket, ...extra });
  await flush();
  return out;
};
const t = (status, over = {}) => ({ id: 700, workspaceId: 1, status, assignedTechId: 48, ...over });

beforeEach(() => {
  processTicketClosed.mockClear();
});

test('Open → Closed credits the close, even where workflows are off for the ingest path (FS sync)', async () => {
  const out = await emit(t('Open'), t('Closed'), { source: 'freshservice_sync', allowNotificationWorkflows: false });
  expect(out.status).toBe('skipped');
  expect(processTicketClosed).toHaveBeenCalledTimes(1);
  expect(processTicketClosed).toHaveBeenCalledWith(700, 1);
});

test('Pending → Resolved and a custom Resolved-base status count as a close', async () => {
  await emit(t('Pending'), t('Resolved'));
  await emit(t('Open'), t('Done'));
  expect(processTicketClosed).toHaveBeenCalledTimes(2);
});

test('an assignment, or any move that is not a close, teaches nothing', async () => {
  await emit(t('Open', { assignedTechId: null }), t('Open', { assignedTechId: 48 }));
  await emit(t('Open'), t('Pending'));
  await emit(t('Open'), t('Needs Rework'));
  await emit(t('Closed'), t('Open')); // reopen
  expect(processTicketClosed).not.toHaveBeenCalled();
});

test('Resolved → Closed is not a second close; a sync that sees Closed again is not a close', async () => {
  await emit(t('Resolved'), t('Closed'));
  await emit(t('Closed'), t('Closed'));
  expect(processTicketClosed).not.toHaveBeenCalled();
});

test('a ticket first seen already closed (history backfill) is not an observed close', async () => {
  await emit(null, t('Closed'));
  expect(processTicketClosed).not.toHaveBeenCalled();
});

test('a learner failure never reaches the caller', async () => {
  processTicketClosed.mockRejectedValueOnce(new Error('boom'));
  await expect(emit(t('Open'), t('Closed'))).resolves.toBeDefined();
});
