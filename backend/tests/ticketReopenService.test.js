import { jest } from '@jest/globals';

// QA 09-25 #1 — "Re-opened" counter: a terminal -> open move counts only if
// it sticks for 10 minutes (FS automation flips Closed->Open->Closed in ~30 s).

const prismaMock = {
  ticket: { update: jest.fn(), updateMany: jest.fn() },
  ticketActivity: { findMany: jest.fn() },
};
const BASES = { open: 'Open', pending: 'Pending', 'waiting on customer': 'Pending', resolved: 'Resolved', closed: 'Closed', done: 'Resolved' };
const statusServiceMock = {
  resolveBaseStatus: jest.fn(async (_ws, name) => BASES[String(name).toLowerCase()] ?? null),
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: statusServiceMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  classifyTransition, computeReopenHistory, planReopenBackfill, stampReopen, noteTerminal, observeStatusTransition,
  REOPEN_FLIP_WINDOW_MS, applyReopenBackfillBatch, REOPEN_BACKFILL_SQL,
} = await import('../src/services/ticketReopenService.js');

const T = (iso) => new Date(iso);

describe('classifyTransition', () => {
  test.each([
    ['Closed', 'Open', 'reopen'],
    ['Resolved', 'Pending', 'reopen'],
    ['Open', 'Closed', 'terminal'],
    ['Pending', 'Resolved', 'terminal'],
    ['Resolved', 'Closed', null],
    ['Open', 'Pending', null],
    ['Closed', null, null], // Deleted / Spam have no base
    [null, 'Closed', 'terminal'],
  ])('%s -> %s = %s', (from, to, expected) => {
    expect(classifyTransition(from, to)).toBe(expected);
  });
});

describe('computeReopenHistory (the rule the live counter and the backfill share)', () => {
  test('the 26-second FreshService System flip is not a reopen (FS #240246)', () => {
    expect(computeReopenHistory([
      { at: T('2026-09-10T23:33:49Z'), fromBase: 'Closed', toBase: 'Open' },
      { at: T('2026-09-10T23:34:15Z'), fromBase: 'Open', toBase: 'Closed' },
    ])).toEqual({ reopenCount: 0, reopenedAt: null });
  });

  test('a reopen that is still open counts', () => {
    expect(computeReopenHistory([
      { at: T('2026-09-10T10:00:00Z'), fromBase: 'Closed', toBase: 'Open' },
    ])).toEqual({ reopenCount: 1, reopenedAt: T('2026-09-10T10:00:00Z') });
  });

  test('a reopen that later closes after the window still counts; the last stuck one wins', () => {
    const r = computeReopenHistory([
      // unsorted on purpose
      { at: T('2026-09-12T09:00:00Z'), fromBase: 'Resolved', toBase: 'Open' },
      { at: T('2026-09-10T10:00:00Z'), fromBase: 'Closed', toBase: 'Open' },
      { at: T('2026-09-11T10:00:00Z'), fromBase: 'Open', toBase: 'Resolved' },
      { at: T('2026-09-12T09:00:30Z'), fromBase: 'Open', toBase: 'Closed' }, // flip
      { at: T('2026-09-13T08:00:00Z'), fromBase: 'Closed', toBase: 'Pending' },
    ]);
    expect(r).toEqual({ reopenCount: 2, reopenedAt: T('2026-09-13T08:00:00Z') });
  });

  test('exactly at the window edge still counts as a flip; one second past does not', () => {
    const at = T('2026-09-10T10:00:00Z');
    const edge = new Date(at.getTime() + REOPEN_FLIP_WINDOW_MS);
    const past = new Date(at.getTime() + REOPEN_FLIP_WINDOW_MS + 1000);
    expect(computeReopenHistory([{ at, fromBase: 'Closed', toBase: 'Open' }, { at: edge, fromBase: 'Open', toBase: 'Closed' }]).reopenCount).toBe(0);
    expect(computeReopenHistory([{ at, fromBase: 'Closed', toBase: 'Open' }, { at: past, fromBase: 'Open', toBase: 'Closed' }]).reopenCount).toBe(1);
  });

  test('ignores Open<->Pending and garbage rows', () => {
    expect(computeReopenHistory([
      { at: T('2026-09-10T10:00:00Z'), fromBase: 'Open', toBase: 'Pending' },
      { at: 'not a date', fromBase: 'Closed', toBase: 'Open' },
    ])).toEqual({ reopenCount: 0, reopenedAt: null });
  });
});

describe('planReopenBackfill', () => {
  test('groups status_changed rows per ticket through the base resolver', () => {
    const baseOf = (_id, name) => BASES[String(name).toLowerCase()] ?? null;
    const plan = planReopenBackfill([
      { ticketId: 1, performedAt: T('2026-09-10T23:33:49Z'), details: { oldStatus: 'Closed', newStatus: 'Open' } },
      { ticketId: 1, performedAt: T('2026-09-10T23:34:15Z'), details: { oldStatus: 'Open', newStatus: 'Closed' } },
      { ticketId: 2, performedAt: T('2026-09-11T08:00:00Z'), details: { oldStatus: 'Done', newStatus: 'Waiting on Customer' } },
      { ticketId: 3, performedAt: T('2026-09-11T08:00:00Z'), details: { oldStatus: 'Closed', newStatus: 'Deleted' } },
      { ticketId: 4, performedAt: T('2026-09-11T08:00:00Z'), details: { note: 'no statuses' } },
    ], baseOf);
    expect(plan.get(1)).toEqual({ reopenCount: 0, reopenedAt: null });
    expect(plan.get(2)).toEqual({ reopenCount: 1, reopenedAt: T('2026-09-11T08:00:00Z') });
    expect(plan.get(3)).toEqual({ reopenCount: 0, reopenedAt: null });
    expect(plan.has(4)).toBe(false);
  });
});

