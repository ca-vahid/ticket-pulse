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

describe('mirror reconcile sweep — deferral has a ceiling (15 Sep 2026, 3–4 PM PT)', () => {
  test('a workspace whose last pass is older than the ceiling runs even when the queue is deep', async () => {
    clientMock.getLimiterStats.mockReturnValue({ queueDepth: 120 });
    // Cold (counts from boot) and busy → defers, as before.
    expect(await mirrorService.reconcile(7, { activeOnly: true, limit: 30, deferWhenBusy: true })).toMatchObject({ skipped: true, reason: 'limiter_busy' });
    // Age the last pass past the ceiling → runs and says why.
    mirrorService._lastReconcileAt.set(7, Date.now() - 16 * 60 * 1000);
    expect(await mirrorService.reconcile(7, { activeOnly: true, limit: 30, deferWhenBusy: true })).toMatchObject({ checked: 1 });
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('running despite a busy FreshService queue'));
    // Straight after a completed pass, still busy → defers again.
    expect(await mirrorService.reconcile(7, { activeOnly: true, limit: 30, deferWhenBusy: true })).toMatchObject({ skipped: true, reason: 'limiter_busy' });
    expect(clientMock.fetchTicketConversations).toHaveBeenCalledTimes(1);
  });
});

// 6 Oct 2026 — the sweep fired ~50 conversation reads back to back every
// 3 minutes; with the 15-minute deleted-ticket check in the same minute
// FreshService answered 429 (Retry-After 24 s) and an agent's ticket page
// timed out in the queue (#245779).
describe('mirror reconcile sweep — shared pace and yielding to people', () => {
  const tickets = [1, 2, 3, 4, 5].map((n) => ({ ...openTicket, id: 600 + n, freshserviceTicketId: BigInt(232000 + n) }));

  test('it stops when a person is waiting and the next pass resumes where it stopped', async () => {
    prismaMock.ticket.findMany.mockResolvedValue(tickets);
    mirrorService._reconcileResume?.delete(9);
    // quiet for the defer check and the first two tickets, then a person's request is queued
    let calls = 0;
    clientMock.getLimiterStats.mockImplementation(() => {
      calls += 1;
      return calls <= 2 ? { queueDepth: 0 } : { queueDepth: 1, queueDepthByPriority: { high: 1 } };
    });
    const first = await mirrorService.reconcile(9, { activeOnly: true, limit: 30, deferWhenBusy: true });
    expect(first).toMatchObject({ checked: 2, yielded: true, remaining: 3 });
    expect(clientMock.fetchTicketConversations).toHaveBeenCalledTimes(2);
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('2 tickets checked of 5 (yielded to people; the rest next pass)'));

    clientMock.fetchTicketConversations.mockClear();
    clientMock.getLimiterStats.mockReturnValue({ queueDepth: 0 });
    const second = await mirrorService.reconcile(9, { activeOnly: true, limit: 30, deferWhenBusy: true });
    expect(second).toMatchObject({ checked: 5 });
    expect(second.yielded).toBeUndefined();
    // the pass started at the third ticket, so the tail was reached first
    expect(clientMock.fetchTicketConversations.mock.calls[0][0]).toBe(232003);
  });

  test('at least one ticket is always checked, so a busy limiter cannot stall the sweep forever', async () => {
    prismaMock.ticket.findMany.mockResolvedValue(tickets);
    mirrorService._reconcileResume?.delete(10);
    clientMock.getLimiterStats.mockReturnValue({ queueDepth: 2, slowdownActive: true });
    const out = await mirrorService.reconcile(10, { activeOnly: true, limit: 30 });
    expect(out).toMatchObject({ checked: 1, yielded: true, remaining: 4 });
  });
});
