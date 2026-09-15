import { jest } from '@jest/globals';

// 15 Sep 2026 — the 3-minute inbound reconcile sweep enqueued ~36 low-priority
// FreshService calls on top of a queue the :00/:30 scheduled syncs had already
// filled to ~90, waited past the 90 s mirror queue timeout and failed every
// ticket. The scheduled sweep now defers itself when the shared limiter's
// queue is already deep; a direct reconcile (ticket page open) never defers.

const prismaMock = {
  ticket: { findMany: jest.fn(), findFirst: jest.fn(), groupBy: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn() },
  ticketActivity: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  workspace: { findUnique: jest.fn().mockResolvedValue({ isActive: true }) },
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const clientMock = {
  getLimiterStats: jest.fn(),
  fetchTicketSafe: jest.fn().mockResolvedValue(null),
  fetchTicketConversations: jest.fn().mockResolvedValue([]),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getFreshServiceConfigForWorkspace: jest.fn().mockResolvedValue({ domain: 'x', apiKey: 'k' }) },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(() => clientMock),
}));
jest.unstable_mockModule('../src/services/ticketTypeService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn().mockResolvedValue(['Open', 'Pending']) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: {}, emitTicketEvent: jest.fn().mockResolvedValue(undefined),
}));

const { default: mirrorService } = await import('../src/services/mirrorService.js');

const openTicket = { id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1042, freshserviceTicketId: BigInt(231900), assignedTech: null };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findMany.mockResolvedValue([openTicket]);
});

describe('mirror reconcile sweep backpressure', () => {
  test('the scheduled sweep defers when the FreshService queue is already deep', async () => {
    clientMock.getLimiterStats.mockReturnValue({ queueDepth: 88, queueDepthByPriority: { high: 0, normal: 0, low: 88 } });
    const result = await mirrorService.reconcile(1, { activeOnly: true, limit: 30, deferWhenBusy: true });
    expect(result).toMatchObject({ skipped: true, reason: 'limiter_busy', queueDepth: 88 });
    expect(clientMock.fetchTicketConversations).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('deferred: FreshService queue busy (88 waiting)'));
  });

  test('a quiet queue runs the sweep as before', async () => {
    clientMock.getLimiterStats.mockReturnValue({ queueDepth: 3 });
    const result = await mirrorService.reconcile(1, { activeOnly: true, limit: 30, deferWhenBusy: true });
    expect(result).toMatchObject({ checked: 1 });
    expect(clientMock.fetchTicketConversations).toHaveBeenCalledTimes(1);
  });

  test('a direct reconcile (ticket page open) never defers, and a client without stats never blocks', async () => {
    clientMock.getLimiterStats.mockReturnValue({ queueDepth: 500 });
    expect(await mirrorService.reconcile(1, { activeOnly: true, limit: 30 })).toMatchObject({ checked: 1 });
    clientMock.getLimiterStats.mockImplementation(() => { throw new Error('no limiter'); });
    expect(await mirrorService.reconcile(1, { activeOnly: true, limit: 30, deferWhenBusy: true })).toMatchObject({ checked: 1 });
  });
});
