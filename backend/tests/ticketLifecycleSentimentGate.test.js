import { jest } from '@jest/globals';

/**
 * Review N2: a new ticket is only queued for a background sentiment
 * classification when the workspace has an enabled ticket.created workflow
 * that reads sentiment or writes with AI. Errors degrade to "don't schedule".
 */

const hasReaderMock = jest.fn();
const scheduleRefreshMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({
  default: { executeForEvent: jest.fn(), workspaceHasSentimentReader: hasReaderMock },
}));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({
  default: { scheduleRefresh: scheduleRefreshMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { maybeRefreshSentiment } = await import('../src/services/ticketLifecycleNotificationService.js');

const created = {
  event: { type: 'ticket.created' },
  workspace: { id: 3 },
  ticket: { id: 77, isNoise: false },
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('no sentiment-reading workflow = no classification scheduled', async () => {
  hasReaderMock.mockResolvedValue(false);
  await maybeRefreshSentiment(created);
  expect(hasReaderMock).toHaveBeenCalledWith(3, 'ticket.created');
  expect(scheduleRefreshMock).not.toHaveBeenCalled();
});

test('a workflow that reads sentiment schedules the delayed classification', async () => {
  hasReaderMock.mockResolvedValue(true);
  await maybeRefreshSentiment(created);
  expect(scheduleRefreshMock).toHaveBeenCalledWith(77, 3, 5000);
});

test('a failing lookup degrades to not scheduling', async () => {
  hasReaderMock.mockRejectedValue(new Error('db down'));
  await maybeRefreshSentiment(created);
  expect(scheduleRefreshMock).not.toHaveBeenCalled();
});

test('requester replies are still re-classified without the workflow check', async () => {
  await maybeRefreshSentiment({ ...created, event: { type: 'ticket.reply_received' } });
  expect(hasReaderMock).not.toHaveBeenCalled();
  expect(scheduleRefreshMock).toHaveBeenCalledWith(77, 3);
});
