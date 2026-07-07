import { jest } from '@jest/globals';

/** Requester sentiment (gap plan 2 P5.1): classify, store, debounce, condition field. */

const prismaMock = {
  ticket: {
    findFirst: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
  ticketThreadEntry: {
    findMany: jest.fn().mockResolvedValue([]),
  },
};
const sendJsonMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({
  default: { sendJson: sendJsonMock },
}));

const { default: ticketSentimentService, SENTIMENTS } = await import('../src/services/ticketSentimentService.js');
const { CONDITION_FIELDS } = await import('../src/services/notificationConditionModel.js');

const TICKET = { id: 5, subject: 'VPN down', descriptionText: 'I cannot connect to the VPN since Monday.', status: 'Open' };

beforeEach(() => {
  jest.clearAllMocks();
  ticketSentimentService._clearPending();
  prismaMock.ticket.findFirst.mockResolvedValue(TICKET);
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
});

describe('requester sentiment', () => {
  test('classifies via the cheap-tier operation and stores the result', async () => {
    sendJsonMock.mockResolvedValue({ parsed: { sentiment: 'frustrated' }, provider: 'anthropic', model: 'haiku' });
    const result = await ticketSentimentService.refreshSentiment(5, 1);
    expect(result).toBe('frustrated');
    expect(sendJsonMock.mock.calls[0][0].operation).toBe('requester_sentiment');
    const update = prismaMock.ticket.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 5 });
    expect(update.data.sentiment).toBe('frustrated');
    expect(update.data.sentimentComputedAt).toBeInstanceOf(Date);
  });

  test('only requester-authored public messages feed the classifier', async () => {
    sendJsonMock.mockResolvedValue({ parsed: { sentiment: 'neutral' } });
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([
      { occurredAt: new Date(), bodyText: 'Still waiting, this is urgent!!', content: null },
    ]);
    await ticketSentimentService.refreshSentiment(5, 1);
    const where = prismaMock.ticketThreadEntry.findMany.mock.calls[0][0].where;
    expect(where.authorType).toBe('requester');
    expect(where.isPrivate).toEqual({ not: true });
    expect(sendJsonMock.mock.calls[0][0].userMessage).toContain('Still waiting');
  });

  test('an out-of-catalog answer is discarded, nothing stored', async () => {
    sendJsonMock.mockResolvedValue({ parsed: { sentiment: 'furious' } });
    const result = await ticketSentimentService.refreshSentiment(5, 1);
    expect(result).toBeNull();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('no requester content at all → no provider call', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...TICKET, descriptionText: null });
    const result = await ticketSentimentService.refreshSentiment(5, 1);
    expect(result).toBeNull();
    expect(sendJsonMock).not.toHaveBeenCalled();
  });

  test('provider failure is swallowed (sentiment is an annotation, not a step)', async () => {
    sendJsonMock.mockRejectedValue(new Error('rate limited'));
    await expect(ticketSentimentService.refreshSentiment(5, 1)).resolves.toBeNull();
  });

  test('scheduleRefresh debounces a reply burst into one classification', async () => {
    jest.useFakeTimers();
    sendJsonMock.mockResolvedValue({ parsed: { sentiment: 'positive' } });
    ticketSentimentService.scheduleRefresh(5, 1);
    ticketSentimentService.scheduleRefresh(5, 1);
    ticketSentimentService.scheduleRefresh(5, 1);
    expect(ticketSentimentService._pendingCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(61_000);
    jest.useRealTimers();
    expect(sendJsonMock).toHaveBeenCalledTimes(1);
    expect(ticketSentimentService._pendingCount()).toBe(0);
  });

  test('ticket.sentiment is a workflow condition field with the same catalog', () => {
    expect(CONDITION_FIELDS['ticket.sentiment']).toEqual({
      label: 'Requester sentiment',
      type: 'enum',
      path: 'ticket.sentiment',
      options: SENTIMENTS,
    });
  });
});
