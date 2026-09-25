import { jest } from '@jest/globals';

/**
 * FS-born notes gap (plans/FS_THREAD_SYNC_GAP_REPORT.md, 24 Sep 2026): the
 * activity feed said "X added a private note" but the note itself never
 * arrived unless someone opened the ticket (#176019: two note lines, zero
 * conversation rows). fsThreadPullService pulls on change / on close and
 * sweeps the backlog, standing down while the FreshService queue is busy.
 */

const prismaMock = {
  ticket: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}), aggregate: jest.fn() },
  $queryRawUnsafe: jest.fn(),
};
const settings = new Map();
const limiter = { queueDepth: 0 };
const client = {
  getLimiterStats: jest.fn(() => ({ queueDepth: limiter.queueDepth })),
  fetchTicketConversations: jest.fn(),
};
const bulkUpsert = jest.fn().mockResolvedValue({ upserted: 2 });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn(async (k) => settings.get(k) ?? null), set: jest.fn(async (k, v) => { settings.set(k, v); }) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { getClient: jest.fn(async () => client) } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { bulkUpsert } }));
jest.unstable_mockModule('../src/integrations/freshserviceTransformer.js', () => ({
  transformTicketConversationEntries: jest.fn((convs, { ticketId, workspaceId }) => convs.map((c) => ({ ticketId, workspaceId, externalEntryId: `fs:${c.id}` }))),
}));

const { default: svc, SWEEP_PHASES } = await import('../src/services/fsThreadPullService.js');

const now = Date.now();
const activity = (over = {}) => ({ source: 'freshservice_activity', ticketId: 4273, workspaceId: 1, content: ' added a private note', occurredAt: new Date(now - 60000), ...over });

beforeEach(() => {
  svc.queue.clear();
  svc.running = false;
  svc.ticks = 0;
  svc.lastGapLogAt = Date.now();
  Object.keys(svc.stats).forEach((k) => { svc.stats[k] = 0; });
  settings.clear();
  limiter.queueDepth = 0;
  jest.clearAllMocks();
  prismaMock.ticket.update.mockResolvedValue({});
  bulkUpsert.mockResolvedValue({ upserted: 2 });
});

describe('noteActivityArrived — pull on change', () => {
  test('queues recent note / reply / forward lines, once per ticket', () => {
    const n = svc.noteActivityArrived([
      activity(),
      activity({ content: ' added a private note' }), // same ticket: one pull
      activity({ ticketId: 5, content: ' replied  to  it@bgcengineering.ca' }),
      activity({ ticketId: 6, content: ' forwarded the ticket' }),
    ]);
    expect(n).toBe(4);
    expect([...svc.queue.keys()].sort((a, b) => a - b)).toEqual([5, 6, 4273]);
  });

  test('ignores edits, history (> 7 days), other activity and conversation rows', () => {
    svc.noteActivityArrived([
      activity({ content: ' updated a note' }),
      activity({ ticketId: 7, occurredAt: new Date(now - 8 * 86400000) }),
      activity({ ticketId: 8, content: ' set Status as Resolved' }),
      { ...activity({ ticketId: 9 }), source: 'freshservice_conversation' },
    ]);
    expect(svc.queue.size).toBe(0);
  });
});

