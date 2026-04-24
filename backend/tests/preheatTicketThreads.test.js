import { jest } from '@jest/globals';

const mockBulkUpsert = jest.fn().mockResolvedValue(undefined);
const mockTicketFindMany = jest.fn();
const mockGroupBy = jest.fn();
const mockWorkspaceFindUnique = jest.fn();
const mockAssignmentConfigFindUnique = jest.fn();
const mockGetFsConfig = jest.fn();
const mockFetchActivities = jest.fn();
const mockFetchConversations = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {
    workspace: { findUnique: mockWorkspaceFindUnique },
    ticket: { findMany: mockTicketFindMany },
    ticketThreadEntry: { groupBy: mockGroupBy },
    assignmentConfig: { findUnique: mockAssignmentConfigFindUnique },
  },
}));

jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({
  default: { bulkUpsert: mockBulkUpsert },
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {
    getFreshServiceConfig: jest.fn().mockResolvedValue({ domain: 'demo', apiKey: 'xx' }),
    getFreshServiceConfigForWorkspace: mockGetFsConfig,
  },
}));

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: () => ({
    fetchTicketActivities: mockFetchActivities,
    fetchTicketConversations: mockFetchConversations,
  }),
  FORBIDDEN_TICKET: Symbol('FORBIDDEN_TICKET'),
}));

jest.unstable_mockModule('../src/integrations/freshserviceTransformer.js', () => ({
  transformTickets: () => [],
  transformAgents: () => [],
  mapTechnicianIds: (x) => x,
  analyzeTicketActivities: () => ({}),
  transformTicketThreadEntries: (rows, ctx) =>
    rows.map((r, i) => ({
      ticketId: ctx.ticketId,
      workspaceId: ctx.workspaceId,
      source: 'freshservice_activity',
      externalEntryId: `act-${ctx.ticketId}-${i}`,
      occurredAt: new Date(),
    })),
  transformTicketConversationEntries: (rows, ctx) =>
    rows.map((r, i) => ({
      ticketId: ctx.ticketId,
      workspaceId: ctx.workspaceId,
      source: 'freshservice_conversation',
      externalEntryId: `conv-${ctx.ticketId}-${i}`,
      occurredAt: new Date(),
    })),
}));

// Stub out the rest of the syncService dependency tree — we only care
// about _preheatTicketThreads here, but the module's top-level imports
// must all resolve.
jest.unstable_mockModule('../src/services/technicianRepository.js', () => ({
  default: { getAll: jest.fn().mockResolvedValue([]) },
}));
jest.unstable_mockModule('../src/services/ticketRepository.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../src/services/syncLogRepository.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../src/services/csatService.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../src/services/assignmentFlowGuards.js', () => ({
  shouldTriggerAssignmentForLatestRun: () => false,
}));
jest.unstable_mockModule('../src/services/dashboardReadCache.js', () => ({
  clearReadCache: () => {},
}));

const { default: syncService } = await import('../src/services/syncService.js');

const makeTicket = (id, fsId, fsTimestamp) => ({
  id,
  freshserviceTicketId: BigInt(fsId),
  // Use createdAt as the FS state-change anchor by default; tests can
  // override with assignedAt/resolvedAt/closedAt as needed.
  createdAt: fsTimestamp,
  assignedAt: null,
  resolvedAt: null,
  closedAt: null,
});

beforeEach(() => {
  mockBulkUpsert.mockClear();
  mockTicketFindMany.mockReset();
  mockGroupBy.mockReset();
  mockWorkspaceFindUnique.mockReset();
  mockAssignmentConfigFindUnique.mockReset();
  mockGetFsConfig.mockReset();
  mockFetchActivities.mockReset();
  mockFetchConversations.mockReset();

  mockWorkspaceFindUnique.mockResolvedValue({
    id: 7, name: 'WS', defaultTimezone: 'America/Los_Angeles',
  });
  // Default: feature ENABLED for the workspace, so the existing tests
  // exercise the actual preheat code path. The new "disabled" test
  // overrides this to exercise the gate.
  mockAssignmentConfigFindUnique.mockResolvedValue({ dailyReviewPreheatEnabled: true });
  mockGetFsConfig.mockResolvedValue({ domain: 'demo', apiKey: 'xx' });
  mockGroupBy.mockResolvedValue([]);
  mockFetchActivities.mockResolvedValue([{ id: 1 }]);
  mockFetchConversations.mockResolvedValue([{ id: 1 }]);
});

