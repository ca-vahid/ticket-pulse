import { jest } from '@jest/globals';

// ----- ESM module mocks must be registered BEFORE the module under test is imported -----

const mockBulkUpsert = jest.fn().mockResolvedValue(undefined);
const mockGetFsConfig = jest.fn();
const mockFetchActivities = jest.fn();
const mockFetchConversations = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({
  default: { bulkUpsert: mockBulkUpsert },
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {
    getFreshServiceConfigForWorkspace: mockGetFsConfig,
  },
}));

jest.unstable_mockModule('../src/services/availabilityService.js', () => ({
  default: {
    getBusinessHours: jest.fn().mockResolvedValue([]),
    isBusinessHours: jest.fn().mockResolvedValue({ isBusinessHours: true }),
  },
}));

jest.unstable_mockModule('../src/services/promptRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/dailyReviewDefinitions.js', () => ({
  DAILY_REVIEW_OUTCOMES: [],
  DAILY_REVIEW_PRIMARY_TAGS: [],
  classifyDailyReviewCase: () => ({}),
  isClosedLikeStatus: () => false,
}));

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: () => ({
    fetchTicketActivities: mockFetchActivities,
    fetchTicketConversations: mockFetchConversations,
  }),
}));

jest.unstable_mockModule('../src/integrations/freshserviceTransformer.js', () => ({
  // Identity-style transforms — return one entry per input so we can count
  // the upsert calls by ticket without caring about the exact shape.
  transformTicketThreadEntries: (rows, ctx) =>
    rows.map((r, i) => ({
      ticketId: ctx.ticketId,
      workspaceId: ctx.workspaceId,
      source: 'freshservice_activity',
      externalEntryId: `act-${ctx.ticketId}-${i}`,
      occurredAt: new Date(),
      _row: r,
    })),
  transformTicketConversationEntries: (rows, ctx) =>
    rows.map((r, i) => ({
      ticketId: ctx.ticketId,
      workspaceId: ctx.workspaceId,
      source: 'freshservice_conversation',
      externalEntryId: `conv-${ctx.ticketId}-${i}`,
      occurredAt: new Date(),
      _row: r,
    })),
}));

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic { constructor() {} },
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  default: { llm: {} },
}));

const { default: assignmentDailyReviewService } =
  await import('../src/services/assignmentDailyReviewService.js');

const ticket = (id, fsId, threadCounts = { activities: 0, conversations: 0 }) => ({
  id,
  freshserviceTicketId: BigInt(fsId),
  threadCounts,
});

beforeEach(() => {
  mockBulkUpsert.mockClear();
  mockGetFsConfig.mockReset();
  mockFetchActivities.mockReset();
  mockFetchConversations.mockReset();

  mockGetFsConfig.mockResolvedValue({ domain: 'demo', apiKey: 'xx' });
  mockFetchActivities.mockResolvedValue([{ id: 1, type: 'activity' }]);
  mockFetchConversations.mockResolvedValue([{ id: 1, body: 'hi' }]);
});

describe('_hydrateMissingThreads', () => {
  test('processes every ticket in parallel — completes when all jobs done', async () => {
    const tickets = [
      ticket(1, 1001),
      ticket(2, 1002),
      ticket(3, 1003),
    ];

    const result = await assignmentDailyReviewService._hydrateMissingThreads(7, tickets, {});

    expect(mockFetchActivities).toHaveBeenCalledTimes(3);
    expect(mockFetchConversations).toHaveBeenCalledTimes(3);
    expect(result.failed).toBe(0);
    expect(result.hydratedActivities).toBe(3);
    expect(result.hydratedConversations).toBe(3);
    expect(result.activitiesFetched).toBe(3);
    expect(result.conversationsFetched).toBe(3);
    // bulkUpsert called once per (ticket, source) pair = 6
    expect(mockBulkUpsert).toHaveBeenCalledTimes(6);
  });

  test('one failing ticket does not block siblings (failure isolation)', async () => {
    const tickets = [ticket(1, 1001), ticket(2, 1002), ticket(3, 1003)];

    // Ticket 2 throws on activities; ticket 1+3 succeed normally
    mockFetchActivities.mockImplementation((fsId) => {
      if (fsId === 1002) return Promise.reject(new Error('FS 500'));
      return Promise.resolve([{ id: 99 }]);
    });

    const result = await assignmentDailyReviewService._hydrateMissingThreads(7, tickets, {});

    expect(result.hydratedActivities).toBe(2); // ticket 2 failed activities
    expect(result.hydratedConversations).toBe(3); // all conversations succeeded
    expect(result.failed).toBe(1); // only ticket 2 counted as failed
    expect(result.warnings.some((w) => w.includes('1002'))).toBe(true);
    expect(result.perTicket.find((p) => p.freshserviceTicketId === 1002).activitiesError)
      .toMatch(/FS 500/);
  });

  test('cancellation mid-flight aborts and re-throws DailyReviewCancelledError', async () => {
    const tickets = Array.from({ length: 12 }, (_, i) => ticket(i + 1, 9000 + i));
    const controller = new AbortController();

    // Trigger cancellation after the first FS call resolves
    mockFetchActivities.mockImplementation(async () => {
      controller.abort();
      return [{ id: 1 }];
    });

    await expect(
      assignmentDailyReviewService._hydrateMissingThreads(7, tickets, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'DailyReviewCancelledError' });
  });

  test('forceRefresh bypasses cache (re-fetches even when threadCounts > 0)', async () => {
    const tickets = [
      // Both have cached threads → without forceRefresh nothing would fetch
      ticket(1, 1001, { activities: 5, conversations: 5 }),
      ticket(2, 1002, { activities: 5, conversations: 5 }),
    ];

    const result = await assignmentDailyReviewService._hydrateMissingThreads(
      7, tickets, { forceRefresh: true },
    );

    expect(mockFetchActivities).toHaveBeenCalledTimes(2);
    expect(mockFetchConversations).toHaveBeenCalledTimes(2);
    expect(result.forceRefresh).toBe(true);
  });

  test('skips fetching when cache is fully warm and emits the cached-already message', async () => {
    const tickets = [
      ticket(1, 1001, { activities: 5, conversations: 5 }),
      ticket(2, 1002, { activities: 5, conversations: 5 }),
    ];
    const progress = [];

    const result = await assignmentDailyReviewService._hydrateMissingThreads(
      7, tickets, { onProgress: (p) => progress.push(p) },
    );

    expect(mockFetchActivities).not.toHaveBeenCalled();
    expect(mockFetchConversations).not.toHaveBeenCalled();
    expect(result.hydratedActivities).toBe(0);
    expect(result.hydratedConversations).toBe(0);
    expect(progress.at(-1).message).toMatch(/already cached locally/);
  });

  test('progress callback fires with monotonically non-decreasing processed counts', async () => {
    const tickets = Array.from({ length: 25 }, (_, i) => ticket(i + 1, 5000 + i));
    const seen = [];
    await assignmentDailyReviewService._hydrateMissingThreads(7, tickets, {
      onProgress: (p) => { if (typeof p.processed === 'number') seen.push(p.processed); },
    });
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    // Final emit should equal total
    expect(seen.at(-1)).toBe(25);
  });

  test('returns warnings + skipped result when FS is not configured', async () => {
    mockGetFsConfig.mockResolvedValue({ domain: null, apiKey: null });

    const result = await assignmentDailyReviewService._hydrateMissingThreads(
      7, [ticket(1, 1001)], {},
    );

    expect(mockFetchActivities).not.toHaveBeenCalled();
    expect(result.warnings[0]).toMatch(/FreshService is not configured/);
  });
});