describe('live stamp / undo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.update.mockReset();
    prismaMock.ticket.updateMany.mockReset();
    prismaMock.ticketActivity.findMany.mockReset();
    prismaMock.ticket.update.mockResolvedValue({});
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.ticketActivity.findMany.mockResolvedValue([]);
  });

  test('stampReopen sets reopenedAt and increments the count', async () => {
    const at = T('2026-09-10T23:33:49Z');
    expect(await stampReopen(5, at)).toBe(true);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 5 }, data: { reopenedAt: at, reopenCount: { increment: 1 } },
    });
  });

  test('26-second flip: the close undoes the stamp (count - 1, never below 0, only inside the window)', async () => {
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const closeAt = T('2026-09-10T23:34:15Z');
    expect(await noteTerminal(5, closeAt, { workspaceId: 1 })).toBe(true);
    expect(prismaMock.ticket.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 5,
        reopenCount: { gt: 0 },
        reopenedAt: { gte: new Date(closeAt.getTime() - REOPEN_FLIP_WINDOW_MS), lte: new Date(closeAt.getTime() + 60000) },
      },
      data: { reopenCount: { decrement: 1 }, reopenedAt: null },
    });
  });

  test('after an undo, an earlier stuck reopen is restored from history', async () => {
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    prismaMock.ticketActivity.findMany.mockResolvedValue([
      { performedAt: T('2026-09-01T10:00:00Z'), details: { oldStatus: 'Closed', newStatus: 'Open' } },
      { performedAt: T('2026-09-05T10:00:00Z'), details: { oldStatus: 'Open', newStatus: 'Closed' } },
    ]);
    await noteTerminal(5, T('2026-09-10T23:34:15Z'), { workspaceId: 1 });
    expect(prismaMock.ticket.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 5, reopenedAt: null, reopenCount: { gt: 0 } },
      data: { reopenedAt: T('2026-09-01T10:00:00Z') },
    });
  });

  test('a close long after the reopen changes nothing (the conditional update matches no row)', async () => {
    expect(await noteTerminal(5, T('2026-09-12T00:00:00Z'))).toBe(false);
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketActivity.findMany).not.toHaveBeenCalled();
  });

  test('observeStatusTransition resolves custom statuses to bases', async () => {
    expect(await observeStatusTransition({ ticketId: 5, workspaceId: 1, from: 'Done', to: 'Waiting on Customer' })).toBe('reopen');
    expect(prismaMock.ticket.update).toHaveBeenCalledTimes(1);
    expect(await observeStatusTransition({ ticketId: 5, workspaceId: 1, from: 'Open', to: 'Closed' })).toBe('terminal');
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
    expect(await observeStatusTransition({ ticketId: 5, workspaceId: 1, from: 'Open', to: 'Pending' })).toBeNull();
    expect(await observeStatusTransition({ ticketId: 5, workspaceId: 1, from: 'Closed', to: 'Closed' })).toBeNull();
  });

  test('never throws: a DB failure is swallowed', async () => {
    prismaMock.ticket.update.mockRejectedValue(new Error('P2024 pool timeout'));
    prismaMock.ticket.updateMany.mockRejectedValue(new Error('P2024 pool timeout'));
    await expect(observeStatusTransition({ ticketId: 5, workspaceId: 1, from: 'Closed', to: 'Open' })).resolves.toBe('reopen');
    await expect(noteTerminal(5, new Date())).resolves.toBe(false);
    statusServiceMock.resolveBaseStatus.mockRejectedValueOnce(new Error('boom'));
    await expect(observeStatusTransition({ ticketId: 5, workspaceId: 1, from: 'Closed', to: 'Open' })).resolves.toBeNull();
  });
});

describe('backfill apply path (review S4)', () => {
  test('writes with a parameterized raw UPDATE (updated_at untouched), never ticket.update', async () => {
    const client = {
      $executeRawUnsafe: jest.fn((...args) => ({ args })),
      $transaction: jest.fn(async (ops) => ops),
      ticket: { update: jest.fn() },
    };
    const at = '2026-09-20T10:00:00.000Z';
    const sent = await applyReopenBackfillBatch(client, [
      { id: 5, reopenCount: 2, reopenedAt: at },
      { id: 6, reopenCount: 0, reopenedAt: null },
    ]);
    expect(sent).toBe(2);
    expect(REOPEN_BACKFILL_SQL).toBe('UPDATE tickets SET reopened_at = $1, reopen_count = $2 WHERE id = $3');
    expect(REOPEN_BACKFILL_SQL).not.toMatch(/updated_at/);
    expect(client.$executeRawUnsafe).toHaveBeenNthCalledWith(1, REOPEN_BACKFILL_SQL, new Date(at), 2, 5);
    expect(client.$executeRawUnsafe).toHaveBeenNthCalledWith(2, REOPEN_BACKFILL_SQL, null, 0, 6);
    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(client.ticket.update).not.toHaveBeenCalled();
  });

  test('an empty batch writes nothing', async () => {
    const client = { $executeRawUnsafe: jest.fn(), $transaction: jest.fn() };
    expect(await applyReopenBackfillBatch(client, [])).toBe(0);
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});