describe('_preheatTicketThreads', () => {
  test('selects today-cohort by FS-source state changes only (not Prisma @updatedAt)', async () => {
    mockTicketFindMany.mockResolvedValue([]);

    await syncService._preheatTicketThreads(7);

    expect(mockTicketFindMany).toHaveBeenCalledTimes(1);
    const where = mockTicketFindMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe(7);
    expect(Array.isArray(where.OR)).toBe(true);
    const fields = where.OR.map((c) => Object.keys(c)[0]).sort();
    // CRITICAL: we filter on FS timestamps only. updatedAt is excluded
    // because Prisma's @updatedAt auto-bumps on every local DB write,
    // which would balloon the cohort to every recently-synced ticket.
    expect(fields).toEqual(['assignedAt', 'closedAt', 'createdAt', 'resolvedAt']);
    expect(fields).not.toContain('updatedAt');
    // All four conditions filter by the SAME start-of-day date
    const dates = where.OR.map((c) => Object.values(c)[0].gte.getTime());
    expect(new Set(dates).size).toBe(1);
  });

  test('skips fetching for (ticket, source) pairs whose cached entry is fresher than the newest FS state change', async () => {
    const fsTimestamp = new Date('2026-04-23T10:00:00Z');
    mockTicketFindMany.mockResolvedValue([
      makeTicket(1, 1001, fsTimestamp),
      makeTicket(2, 1002, fsTimestamp),
    ]);
    // Ticket 1: activities cache is FRESH (after updatedAt) → skip activities;
    //           conversations cache is STALE → must fetch
    // Ticket 2: both caches FRESH → skip everything
    mockGroupBy.mockResolvedValue([
      { ticketId: 1, source: 'freshservice_activity', _max: { occurredAt: new Date('2026-04-23T11:00:00Z') } },
      { ticketId: 1, source: 'freshservice_conversation', _max: { occurredAt: new Date('2026-04-23T09:00:00Z') } },
      { ticketId: 2, source: 'freshservice_activity', _max: { occurredAt: new Date('2026-04-23T11:00:00Z') } },
      { ticketId: 2, source: 'freshservice_conversation', _max: { occurredAt: new Date('2026-04-23T11:00:00Z') } },
    ]);

    const result = await syncService._preheatTicketThreads(7);

    expect(mockFetchActivities).not.toHaveBeenCalled(); // ticket 1+2 activities fresh
    expect(mockFetchConversations).toHaveBeenCalledTimes(1); // only ticket 1 conv stale
    expect(mockFetchConversations).toHaveBeenCalledWith(1001, expect.any(Object));
    expect(result.ticketsHydrated).toBe(1);
  });

  test('honors the per-cycle cap (MAX_PREHEAT_TICKETS_PER_CYCLE = 60)', async () => {
    const updatedAt = new Date('2026-04-23T10:00:00Z');
    // Build 100 tickets with no cached entries → every ticket needs both sources
    const cohort = Array.from({ length: 100 }, (_, i) => makeTicket(i + 1, 1000 + i, updatedAt));
    mockTicketFindMany.mockResolvedValue(cohort);
    mockGroupBy.mockResolvedValue([]); // nothing cached

    const result = await syncService._preheatTicketThreads(7);

    expect(result.ticketsHydrated).toBe(60);
    // Each capped ticket fires 2 endpoints
    expect(mockFetchActivities).toHaveBeenCalledTimes(60);
    expect(mockFetchConversations).toHaveBeenCalledTimes(60);
  });

  test('one ticket failure does not abort the cycle (fire-and-forget per ticket)', async () => {
    const updatedAt = new Date('2026-04-23T10:00:00Z');
    mockTicketFindMany.mockResolvedValue([
      makeTicket(1, 1001, updatedAt),
      makeTicket(2, 1002, updatedAt),
      makeTicket(3, 1003, updatedAt),
    ]);

    mockFetchActivities.mockImplementation((fsId) => {
      if (fsId === 1002) return Promise.reject(new Error('FS 500'));
      return Promise.resolve([{ id: 1 }]);
    });

    const result = await syncService._preheatTicketThreads(7);

    expect(result.failures).toBe(1);
    expect(result.ticketsHydrated).toBe(3);
    // Conversations still fired for all 3, activities for 2 successful
    expect(mockFetchConversations).toHaveBeenCalledTimes(3);
    expect(mockFetchActivities).toHaveBeenCalledTimes(3); // attempted on all
  });

  test('writes via ticketThreadRepository.bulkUpsert with the workspaceId', async () => {
    const updatedAt = new Date('2026-04-23T10:00:00Z');
    mockTicketFindMany.mockResolvedValue([makeTicket(1, 1001, updatedAt)]);

    await syncService._preheatTicketThreads(7);

    expect(mockBulkUpsert).toHaveBeenCalled();
    for (const call of mockBulkUpsert.mock.calls) {
      const entries = call[0];
      for (const entry of entries) {
        expect(entry.workspaceId).toBe(7);
      }
    }
  });

  test('skips cleanly when FreshService is not configured', async () => {
    mockGetFsConfig.mockResolvedValue({ domain: null, apiKey: null });

    const result = await syncService._preheatTicketThreads(7);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('freshservice_not_configured');
    expect(mockTicketFindMany).not.toHaveBeenCalled();
    expect(mockFetchActivities).not.toHaveBeenCalled();
  });

  test('skips cleanly when workspace does not exist', async () => {
    mockWorkspaceFindUnique.mockResolvedValue(null);

    const result = await syncService._preheatTicketThreads(999);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('workspace_not_found');
    expect(mockTicketFindMany).not.toHaveBeenCalled();
  });

  test('skips silently when the workspace has the preheat flag OFF (default)', async () => {
    mockAssignmentConfigFindUnique.mockResolvedValue({ dailyReviewPreheatEnabled: false });

    const result = await syncService._preheatTicketThreads(7);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('preheat_disabled_for_workspace');
    expect(mockTicketFindMany).not.toHaveBeenCalled();
    expect(mockGroupBy).not.toHaveBeenCalled();
    expect(mockFetchActivities).not.toHaveBeenCalled();
    expect(mockFetchConversations).not.toHaveBeenCalled();
  });

  test('skips silently when the workspace has no AssignmentConfig row at all', async () => {
    mockAssignmentConfigFindUnique.mockResolvedValue(null);

    const result = await syncService._preheatTicketThreads(7);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('preheat_disabled_for_workspace');
    expect(mockTicketFindMany).not.toHaveBeenCalled();
    expect(mockFetchActivities).not.toHaveBeenCalled();
  });

  test('returns {ticketsHydrated: 0} when all cohort tickets have fresh cache', async () => {
    const updatedAt = new Date('2026-04-23T10:00:00Z');
    mockTicketFindMany.mockResolvedValue([
      makeTicket(1, 1001, updatedAt),
      makeTicket(2, 1002, updatedAt),
    ]);
    mockGroupBy.mockResolvedValue([
      { ticketId: 1, source: 'freshservice_activity', _max: { occurredAt: new Date('2026-04-23T11:00:00Z') } },
      { ticketId: 1, source: 'freshservice_conversation', _max: { occurredAt: new Date('2026-04-23T11:00:00Z') } },
      { ticketId: 2, source: 'freshservice_activity', _max: { occurredAt: new Date('2026-04-23T11:00:00Z') } },
      { ticketId: 2, source: 'freshservice_conversation', _max: { occurredAt: new Date('2026-04-23T11:00:00Z') } },
    ]);

    const result = await syncService._preheatTicketThreads(7);

    expect(result.ticketsConsidered).toBe(2);
    expect(result.ticketsHydrated).toBe(0);
    expect(mockFetchActivities).not.toHaveBeenCalled();
    expect(mockFetchConversations).not.toHaveBeenCalled();
  });
});
