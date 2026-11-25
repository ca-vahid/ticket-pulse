import { jest } from '@jest/globals';

// FreshService switch (25 Nov 2026): the daily review's thread hydration uses
// the cache when the workspace's FreshService is Off. Harness from
// hydrateMissingThreads.test.js.

const fsMode = { mode: 'off' };
jest.unstable_mockModule('../src/services/fsModeService.js', () => ({
  default: {},
  fsGate: jest.fn(async () => fsMode.mode !== 'off'),
  isFreshServiceOff: jest.fn(async () => fsMode.mode === 'off'),
  onModeChange: jest.fn(() => () => {}),
  getMode: jest.fn(async () => fsMode.mode),
  getModeRecord: jest.fn(async () => ({ mode: fsMode.mode })),
  setMode: jest.fn(),
  getShadowReport: jest.fn(async () => ({ since: null, counts: {}, total: 0 })),
  flushShadow: jest.fn(),
  FS_MODES: ['connected', 'shadow', 'off'],
  FS_PURPOSES: [],
  modeSettingKey: (ws) => `freshservice_mode_ws${ws}`,
  shadowSettingKey: (ws) => `freshservice_shadow_ws${ws}`,
  _resetFsModeCache: jest.fn(),
}));

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


const { default: reviewService } = await import('../src/services/assignmentDailyReviewService.js');

const ticket = (id, fsId) => ({ id, origin: 'freshservice', freshserviceTicketId: BigInt(fsId), threadCounts: { activities: 0, conversations: 0 } });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFsConfig.mockResolvedValue({ domain: 'demo', apiKey: 'xx' });
  mockFetchActivities.mockResolvedValue([{ id: 1 }]);
  mockFetchConversations.mockResolvedValue([{ id: 1 }]);
});

test('Off: nothing is fetched from FreshService; the review says it used the stored threads', async () => {
  fsMode.mode = 'off';
  const out = await reviewService._hydrateMissingThreads(7, [ticket(1, 1001), ticket(2, 1002)], {});
  expect(mockFetchActivities).not.toHaveBeenCalled();
  expect(mockFetchConversations).not.toHaveBeenCalled();
  expect(mockGetFsConfig).not.toHaveBeenCalled();
  expect(out).toEqual(expect.objectContaining({ hydratedActivities: 0, hydratedConversations: 0, skipped: 'freshservice_off' }));
  expect(out.warnings[0]).toMatch(/FreshService is off for this workspace/);
});

test('Connected: hydrates as before', async () => {
  fsMode.mode = 'connected';
  await reviewService._hydrateMissingThreads(7, [ticket(1, 1001)], {});
  expect(mockFetchActivities).toHaveBeenCalledTimes(1);
});