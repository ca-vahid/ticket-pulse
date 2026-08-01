import { jest } from '@jest/globals';

const prismaMock = {
  ticket: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));

const { bucketTicketsByDay, getActivityCalendar } = await import('../src/services/activityCalendarService.js');

describe('bucketTicketsByDay — the heatmap day math', () => {
  test('empty / null input returns an empty array', () => {
    expect(bucketTicketsByDay([])).toEqual([]);
    expect(bucketTicketsByDay(null)).toEqual([]);
    expect(bucketTicketsByDay(undefined)).toEqual([]);
  });

  test('counts tickets per Pacific-time calendar day, sorted ascending', () => {
    const rows = [
      // 2026-07-27 10:00 PT
      { firstAssignedAt: new Date('2026-07-27T17:00:00.000Z'), createdAt: null },
      { firstAssignedAt: new Date('2026-07-27T18:30:00.000Z'), createdAt: null },
      // 2026-07-28 09:00 PT (listed first to prove sorting)
      { firstAssignedAt: new Date('2026-07-28T16:00:00.000Z'), createdAt: null },
    ];
    // Deliberately shuffled
    expect(bucketTicketsByDay([rows[2], rows[0], rows[1]])).toEqual([
      { date: '2026-07-27', count: 2 },
      { date: '2026-07-28', count: 1 },
    ]);
  });

  test('UTC evening lands on the SAME Pacific day, not the next one', () => {
    // 2026-07-28T02:30Z is still 2026-07-27 in Pacific time.
    const rows = [{ firstAssignedAt: new Date('2026-07-28T02:30:00.000Z'), createdAt: null }];
    expect(bucketTicketsByDay(rows)).toEqual([{ date: '2026-07-27', count: 1 }]);
  });

  test('falls back to createdAt when firstAssignedAt is null (same rule as statsCalculator)', () => {
    const rows = [
      { firstAssignedAt: null, createdAt: new Date('2026-07-27T17:00:00.000Z') },
      { firstAssignedAt: new Date('2026-07-27T18:00:00.000Z'), createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ];
    expect(bucketTicketsByDay(rows)).toEqual([{ date: '2026-07-27', count: 2 }]);
  });

  test('skips rows with no usable timestamp or an invalid one', () => {
    const rows = [
      { firstAssignedAt: null, createdAt: null },
      { firstAssignedAt: 'not-a-date', createdAt: null },
      { firstAssignedAt: new Date('2026-07-27T17:00:00.000Z'), createdAt: null },
    ];
    expect(bucketTicketsByDay(rows)).toEqual([{ date: '2026-07-27', count: 1 }]);
  });

  test('honours a custom timezone for day boundaries', () => {
    // 2026-07-28T02:30Z is already 2026-07-28 in UTC.
    const rows = [{ firstAssignedAt: new Date('2026-07-28T02:30:00.000Z'), createdAt: null }];
    expect(bucketTicketsByDay(rows, 'UTC')).toEqual([{ date: '2026-07-28', count: 1 }]);
  });
});

describe('getActivityCalendar — query shape', () => {
  test('runs a single skinny findMany scoped to tech + workspace and buckets the result', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([
      { firstAssignedAt: new Date('2026-07-27T17:00:00.000Z'), createdAt: null },
      { firstAssignedAt: new Date('2026-07-27T18:00:00.000Z'), createdAt: null },
    ]);

    const result = await getActivityCalendar({ technicianId: 7, workspaceId: 1, days: 30 });

    expect(result).toEqual([{ date: '2026-07-27', count: 2 }]);
    expect(prismaMock.ticket.findMany).toHaveBeenCalledTimes(1);
    const arg = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(arg.where.assignedTechId).toBe(7);
    expect(arg.where.workspaceId).toBe(1);
    // Only the two timestamps are selected — no heavy includes.
    expect(arg.select).toEqual({ firstAssignedAt: true, createdAt: true });
    // Cutoff respects the days window (~30 days ago).
    const cutoff = arg.where.OR[0].firstAssignedAt.gte;
    const expected = Date.now() - 30 * 86_400_000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000);
  });
});