describe('tick — pulls, stands down when busy, never drops on a busy queue', () => {
  test('stands down while the shared FreshService queue is busy', async () => {
    svc.enqueue(4273, 1, 'resolved', { delayMs: 0 });
    limiter.queueDepth = 31;
    await svc.tick(Date.now() + 1000);
    expect(client.fetchTicketConversations).not.toHaveBeenCalled();
    expect(svc.queue.has(4273)).toBe(true);
    expect(svc.stats.deferred).toBe(1);
  });

  test('pulls the whole conversation (no 60 cap), stores it and marks the ticket checked', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 4273, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 176019n, freshserviceUpdatedAt: new Date('2026-09-24T06:34:04Z') });
    client.fetchTicketConversations.mockResolvedValue([{ id: 1043130568 }, { id: 1039158321 }]);
    svc.enqueue(4273, 1, 'backfill', { delayMs: 0 });
    await svc.tick(Date.now() + 1000);
    expect(client.fetchTicketConversations).toHaveBeenCalledWith(176019);
    expect(bulkUpsert).toHaveBeenCalledWith([
      expect.objectContaining({ ticketId: 4273, externalEntryId: 'fs:1043130568' }),
      expect.objectContaining({ ticketId: 4273, externalEntryId: 'fs:1039158321' }),
    ]);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 4273 },
      data: expect.objectContaining({ fsThreadPulledAt: expect.any(Date), conversationsSyncFreshserviceUpdatedAt: new Date('2026-09-24T06:34:04Z') }),
    });
    expect(svc.queue.size).toBe(0);
    expect(svc.stats.pulled).toBe(1);
  });

  test('a ticket born in Ticket Pulse is skipped (its FS copy is the mirror\'s job)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 9, workspaceId: 1, origin: 'ticketpulse', freshserviceTicketId: 244097n });
    svc.enqueue(9, 1, 'change', { delayMs: 0 });
    await svc.tick(Date.now() + 1000);
    expect(client.fetchTicketConversations).not.toHaveBeenCalled();
  });

  test('a queue timeout re-queues with back-off, however many times', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 4273, workspaceId: 1, origin: 'freshservice', freshserviceTicketId: 176019n });
    const err = Object.assign(new Error('FreshService request timed out after 90s waiting in the rate-limit queue'), { code: 'FS_QUEUE_TIMEOUT' });
    client.fetchTicketConversations.mockRejectedValue(err);
    svc.enqueue(4273, 1, 'backfill', { delayMs: 0 });
    for (let i = 0; i < 10; i++) {
      const item = svc.queue.get(4273);
      await svc.tick(item.dueAt + 1);
    }
    expect(svc.queue.has(4273)).toBe(true);
    expect(svc.stats.dropped).toBe(0);
    expect(svc.stats.requeued).toBe(10);
  });
});

describe('sweepStep — the backfill and the net under the live feeds', () => {
  test('queues gapped tickets of the current phase and moves the cursor on', async () => {
    prismaMock.ticket.aggregate.mockResolvedValue({ _max: { id: 46678 } });
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 4273, workspaceId: 1 }, { id: 42979, workspaceId: 1 }]);
    const out = await svc.sweepStep();
    expect(out.queued).toBe(2);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("interval '90 days'"), 1, 0, 2500);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toMatch(/fs_thread_pulled_at IS NULL/);
    expect(JSON.parse(settings.get('fs_thread_backfill_state'))).toMatchObject({ phase: 0, afterId: 2500 });
    expect([...svc.queue.keys()]).toEqual([4273, 42979]);
  });

  test('past the last ticket id it moves to the next phase (IT all time after IT 90 days)', async () => {
    settings.set('fs_thread_backfill_state', JSON.stringify({ phase: 0, afterId: 45000 }));
    prismaMock.ticket.aggregate.mockResolvedValue({ _max: { id: 46678 } });
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    await svc.sweepStep();
    expect(JSON.parse(settings.get('fs_thread_backfill_state'))).toMatchObject({ phase: 1, afterId: 0 });
    expect(SWEEP_PHASES[1]).toEqual({ workspaceId: 1, days: null });
  });

  test('can be switched off, and never floods a busy queue', async () => {
    settings.set('fs_thread_backfill_enabled', 'false');
    await expect(svc.sweepStep()).resolves.toEqual({ skipped: 'disabled' });
    settings.clear();
    for (let i = 0; i < 40; i++) svc.enqueue(1000 + i, 1, 'change');
    await expect(svc.sweepStep()).resolves.toEqual({ skipped: 'queue_full' });
  });
});
